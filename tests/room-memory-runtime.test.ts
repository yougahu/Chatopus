import {afterEach,expect,it,vi} from 'vitest';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {LlmAdapter,type GenerateOptions,type LlmResolvedModelInfo,type StreamChunk} from '@deepseek-ai/dsh-llm';
import {DshRuntime,routerPayload,routerRecoveryPayload} from '../src/dsh-runtime.js';
import {NativeAgentRuntime,type NativeRuntimeOptions} from '../src/runtime/native.js';
import {loadConfig} from '../src/config.js';
import {routerClock} from '../src/runtime/router-request.js';
import type {MemorySummaryInput} from '../src/room-memory-worker.js';
import type {GroupMessage,RouterRequest,WorkerRequest} from '../src/types.js';

const cleanup:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const dispose of cleanup.splice(0).reverse())await dispose();vi.restoreAllMocks();vi.useRealTimers();});
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(r=>resolve=r);return {promise,resolve};}
const jsonBytes=(value:unknown)=>Buffer.byteLength(JSON.stringify(value));
const message:GroupMessage={id:'m-current',messageId:'platform-current',roomId:'room',platform:'replay',authorId:'A',authorName:'A',text:'请分析当前问题',timestamp:1,mentions:[],attachments:[],isMentioned:true,isAdmin:false};
const route:RouterRequest={roomId:'room',event:'messages',messages:[message],recentMessages:[],threads:[]};
function summaryInput(text='A condition'):MemorySummaryInput{return{roomId:'room',epoch:1,baseVersion:0,coveredSeq:0,targetSeq:1,previousNotes:[],
 events:[{seq:1,roomId:'room',kind:'message',sourceId:'old-source',authorId:'A',text,digest:'a'.repeat(64)}],outputTokens:8192,inputBudgetBytes:100_000};}
class Adapter extends LlmAdapter {
 requests:GenerateOptions[]=[];
 constructor(readonly contextWindow:number,readonly respond:(input:Record<string,any>,call:GenerateOptions)=>Promise<string>|string){super();}
 override async resolveModel(provider:string,model:string):Promise<LlmResolvedModelInfo>{return{provider,id:model,name:model,context:{contextWindow:this.contextWindow},defaultMaxTokens:32_768};}
 async *stream(call:GenerateOptions):AsyncIterable<StreamChunk>{
  this.requests.push(call);const last=call.messages.findLast(message=>message.role==='user')!;
  const input=JSON.parse(last.content.filter(block=>block.type==='text').map(block=>block.text).join(''));
  const text=await this.respond(input,call);yield{type:'text-delta',index:0,text};yield{type:'usage',usage:{inputTokens:100,outputTokens:20}};yield{type:'finish',reason:{kind:'stop'}};
 }
}
async function fixture(adapter:Adapter,workerTimeoutMs=30_000){
 const root=await mkdtemp(join(tmpdir(),'boe2-memory-runtime-'));cleanup.push(()=>rm(root,{recursive:true,force:true}));
 await mkdir(join(root,'personas'));await writeFile(join(root,'personas/default.md'),'# Test persona\nCurrent facts only.');
 const nativeCreate=NativeAgentRuntime.create.bind(NativeAgentRuntime),created:NativeRuntimeOptions[]=[];
 vi.spyOn(NativeAgentRuntime,'create').mockImplementation(async options=>{
  created.push(options);return nativeCreate({...options,providers:undefined,adapters:{'boe-router':adapter,'boe-worker':adapter}});
 });
 const config=loadConfig(root,{stateDir:join(root,'state'),routerApiKey:'local-router-key',workerApiKey:'local-worker-key',
  router:{provider:'boe-router',model:'router',maxTokens:4096},worker:{provider:'boe-worker',model:'worker',maxTokens:4096},workerTimeoutMs});
 const runtime=await DshRuntime.create(config,{capabilityFactory:async()=>({tools:[],systemContext:'Test domain',finalizeAnswer:async text=>text+' checked',close:async()=>{}})});
 cleanup.push(()=>runtime.close());return{runtime,created,root};
}

