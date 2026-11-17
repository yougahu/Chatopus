import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { PersistentRouterManager, type PreparedRouterTurn, type PersistentRouterOptions } from '../src/runtime/persistent-router.js';
import type { GroupMessage, RouterRequest } from '../src/types.js';
const cleanup:Array<()=>void>=[];
afterEach(()=>{for(const fn of cleanup.splice(0).reverse())fn();});
function fixture(options:PersistentRouterOptions={}){
  const directory=mkdtempSync(join(tmpdir(),'boe-router-v2-'));cleanup.push(()=>rmSync(directory,{recursive:true,force:true}));
  const store=new Store(join(directory,'state.sqlite'));cleanup.push(()=>store.close());
  const manager=new PersistentRouterManager(store.routerSessions,options);
  return {store,manager,sessions:store.routerSessions,directory};
}
function message(id:string,text=id,roomId='room'):GroupMessage{return {id:roomId+':'+id,roomId,messageId:id,platform:'replay',authorId:'owner',authorName:'Owner',text,timestamp:1,mentions:[],attachments:[],isMentioned:true,isAdmin:false};}
function request(current:GroupMessage):RouterRequest{return {roomId:current.roomId,event:'messages',messages:[current],recentMessages:[],threads:[]};}
function ingest(f:ReturnType<typeof fixture>,value:GroupMessage){f.store.ingest(value);f.manager.ingest(value);return value;}
function finish(f:ReturnType<typeof fixture>,prepared:PreparedRouterTurn){f.manager.startAttempt(prepared);f.sessions.commitTurn({turnId:prepared.turn.id,generation:prepared.session.generation,actions:[],receipt:{accepted:true},contextBoundary:prepared.contextBoundary});f.store.messageStatus(prepared.request.messages[0].id,'routed');}

