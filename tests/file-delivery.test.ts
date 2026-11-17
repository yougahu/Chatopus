import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { Coordinator } from '../src/coordinator.js';
import { Store } from '../src/store.js';
import { MemoryPublisher } from '../src/platform/memory.js';
import { parseReport } from '../src/protocol.js';
import type { GroupMessage, OutgoingFile, OutgoingMessage, RuntimePort, SendReceipt, WorkerRequest } from '../src/types.js';

const ROOM='qq:900:100';
const cleanup:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
class FilePublisher extends MemoryPublisher {
  uploads:Array<{roomId:string;file:OutgoingFile;key:string}>=[];
  order:string[]=[];
  onUpload:(file:OutgoingFile)=>Promise<SendReceipt>=async file=>({status:'sent',platformFileId:'qq-'+file.artifactId});
  override async send(message:OutgoingMessage,key:string){this.order.push('text:'+key);return super.send(message,key);}
  async uploadFile(roomId:string,file:OutgoingFile,key:string){this.uploads.push({roomId,file,key});this.order.push('file:'+file.name);return this.onUpload(file);}
}
function fixture(persistentRouter=false){
  const root=mkdtempSync(join(tmpdir(),'boe-file-delivery-'));
  const config=loadConfig(root,{stateDir:join(root,'state'),apiKey:'test',workerApiKey:'test',worker:{model:'test',provider:'boe-openai'},persistentRouter,routerBatchWindowMs:0,
    scheduledTasks:{enabled:true,scanIntervalMs:1},qq:{enabled:false,selfId:'900',accessToken:'',allowedGroupIds:['100'],host:'127.0.0.1',port:0}});
  const database=join(root,'state.sqlite');let store=new Store(database);
  const publisher=new FilePublisher();let selected:OutgoingFile[]=[];
  const runtime:RuntimePort={async route(request){return request.result?[{action:'publish_result',resultId:request.result.id}]:[{action:'open_thread',sourceMessageIds:request.messages.map(m=>m.id),subject:'Translate a document'}];},
    async runWorker(request:WorkerRequest){return {threadId:request.thread.id,runId:request.runId,coveredInputSeq:request.thread.latestInputSeq,basedOnRevision:request.thread.revision,status:'ready',shortAnswer:'翻译见附件。',assumptions:[],evidenceRefs:[],openQuestions:[],files:selected.map(f=>f.artifactId),fileAttachments:selected};},
    async steer(){},async cancel(){},async close(){}};
  let coordinator=new Coordinator(config,store,runtime,publisher,true);
  cleanup.push(async()=>{await coordinator.close();store.close();rmSync(root,{recursive:true,force:true});});
  const file=(name:string,content='# Translation\n\nHello.'):OutgoingFile=>{
    const path=join(config.stateDir,'workspaces','test','run','.reply-files',name);mkdirSync(join(path,'..'),{recursive:true});writeFileSync(path,content);
    return {kind:'file',artifactId:name,file:path,name,bytes:Buffer.byteLength(content),sha256:createHash('sha256').update(content).digest('hex')};
  };
  return {root,config,publisher,file,select(files:OutgoingFile[]){selected=files;},get store(){return store;},get coordinator(){return coordinator;},
    async restart(){await coordinator.close();store.close();store=new Store(database);coordinator=new Coordinator(config,store,runtime,publisher,true);store.recovery();},
    queue(files:OutgoingFile[],id='delivery'){store.enqueue({roomId:ROOM,text:'翻译见附件。',files},{id});},
    due(id='delivery'){const row=store.outbox().find(r=>r.id===id)!;row.dueAt=Date.now()-1;store.saveOutbox(row);},
    row(id='delivery'){return store.outbox().find(r=>r.id===id)!;}};
}
const message:GroupMessage={id:ROOM+':1',platform:'qq',roomId:ROOM,messageId:'1',authorId:'301',authorName:'Reader',text:'请翻译并生成 Markdown 文件上传群里',timestamp:Date.now(),mentions:['900'],attachments:[],isMentioned:true,isAdmin:false};

