import {afterEach,expect,it,vi} from 'vitest';
import {mkdtempSync,rmSync,mkdirSync,writeFileSync,readFileSync,symlinkSync,existsSync,chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadConfig} from '../src/config.js';
import {ScheduledTaskService} from '../src/scheduled-tasks/service.js';
import {Store} from '../src/store.js';
import {PrivateChatAccess} from '../src/private-chat.js';
import {AttachmentService,prepareFileMetadata} from '../src/attachments.js';
import type {Attachment,GroupMessage,WorkerRequest} from '../src/types.js';
const room='qq:900:private:901',clean:Array<()=>unknown>=[];
afterEach(async()=>{vi.restoreAllMocks();for(const close of clean.splice(0).reverse())await close();});
function fixture(fetchFile?:(a:Attachment,room:string,signal:AbortSignal)=>Promise<Buffer>){
 const root=mkdtempSync(join(tmpdir(),'chatopus-files-'));clean.push(()=>rmSync(root,{recursive:true,force:true}));
 const config=loadConfig(root,{stateDir:join(root,'state'),attachments:{retentionDays:7,maxStorageBytes:20*1024**2,minFreeDiskBytes:0}});
 const store=new Store(':memory:');new ScheduledTaskService(store.db);store.privateAccess=new PrivateChatAccess('900',{enabled:true,allowedUserIds:['901','902']});
 const files=new AttachmentService(config,store,fetchFile);clean.push(async()=>{await files.close();store.close();});
 function input(id='1',attachments:Attachment[]=[{kind:'file',name:'notes.txt',bytes:3}]){
  const message=prepareFileMetadata({id:room+':'+id,platform:'qq',roomId:room,messageId:id,authorId:'901',authorName:'Member',text:'read selected file',timestamp:Date.now(),mentions:[],isAdmin:false,isMentioned:false,attachments} satisfies GroupMessage);
  store.ingest(message);return message;
 }
 return {root,config,store,files,input};
}
it('isolates source IDs and immutable same-name uploads by room and message',async()=>{
 const f=fixture(async()=>Buffer.from('abc')),a=f.input(),b=f.input('2');
 expect(a.attachments[0].attachmentId).not.toBe(b.attachments[0].attachmentId);
 const id=a.attachments[0].attachmentId!,download=await f.files.download(room,id);
 expect(download.sha256).toHaveLength(64);expect(download.bytes).toBe(3);
 await expect(f.files.download('qq:900:private:902',id)).rejects.toThrow('attachment_not_found');
 await expect(f.files.refs(room,[id],new Set([b.id]))).rejects.toThrow('attachment_out_of_scope');
 expect(await f.files.refs(room,[id],new Set([a.id]))).toEqual([expect.objectContaining({sourceInputId:a.id,sha256:download.sha256})]);
 chmodSync(download.localFile!,0o600);writeFileSync(download.localFile!,'xyz');await expect(f.files.download(room,id)).rejects.toThrow('attachment_changed');
});
it('rejects unsafe names, oversized metadata, too many files and oversized actual bytes',async()=>{
 let calls=0;const f=fixture(async()=>{calls++;return Buffer.alloc(10*1024**2+1);});
 for(const name of ['../secret','a/b','x\\y']){const m=f.input(name,[{kind:'file',name}]);await expect(f.files.download(room,m.attachments[0].attachmentId!)).rejects.toThrow();}
 const many=f.input('many',Array.from({length:5},()=>({kind:'file' as const,name:'a'})));expect(many.attachments.every(a=>!!a.downloadError)).toBe(true);
 const big=f.input('big',[{kind:'file',name:'a',bytes:10*1024**2+1}]);expect(big.attachments[0].downloadError).toBeTruthy();
 const good=f.input();await expect(f.files.download(room,good.attachments[0].attachmentId!)).rejects.toThrow('file_too_large');expect(calls).toBe(1);
 await expect(f.files.download(room,good.attachments[0].attachmentId!)).rejects.toThrow('file_too_large');expect(calls).toBe(1);
});
it('does not attach late download bytes after revocation and regrant',async()=>{
 let release!:(b:Buffer)=>void;const f=fixture(()=>new Promise(r=>release=r)),m=f.input();
 const job=f.files.download(room,m.attachments[0].attachmentId!);const rejected=expect(job).rejects.toThrow();
 f.store.privateAccess!.apply({enabled:false},[room],()=>{});f.store.privateAccess!.apply({enabled:true,allowedUserIds:['901']},[],()=>{});release(Buffer.from('abc'));await rejected;
 expect(f.store.message(m.id)!.attachments[0].localFile).toBeUndefined();
 expect(JSON.parse(readFileSync(join(f.config.stateDir,'attachments/manifest.json'),'utf8')).every((x:any)=>x.state==='expired')).toBe(true);
});
it('reserves bytes across simultaneous downloads and releases failed reservations',async()=>{
 const releases:Array<(b:Buffer)=>void>=[],f=fixture(()=>new Promise(r=>releases.push(r)));
 const ids=['1','2','3'].map(id=>f.input(id).attachments[0].attachmentId!);
 const first=f.files.download(room,ids[0]),second=f.files.download(room,ids[1]);await expect(f.files.download(room,ids[2])).rejects.toThrow('attachment_storage_full');
 releases.forEach(r=>r(Buffer.from('abc')));await Promise.all([first,second]);
 const third=f.files.download(room,ids[2]);releases.at(-1)!(Buffer.from('abc'));expect((await third).bytes).toBe(3);
});
it('rejects worker directory symlinks before writing outside managed roots',async()=>{
 const f=fixture(),external=join(f.root,'outside'),run=join(f.config.stateDir,'workspaces/run');mkdirSync(external);mkdirSync(run,{recursive:true});symlinkSync(external,join(run,'inputs'));
 await expect(f.files.write(join(run,'inputs/stolen'),Buffer.from('abc'),{roomId:room})).rejects.toThrow('attachment_symlink');expect(existsSync(join(external,'stolen'))).toBe(false);
});
it('protects task references and starts retention only after the last reference releases',async()=>{
 const f=fixture(async()=>Buffer.from('abc')),m=f.input(),a=await f.files.download(room,m.attachments[0].attachmentId!);
 const t=f.store.createThread(m,'read file',true),time=Date.now(),clock=vi.spyOn(Date,'now');
 clock.mockReturnValue(time+20*86400000);await f.files.sweep(true);expect(existsSync(a.localFile!)).toBe(true);
 t.status='idle';f.store.saveThread(t);await f.files.sweep(true);
 clock.mockReturnValue(time+26*86400000);await f.files.download(room,a.attachmentId!);await f.files.sweep(true);expect(existsSync(a.localFile!)).toBe(true);
 clock.mockReturnValue(time+28*86400000);await f.files.sweep(true);expect(existsSync(a.localFile!)).toBe(false);await expect(f.files.download(room,a.attachmentId!)).rejects.toThrow('attachment_expired');
});
it('exposes only selected attachment IDs to the worker and copies verified bytes into its run',async()=>{
 const f=fixture(async()=>Buffer.from('abc')),m=f.input(),other=f.input('2'),thread=f.store.createThread(m,'read',true),workspace=join(f.config.stateDir,'workspaces',thread.id,'run');mkdirSync(workspace,{recursive:true});
 const tool=f.files.tool({thread,workspace,runId:'run',inputs:f.store.inputs(thread.id)} as WorkerRequest);
 await expect(tool.execute({attachmentId:other.attachments[0].attachmentId})).rejects.toThrow('attachment_out_of_scope');
 const result=await tool.execute({attachmentId:m.attachments[0].attachmentId}) as any;
 expect(result.root).toBe('run');expect(readFileSync(join(workspace,result.path),'utf8')).toBe('abc');
 await expect(tool.execute({attachmentId:m.attachments[0].attachmentId,path:'/etc/passwd'})).rejects.toThrow('attachment_out_of_scope');
});
it('refuses untrusted URL origins and private addresses before a request',async()=>{
 const f=fixture();
 for(const url of ['https://127.0.0.1/secret','https://example.com/a','file:///tmp/a','https://qq.com@127.0.0.1/a']){
  const m=f.input(url,[{kind:'file',name:'a',url}]);await expect(f.files.download(room,m.attachments[0].attachmentId!)).rejects.toThrow();
 }
});
