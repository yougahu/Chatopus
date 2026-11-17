import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/store.js';
import { Coordinator } from '../src/coordinator.js';
import { MemoryPublisher } from '../src/platform/memory.js';
import { MODEL_RETRIES_EXHAUSTED, MODEL_ERROR_REPLY } from '../src/runtime/model-retry.js';
import type { SharedMemoryService, MemberWriteIntent } from '../src/memory/shared-memory.js';
import type { MemberMemoryProjection } from '../src/memory/member-updates.js';
import type { GroupMessage, RouteAction, RouterRequest, RuntimePort, WorkerReport, WorkerRequest } from '../src/types.js';

class Runtime implements RuntimePort {
  routes:RouterRequest[]=[];workers:WorkerRequest[]=[];budget=50_000;
  sharedMemory?:SharedMemoryService;
  refreshes:Parameters<NonNullable<RuntimePort['refreshReplyPreferences']>>[0][]=[];
  refresh:(input:Parameters<NonNullable<RuntimePort['refreshReplyPreferences']>>[0])=>Promise<string>=async input=>input.text;
  async refreshReplyPreferences(input:Parameters<NonNullable<RuntimePort['refreshReplyPreferences']>>[0]){this.refreshes.push(structuredClone(input));return this.refresh(input);}
  decide:(request:RouterRequest)=>RouteAction[]|Promise<RouteAction[]>=request=>request.result?[{action:'publish_result',resultId:request.result.id}]:[{action:'reply_direct',sourceMessageIds:request.messages.map(message=>message.id),text:'收到'}];
  async route(request:RouterRequest){this.routes.push(structuredClone(request));return this.decide(request);}
  routerConfigurationHash(){return 'test-config';}
  async routerContextBudget(){return this.budget;}
  async runWorker(request:WorkerRequest):Promise<WorkerReport>{this.workers.push(request);return {threadId:request.thread.id,runId:request.runId,coveredInputSeq:request.inputs.at(-1)!.seq,basedOnRevision:request.inputs.at(-1)!.revision,status:'ready',shortAnswer:'已完成核对',assumptions:[],evidenceRefs:[],openQuestions:[]};}
  async steer(){}async cancel(){}async close(){}
}
const cleanup:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const fn of cleanup.splice(0).reverse())await fn();});
function fixture(options:{runtime?:Runtime;directory?:string;batchSize?:number}={}){
  const directory=options.directory??mkdtempSync(join(tmpdir(),'boe-persistent-coordinator-'));
  const config=loadConfig(directory,{apiKey:'',stateDir:join(directory,'runtime'),persistentRouter:true,routerBatchWindowMs:0,routerBatchSize:options.batchSize??8});
  const store=new Store(join(directory,'state.sqlite')),runtime=options.runtime??new Runtime(),publisher=new MemoryPublisher();
  const coordinator=new Coordinator(config,store,runtime,publisher);
  cleanup.push(async()=>{await coordinator.close();store.close();if(!options.directory)rmSync(directory,{recursive:true,force:true});});
  return {directory,config,store,runtime,publisher,coordinator};
}
function message(id:string,text=id,overrides:Partial<GroupMessage>={}):GroupMessage{return {id:'room:'+id,roomId:'room',messageId:id,platform:'replay',authorId:'A',authorName:'A',text,timestamp:Date.now(),mentions:[],attachments:[],isMentioned:true,isAdmin:false,...overrides};}
async function until(check:()=>boolean,timeout=3000){const end=Date.now()+timeout;while(Date.now()<end){if(check())return;await new Promise(resolve=>setTimeout(resolve,5));}throw new Error('Condition timed out');}