it('continues the native session, adds bounded new observations, and always reloads explicit quotes',async()=>{
  const f=fixture(),old=ingest(f,message('old','预算十元')),first=await f.manager.prepare(request(old),'config',50_000);finish(f,first);
  const quiet=ingest(f,{...message('quiet','旁聊'),isMentioned:false}),next=ingest(f,message('next','更正成五元'));
  const second=await f.manager.prepare(request(next),'config',50_000);
  expect(second.request.routing).toMatchObject({sessionId:first.session.sessionId,mode:'incremental',resume:true,context:{history:'bounded',omittedHistory:true}});
  expect(second.request.recentMessages.map(m=>m.id)).toEqual([quiet.id]);finish(f,second);
  const quote=ingest(f,{...message('quote','再看旧要求'),replyToMessageId:old.messageId});
  const third=await f.manager.prepare({...request(quote),references:{[quote.id]:{status:'unbound',message:old,chain:[old.messageId]}}},'config',50_000);
  expect(third.request.references?.[quote.id].message?.text).toBe(old.text);
  expect(third.request.recentMessages.map(m=>m.id)).toContain(old.id);
  expect(third.request.routing!.context.messageIds).toEqual(expect.arrayContaining([quote.id,old.id]));
});
it('keeps arbitrary room identities and future intake out of the current context',async()=>{
  const f=fixture(),one=ingest(f,message('one','one room','qq:one')),two=ingest(f,message('two','two room','qq_one')),later=ingest(f,message('later','future','qq:one'));
  const a=await f.manager.prepare({...request(one),recentMessages:[later]},'config',50_000),b=await f.manager.prepare(request(two),'config',50_000);
  expect(a.session.sessionId).not.toBe(b.session.sessionId);expect(JSON.stringify(a.request)).not.toContain(later.text);expect(JSON.stringify(a.request)).not.toContain(two.text);
  await expect(f.manager.prepare({...request(one),recentMessages:[two]},'config',50_000)).rejects.toMatchObject({code:'ROUTER_SCOPE_INVALID'});
});
it('does not summarize or replay a 444 KB chatter backlog before accepting the current question',async()=>{
  const f=fixture({initialHistoryLimit:8,maxInputBytes:7000});
  for(let index=0;index<252;index++)ingest(f,{...message('quiet-'+index,'旁聊原文'.repeat(149)),isMentioned:false});
  const current=ingest(f,message('current','现在还在吗'));
  const prepared=await f.manager.prepare(request(current),'config',7000);
  expect(prepared.inputBytes).toBeLessThanOrEqual(7000);expect(prepared.request.messages[0].text).toBe(current.text);
  expect(prepared.request.routing?.context.omittedHistory).toBe(true);expect(f.sessions.pendingTurns()).toHaveLength(1);
  expect(f.store.db.prepare('SELECT count(*) AS n FROM messages').get()?.n).toBe(253);
  const original=await f.store.routerContextReader('room',current.id)({kind:'messages',id:'room:quiet-0'});expect(original.messages?.[0].text).toContain('旁聊原文');
});
it('rebuilds directly after every kind of native context failure with the same turn and durable budget',async()=>{
  const f=fixture(),old=ingest(f,message('old','预算十元')),first=await f.manager.prepare(request(old),'config',50_000);finish(f,first);
  const current=ingest(f,message('current','改成五元')),prepared=await f.manager.prepare(request(current),'config',50_000);
  f.manager.startAttempt(prepared);f.sessions.consumeModelCall(prepared.turn.id,true);f.manager.markFailure(prepared,{code:'max-tokens'});
  const rebuilt=await f.manager.prepare(request(current),'config',50_000);
  expect(rebuilt.turn).toMatchObject({id:prepared.turn.id,attempts:1,modelCalls:1,summaryCalls:1,rebuilds:1,deadlineAt:prepared.turn.deadlineAt});
  expect(rebuilt.request.routing).toMatchObject({mode:'seed',resume:false,generation:2});expect(rebuilt.request.recentMessages.some(m=>m.text===old.text)).toBe(true);
  expect(()=>f.sessions.commitTurn({turnId:prepared.turn.id,generation:prepared.session.generation,actions:[]})).toThrow('inactive generation');
  f.manager.startAttempt(rebuilt);f.manager.markFailure(rebuilt,{code:'CONTEXT_LIMIT'});
  await expect(f.manager.prepare(request(current),'config',50_000)).rejects.toMatchObject({code:'ROUTER_REBUILD_LIMIT'});
});
it('does not reset expired deadlines, rebuild counts or model usage on manager restart',async()=>{
  const f=fixture(),current=ingest(f,message('pending')),prepared=await f.manager.prepare(request(current),'config',50_000);f.manager.startAttempt(prepared);f.sessions.consumeModelCall(prepared.turn.id,true);
  const restored=new PersistentRouterManager(f.sessions);restored.recover();const second=await restored.prepare(request(current),'config',50_000);expect(second.turn.modelCalls).toBe(1);expect(second.turn.deadlineAt).toBe(prepared.turn.deadlineAt);
  f.sessions.db.prepare('UPDATE router_turns SET deadline_at=? WHERE id=?').run(Date.now()-1,prepared.turn.id);
  await expect(new PersistentRouterManager(f.sessions).prepare(request(current),'config',50_000)).rejects.toMatchObject({code:'ROUTER_DEADLINE'});
});
it('fails a truly oversized current question or explicit quote without silently clipping it',async()=>{
  const f=fixture({maxInputBytes:5000}),huge=ingest(f,message('huge','不能丢失的条件'.repeat(1000)));
  await expect(f.manager.prepare(request(huge),'config',5000)).rejects.toMatchObject({code:'ROUTER_PAYLOAD_OVERSIZED'});
  expect(f.store.message(huge.id)?.text).toBe(huge.text);expect(f.sessions.pendingTurns()[0].attempts).toBe(0);
});
it('survives twenty bounded recovery cycles without losing current sources or duplicate commits',async()=>{
  const f=fixture({maxInputBytes:8000});
  for(let index=0;index<20;index++){
    const current=ingest(f,message('turn-'+index,'当前条件'+index+'；'.repeat(100))),prepared=await f.manager.prepare(request(current),'config',8000);
    f.manager.startAttempt(prepared);f.manager.markFailure(prepared,{code:'ROUTER_COMPACTION_TRUNCATED'});
    const recovered=await f.manager.prepare(request(current),'config',8000);expect(recovered.inputBytes).toBeLessThanOrEqual(8000);expect(recovered.request.messages[0].text).toBe(current.text);finish(f,recovered);
  }
  expect(f.sessions.turns('room')).toHaveLength(20);expect(f.sessions.turns('room').every(turn=>turn.state==='committed'&&turn.rebuilds===1)).toBe(true);
});
it('rebuilds task requirements from the verified snapshot plus newer attributed corrections',async()=>{
  const f=fixture(),old=ingest(f,message('task-old','预算十元')),thread=f.store.createThread(old,'活动预算',true);
  const original=f.store.inputs(thread.id)[0];
  f.store.saveRun('validated',thread.id,'completed',{report:{requirementSnapshot:{throughInputSeq:original.seq,revision:thread.revision,inputDigest:'validated-fixture',byAuthor:[{authorId:old.authorId,text:'预算十元',sourceSeqs:[original.seq]}]}}});
  const correction=ingest(f,message('correction','更正预算五元'));f.store.append(f.store.thread(thread.id)!,correction,'correction');
  const current=ingest(f,message('current','按最新预算继续')),fresh=f.store.thread(thread.id)!;
  const prepared=await f.manager.prepare({...request(current),threads:[fresh]},'config',50_000),state=prepared.request.taskStates![0];
  expect(state).toMatchObject({threadId:thread.id,revision:fresh.revision,needsRecall:false,snapshot:{byAuthor:[{text:'预算十元'}]}});
  expect(state.updates.map(input=>input.message.text)).toEqual(['更正预算五元']);
});
it('keeps incomplete task histories explicit and accessible through scoped task-input paging',async()=>{
  const f=fixture(),old=ingest(f,message('task-old')),thread=f.store.createThread(old,'条件',true);
  for(let index=0;index<8;index++)f.store.append(f.store.thread(thread.id)!,ingest(f,message('condition-'+index,'条件'+index)),'supplement');
  const current=ingest(f,message('now','复述全部条件')),prepared=await f.manager.prepare({...request(current),threads:[f.store.thread(thread.id)!]},'config',50_000);
  expect(prepared.request.taskStates![0]).toMatchObject({needsRecall:true,nextInputSeq:1,throughInputSeq:9});
  const read=f.store.routerContextReader('room',current.id),page=await read({kind:'task_inputs',id:thread.id,limit:4});
  expect(page.taskInputs?.map(input=>input.seq)).toEqual([1,2,3,4]);expect(page.hasMore).toBe(true);
  const foreign=await f.store.routerContextReader('other')({kind:'task_inputs',id:thread.id});expect(foreign.taskInputs).toEqual([]);
});