it.each([false,true])('delivers accepted Worker file reports through Router publication (persistent=%s)',async persistent=>{
  const f=fixture(persistent),file=f.file('translation.md');f.select([file]);await f.coordinator.receive(message);await f.coordinator.drain(1500);
  expect(f.publisher.uploads.map(u=>[u.roomId,u.file.name])).toEqual([[ROOM,'translation.md']]);
  expect(f.publisher.messages.at(-1)?.message).toMatchObject({roomId:ROOM,text:'翻译见附件。'});
  expect(f.publisher.messages.at(-1)?.message.files).toBeUndefined();
  const row=f.store.outbox('sent').find(r=>r.message.files?.length)!;
  expect(row.fileDeliveries?.[0]).toMatchObject({status:'sent',platformFileId:'qq-translation.md',attempts:1});
});
it('uploads every file before sending the result text',async()=>{
  const f=fixture();f.queue([f.file('translation.md'),f.file('data.csv','name,value\nA,1')]);await f.coordinator.tick();
  expect(f.publisher.order).toEqual(['file:translation.md','file:data.csv','text:delivery']);expect(f.row().status).toBe('sent');
});
it('preflights all files before any upload and does not publish a success reply on invalid bytes',async()=>{
  const f=fixture(),first=f.file('translation.md'),second=f.file('data.csv');writeFileSync(second.file,'changed');f.queue([first,second]);
  for(let i=0;i<3;i++){f.due();await f.coordinator.tick();}
  expect(f.publisher.uploads).toEqual([]);expect(f.row().status).toBe('failed');await f.coordinator.tick();
  expect(f.publisher.messages).toHaveLength(1);expect(f.publisher.messages[0].message.text).toContain('未能上传到群');expect(f.publisher.messages[0].message.text).not.toContain(f.root);
});
it('preserves confirmed uploads across a retry and process restart',async()=>{
  const f=fixture();f.queue([f.file('one.md'),f.file('two.md')]);let failed=false;
  f.publisher.onUpload=async file=>file.name==='two.md'&&!failed?(failed=true,{status:'failed',reason:'action_failed'}):{status:'sent',platformFileId:file.name};
  await f.coordinator.tick();expect(f.row().status).toBe('pending');expect(f.row().fileDeliveries?.map(x=>x.status)).toEqual(['sent','failed']);
  await f.restart();f.due();await f.coordinator.tick();
  expect(f.publisher.uploads.map(u=>u.file.name)).toEqual(['one.md','two.md','two.md']);expect(f.row().status).toBe('sent');
});
it('retries the text without reuploading confirmed files',async()=>{
  const f=fixture();f.queue([f.file('one.md')]);const send=f.publisher.send.bind(f.publisher);let fail=true;
  f.publisher.send=async(message,key)=>fail?(fail=false,{status:'failed',reason:'action_failed'}):send(message,key);
  await f.coordinator.tick();f.due();await f.coordinator.tick();expect(f.publisher.uploads).toHaveLength(1);expect(f.row().status).toBe('sent');
});
it('stops at an uncertain file and notifies without claiming success or retrying',async()=>{
  const f=fixture();f.queue([f.file('one.md'),f.file('two.md'),f.file('three.md')]);
  f.publisher.onUpload=async file=>file.name==='two.md'?{status:'unknown',reason:'timeout'}:{status:'sent',platformFileId:file.name};
  await f.coordinator.tick();await f.coordinator.tick();expect(f.row().status).toBe('unknown');
  expect(f.publisher.uploads.map(u=>u.file.name)).toEqual(['one.md','two.md']);expect(f.publisher.messages).toHaveLength(1);
  expect(f.publisher.messages[0].message.text).toContain('已确认上传 1 个文件');expect(f.publisher.messages[0].message.text).toContain('上传结果尚未确认');
  await f.coordinator.tick();expect(f.publisher.uploads).toHaveLength(2);
});
it('converts a crashed in-flight file to unknown and preserves prior receipts',async()=>{
  const f=fixture(),files=[f.file('one.md'),f.file('two.md')];f.queue(files);const row=f.row();row.status='sending';row.attempts=1;
  row.fileDeliveries=[{artifactId:files[0].artifactId,status:'sent',attempts:1,platformFileId:'first'},{artifactId:files[1].artifactId,status:'sending',attempts:1}];f.store.saveOutbox(row);
  await f.restart();expect(f.row().status).toBe('unknown');expect(f.row().fileDeliveries?.map(x=>x.status)).toEqual(['sent','unknown']);await f.coordinator.tick();expect(f.publisher.uploads).toHaveLength(0);
});
it('disconnection before transmission does not consume upload or row retry budgets',async()=>{
  const f=fixture();f.queue([f.file('one.md')]);f.publisher.onUpload=async()=>({status:'deferred',reason:'not_connected'});
  for(let i=0;i<4;i++){f.due();await f.coordinator.tick();}
  expect(f.row()).toMatchObject({status:'pending',attempts:0,fileDeliveries:[{status:'pending',attempts:0}]});expect(f.publisher.messages).toHaveLength(0);
});
it('cancellation after one file receipt suppresses remaining uploads and success text',async()=>{
  const f=fixture();const thread=f.store.createThread(message,'Translation',true);thread.status='idle';f.store.saveThread(thread);
  const files=[f.file('one.md'),f.file('two.md')];f.store.enqueue({roomId:ROOM,text:'translated',files},{id:'delivery',threadId:thread.id,revision:thread.revision,epoch:thread.epoch});
  f.publisher.onUpload=async()=>{const current=f.store.thread(thread.id)!;current.status='cancelled';current.epoch++;f.store.saveThread(current);return {status:'sent',platformFileId:'first'};};
  await f.coordinator.tick();expect(f.publisher.uploads).toHaveLength(1);expect(f.publisher.messages).toHaveLength(0);expect(f.row().status).toBe('stale');expect(f.row().fileDeliveries?.[0].status).toBe('sent');
});
it('scheduled Worker file delivery retains one parent delivery status',async()=>{
  const f=fixture();f.select([f.file('scheduled.md')]);const schedule=f.coordinator.scheduledTasks.service.create({kind:'admin'},{roomId:ROOM,title:'Daily document',executionKind:'worker',content:'Translate a document',scheduleSpec:{kind:'once',at:Date.now()+3600000}},'create');
  f.coordinator.scheduledTasks.service.command({kind:'admin'},schedule.id,'run_now',schedule.version,'now');await f.coordinator.drain(1500);
  const row=f.store.outbox('sent').find(r=>r.scheduleRunId)!;expect(row.message.files?.[0].name).toBe('scheduled.md');expect(row.fileDeliveries?.[0].status).toBe('sent');
  expect(f.coordinator.scheduledTasks.service.getRun(row.scheduleRunId!)?.deliveryStatus).toBe('sent');expect(f.publisher.uploads).toHaveLength(1);
});
it('never accepts file paths from model output',()=>{
  const report={threadId:'task',runId:'run',coveredInputSeq:1,basedOnRevision:1,status:'ready',shortAnswer:'ready',files:['file-current'],fileAttachments:[{file:'/private/secret'}]};
  expect(parseReport(JSON.stringify(report)).fileAttachments).toBeUndefined();
  expect(()=>parseReport(JSON.stringify({...report,files:['duplicate','duplicate']}))).toThrow();
});
it('blocks a scheduled plan on unknown upload and keeps its failure notice separate',async()=>{
  const f=fixture();f.select([f.file('scheduled.md')]);f.publisher.onUpload=async()=>({status:'unknown',reason:'upload_result_unknown'});
  const schedule=f.coordinator.scheduledTasks.service.create({kind:'admin'},{roomId:ROOM,title:'Document',executionKind:'worker',content:'Translate a document',scheduleSpec:{kind:'once',at:Date.now()+3600000}},'create');
  f.coordinator.scheduledTasks.service.command({kind:'admin'},schedule.id,'run_now',schedule.version,'now');await f.coordinator.drain(1500);
  const row=f.store.outbox('unknown').find(r=>r.scheduleRunId)!;expect(row.fileDeliveries?.[0].status).toBe('unknown');
  expect(f.coordinator.scheduledTasks.service.getRun(row.scheduleRunId!)?.deliveryStatus).toBe('unknown');
  expect(f.coordinator.scheduledTasks.service.get({kind:'admin'},schedule.id).status).toBe('blocked');
  expect(f.publisher.messages).toHaveLength(1);expect(f.publisher.messages[0].message.text).toContain('上传结果尚未确认');
});
it('refuses stale files before starting a platform action',async()=>{
  const f=fixture(),thread=f.store.createThread(message,'Translation',true);thread.status='idle';f.store.saveThread(thread);
  f.store.enqueue({roomId:ROOM,text:'obsolete',files:[f.file('old.md')]},{id:'delivery',threadId:thread.id,revision:thread.revision-1,epoch:thread.epoch});
  await f.coordinator.tick();expect(f.row().status).toBe('stale');expect(f.publisher.uploads).toHaveLength(0);expect(f.publisher.messages).toHaveLength(0);
});
it('does not silently drop files when a publisher has no upload capability',async()=>{
  const f=fixture();(f.publisher as any).uploadFile=undefined;f.queue([f.file('translation.md')]);
  for(let i=0;i<3;i++){f.due();await f.coordinator.tick();}
  expect(f.row()).toMatchObject({status:'failed',reason:'file_upload_unavailable'});await f.coordinator.tick();
  expect(f.publisher.messages[0].message.text).toContain('没有可用的群文件上传接口');
});
it('rejects excessive combined file bytes before attempting uploads',async()=>{
  const f=fixture(),first=f.file('one.md');f.queue([1,2,3].map(index=>({...first,artifactId:'file-'+index,name:index+'.md',bytes:8*1024*1024})));
  await f.coordinator.tick();expect(f.row().reason).toBe('invalid_output_file');expect(f.publisher.uploads).toHaveLength(0);expect(f.publisher.messages).toHaveLength(0);
});