it.each(['previous image','old quoted image','restart follow-up'])('rehydrates original attachments after persistent Router projection: %s',async scenario=>{
  const f=fixture();
  const picture=message('picture','图片原文',{isMentioned:false,authorId:scenario==='old quoted image'?'B':'A',
    attachments:[{kind:'image',file:'persisted-picture.png',url:'https://gchat.qpic.cn/original-image'}]});
  await f.coordinator.receive(picture);
  if(scenario==='old quoted image')for(let n=0;n<60;n++)await f.coordinator.receive(message('noise-'+n,'background',{isMentioned:false}));
  f.runtime.decide=request=>request.result?[{action:'publish_result',resultId:request.result.id}]:[
    {action:'open_thread',sourceMessageIds:[request.messages[0].id],contextMessageIds:[picture.id],subject:'读取原图'}];
  await f.coordinator.receive(message('question','请分析前面的图片',scenario==='old quoted image'?{replyToMessageId:picture.messageId}:{}));
  await f.coordinator.drain(3000);
  const request=f.runtime.routes.find(r=>r.messages.some(m=>m.id==='room:question'))!;
  expect(JSON.stringify(request)).not.toContain('original-image');
  expect(JSON.stringify(request)).not.toContain('persisted-picture.png');
  expect(f.runtime.workers[0].inputs[0].contextMessages).toEqual([picture]);
  expect(f.runtime.workers[0].thread.ownerId).toBe('A');
  if(scenario==='restart follow-up'){
    const thread=f.store.threads()[0];
    // Also recover a historical input written by the pre-fix implementation.
    const input=f.store.inputs(thread.id)[0];
    input.contextMessages![0].attachments=[{kind:'image'}];
    f.store.db.prepare('UPDATE inputs SET data=? WHERE thread_id=? AND seq=1').run(JSON.stringify(input),thread.id);
    await f.coordinator.close();
    const reopened=fixture({directory:f.directory});
    reopened.runtime.decide=request=>request.result?[{action:'publish_result',resultId:request.result.id}]:[
      {action:'append_thread',sourceMessageIds:[request.messages[0].id],threadId:thread.id,kind:'supplement'}];
    await reopened.coordinator.start();
    await reopened.coordinator.receive(message('followup','继续解释图中的第二行',{replyToMessageId:'question'}));
    await reopened.coordinator.drain(3000);
    expect(reopened.runtime.workers[0].inputs[0].contextMessages).toEqual([picture]);
  }
});

it.each(['other-author','other-room','future','unknown'])('keeps persistent image context permission checks: %s',async kind=>{
  const f=fixture(),picture=message('blocked','图片',{isMentioned:false,authorId:kind==='other-author'?'B':'A',
    roomId:kind==='other-room'?'elsewhere':'room',attachments:[{kind:'image',url:'https://gchat.qpic.cn/blocked'}]});
  if(kind!=='future'&&kind!=='unknown')await f.coordinator.receive(picture);
  const question=message('question','看前图');
  if(kind==='future'){f.store.ingest(question);f.store.ingest(picture);}
  f.runtime.decide=request=>[{action:'open_thread',sourceMessageIds:[request.messages[0].id],contextMessageIds:[picture.id],subject:'读取图片'}];
  if(kind==='future')await f.coordinator.start();else await f.coordinator.receive(question);
  await f.coordinator.drain(3000);
  expect(f.runtime.workers).toHaveLength(0);
});
it('keeps a verified host memory receipt immutable instead of sending it through a preference model',async()=>{
  const runtime=new Runtime();
  runtime.sharedMemory={account:()=> 'fixture-account',project:async()=>{throw new Error('Receipt must not depend on later memory reads');}} as unknown as SharedMemoryService;
  const f=fixture({runtime});
  await f.coordinator.memoryIngestion!.close();
  const text='你的长期资料已更新，后续回复会按最新设置处理。';
  f.store.enqueue({roomId:'room',text},{id:'memory-confirm:verified-commit'});
  await f.coordinator.tick();
  expect(f.publisher.messages.map(row=>row.message.text)).toEqual([text]);
  expect(f.store.outbox('sent')).toHaveLength(1);
});

