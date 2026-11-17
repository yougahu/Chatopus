import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LlmAdapter, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { NativeAgentRuntime } from '../src/runtime/native.js';
import { DshRuntime } from '../src/dsh-runtime.js';
import { Store } from '../src/store.js';
import { Coordinator } from '../src/coordinator.js';
import { loadConfig } from '../src/config.js';
import { MemoryPublisher } from '../src/platform/memory.js';
import type { GroupMessage } from '../src/types.js';
const cleanup:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const fn of cleanup.splice(0).reverse())await fn();});
function message(id:string,text=id):GroupMessage{return {id:'room:'+id,roomId:'room',messageId:id,platform:'replay',authorId:'owner',authorName:'Owner',text,timestamp:Date.now(),mentions:[],attachments:[],isMentioned:true,isAdmin:false};}
const response=(text:string):StreamChunk[]=>[{type:'text-delta',index:0,text},{type:'usage',usage:{inputTokens:40,outputTokens:10}},{type:'finish',reason:{kind:'stop'}}];
class Adapter extends LlmAdapter{
  calls:GenerateOptions[]=[];invalidOnce=false;invalidResponses=0;recallIncomplete=false;late=false;lateMs=100;hold?:Promise<void>;
  override async resolveModel(provider:string,model:string){return {provider,id:model,name:model,context:{contextWindow:64_000},defaultMaxTokens:4096};}
  async *stream(request:GenerateOptions):AsyncIterable<StreamChunk>{
    this.calls.push(request);
    if(this.hold)await this.hold;
    if(this.invalidOnce||this.invalidResponses>0){this.invalidOnce=false;this.invalidResponses=Math.max(0,this.invalidResponses-1);yield*response(JSON.stringify([{action:'reply_direct',sourceMessageIds:['historical-unowned-id'],text:'invalid candidate'}]));return;}
    if(this.recallIncomplete&&!request.messages.some(message=>message.role==='tool')){
      yield {type:'block-end',index:0,block:{type:'tool-call',id:ToolCallId('recall-'+this.calls.length),name:'router_context',arguments:JSON.stringify({kind:'messages',id:'room:history'})}};
      yield {type:'finish',reason:{kind:'tool-calls'}};return;
    }
    if(request.purpose==='compaction'){yield*response('uncommittable partial').slice(0,-1);yield {type:'finish',reason:{kind:'max-tokens'}};return;}
    if(this.late)await new Promise(resolve=>setTimeout(resolve,this.lateMs));
    const data=request.messages.filter(m=>m.role==='user').flatMap(m=>m.content.flatMap(b=>b.type==='text'?[b.text]:[])).map(text=>{try{return JSON.parse(text);}catch{return undefined;}}).findLast(v=>v?.event==='messages');
    yield*response(JSON.stringify([{action:'reply_direct',sourceMessageIds:data.messages.map((m:GroupMessage)=>m.id),text:'已处理'}]));
  }
}
async function fixture(timeout=2000,compaction=true){
  const root=mkdtempSync(join(tmpdir(),'boe-context-recovery-')),adapter=new Adapter(),store=new Store(join(root,'state.sqlite'));
  const config=loadConfig(root,{stateDir:root,apiKey:'',router:{provider:'mock',model:'router'},persistentRouter:true,routerBatchWindowMs:0,routerTurnTimeoutMs:timeout});
  const native=await NativeAgentRuntime.create({root:join(root,'dsh'),adapters:{mock:adapter},compactionRole:'router',compaction:compaction?{thresholdRatio:.015,headroomTokens:1024,retainTokens:0,maxTokens:1024,compactionRetries:0}:false});
  const runtime=await DshRuntime.create(config,{native}),publisher=new MemoryPublisher(),coordinator=new Coordinator(config,store,runtime,publisher);
  cleanup.push(async()=>{await coordinator.close();store.close();rmSync(root,{recursive:true,force:true});});
  return {store,adapter,publisher,coordinator};
}
it('rebuilds after two truncated official summaries, records their usage, and commits the original input once',async()=>{
  const f=await fixture();await f.coordinator.receive(message('first','背景原文。'.repeat(500)));
  await f.coordinator.receive(message('next','更正为预算五元'));
  const turns=f.store.routerSessions.turns('room'),second=turns[1];
  expect(second).toMatchObject({state:'committed',attempts:2,rebuilds:1,summaryCalls:2,modelCalls:3});
  expect(f.adapter.calls.filter(call=>call.purpose==='compaction')).toHaveLength(2);
  const costs=f.store.db.prepare("SELECT data FROM telemetry WHERE kind='router_model_call'").all().map(row=>JSON.parse(String(row.data)));
  expect(costs.filter(row=>row.purpose==='compaction')).toEqual(expect.arrayContaining([expect.objectContaining({code:'max-tokens',inputTokens:40,outputTokens:10})]));
  expect(f.publisher.messages.map(m=>m.dedupeKey)).toHaveLength(2);expect(new Set(f.publisher.messages.map(m=>m.dedupeKey)).size).toBe(2);
  expect(f.store.routerSessions.pendingTurns()).toEqual([]);
});
it('fences late output after the shared deadline and fast-fails subsequent requests during provider recovery',async()=>{
  // Allow setup under full-suite load: this case must expire inside the model
  // request, not before it starts, to exercise provider circuit recovery.
  const f=await fixture(1000);f.adapter.late=true;f.adapter.lateMs=1500;
  await f.coordinator.receive(message('slow'));
  expect(f.adapter.calls).toHaveLength(1);
  expect(f.store.routerSessions.turns('room')[0].state).toBe('failed');expect(f.publisher.messages.some(m=>m.message.text==='已处理')).toBe(false);
  const calls=f.adapter.calls.length;await f.coordinator.receive(message('next'));expect(f.adapter.calls).toHaveLength(calls);
  expect(f.store.routerSessions.pendingTurns()).toEqual([]);expect(f.store.routerSessions.turns('room').every(turn=>turn.state==='failed')).toBe(true);
});
it('expires queued requests from durable receive time before spending model calls',async()=>{
  const f=await fixture(),old=message('expired');f.store.ingest(old,Date.now()-300_000);
  await f.coordinator.start();expect(f.adapter.calls).toHaveLength(0);expect(f.store.routerSessions.turns('room')[0].state).toBe('failed');expect(f.store.pendingMessages()).toEqual([]);
});
it('releases the room queue while a provider ignores cancellation, then fences its eventual response',async()=>{
  const f=await fixture(400);let release!:()=>void;
  f.adapter.hold=new Promise<void>(resolve=>{release=resolve;});
  try{
    await f.coordinator.receive(message('blocked'));
    expect(f.adapter.calls).toHaveLength(1);expect(f.store.routerSessions.turns('room')[0].state).toBe('failed');
    // Simulate cooldown expiry without completing the held physical request.
    f.store.db.prepare('UPDATE router_provider_health SET retry_at=0,probe_turn=NULL').run();
    f.adapter.hold=undefined;
    await f.coordinator.receive(message('recovered'));
    expect(f.store.routerSessions.turns('room')[1]).toMatchObject({state:'committed',rebuilds:0});
    expect(f.adapter.calls).toHaveLength(2);expect(f.adapter.calls[1].sessionId).not.toBe(f.adapter.calls[0].sessionId);
    expect(f.publisher.messages.filter(row=>row.message.text==='已处理')).toHaveLength(1);
  }finally{release();}
  await new Promise(resolve=>setTimeout(resolve,30));
  expect(f.store.routerSessions.turns('room').map(turn=>turn.state)).toEqual(['failed','committed']);
  expect(f.publisher.messages.filter(row=>row.message.text==='已处理')).toHaveLength(1);
});

