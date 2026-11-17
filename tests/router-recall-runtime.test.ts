import {afterEach,expect,it} from 'vitest';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {LlmAdapter,ToolCallId,type GenerateOptions,type StreamChunk} from '@deepseek-ai/dsh-llm';
import {NativeAgentRuntime} from '../src/runtime/native.js';
import {DshRuntime} from '../src/dsh-runtime.js';
import {loadConfig} from '../src/config.js';
import {Store} from '../src/store.js';
import {PersistentRouterManager} from '../src/runtime/persistent-router.js';
import {parseRoutesForRequest} from '../src/protocol.js';
import {Coordinator} from '../src/coordinator.js';
import {MemoryPublisher} from '../src/platform/memory.js';
import type {GroupMessage,RouterRequest,RuntimePort,WorkerRequest} from '../src/types.js';
const cleanup:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const fn of cleanup.splice(0).reverse())await fn();});
function message(id:string,text:string):GroupMessage{return{id,roomId:'room',messageId:id,authorId:'owner',authorName:'owner',platform:'replay',text,timestamp:1,mentions:[],attachments:[],isMentioned:true,isAdmin:false};}
it('runs read-only recall through dsh, preserves recalled IDs through format repair and transfers no historical source',async()=>{
 const root=await mkdtemp(join(tmpdir(),'router-recall-runtime-'));cleanup.push(()=>rm(root,{recursive:true,force:true}));
 await mkdir(join(root,'personas'));await writeFile(join(root,'personas/default.md'),'# test\n回答当前问题');
 const store=new Store(':memory:');cleanup.push(async()=>store.close());
 const original=message('old','原始预算10元');store.ingest(original);const thread=store.createThread(original,'预算',true);
 const current=message('current','继续原先任务');store.ingest(current);
 let calls=0;
 class Adapter extends LlmAdapter{
  async *stream(request:GenerateOptions):AsyncIterable<StreamChunk>{
   calls++;
   if(calls===1){
    expect(request.tools?.map(t=>t.name)).toEqual(['router_context']);
    yield {type:'block-start',index:0,blockType:'tool-call'};
    yield {type:'block-end',index:0,block:{type:'tool-call',id:ToolCallId('lookup'),name:'router_context',arguments:JSON.stringify({kind:'threads',id:thread.id})}};
    yield {type:'finish',reason:{kind:'tool-calls'}};return;
   }
   if(calls===2)expect(JSON.stringify(request.messages)).toContain(thread.id);
   if(calls===3){
    const last=request.messages.filter(m=>m.role==='user').at(-1)!;
    const payload=JSON.parse(last.content.filter(b=>b.type==='text').map(b=>b.text).join(''));
    expect(payload.messages.map((m:GroupMessage)=>m.id)).toEqual(['current']);expect(payload.recalledContext.threads[0].id).toBe(thread.id);
   }
   const text=calls===2?'bad json':JSON.stringify([{action:'append_thread',sourceMessageIds:['current'],threadId:thread.id}]);
   yield {type:'block-start',index:0,blockType:'text'};yield {type:'text-delta',index:0,text};yield {type:'block-end',index:0,block:{type:'text',text}};yield {type:'finish',reason:{kind:'stop'}};
  }
 }
 const config=loadConfig(root,{stateDir:join(root,'state'),router:{provider:'mock',model:'router'}});
 const native=await NativeAgentRuntime.create({root:join(root,'native'),adapters:{mock:new Adapter()}});
 const runtime=await DshRuntime.create(config,{native});cleanup.push(()=>runtime.close());
 const req:RouterRequest={roomId:'room',event:'messages',messages:[current],recentMessages:[],threads:[]};
 expect(await runtime.route(req,store.routerContextReader('room','current'))).toEqual([{action:'append_thread',sourceMessageIds:['current'],threadId:thread.id}]);
 expect(calls).toBe(3);
});

