import {afterEach,describe,expect,it} from 'vitest';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {LlmAdapter,ToolCallId,type GenerateOptions,type LlmResolvedModelInfo,type StreamChunk} from '@deepseek-ai/dsh-llm';
import {loadConfig} from '../src/config.js';
import {Coordinator} from '../src/coordinator.js';
import {DshRuntime} from '../src/dsh-runtime.js';
import {NativeAgentRuntime} from '../src/runtime/native.js';
import {Store} from '../src/store.js';
import {MemoryPublisher} from '../src/platform/memory.js';
import {attachRoomMemory} from '../src/router-context-builder.js';
import type {MemoryBudget,MemorySummaryInput} from '../src/room-memory-worker.js';
import type {MemoryNote} from '../src/room-memory-store.js';
import type {GroupMessage,RouteAction,RouterRequest,RuntimePort,WorkerReport} from '../src/types.js';

const cleanup:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const fn of cleanup.splice(0).reverse())await fn();});
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(done=>resolve=done);return{promise,resolve};}
function message(id:string,text:string,authorId='A',roomId='room'):GroupMessage{return{id:roomId+':'+id,roomId,messageId:id,platform:'replay',authorId,authorName:authorId,text,timestamp:Date.now(),mentions:[],attachments:[],isMentioned:true,isAdmin:false};}
async function bounded<T>(promise:Promise<T>):Promise<T>{
 let timer:ReturnType<typeof setTimeout>|undefined;
 try{return await Promise.race([promise,new Promise<never>((_,reject)=>timer=setTimeout(()=>reject(new Error('Foreground waited for blocked background work')),1000))]);}
 finally{if(timer)clearTimeout(timer);}
}
async function until(check:()=>boolean){for(let i=0;i<200;i++){if(check())return;await new Promise(resolve=>setTimeout(resolve,5));}throw new Error('Background checkpoint did not settle');}
function allCovered(store:Store,roomId='room'){return(store.roomMemory.head(roomId).version?.coveredSeq??0)>=store.roomMemory.latestSeq(roomId);}
/** Deterministic extraction keeps the test about durable context/lifecycle,
 * rather than treating a model's semantic self-evaluation as evidence. */
function budgetNotes(input:MemorySummaryInput):MemoryNote[]{
 let notes=structuredClone(input.previousNotes);
 for(const event of input.events){
  if(event.kind!=='message'||!event.authorId)continue;
  const value=event.text.match(/BUDGET=(\d+元);KEEP=([^;\s]+)/);if(!value)continue;
  const previous=notes.filter(note=>note.authorId===event.authorId),id='budget-'+event.authorId+'-'+event.seq;
  notes=notes.filter(note=>note.authorId!==event.authorId);
  notes.push({id,authorId:event.authorId,text:'BUDGET='+value[1]+';KEEP='+value[2],sourceSeqs:[event.seq],...(previous.length?{supersedes:previous.map(note=>note.id)}:{})});
 }
 return notes;
}
class MemoryRuntime implements RuntimePort {
 readonly routes:RouterRequest[]=[];readonly summaries:MemorySummaryInput[]=[];closed=false;
 constructor(readonly summarize=(input:MemorySummaryInput,_signal:AbortSignal):Promise<MemoryNote[]>=>Promise.resolve(budgetNotes(input))){}
 async route(input:RouterRequest):Promise<RouteAction[]>{this.routes.push(structuredClone(input));return[{action:'reply_direct',sourceMessageIds:input.messages.map(m=>m.id),text:'已记住本次条件。'}];}
 async routerContextBudget(){return 65_536;}
 async roomMemoryBudget():Promise<MemoryBudget>{return{inputBudgetBytes:65_536,outputTokens:2048,maxOutputTokens:8192};}
 async summarizeRoomMemory(input:MemorySummaryInput,signal:AbortSignal){this.summaries.push(structuredClone(input));return this.summarize(input,signal);}
 async runWorker():Promise<WorkerReport>{throw new Error('These local memory tests must not start a professional Worker');}
 async steer(){}async cancel(){}async close(){this.closed=true;}
}
async function directory(){const root=await mkdtemp(join(tmpdir(),'boe-room-memory-integration-'));cleanup.push(()=>rm(root,{recursive:true,force:true}));return root;}
function host(root:string,runtime:MemoryRuntime){
 const config=loadConfig(root,{stateDir:join(root,'state'),routerBatchWindowMs:0,recentMessageLimit:1});
 const store=new Store(join(root,'state.sqlite')),publisher=new MemoryPublisher(),coordinator=new Coordinator(config,store,runtime,publisher);let closed=false;
 const close=async()=>{if(closed)return;closed=true;await coordinator.close();store.close();};cleanup.push(close);
 return{store,publisher,coordinator,close};
}