it('carries validation diagnostics across persistent rebuild after bounded corrections while keeping the original action scope',async()=>{
 const f=await fixture(2000,false);f.adapter.invalidResponses=3;
 await f.coordinator.receive(message('repair-current','本轮只处理这条消息'));
 const turn=f.store.routerSessions.turns('room')[0];expect(turn).toMatchObject({state:'committed',attempts:2,rebuilds:1});
 expect(f.adapter.calls).toHaveLength(4);
 const serialized=JSON.stringify(f.adapter.calls[3].messages);
 expect(serialized).toContain('historical-unowned-id');expect(serialized).toContain('validationError');expect(serialized).toContain('room:repair-current');
 expect(f.publisher.messages.map(item=>item.message.text)).toEqual(['已处理']);
});

it('corrects a validation failure in the refreshed configuration session and publishes exactly once',async()=>{
 const f=await fixture(2000,false);f.store.routerSessions.ensureSession({roomId:'room',sessionId:'prior-session',configHash:'prior-config'});
 f.adapter.invalidOnce=true;await f.coordinator.receive(message('after-update'));
 expect(f.store.routerSessions.turns('room')[0]).toMatchObject({state:'committed',attempts:1,rebuilds:0,modelCalls:2});
 expect(f.store.routerSessions.session('room')?.generation).toBe(2);
 expect(f.adapter.calls[1].sessionId).toBe(f.adapter.calls[0].sessionId);
 expect(f.adapter.calls).toHaveLength(2);expect(f.publisher.messages.map(item=>item.message.text)).toEqual(['已处理']);
});

