import {createHash,randomUUID} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,renameSync,writeFileSync,statfsSync,lstatSync,promises as fs} from 'node:fs';
import {join,resolve,sep,dirname,parse} from 'node:path';
import type {Config} from './config.js';
import type {Store} from './store.js';
import type {Attachment,GroupMessage,ToolDefinition,WorkerRequest} from './types.js';
import {isPrivateRoom} from './conversation.js';
import {readTaskFile,validateOutputFileName,MAX_OUTPUT_FILE_BYTES,MAX_OUTPUT_FILE_TOTAL_BYTES} from './output-files.js';
import {PublicWebAccess,publicWebUrl} from './tools/public-network.js';
import {imageMime} from './output-images.js';

export interface AttachmentRef {sourceInputId:string;attachmentId:string;name:string;bytes:number;sha256:string}
interface ManagedFile {id:string;roomId:string;path:string;temporary?:string;bytes:number;sha256:string;createdAt:number;releasedAt?:number;state:'staging'|'available'|'deleting'|'expired';attachmentId?:string;sourceInputId?:string;threadId?:string;artifactId?:string}
export interface ManagedFileWriter {write(path:string,bytes:Buffer,artifactId:string,signal?:AbortSignal):Promise<void>}
const sha=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
export function prepareFileMetadata(message:GroupMessage):GroupMessage {
  if(!isPrivateRoom(message.roomId))return message;
  const files=message.attachments.filter(a=>a.kind==='file');
  let total=0;
  for(const [index,a]of message.attachments.entries())if(a.kind==='image'){a.attachmentId='image-'+sha(JSON.stringify([message.roomId,message.id,index]));a.sourceInputId=message.id;}
  for(const [index,a]of message.attachments.entries())if(a.kind==='file'){
    a.attachmentId='in-'+sha(JSON.stringify([message.roomId,message.id,index]));a.sourceInputId=message.id;
    try{
      a.name=validateOutputFileName(a.name);
      if(files.length>4||a.bytes!==undefined&&(!Number.isSafeInteger(a.bytes)||a.bytes<0||a.bytes>MAX_OUTPUT_FILE_BYTES))throw new Error('invalid_file_size');
      total+=a.bytes??0;if(total>MAX_OUTPUT_FILE_TOTAL_BYTES)throw new Error('input_files_too_large');
    }catch{a.downloadError='invalid_file_metadata';delete a.url;delete a.file;}
  }
  if(total>MAX_OUTPUT_FILE_TOTAL_BYTES||files.length>4)for(const a of files)a.downloadError='input_files_too_large';
  return message;
}
/** Single service owns the manifest. Only explicitly registered snapshots are cleaned. */
export class AttachmentService {
  private files=new Map<string,ManagedFile>();
  private readonly root:string;
  private readonly manifest:string;
  private readonly web=new PublicWebAccess();
  private readonly busy=new Set<string>();
  private readonly downloads=new Map<string,Promise<Attachment>>();
  private lastSweep=0;
  constructor(readonly config:Config,readonly store:Store,private readonly fetchFile?:(attachment:Attachment,roomId:string,signal:AbortSignal)=>Promise<Buffer>,private readonly resolveUrl?:(roomId:string,attachment:Attachment)=>Promise<string|undefined>){
    this.root=join(config.stateDir,'attachments');this.manifest=join(this.root,'manifest.json');
    mkdirSync(this.root,{recursive:true,mode:0o700});
    if(existsSync(this.manifest)){
      const entries=JSON.parse(readFileSync(this.manifest,'utf8')) as ManagedFile[];
      if(!Array.isArray(entries))throw new Error('Invalid attachment manifest');
      for(const entry of entries){this.assertPath(entry.path);this.files.set(entry.id,entry);}
    }
  }
  private assertPath(path:string){
    const target=resolve(path);if(![this.root,join(this.config.stateDir,'workspaces')].some(root=>target.startsWith(resolve(root)+sep)))throw new Error('Invalid managed attachment path');
    // Check every existing ancestor before creating directories or opening bytes.
    for(let current=target;current!==dirname(resolve(this.config.stateDir))&&current!==parse(current).root;current=dirname(current))if(existsSync(current)&&lstatSync(current).isSymbolicLink())throw new Error('attachment_symlink');
  }
  private save(){const temp=this.manifest+'.tmp';writeFileSync(temp,JSON.stringify([...this.files.values()]),{mode:0o600});renameSync(temp,this.manifest);}
  private reserve(bytes:number){
    const settings=this.config.attachments??{maxStorageBytes:10*1024**3,minFreeDiskBytes:512*1024**2,retentionDays:7};
    const used=[...this.files.values()].filter(f=>f.state!=='expired').reduce((n,f)=>n+f.bytes,0),disk=statfsSync(this.root);
    if(used+bytes>settings.maxStorageBytes||disk.bavail*disk.bsize-bytes<settings.minFreeDiskBytes)throw new Error('attachment_storage_full');
  }
  async write(path:string,bytes:Buffer,metadata:Omit<ManagedFile,'id'|'path'|'bytes'|'sha256'|'createdAt'|'state'>,signal?:AbortSignal){
    signal?.throwIfAborted();this.assertPath(path);
    try{this.reserve(bytes.length);}catch(error){await this.sweep(true);signal?.throwIfAborted();this.reserve(bytes.length);}
    const id=sha(path),entry:ManagedFile={...metadata,id,path,bytes:bytes.length,sha256:sha(bytes),createdAt:Date.now(),state:'staging'};
    if(this.files.has(id)&&this.files.get(id)!.state!=='expired')throw new Error('Attachment snapshot already registered');
    const temporary=path+'.'+randomUUID()+'.tmp';entry.temporary=temporary;
    this.files.set(id,entry);this.busy.add(id);this.save();
    try{
      await fs.mkdir(dirname(path),{recursive:true,mode:0o700});signal?.throwIfAborted();this.assertPath(path);
      await fs.writeFile(temporary,bytes,{flag:'wx',mode:0o400});signal?.throwIfAborted();
      this.assertPath(path);await fs.rename(temporary,path);signal?.throwIfAborted();entry.state='available';delete entry.temporary;this.save();
    }catch(error){await fs.rm(temporary,{force:true});await fs.rm(path,{force:true});entry.state='expired';this.save();throw error;}
    finally{this.busy.delete(id);}
  }
  writer(request:WorkerRequest):ManagedFileWriter{return {write:(path,bytes,artifactId,signal)=>this.write(path,bytes,{roomId:request.thread.roomId,threadId:request.thread.id,artifactId},AbortSignal.any([...(request.signal?[request.signal]:[]),...(signal?[signal]:[])]))};}
  async image(roomId:string,sourceInputId:string,index:number,load:(signal:AbortSignal)=>Promise<Attachment>,signal?:AbortSignal):Promise<Attachment>{
    const lease=this.store.privateAccess!.capture(roomId),key='image:'+roomId+':'+sourceInputId+':'+index;signal?.throwIfAborted();
    let job=this.downloads.get(key);if(!job){job=this.loadImage(roomId,sourceInputId,index,load,signal);this.downloads.set(key,job);}
    try{const value=await job;this.store.privateAccess!.assert(lease);signal?.throwIfAborted();return value;}finally{if(this.downloads.get(key)===job)this.downloads.delete(key);}
  }
  private async loadImage(roomId:string,sourceInputId:string,index:number,load:(signal:AbortSignal)=>Promise<Attachment>,signal?:AbortSignal):Promise<Attachment>{
    const lease=this.store.privateAccess!.capture(roomId),combined=AbortSignal.any([lease.signal,...(signal?[signal]:[])]),source=this.store.message(sourceInputId),attachment=source?.attachments[index];
    if(source?.roomId!==roomId||attachment?.kind!=='image'||!attachment.attachmentId)throw new Error('attachment_out_of_scope');
    combined.throwIfAborted();const path=join(this.root,attachment.attachmentId),id=sha(path),existing=this.files.get(id);
    const result=(bytes:Buffer):Attachment=>({kind:'image',mimeType:imageMime(bytes),url:`data:${imageMime(bytes)};base64,${bytes.toString('base64')}`});
    if(existing){
      if(existing.state!=='available')throw new Error('attachment_unavailable');this.busy.add(id);
      try{const bytes=await readTaskFile(path,this.root,existing.bytes);combined.throwIfAborted();if(sha(bytes)!==existing.sha256)throw new Error('attachment_changed');return result(bytes);}finally{this.busy.delete(id);}
    }
    try{this.reserve(MAX_OUTPUT_FILE_BYTES);}catch{await this.sweep(true);this.reserve(MAX_OUTPUT_FILE_BYTES);}const reservation:ManagedFile={id,path,bytes:MAX_OUTPUT_FILE_BYTES,sha256:'',roomId,attachmentId:attachment.attachmentId,sourceInputId,createdAt:Date.now(),state:'staging'};
    this.files.set(id,reservation);this.busy.add(id);this.save();
    try{
      const loaded=await load(combined);combined.throwIfAborted();const match=/^data:image\/(?:png|jpeg|gif|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(loaded.url??'');
      if(!match||match[1].length>4*Math.ceil(MAX_OUTPUT_FILE_BYTES/3))throw new Error('invalid_image');const bytes=Buffer.from(match[1],'base64');
      if(!bytes.length||bytes.length>MAX_OUTPUT_FILE_BYTES)throw new Error('file_too_large');const output=result(bytes);
      this.files.delete(id);this.busy.delete(id);await this.write(path,bytes,{roomId,attachmentId:attachment.attachmentId,sourceInputId},combined);return output;
    }catch(error){if(this.files.get(id)?.state==='staging'){reservation.state='expired';this.save();}throw error;}
    finally{this.busy.delete(id);}
  }
  private source(roomId:string,id:string){
    for(const row of this.store.db.prepare('SELECT data FROM messages WHERE room=?').all(roomId)){
      const message=JSON.parse(String(row.data)) as GroupMessage;
      const attachment=message.attachments.find(a=>a.kind==='file'&&a.attachmentId===id);
      if(attachment)return {message,attachment};
    }
    throw new Error('attachment_not_found');
  }
  private update(messageId:string,id:string,patch:Partial<Attachment>){
    const message=this.store.message(messageId);if(!message)throw new Error('attachment_not_found');
    const a=message.attachments.find(a=>a.attachmentId===id);if(!a)throw new Error('attachment_not_found');Object.assign(a,patch);
    this.store.db.prepare('UPDATE messages SET data=? WHERE id=?').run(JSON.stringify(message),messageId);
  }
  async download(roomId:string,id:string,signal?:AbortSignal):Promise<Attachment>{
    const lease=this.store.privateAccess!.capture(roomId),key=roomId+'\0'+id;
    const active=this.downloads.get(key);if(active){const value=await active;this.store.privateAccess!.assert(lease);return value;}
    const job=this.performDownload(roomId,id,AbortSignal.any([lease.signal,AbortSignal.timeout(60000),...(signal?[signal]:[])]));
    this.downloads.set(key,job);try{return await job;}finally{this.downloads.delete(key);}
  }
  private async performDownload(roomId:string,id:string,signal:AbortSignal):Promise<Attachment>{
    const {message,attachment}=this.source(roomId,id);signal.throwIfAborted();
    if(attachment.downloadError)throw new Error(attachment.downloadError);
    const path=join(this.root,id);
    const entry=this.files.get(sha(path));
    if(entry){
      if(entry.state!=='available')throw new Error('attachment_expired');
      this.busy.add(entry.id);
      try{const bytes=await readTaskFile(path,this.root,entry.bytes);signal.throwIfAborted();if(sha(bytes)!==entry.sha256)throw new Error('attachment_changed');return {...attachment,localFile:path,bytes:entry.bytes,sha256:entry.sha256};}
      finally{this.busy.delete(entry.id);}
    }
    // Reserve worst-case bytes before starting concurrent downloads.
    try{this.reserve(MAX_OUTPUT_FILE_BYTES);}catch{await this.sweep(true);this.reserve(MAX_OUTPUT_FILE_BYTES);}
    const reservation:ManagedFile={id:sha(path),path,bytes:MAX_OUTPUT_FILE_BYTES,sha256:'',roomId,attachmentId:id,sourceInputId:message.id,createdAt:Date.now(),state:'staging'};
    this.files.set(reservation.id,reservation);this.busy.add(reservation.id);this.save();
    try{
      let url=attachment.url;
      if(!this.fetchFile&&!url&&this.resolveUrl){url=await this.resolveUrl(roomId,attachment);signal.throwIfAborted();}
      const bytes=this.fetchFile?await this.fetchFile(attachment,roomId,signal):await this.downloadUrl(url,signal);
      signal.throwIfAborted();if(!bytes.length||bytes.length>MAX_OUTPUT_FILE_BYTES)throw new Error('file_too_large');
      const peers=this.store.message(message.id)!.attachments.filter(a=>a.kind==='file'&&a.attachmentId!==id);
      if(bytes.length+peers.reduce((n,a)=>n+(a.bytes??0),0)>MAX_OUTPUT_FILE_TOTAL_BYTES)throw new Error('input_files_too_large');
      this.files.delete(reservation.id);this.busy.delete(reservation.id);
      await this.write(path,bytes,{roomId,attachmentId:id,sourceInputId:message.id},signal);signal.throwIfAborted();
      const patch={localFile:path,bytes:bytes.length,sha256:sha(bytes)};this.update(message.id,id,patch);return {...attachment,...patch};
    }catch(error){
      const current=this.files.get(reservation.id);if(current?.state==='staging'){current.state='expired';this.save();}
      if(!signal.aborted)this.update(message.id,id,{downloadError:error instanceof Error&&/^[a-z_]+$/.test(error.message)?error.message:'file_download_failed'});
      throw error;
    }finally{this.busy.delete(reservation.id);}
  }
  private async downloadUrl(raw:string|undefined,signal:AbortSignal):Promise<Buffer>{
    if(!raw)throw new Error('file_url_unavailable');
    for(let redirects=0;redirects<=3;redirects++){
      const url=publicWebUrl(raw);
      if(!['qq.com','qq.com.cn','qpic.cn'].some(domain=>url.hostname===domain||url.hostname.endsWith('.'+domain)))throw new Error('untrusted_file_url');
      const response=await this.web.fetch(url.href,signal,'manual');
      if([301,302,303,307,308].includes(response.status)){
        const location=response.headers.get('location');await response.body?.cancel();if(!location||redirects===3)throw new Error('file_redirect_limit');raw=new URL(location,url).href;continue;
      }
      if(!response.ok||!response.body){await response.body?.cancel();throw new Error('file_download_failed');}
      if(Number(response.headers.get('content-length'))>MAX_OUTPUT_FILE_BYTES){await response.body.cancel();throw new Error('file_too_large');}
      const chunks:Buffer[]=[];let bytes=0;
      for await(const chunk of response.body){signal.throwIfAborted();bytes+=chunk.byteLength;if(bytes>MAX_OUTPUT_FILE_BYTES)throw new Error('file_too_large');chunks.push(Buffer.from(chunk));}
      return Buffer.concat(chunks);
    }
    throw new Error('file_redirect_limit');
  }
  async refs(roomId:string,ids:string[],allowedSourceIds:Set<string>,signal?:AbortSignal):Promise<AttachmentRef[]>{
    if(ids.length>4||new Set(ids).size!==ids.length)throw new Error('invalid_attachment_selection');
    const refs:AttachmentRef[]=[];
    for(const id of ids){const source=this.source(roomId,id);if(!allowedSourceIds.has(source.message.id))throw new Error('attachment_out_of_scope');const a=await this.download(roomId,id,signal);refs.push({sourceInputId:source.message.id,attachmentId:id,name:a.name!,bytes:a.bytes!,sha256:a.sha256!});}
    if(refs.reduce((n,r)=>n+r.bytes,0)>MAX_OUTPUT_FILE_TOTAL_BYTES)throw new Error('input_files_too_large');return refs;
  }
  async validateRefs(roomId:string,refs:AttachmentRef[],signal?:AbortSignal){
    for(const ref of refs){const source=this.source(roomId,ref.attachmentId);if(source.message.id!==ref.sourceInputId)throw new Error('attachment_out_of_scope');const a=await this.download(roomId,ref.attachmentId,signal);if(a.sha256!==ref.sha256||a.bytes!==ref.bytes)throw new Error('attachment_changed');}
  }
  validateCachedRefs(roomId:string,refs:AttachmentRef[]){
    for(const ref of refs){
      const source=this.source(roomId,ref.attachmentId),path=join(this.root,ref.attachmentId),entry=this.files.get(sha(path));
      if(source.message.id!==ref.sourceInputId||entry?.state!=='available'||entry.roomId!==roomId||entry.bytes!==ref.bytes||entry.sha256!==ref.sha256)throw new Error('attachment_unavailable');
      this.assertPath(path);const stat=lstatSync(path);
      if(!stat.isFile()||stat.nlink!==1||stat.size!==ref.bytes||sha(readFileSync(path))!==ref.sha256)throw new Error('attachment_changed');
    }
  }
  tool(request:WorkerRequest):ToolDefinition {
    const selected=request.scheduledInput?.attachmentRefs??request.inputs.flatMap(i=>[i.message,...i.contextMessages??[]]).flatMap(m=>m.attachments.filter(a=>a.kind==='file'&&a.attachmentId).map(a=>({attachmentId:a.attachmentId!,sourceInputId:m.id})));
    return {name:'input_file',description:'Read a selected input file by its host attachmentId. Downloads and verifies an immutable snapshot and returns a file path beneath this run, for artifact_read or parsing tools. Never executes files. Failure requires a new user upload. No arbitrary URL/path is accepted.',
      inputSchema:{type:'object',properties:{attachmentId:{type:'string'}},required:['attachmentId'],additionalProperties:false},
      execute:async(value,signal)=>{
        request.signal?.throwIfAborted();const args=value as {attachmentId?:string};
        if(!args||Object.keys(args).some(k=>k!=='attachmentId')||!selected.some(a=>a.attachmentId===args.attachmentId))throw new Error('attachment_out_of_scope');
        const combined=AbortSignal.any([...(signal?[signal]:[]),...(request.signal?[request.signal]:[])]),a=await this.download(request.thread.roomId,args.attachmentId!,combined);
        const path=join(request.workspace,'inputs',args.attachmentId!+'-'+a.name),existing=this.files.get(sha(path));
        if(!existing){const bytes=await readTaskFile(a.localFile!,this.root,a.bytes);combined.throwIfAborted();await this.write(path,bytes,{roomId:request.thread.roomId,threadId:request.thread.id,attachmentId:a.attachmentId,sourceInputId:a.sourceInputId},combined);}
        else if(existing.state!=='available')throw new Error('attachment_expired');
        return {attachmentId:a.attachmentId,name:a.name,bytes:a.bytes,sha256:a.sha256,root:'run',path:'inputs/'+args.attachmentId+'-'+a.name};
      }};
  }
  private protectedFiles():Set<string>{
    const ids=new Set<string>(),add=(value:any)=>{if(value?.attachmentId)ids.add(value.attachmentId);if(value?.artifactId)ids.add(value.artifactId);};
    for(const thread of ['queued','running','needs_input'].flatMap(status=>this.store.threadsInStatus(status as 'queued'|'running'|'needs_input'))){
      ids.add('thread:'+thread.id);for(const input of this.store.inputs(thread.id))for(const message of [input.message,...input.contextMessages??[]])message.attachments.forEach(add);
    }
    for(const row of this.store.db.prepare('SELECT data FROM schedules').all()){
      const s=JSON.parse(String(row.data));if(['active','paused','blocked'].includes(s.status)&&(!s.expiresAt||s.expiresAt>=Date.now())&&(s.maxRuns===undefined||s.triggerCount<s.maxRuns))s.attachmentRefs?.forEach(add);
    }
    for(const row of this.store.db.prepare("SELECT data FROM schedule_runs WHERE status IN ('queued','running')").all())JSON.parse(String(row.data)).snapshot?.attachmentRefs?.forEach(add);
    for(const row of this.store.db.prepare("SELECT data FROM schedule_commands WHERE status IN ('pending','proposed')").all()){
      const c=JSON.parse(String(row.data));if(!c.expiresAt||c.expiresAt>=Date.now())(c.mutation.input??c.mutation.patch)?.attachmentRefs?.forEach(add);
    }
    for(const row of this.store.outbox())if(['pending','sending'].includes(row.status)){row.message.files?.forEach(add);row.message.attachments?.forEach(add);}
    for(const result of this.store.results()){result.report.fileAttachments?.forEach(add);result.report.attachments?.forEach(add);}
    return ids;
  }
  async sweep(force=false){
    const now=Date.now();if(!force&&now-this.lastSweep<3600000)return;this.lastSweep=now;
    const ttl=(this.config.attachments?.retentionDays??7)*86400000;
    for(const entry of this.files.values()){
      if(this.busy.has(entry.id)||entry.state==='expired')continue;
      if(entry.state==='available'&&!existsSync(entry.path)){entry.state='expired';continue;}
      const protectedIds=this.protectedFiles();
      if(entry.state==='available'&&(protectedIds.has(entry.attachmentId??'')||protectedIds.has(entry.artifactId??'')||protectedIds.has('thread:'+entry.threadId))){delete entry.releasedAt;continue;}
      entry.releasedAt??=now;
      if(entry.state==='available'&&now-entry.releasedAt<ttl)continue;
      entry.state='deleting';this.save();
      this.assertPath(entry.path);if(entry.temporary){this.assertPath(entry.temporary);await fs.rm(entry.temporary,{force:true});}
      await fs.rm(entry.path,{force:true});entry.state='expired';
    }
    this.save();
  }
  async close(){await Promise.allSettled([...this.downloads.values()]);await this.web.close();}
}