it('keeps one Router session across direct follow-ups while filtered messages remain observations',async()=>{
  const f=fixture();await f.coordinator.receive(message('quiet','背景条件',{isMentioned:false}));expect(f.runtime.routes).toHaveLength(0);
  await f.coordinator.receive(message('first','我的预算十元'));await f.coordinator.receive(message('second','改成五元'));
  expect(f.runtime.routes).toHaveLength(2);expect(f.runtime.routes[1].routing?.sessionId).toBe(f.runtime.routes[0].routing?.sessionId);
  expect(f.runtime.routes[0].routing?.mode).toBe('seed');expect(f.runtime.routes[1].routing?.mode).toBe('incremental');
  expect(f.runtime.routes[1].recentMessages.some(item=>item.id==='room:first')).toBe(false);
  expect(f.store.routerSessions.inputEvent('room',{kind:'message',id:'room:quiet'})?.observeOnly).toBe(true);
  expect(f.store.routerSessions.turns('room').map(turn=>turn.state)).toEqual(['committed','committed']);
  expect(f.publisher.messages).toHaveLength(2);
});

it('rebuilds a failed native turn once with the same input identity and never duplicates the business reply',async()=>{
  const runtime=new Runtime();let calls=0;runtime.decide=request=>{if(!calls++)throw Object.assign(new Error('native timeout'),{code:'TIMEOUT'});return [{action:'reply_direct',sourceMessageIds:request.messages.map(item=>item.id),text:'成功'}];};
  const f=fixture({runtime});await f.coordinator.receive(message('first'));
  expect(runtime.routes).toHaveLength(2);expect(runtime.routes[0].routing?.routeTurnId).toBe(runtime.routes[1].routing?.routeTurnId);
  expect(runtime.routes[1].routing?.generation).toBe(2);expect(f.store.routerSessions.turns('room')[0]).toMatchObject({attempts:2,state:'committed'});
  expect(f.publisher.messages.map(item=>item.message.text)).toEqual(['成功']);
});

it('terminates exhausted provider retries and saves failed turn with the same failure response transaction',async()=>{
  const runtime=new Runtime();runtime.decide=()=>{throw Object.assign(new Error('provider unavailable'),{code:MODEL_RETRIES_EXHAUSTED});};
  const f=fixture({runtime});await f.coordinator.receive(message('first'));
  expect(runtime.routes).toHaveLength(1);expect(f.store.routerSessions.turns('room')[0]).toMatchObject({attempts:1,state:'failed'});
  expect(f.store.db.prepare('SELECT status FROM messages').get()?.status).toBe('failed');expect(f.publisher.messages[0].message.text).toBe(MODEL_ERROR_REPLY);
});

it('recovers the exact pending batch before later intake and preserves the previous attempt count',async()=>{
  const f=fixture(),first=message('one'),second=message('two'),later=message('later');
  for(const original of [first,second,later]){f.store.ingest(original);f.coordinator.persistentRouter!.ingest(original);}
  const prepared=await f.coordinator.persistentRouter!.prepare({roomId:'room',event:'messages',messages:[first,second],recentMessages:[],threads:[]},'test-config',50_000);
  f.coordinator.persistentRouter!.startAttempt(prepared);for(const original of [first,second])f.store.messageStatus(original.id,'processing');
  await f.coordinator.start();await f.coordinator.drain(3000);
  expect(f.runtime.routes.map(request=>request.messages.map(item=>item.id))).toEqual([['room:one','room:two'],['room:later']]);
  const restored=f.store.routerSessions.turn(prepared.turn.id)!;expect(restored).toMatchObject({state:'committed',attempts:2,generation:2});
});