it('keeps blocked background work on an independent noncompacting production-pool host and closes it without blocking foreground or Worker',async()=>{
 const entered=deferred();let summaryAborted=false;
 const adapter=new Adapter(1_000_000,async(input,call)=>{
  if(input.events){entered.resolve();await new Promise<void>((_,reject)=>call.signal?.addEventListener('abort',()=>{summaryAborted=true;reject(call.signal?.reason);},{once:true}));throw new Error('Unexpected summary continuation');}
  if(input.threadId)return JSON.stringify({threadId:input.threadId,runId:input.runId,coveredInputSeq:1,basedOnRevision:1,status:'ready',shortAnswer:'Worker answer',assumptions:[],evidenceRefs:[],openQuestions:[]});
  return JSON.stringify([{action:'silence',sourceMessageIds:input.messages.map((m:GroupMessage)=>m.id)}]);
 });
 const {runtime,created,root}=await fixture(adapter),input=summaryInput();
 const budget=await runtime.roomMemoryBudget({roomId:'room',previousNotes:[],reason:'initial'},new AbortController().signal);
 input.inputBudgetBytes=budget.inputBudgetBytes;input.outputTokens=budget.outputTokens;
 const background=runtime.summarizeRoomMemory(input,new AbortController().signal).catch(error=>error);
 await entered.promise;
 expect(await runtime.route(route)).toEqual([{action:'silence',sourceMessageIds:['m-current']}]);
 expect(await runtime.route(route)).toEqual([{action:'silence',sourceMessageIds:['m-current']}]);
 expect(summaryAborted).toBe(false);expect(created).toHaveLength(2);expect(created.filter(options=>options.compaction===false)).toHaveLength(1);expect(created.filter(options=>options.compactionRole==='router')).toHaveLength(1);
 const routed=adapter.requests.filter(call=>call.messages.some(m=>m.role==='user'&&m.content.some(b=>b.type==='text'&&b.text.includes('m-current'))));
 expect(routed).toHaveLength(2);expect(routed[0].sessionId).not.toBe(routed[1].sessionId);
 const request:WorkerRequest={thread:{id:'thread',roomId:'room',ownerId:'A',sourceMessageId:message.id,explicit:true,participants:['A'],status:'running',subject:'Current question',summary:'',revision:1,epoch:1,latestInputSeq:1,sessionId:'worker-thread'},runId:'run',workspace:join(root,'worker'),inputs:[{seq:1,revision:1,message,kind:'question'}]};
 expect((await runtime.runWorker(request)).shortAnswer).toBe('Worker answer checked');
 expect(created).toHaveLength(3);expect(created[2].compaction).toMatchObject({summarizationProvider:'boe-worker',summarizationModel:'worker'});
 const firstClose=runtime.close();expect(runtime.close()).toBe(firstClose);await firstClose;
 expect(summaryAborted).toBe(true);expect(await background).toBeInstanceOf(Error);
 await expect(runtime.route(route)).rejects.toThrow('Runtime is closed');
});

it('accepts a memory batch which fits its declared complete input budget without charging JSON transport escaping again',async()=>{
 const adapter=new Adapter(64_000,()=>JSON.stringify({notes:[]}));const {runtime}=await fixture(adapter);
 const budget=await runtime.roomMemoryBudget({roomId:'room',previousNotes:[],reason:'initial'},new AbortController().signal);
 const input=summaryInput();input.inputBudgetBytes=budget.inputBudgetBytes;input.outputTokens=budget.outputTokens;
 let low=0,high=budget.inputBudgetBytes;
 while(low<high){const middle=Math.ceil((low+high)/2);input.events[0].text='"\\\n'.repeat(middle);if(jsonBytes(input)<=budget.inputBudgetBytes)low=middle;else high=middle-1;}
 input.events[0].text='"\\\n'.repeat(low);
 expect(jsonBytes(input)).toBeLessThanOrEqual(budget.inputBudgetBytes);expect(jsonBytes(input)).toBeGreaterThan(budget.inputBudgetBytes-10);
 await expect(runtime.summarizeRoomMemory(input,new AbortController().signal)).resolves.toEqual([]);
 expect(adapter.requests).toHaveLength(1);
});