describe('persistent room memory in the foreground Coordinator path',()=>{
 it('routes the next same-room and other-room requests while an older summary is blocked',async()=>{
  const root=await directory(),entered=deferred(),gate=deferred();let blocked=true;
  const runtime=new MemoryRuntime(async(input,signal)=>{
   if(blocked){entered.resolve();await Promise.race([gate.promise,new Promise<never>((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}))]);}
   return budgetNotes(input);
  });
  const h=host(root,runtime);
  await bounded(h.coordinator.receive(message('first','BUDGET=10元;KEEP=键盘')));await bounded(entered.promise);
  try{
   await bounded(h.coordinator.receive(message('second','请确认已经记住条件')));
   await bounded(h.coordinator.receive(message('other','BUDGET=80元;KEEP=鼠标','B','other-room')));
   expect(runtime.routes.map(r=>r.messages[0].messageId)).toEqual(['first','second','other']);
   expect(h.publisher.messages).toHaveLength(3);
   const second=runtime.routes[1];expect(second.workingMemory?.version).toBe(0);
   expect(second.recentMessages.some(m=>m.id==='room:first'&&m.text==='BUDGET=10元;KEEP=键盘')).toBe(true);
   expect(JSON.stringify(runtime.routes[2])).not.toContain('BUDGET=10元;KEEP=键盘');
  }finally{blocked=false;gate.resolve();}
  await until(()=>allCovered(h.store)&&allCovered(h.store,'other-room'));
 });

 it('preserves independently attributed corrected conditions and their source IDs across a Store/runtime restart',async()=>{
  const root=await directory(),runtime=new MemoryRuntime(),h=host(root,runtime);
  const original=message('a-original','BUDGET=10元;KEEP=键盘');
  await h.coordinator.receive(original);await until(()=>allCovered(h.store));
  await h.coordinator.receive(message('b-original','BUDGET=80元;KEEP=鼠标','B'));await until(()=>allCovered(h.store));
  const corrected={...message('a-corrected','BUDGET=7元;KEEP=键盘'),replyToMessageId:original.messageId};
  await h.coordinator.receive(corrected);await until(()=>allCovered(h.store));
  const stored=h.store.roomMemory.head('room').version!;
  expect(stored.notes.map(n=>[n.authorId,n.text]).sort()).toEqual([['A','BUDGET=7元;KEEP=键盘'],['B','BUDGET=80元;KEEP=鼠标']]);
  expect(h.store.message(original.id)?.text).toBe('BUDGET=10元;KEEP=键盘');
  await h.close();
  const nextRuntime=new MemoryRuntime(),next=host(root,nextRuntime);
  expect(next.store.roomMemory.head('room').version).toEqual(stored);
  await next.coordinator.receive(message('after-restart','请核对两人的最新条件'));
  const observed=nextRuntime.routes[0].workingMemory!;
  expect(observed.version).toBe(stored.version);expect(observed.coveredSeq).toBe(stored.coveredSeq);
  expect(observed.notes.map(n=>[n.authorId,n.text]).sort()).toEqual([['A','BUDGET=7元;KEEP=键盘'],['B','BUDGET=80元;KEEP=鼠标']]);
  expect(observed.notes.find(n=>n.authorId==='A')!.sources.map(s=>s.id)).toEqual(['room:a-corrected']);
  expect(observed.notes.find(n=>n.authorId==='B')!.sources.map(s=>s.id)).toEqual(['room:b-original']);
  expect(next.store.message(original.id)?.text).toBe(original.text);
 });

 it('aborts background work at shutdown and rebuilds the uncommitted source prefix after startup',async()=>{
  const root=await directory(),entered=deferred();let aborted=false;
  const runtime=new MemoryRuntime(async(_input,signal)=>{
   entered.resolve();return new Promise<never>((_,reject)=>signal.addEventListener('abort',()=>{aborted=true;reject(signal.reason);},{once:true}));
  });
  const h=host(root,runtime);await h.coordinator.receive(message('uncommitted','BUDGET=12元;KEEP=显示器'));await bounded(entered.promise);
  expect(h.store.roomMemory.head('room').version).toBeNull();await bounded(h.close());expect(aborted).toBe(true);
  const restarted=host(root,new MemoryRuntime());expect(restarted.store.message('room:uncommitted')?.text).toBe('BUDGET=12元;KEEP=显示器');
  await restarted.coordinator.start();await until(()=>allCovered(restarted.store));
  expect(restarted.store.roomMemory.head('room').version?.notes).toMatchObject([{authorId:'A',text:'BUDGET=12元;KEEP=显示器'}]);
 });
});