it('shares the room session with result routing and gives a deferred timer a distinct stable trigger',async()=>{
  const runtime=new Runtime();runtime.decide=request=>request.event==='messages'?[{action:'open_thread',sourceMessageIds:request.messages.map(item=>item.id),subject:'问题'}]
    :request.event==='worker_result'?[{action:'defer_result',resultId:request.result!.id,delayMs:100}]:[{action:'publish_result',resultId:request.result!.id}];
  const f=fixture({runtime});await f.coordinator.receive(message('first'));await f.coordinator.drain(3000);
  expect(runtime.routes.map(request=>request.event)).toEqual(['messages','worker_result','timer']);
  expect(new Set(runtime.routes.map(request=>request.routing?.sessionId)).size).toBe(1);
  const turns=f.store.routerSessions.turns('room');expect(turns.map(turn=>turn.trigger.kind)).toEqual(['messages','worker_result','timer']);expect(turns.every(turn=>turn.state==='committed')).toBe(true);
  expect(f.publisher.messages.filter(item=>item.dedupeKey.startsWith('result-'))).toHaveLength(1);
});

it('runs long follow-up load in one bounded native session without host summary calls',async()=>{
  const runtime=new Runtime();runtime.budget=14_000;const f=fixture({runtime});
  for(let index=0;index<14;index++){
    await f.coordinator.receive(message('input-'+index,`条件第${index}轮：`+'保留原条件'.repeat(90)));
  }
  await f.coordinator.drain(3000);
  expect(f.store.routerSessions.session('room')!.generation).toBe(1);expect(runtime.routes.every(request=>Buffer.byteLength(JSON.stringify(request))<=runtime.budget)).toBe(true);
  expect(runtime.routes.map(request=>request.messages[0].id)).toEqual(Array.from({length:14},(_,index)=>'room:input-'+index));
  expect(f.store.routerSessions.turns('room')).toHaveLength(14);expect(f.publisher.messages).toHaveLength(14);
});

it('freezes remote member intent before saving and retries verification without a new model decision or premature acknowledgement',async()=>{
  const runtime=new Runtime();let writes=0;const intents:MemberWriteIntent[]=[];
  const memory={
    account(roomId:string){return 'test-'+roomId;},client:{},
    async project(_room:string,ids:string[]){return ids.map(memberId=>({memberId,revision:0,fields:{},omittedKeys:[]}));},
    async prepareMemberWrites(roomId:string,updates:Array<{memberId:string;sourceMessageId:string;sourceOrder:number}>,turnId:string){
      return updates.map(update=>{const document={schemaVersion:1,memberId:update.memberId,revision:1,commitId:'saved-'+turnId,updatedAt:1,fields:{preferredName:{state:'set',value:'阿明',sourceMessageId:update.sourceMessageId,sourceOrder:update.sourceOrder,updatedAt:1}}};
        const intent={accountId:'room-account',roomId,memberId:update.memberId,commitId:document.commitId,expectedSha256:null,text:JSON.stringify(document),sha256:'hash'};intents.push(intent);return intent;});
    },
    async applyMemberWrite(intent:MemberWriteIntent){if(!writes++)throw Object.assign(new Error('write result uncertain'),{code:'MEMORY_PENDING'});return JSON.parse(intent.text);},
  } as unknown as SharedMemoryService;
  runtime.sharedMemory=memory;runtime.decide=request=>[{action:'reply_direct',sourceMessageIds:[request.messages[0].id],text:'已记住，以后叫你阿明。',memoryUpdates:[{kind:'member',sourceMessageId:request.messages[0].id,changes:[{key:'preferredName',op:'set',value:'阿明'}]}]}];
  const f=fixture({runtime}),received=f.coordinator.receive(message('name','以后叫我阿明'));
  await until(()=>writes===1);expect(f.publisher.messages).toEqual([]);expect(f.store.routerSessions.pendingTurns('room')[0].actions).toMatchObject({version:1,memoryIntents:[{commitId:intents[0].commitId}]});
  await received;expect(runtime.routes).toHaveLength(1);expect(intents).toHaveLength(1);expect(writes).toBe(2);
  expect(f.publisher.messages.map(item=>item.message.text)).toEqual(['已记住，以后叫你阿明。']);
  expect(f.store.routerSessions.events('room').some(event=>event.payload.kind==='memory_changed')).toBe(true);
  expect(f.coordinator.memoryWorker).toBeUndefined();expect(runtime.routes[0].memoryAvailable).toBe(true);expect(runtime.routes[0].workingMemory).toBeUndefined();
  expect(f.store.routerSessions.session('room')?.needsRebuild).toBe(true);
  runtime.decide=request=>[{action:'reply_direct',sourceMessageIds:request.messages.map(source=>source.id),text:'继续处理'}];
  await f.coordinator.receive(message('after-name','继续'));
  expect(runtime.routes[1].routing).toMatchObject({generation:2,mode:'seed',resume:false});
});