it.each([0,64])('fits independent recovery around an intact current payload with only %s bytes spare',async spare=>{
 let currentText='',calls=0;
 const adapter=new Adapter(96_000,input=>{
  expect(input.messages[0].text).toBe(currentText);
  if(++calls===1)return 'not valid routing JSON '+ 'x'.repeat(8192);
  if(spare)expect(input.repair).toEqual({retry:true});else expect(input).not.toHaveProperty('repair');
  return JSON.stringify([{action:'open_thread',sourceMessageIds:[message.id],subject:'Current conditions'}]);
 });
 const {runtime}=await fixture(adapter),budget=await runtime.routerContextBudget('room');
 const input=structuredClone(route);
 input.currentTime=Date.now();input.currentTimeContext=routerClock(input.currentTime,'Asia/Shanghai');
 let low=0,high=budget;
 while(low<high){const middle=Math.ceil((low+high)/2);input.messages[0].text='完整当前条件BEGIN '+ 'x'.repeat(middle)+' END完整当前条件';
  if(Buffer.byteLength(routerPayload(input,{recentMessageLimit:16,threadCardLimit:12}))<=budget-spare)low=middle;else high=middle-1;}
 input.messages[0].text='完整当前条件BEGIN '+ 'x'.repeat(low)+' END完整当前条件';currentText=input.messages[0].text;
 expect(Buffer.byteLength(routerPayload(input,{recentMessageLimit:16,threadCardLimit:12}))).toBeGreaterThan(budget-100);
 await expect(runtime.route(input,async()=>({hasMore:false}))).resolves.toEqual([{action:'open_thread',sourceMessageIds:[message.id],subject:'Current conditions'}]);
 expect(adapter.requests).toHaveLength(2);expect(adapter.requests[0].sessionId).not.toBe(adapter.requests[1].sessionId);
 for(const call of adapter.requests){
  const inputBytes=call.messages.reduce((total,m)=>total+32+m.content.reduce((size,b)=>size+(b.type==='text'?Buffer.byteLength(b.text)+32:jsonBytes(b)),0),0)+jsonBytes(call.tools??[]);
  expect(inputBytes).toBeLessThanOrEqual(96_000-4096);
 }
});

it('drops invalid recovery output before optional old context while keeping current facts and scoped recall',()=>{
 const input={...structuredClone(route),recentMessages:[{...message,id:'old-1',messageId:'old-platform-1',text:'Old optional context '.repeat(40)},{...message,id:'old-2',messageId:'old-platform-2',text:'Other optional context '.repeat(40)}]};
 const config={recentMessageLimit:16,threadCardLimit:12},payload=routerPayload(input,config,true),budget=Buffer.byteLength(payload)+20;
 const recalled={messages:[{...message,id:'recalled-source',messageId:'recalled-platform',text:'Scoped original evidence'}]};
 const repaired=routerRecoveryPayload(input,config,payload,budget,'INVALID '.repeat(2000),'Invalid JSON',recalled);
 expect(Buffer.byteLength(repaired)).toBeLessThanOrEqual(budget);
 const parsed=JSON.parse(repaired);expect(parsed.messages).toEqual(input.messages);expect(parsed.recalledContext).toEqual(recalled);
 expect(parsed.repair).toMatchObject({validationError:'Invalid JSON'});expect(parsed.repair).not.toHaveProperty('previousOutput');
 expect(parsed.recentMessages.length).toBeLessThan(input.recentMessages.length);
});

it('classifies only its own background deadline as TIMEOUT, preserving external cancellation',async()=>{
 const entered=deferred();
 const adapter=new Adapter(1_000_000,async(_input,call)=>{entered.resolve();await new Promise<void>((_,reject)=>call.signal?.addEventListener('abort',()=>reject(call.signal?.reason),{once:true}));return '{}';});
 const {runtime}=await fixture(adapter,80);
 vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});
 const assertion=expect(runtime.summarizeRoomMemory(summaryInput(),new AbortController().signal)).rejects.toMatchObject({code:'TIMEOUT'});
 await entered.promise;await vi.advanceTimersByTimeAsync(56_480);await assertion;
 const external=new AbortController();external.abort(new DOMException('Caller deadline','TimeoutError'));
 const failed=await runtime.summarizeRoomMemory(summaryInput(),external.signal).catch(error=>error);
 expect(failed.code).not.toBe('TIMEOUT');
});

it('sends complete memory evidence and attribution without repeated host identity hashes',async()=>{
 const original=summaryInput('必须保留“7元改成9元”、\\、\n以及全部原文。');
 Object.assign(original.events[0],{threadId:'private-host-thread',messageId:'platform-original',authorName:'A',replyToMessageId:'quoted-platform',mentions:['B'],hasImage:true,textOffset:12,totalTextLength:1000,finalPart:false});
 const adapter=new Adapter(1_000_000,input=>{
  expect(input.roomId).toBe(original.roomId);
  const {roomId,sourceId,digest,threadId,...evidence}=original.events[0];
  expect(input.events).toEqual([evidence]);expect(input.previousNotes).toEqual(original.previousNotes);
  for(const key of ['roomId','sourceId','digest','threadId'])expect(input.events[0]).not.toHaveProperty(key);
  return JSON.stringify({notes:[]});
 });
 const {runtime}=await fixture(adapter);
 await expect(runtime.summarizeRoomMemory(original,new AbortController().signal)).resolves.toEqual([]);
 expect(original.events[0]).toHaveProperty('digest','a'.repeat(64));expect(original.events[0].sourceId).toBe('old-source');
});