it('preserves unread-evidence cause through runtime wrapping, recovery and terminal accounting',async()=>{
 const f=await fixture(2000,false),old=message('history','condition '.repeat(150));f.store.ingest(old);f.store.messageStatus(old.id,'routed');
 f.adapter.recallIncomplete=true;await f.coordinator.receive(message('current'));
 const turn=f.store.routerSessions.turns('room')[0];
 expect(turn).toMatchObject({state:'failed',attempts:2,rebuilds:1,error:{code:'STRUCTURED_OUTPUT_INVALID',rootCode:'ROUTER_EVIDENCE_UNREAD',history:[
  {code:'STRUCTURED_OUTPUT_INVALID',causeCode:'ROUTER_EVIDENCE_UNREAD',stage:'attempt'},
  {code:'ROUTER_REBUILD',stage:'rebuild'},
  {code:'STRUCTURED_OUTPUT_INVALID',causeCode:'ROUTER_EVIDENCE_UNREAD',stage:'attempt'},
  {code:'STRUCTURED_OUTPUT_INVALID',stage:'terminal'},
 ]}});
 const attempts=f.store.db.prepare("SELECT data FROM telemetry WHERE kind='router_attempt'").all().map(row=>JSON.parse(JSON.parse(String(row.data)).error));
 expect(attempts).toHaveLength(2);expect(attempts.every(item=>item.causeCode==='ROUTER_EVIDENCE_UNREAD')).toBe(true);
 const lifecycle=f.store.db.prepare("SELECT data FROM telemetry WHERE kind='router_context_lifecycle'").all().map(row=>JSON.parse(String(row.data)));
 expect(lifecycle).toContainEqual(expect.objectContaining({kind:'recovery_rebuild',code:'STRUCTURED_OUTPUT_INVALID',turnId:turn.id}));
 expect(f.publisher.messages).toHaveLength(1);expect(f.publisher.messages[0].message.text).toContain('暂时没能处理');
});

it('retains the inference cause when recovery preparation fails before a second model attempt',async()=>{
 const f=await fixture(2000,false),old=message('history','condition '.repeat(150));f.store.ingest(old);f.store.messageStatus(old.id,'routed');
 f.adapter.recallIncomplete=true;
 f.store.routerSessions.consumeRebuild=()=>{throw Object.assign(new Error('Recovery unavailable'),{code:'ROUTER_REBUILD_LIMIT'});};
 await f.coordinator.receive(message('current'));
 expect(f.store.routerSessions.turns('room')[0]).toMatchObject({state:'failed',attempts:1,modelCalls:4,error:{
  code:'ROUTER_REBUILD_LIMIT',rootCode:'ROUTER_EVIDENCE_UNREAD',history:[
   {code:'STRUCTURED_OUTPUT_INVALID',causeCode:'ROUTER_EVIDENCE_UNREAD',stage:'attempt'},
   {code:'ROUTER_REBUILD_LIMIT',stage:'terminal'},
  ],
 }});
 expect(f.publisher.messages).toHaveLength(1);expect(f.store.routerSessions.pendingTurns()).toEqual([]);
});