it('keeps one failure recovery after initial configuration refresh without resetting shared budgets',async()=>{
 const f=fixture(),old=ingest(f,message('old')),first=await f.manager.prepare(request(old),'before',50_000);finish(f,first);
 const current=ingest(f,message('current')),prepared=await f.manager.prepare(request(current),'after',50_000);
 expect(prepared.turn).toMatchObject({attempts:0,rebuilds:0});expect(prepared.session.generation).toBe(2);
 f.manager.startAttempt(prepared);f.sessions.consumeModelCall(prepared.turn.id,false);
 f.manager.markFailure(prepared,{code:'STRUCTURED_OUTPUT_INVALID',causeCode:'ROUTER_EVIDENCE_UNREAD'});
 // Reopening the manager must not reset attempts, model calls or the deadline.
 const restored=new PersistentRouterManager(f.sessions);restored.recover();
 const retry=await restored.prepare(request(current),'after',50_000);
 expect(retry.turn).toMatchObject({id:prepared.turn.id,attempts:1,rebuilds:1,modelCalls:1,deadlineAt:prepared.turn.deadlineAt});
 restored.startAttempt(retry);restored.markFailure(retry,{code:'TIMEOUT'});
 await expect(restored.prepare(request(current),'after',50_000)).rejects.toMatchObject({code:'ROUTER_REBUILD_LIMIT'});
});

it('does not charge a new request for rebuilding state left by an earlier terminal failure',async()=>{
 const f=fixture(),old=ingest(f,message('failed')),first=await f.manager.prepare(request(old),'config',50_000);
 f.manager.startAttempt(first);f.sessions.failTurn({turnId:first.turn.id,generation:first.session.generation,error:{code:'TIMEOUT'}});
 const current=ingest(f,message('next')),next=await f.manager.prepare(request(current),'config',50_000);
 expect(next.turn).toMatchObject({attempts:0,rebuilds:0});f.manager.startAttempt(next);f.manager.markFailure(next,{code:'TIMEOUT'});
 expect((await f.manager.prepare(request(current),'config',50_000)).turn.rebuilds).toBe(1);
});