it('repairs unread evidence and a forbidden image reference in one persistent session without losing current input',async()=>{
 const root=await mkdtemp(join(tmpdir(),'router-validation-repair-'));cleanup.push(()=>rm(root,{recursive:true,force:true}));
 const store=new Store(':memory:');cleanup.push(async()=>store.close());
 const original=message('original','Background condition. '.repeat(65)+'Final correction: budget is 20.');
 store.ingest(original);const thread=store.createThread(original,'Document analysis',true);
 thread.status='idle';store.saveThread(thread);store.messageStatus(original.id,'filtered');
 const picture={...message('foreign-picture','Another participant’s diagram'),authorId:'other',attachments:[{kind:'image' as const,url:'https://example.invalid/diagram.png'}]};store.ingest(picture);
 store.messageStatus(picture.id,'filtered');
 const current=message('current','Continue the document analysis using the corrected budget.');
 const action={action:'append_thread' as const,sourceMessageIds:[current.id],threadId:thread.id,kind:'supplement' as const,resolvedRequest:current.text};
 let calls=0;const phases:string[]=[];
 class Adapter extends LlmAdapter{
  async *stream(request:GenerateOptions):AsyncIterable<StreamChunk>{
   calls++;
   const last=request.messages.filter(m=>m.role==='user').at(-1)!;
   const payload=JSON.parse(last.content.filter(b=>b.type==='text').map(b=>b.text).join(''));
   expect(payload.messages).toMatchObject([{id:current.id,authorId:'owner',text:current.text}]);
   if(calls===3){expect(payload.repair.validationError).toContain('unread');expect(JSON.stringify(request.messages)).toContain('Background condition.');}
   if(calls===5){expect(payload.repair.validationError).toContain('Image context');expect(JSON.stringify(request.messages)).toContain('Final correction: budget is 20.');}
   if(calls===1||calls===3){
    yield {type:'block-start',index:0,blockType:'tool-call'};
    yield {type:'block-end',index:0,block:{type:'tool-call',id:ToolCallId('read-'+calls),name:'router_context',arguments:JSON.stringify({kind:'task_inputs',id:thread.id,textOffset:calls===1?0:1200})}};
    yield {type:'finish',reason:{kind:'tool-calls'}};return;
   }
   const text=JSON.stringify([{...action,...(calls===4?{contextMessageIds:[picture.id]}:{})}]);
   yield {type:'block-start',index:0,blockType:'text'};yield {type:'text-delta',index:0,text};yield {type:'block-end',index:0,block:{type:'text',text}};yield {type:'finish',reason:{kind:'stop'}};
  }
 }
 const config=loadConfig(root,{stateDir:join(root,'state'),persistentRouter:true,routerBatchWindowMs:0,router:{provider:'mock',model:'router'}});
 const native=await NativeAgentRuntime.create({root:join(root,'native'),adapters:{mock:new Adapter()}});
 const runtime=await DshRuntime.create(config,{native,onMetrics:event=>phases.push(event.phase??'initial')});cleanup.push(()=>runtime.close());
 const workers:WorkerRequest[]=[],publisher=new MemoryPublisher();
 const port:RuntimePort={route:(request,read,execution)=>request.result?Promise.resolve([{action:'publish_result',resultId:request.result.id}]):runtime.route(request,read,execution),
  async runWorker(request){workers.push(request);return {threadId:request.thread.id,runId:request.runId,coveredInputSeq:request.thread.latestInputSeq,basedOnRevision:request.thread.revision,status:'ready',shortAnswer:'Document checked with budget 20.',assumptions:[],evidenceRefs:[],openQuestions:[]};},
  async steer(){},async cancel(){},close:()=>runtime.close()};
 const coordinator=new Coordinator(config,store,port,publisher);cleanup.push(()=>coordinator.close());
 await coordinator.receive(current);await coordinator.drain(3000);
 expect(calls).toBe(5);expect(phases).toEqual(['initial','repair','repair']);
 const turn=store.routerSessions.turns('room').find(turn=>turn.trigger.kind==='messages')!;
 expect(turn).toMatchObject({state:'committed',attempts:1,rebuilds:0,modelCalls:5});
 expect(turn.actions).toEqual([action]);expect(workers).toHaveLength(1);
 expect(workers[0].inputs.at(-1)).toMatchObject({message:current,routingContext:{resolvedRequest:current.text,sourceMessageIds:[current.id]}});
 expect(workers[0].inputs.at(-1)?.contextMessages??[]).toEqual([]);
 expect(publisher.messages.filter(row=>row.message.text==='Document checked with budget 20.')).toHaveLength(1);
 expect(store.db.prepare('SELECT status FROM messages WHERE id=?').get(current.id)?.status).toBe('routed');
 expect(()=>parseRoutesForRequest(JSON.stringify([{...action,contextMessageIds:[picture.id]}]),{...(turn.request as RouterRequest),recentMessages:[picture]})).toThrow('Image context');
});

it.each([
 {name:'read-only tools',recall:true,reads:0,limit:12,calls:3,code:'STRUCTURED_OUTPUT_INVALID'},
 {name:'no tools',recall:false,reads:0,limit:12,calls:2,code:'STRUCTURED_OUTPUT_INVALID'},
 {name:'durable call limit',recall:true,reads:0,limit:2,calls:2,code:'ROUTER_CALL_LIMIT'},
 {name:'shared native step limit',recall:true,reads:4,limit:12,calls:6,code:'STEP_LIMIT'},
])('bounds persistent validation repairs with $name',async scenario=>{
 const root=await mkdtemp(join(tmpdir(),'router-validation-bound-'));cleanup.push(()=>rm(root,{recursive:true,force:true}));
 const store=new Store(':memory:');cleanup.push(async()=>store.close());const current=message('current','Analyze this document.');store.ingest(current);
 let calls=0;
 class Adapter extends LlmAdapter{async *stream():AsyncIterable<StreamChunk>{
  calls++;
  if(calls<=scenario.reads){yield {type:'block-start',index:0,blockType:'tool-call'};yield {type:'block-end',index:0,block:{type:'tool-call',id:ToolCallId('read-'+calls),name:'router_context',arguments:JSON.stringify({kind:'messages'})}};yield {type:'finish',reason:{kind:'tool-calls'}};return;}
  yield {type:'block-start',index:0,blockType:'text'};yield {type:'text-delta',index:0,text:'invalid json'};yield {type:'block-end',index:0,block:{type:'text',text:'invalid json'}};yield {type:'finish',reason:{kind:'stop'}};
 }}
 const config=loadConfig(root,{stateDir:join(root,'state'),router:{provider:'mock',model:'router'}});
 const native=await NativeAgentRuntime.create({root:join(root,'native'),adapters:{mock:new Adapter()}});
 const runtime=await DshRuntime.create(config,{native});cleanup.push(()=>runtime.close());
 const manager=new PersistentRouterManager(store.routerSessions),prepared=await manager.prepare({roomId:'room',event:'messages',messages:[current],recentMessages:[],threads:[]},'test-config',50_000);manager.startAttempt(prepared);
 await expect(runtime.route(prepared.request,scenario.recall?async()=>({hasMore:false}):undefined,{signal:AbortSignal.timeout(10_000),consumeModelCall:summary=>store.routerSessions.consumeModelCall(prepared.turn.id,summary,scenario.limit)})).rejects.toMatchObject({code:scenario.code});
 expect(calls).toBe(scenario.calls);expect(store.routerSessions.turn(prepared.turn.id)?.modelCalls).toBe(scenario.calls);
});