it('fails one truly oversized current input explicitly without spinning checkpoint retries or losing its source',async()=>{
  const runtime=new Runtime();runtime.budget=3500;const f=fixture({runtime});const original=message('huge','当前问题'.repeat(2500));
  await f.coordinator.receive(original);await f.coordinator.drain(1000);
  expect(runtime.routes).toEqual([]);expect(f.store.message(original.id)?.text).toBe(original.text);
  expect(f.store.routerSessions.pendingTurns('room')).toEqual([]);expect(f.store.routerSessions.turns('room')[0].state).toBe('failed');
  expect(f.publisher.messages[0].message.text).toContain('超过了当前处理容量');
});

function profile(revision:number,name:string):MemberMemoryProjection{return {memberId:'A',revision,fields:{preferredName:{state:'set',value:name}},omittedKeys:[]};}
function profileMemory(runtime:Runtime,read:()=>MemberMemoryProjection){runtime.sharedMemory={account:()=> 'test-account',client:{},project:async()=>[structuredClone(read())]} as unknown as SharedMemoryService;}
function pendingReply(f:ReturnType<typeof fixture>,baseline:MemberMemoryProjection,text='旧称呼，预算 5元。'){
  f.store.ingest(message('source'));const id=f.store.enqueue({roomId:'room',replyToMessageId:'source',text});
  const row=f.store.outbox('pending').find(item=>item.id===id)!;Object.assign(row,{hostMemberMemory:[baseline]});f.store.saveOutbox(row);return id;
}

it('refreshes a pending reply against current preferences while preserving the same delivery identity',async()=>{
  const runtime=new Runtime();profileMemory(runtime,()=>profile(2,'阿明'));runtime.refresh=async input=>input.text.replace('旧称呼','阿明');const f=fixture({runtime});
  const id=pendingReply(f,profile(1,'旧称呼'));await f.coordinator.tick();
  expect(runtime.refreshes).toHaveLength(1);expect(runtime.refreshes[0].previousMemberMemory?.[0].revision).toBe(1);
  expect(f.publisher.messages).toEqual([{dedupeKey:id,message:{roomId:'room',replyToMessageId:'source',text:'阿明，预算 5元。'}}]);
  expect((f.store.outbox('sent')[0] as unknown as {hostMemberMemory:MemberMemoryProjection[]}).hostMemberMemory[0].revision).toBe(2);
});

it('prioritizes the reply recipient within the twenty-member preference read limit',async()=>{
  const runtime=new Runtime(),reads:string[][]=[];
  runtime.sharedMemory={account:()=> 'test-account',client:{},async project(_room:string,ids:string[]){reads.push(ids);if(ids.length>20)throw new Error('too many members');return ids.map(memberId=>({...profile(0,''),memberId,fields:{}}));}} as unknown as SharedMemoryService;
  const f=fixture({runtime}),id=pendingReply(f,profile(0,''));
  const row=f.store.outbox('pending')[0];Object.assign(row,{hostMemberMemory:Array.from({length:20},(_,index)=>({...profile(0,''),memberId:'other-'+index,fields:{}}))});f.store.saveOutbox(row);
  await f.coordinator.tick();
  expect(reads[0]).toHaveLength(20);expect(reads[0][0]).toBe('A');expect(f.store.outbox('sent')[0].id).toBe(id);
});