it('treats memory source IDs as hints and requires scoped original retrieval before using one as context',async()=>{
 const root=await directory();await mkdir(join(root,'personas'));await writeFile(join(root,'personas/default.md'),'# Local test\n只处理当前问题。');
 const store=new Store(':memory:');cleanup.push(async()=>store.close());const old=message('old','BUDGET=10元;KEEP=键盘');store.ingest(old);store.messageStatus(old.id,'routed');
 const batch=store.roomMemory.batch('room',store.roomMemory.latestSeq('room'));
 store.roomMemory.commit({roomId:'room',epoch:batch.epoch,baseVersion:batch.baseVersion,untilSeq:batch.untilSeq,sourceDigest:batch.sourceDigest,notes:[{id:'budget',authorId:'A',text:old.text,sourceSeqs:[batch.events[0].seq]}]});
 let allowRecall=false,lookups=0;
 class Adapter extends LlmAdapter {
  override async resolveModel(provider:string,model:string):Promise<LlmResolvedModelInfo>{return{provider,id:model,name:model,context:{contextWindow:128_000},defaultMaxTokens:4096};}
  async *stream(call:GenerateOptions):AsyncIterable<StreamChunk>{
   const user=[...call.messages].reverse().find(m=>m.role==='user')!;
   const data=JSON.parse(user.content.filter(b=>b.type==='text').map(b=>b.text).join(''));
   if(allowRecall&&!call.messages.some(m=>m.role==='tool')){
    yield{type:'block-end',index:0,block:{type:'tool-call',id:ToolCallId('lookup'),name:'router_context',arguments:JSON.stringify({kind:'messages',id:old.id})}};
    yield{type:'finish',reason:{kind:'tool-calls'}};return;
   }
   const text=JSON.stringify([{action:'open_thread',sourceMessageIds:data.messages.map((m:GroupMessage)=>m.id),contextMessageIds:[old.id],subject:'继续原预算分析',resolvedRequest:'按当前作者原预算继续',acknowledgement:'我按原条件继续核对。'}]);
   yield{type:'text-delta',index:0,text};yield{type:'finish',reason:{kind:'stop'}};
  }
 }
 const config=loadConfig(root,{stateDir:join(root,'state'),router:{provider:'mock',model:'router',api:'openai-responses'}});
 const native=await NativeAgentRuntime.create({root:join(root,'native'),adapters:{mock:new Adapter()},compaction:false});cleanup.push(()=>native.close());
 const runtime=await DshRuntime.create(config,{native});cleanup.push(()=>runtime.close());
 const first=message('first','继续原预算分析');store.ingest(first);
 const input=attachRoomMemory(store,{roomId:'room',event:'messages',messages:[first],recentMessages:[],threads:[]},65_536);
 expect(input.recentMessages).toEqual([]);expect(input.workingMemory?.notes[0].sources[0].id).toBe(old.id);
 await expect(runtime.route(input)).rejects.toMatchObject({code:'ROUTER_RECOVERY_FAILED'});
 allowRecall=true;const next=message('next','继续原预算分析');store.ingest(next);
 const nextInput=attachRoomMemory(store,{roomId:'room',event:'messages',messages:[next],recentMessages:[],threads:[]},65_536);
 const lookup=store.routerContextReader('room',next.id,Date.now());
 const actions=await runtime.route(nextInput,async query=>{lookups++;return lookup(query);});
 expect(lookups).toBe(1);expect(actions).toMatchObject([{action:'open_thread',sourceMessageIds:[next.id],contextMessageIds:[old.id]}]);
});