it('pauses between confirmed files for an unresolved quote and resumes without reuploading',async()=>{
 const f=fixture();f.store.ingest(message);f.store.messageStatus(message.id,'routed');
 const thread=f.store.createThread(message,'Translation',true);thread.status='idle';f.store.saveThread(thread);
 const update={...message,id:ROOM+':2',messageId:'2',replyToMessageId:message.messageId,text:'请展示已经保存的交接内容'};
 f.store.enqueue({roomId:ROOM,text:'translated',files:[f.file('one.md'),f.file('two.md')]},{id:'delivery',threadId:thread.id,revision:thread.revision,epoch:thread.epoch});
 f.publisher.onUpload=async file=>{if(file.name==='one.md'){f.store.ingest(update);f.store.messageStatus(update.id,'processing');}return {status:'sent',platformFileId:file.name};};
 await f.coordinator.tick();
 expect(f.row()).toMatchObject({status:'pending',reason:'related_input_unresolved',attempts:0});
 expect(f.publisher.uploads.map(item=>item.file.name)).toEqual(['one.md']);expect(f.publisher.messages).toHaveLength(0);
 const events=f.store.db.prepare("SELECT data FROM telemetry WHERE kind='delivery_attempt_settled' ORDER BY id").all().map(row=>JSON.parse(String(row.data)));
 expect(events).toEqual(expect.arrayContaining([expect.objectContaining({status:'sent',part:'one.md'}),expect.objectContaining({status:'deferred',reason:'related_input_unresolved'})]));
 f.store.messageStatus(update.id,'routed');f.due();await f.coordinator.tick();
 expect(f.row().status).toBe('sent');expect(f.publisher.uploads.map(item=>item.file.name)).toEqual(['one.md','two.md']);expect(f.publisher.messages).toHaveLength(1);
});