it('detects an expired expression field even when its document revision did not change',async()=>{
  const runtime=new Runtime(),expired:MemberMemoryProjection={memberId:'A',revision:1,fields:{preferredName:{state:'expired'}},omittedKeys:[]};
  profileMemory(runtime,()=>expired);runtime.refresh=async input=>input.text.replace('旧称呼，','');const f=fixture({runtime});pendingReply(f,profile(1,'旧称呼'));
  await f.coordinator.tick();expect(runtime.refreshes).toHaveLength(1);expect(f.publisher.messages[0].message.text).toBe('预算 5元。');
});

it('leaves the original reply pending when preference reading or rewriting fails',async()=>{
  const runtime=new Runtime();profileMemory(runtime,()=>profile(2,'阿明'));runtime.refresh=async()=>{throw new Error('rewriter unavailable');};const f=fixture({runtime});const id=pendingReply(f,profile(1,'旧称呼'));
  await f.coordinator.tick();expect(f.publisher.messages).toEqual([]);expect(f.store.outbox('pending')[0]).toMatchObject({id,attempts:0,message:{text:'旧称呼，预算 5元。'}});
  runtime.refresh=async input=>input.text.replace('旧称呼','阿明');const retry=f.store.outbox('pending')[0];retry.dueAt=Date.now();f.store.saveOutbox(retry);
  await f.coordinator.tick();expect(f.publisher.messages[0].dedupeKey).toBe(id);
});

it('rechecks preferences after rewriting and does not send when another update won the race',async()=>{
  const runtime=new Runtime();let current=profile(2,'阿明');profileMemory(runtime,()=>current);
  runtime.refresh=async input=>{current=profile(3,'小明');return input.text.replace('旧称呼','阿明');};const f=fixture({runtime});pendingReply(f,profile(1,'旧称呼'));
  await f.coordinator.tick();expect(f.publisher.messages).toEqual([]);expect(f.store.outbox('pending')[0].message.text).toBe('旧称呼，预算 5元。');
});

it('keeps sending content frozen when preferences change after the platform send started',async()=>{
  const runtime=new Runtime();let current=profile(1,'旧称呼');profileMemory(runtime,()=>current);runtime.refresh=async input=>input.text.replace('旧称呼','阿明');
  const f=fixture({runtime});pendingReply(f,current);let release!:(value:{status:'sent';platformMessageId:string})=>void;let observed='';
  f.publisher.send=async outgoing=>{observed=outgoing.text;return new Promise(resolve=>release=resolve);};
  const sending=f.coordinator.tick();await until(()=>Boolean(release));expect(f.store.outbox('sending')).toHaveLength(1);
  current=profile(2,'阿明');await f.coordinator.tick();expect(runtime.refreshes).toEqual([]);expect(observed).toBe('旧称呼，预算 5元。');
  release({status:'sent',platformMessageId:'confirmed'});await sending;expect(f.store.outbox('sent')[0].message.text).toBe(observed);
});

it('uses the Worker rendering baseline when a member changes preferences while the Worker is running',async()=>{
  const runtime=new Runtime();let current=profile(1,'旧称呼'),complete!:(report:WorkerReport)=>void;profileMemory(runtime,()=>current);
  // Message turns without member changes still use the shared service's empty intent contract.
  Object.assign(runtime.sharedMemory!,{prepareMemberWrites:async()=>[],applyMemberWrite:async()=>{throw new Error('unexpected write');}});
  runtime.decide=request=>request.result?[{action:'publish_result',resultId:request.result.id}]:[{action:'open_thread',sourceMessageIds:request.messages.map(item=>item.id),subject:'预算问题'}];
  runtime.runWorker=async request=>{runtime.workers.push(request);return new Promise(resolve=>complete=resolve);};runtime.refresh=async input=>input.text.replace('旧称呼','阿明');
  const f=fixture({runtime});await f.coordinator.receive(message('question','这次用英文回答，预算保持5元'));await until(()=>Boolean(complete));
  current=profile(2,'阿明');const worker=runtime.workers[0];complete({threadId:worker.thread.id,runId:worker.runId,coveredInputSeq:worker.inputs.at(-1)!.seq,basedOnRevision:worker.inputs.at(-1)!.revision,status:'ready',shortAnswer:'旧称呼，预算 5元。',assumptions:[],evidenceRefs:[],openQuestions:[],hostMemberMemory:[profile(1,'旧称呼')]});
  await f.coordinator.drain(3000);const result=f.publisher.messages.find(item=>item.dedupeKey.startsWith('result-'))!;
  expect(result.message.text).toBe('阿明，预算 5元。');expect(runtime.refreshes.at(-1)?.previousMemberMemory?.[0].revision).toBe(1);
  expect(runtime.refreshes.at(-1)?.sourceText).toContain('这次用英文回答');
});

it('bounds repeated invalid preference rewrites and retains the unsent original for inspection',async()=>{
  const runtime=new Runtime();profileMemory(runtime,()=>profile(2,'阿明'));runtime.refresh=async()=>{throw Object.assign(new Error('technical anchors changed'),{code:'PREFERENCE_CONTENT_CHANGED'});};
  const f=fixture({runtime}),id=pendingReply(f,profile(1,'旧称呼'));
  for(let index=0;index<3;index++){
    const pending=f.store.outbox('pending').find(row=>row.id===id)!;pending.dueAt=Date.now();f.store.saveOutbox(pending);await f.coordinator.tick();
    const row=f.store.outbox().find(row=>row.id===id)!;
    expect(row.dueAt-Date.now()).toBeGreaterThan([4500,14_500,59_500][index]);
  }
  expect(runtime.refreshes).toHaveLength(3);expect(f.publisher.messages).toEqual([]);
  expect(f.store.outbox('failed')[0]).toMatchObject({id,reason:'preference_refresh_exhausted:PREFERENCE_CONTENT_CHANGED',message:{text:'旧称呼，预算 5元。'}});
  await f.coordinator.tick();expect(runtime.refreshes).toHaveLength(3);
});

it('keeps transient profile-read failures pending with slow backoff without spending rewrite calls',async()=>{
  const runtime=new Runtime();profileMemory(runtime,()=>{throw new Error('backend unavailable');});const f=fixture({runtime}),id=pendingReply(f,profile(1,'旧称呼'));
  for(let index=0;index<4;index++){
    const pending=f.store.outbox('pending').find(row=>row.id===id)!;pending.dueAt=Date.now();f.store.saveOutbox(pending);await f.coordinator.tick();
  }
  expect(runtime.refreshes).toEqual([]);expect(f.publisher.messages).toEqual([]);expect(f.store.outbox('failed')).toEqual([]);
  expect(f.store.outbox('pending')[0].dueAt-Date.now()).toBeGreaterThan(59_500);
});
it('terminates unavailable member reads and lets the next input proceed with a durable failure',async()=>{
 const runtime=new Runtime();runtime.sharedMemory={account:()=> 'test-account',client:{},project:async()=>{throw new Error('member backend down');}} as unknown as SharedMemoryService;
 const f=fixture({runtime});await f.coordinator.receive(message('first'));await f.coordinator.receive(message('second'));
 expect(runtime.routes).toHaveLength(0);expect(f.store.routerSessions.pendingTurns()).toEqual([]);expect(f.store.routerSessions.turns('room').map(t=>t.state)).toEqual(['failed','failed']);
 expect(f.publisher.messages).toHaveLength(2);expect(f.store.outbox('pending')).toEqual([]);expect(runtime.refreshes).toEqual([]);
});
