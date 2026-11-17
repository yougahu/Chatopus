import {afterEach,expect,it,vi} from 'vitest';
import {Store} from '../src/store.js';
import {attachRoomMemory,buildRouterPayload} from '../src/router-context-builder.js';
import {parseRoutesForRequest} from '../src/protocol.js';
import type {GroupMessage,RouterRequest} from '../src/types.js';

const stores:Store[]=[];
afterEach(()=>{vi.restoreAllMocks();for(const store of stores.splice(0))store.close();});
const config={recentMessageLimit:1,threadCardLimit:1};
const message=(id:string,text=id,roomId='room',timestamp=1):GroupMessage=>({id:`${roomId}:${id}`,messageId:id,roomId,platform:'replay',authorId:'owner',authorName:'Owner',text,timestamp,mentions:[],attachments:[],isMentioned:true,isAdmin:false});
const request=(messages:GroupMessage[],extra:Partial<RouterRequest>={}):RouterRequest=>({roomId:'room',event:'messages',messages,recentMessages:[],threads:[],...extra});
function store(){const result=new Store(':memory:');stores.push(result);return result;}
function remember(s:Store,text='预算20元',id='budget'){
  const batch=s.roomMemory.batch('room',s.roomMemory.latestSeq('room'));
  return s.roomMemory.commit({roomId:'room',epoch:batch.epoch,baseVersion:batch.baseVersion,untilSeq:batch.untilSeq,sourceDigest:batch.sourceDigest,
    notes:[...(batch.base?.notes??[]),{id,authorId:'owner',text,sourceSeqs:[batch.events[0].seq]}]})!;
}
const payload=(r:RouterRequest,budget?:number)=>JSON.parse(buildRouterPayload(r,config,true,budget)) as RouterRequest;

it('renders current, recent and multiply quoted originals once per identity',()=>{
  const current=message('current','UNIQUE_CURRENT_BODY'),other=message('second'),old=message('old','UNIQUE_OLD_BODY');
  const r=request([current,other],{recentMessages:[current,old,old],references:{
    [current.id]:{status:'unbound',message:old,chain:[old.messageId]},
    [other.id]:{status:'unbound',message:old,chain:[old.messageId]},
  }});
  const json=buildRouterPayload(r,config,true),parsed=JSON.parse(json);
  expect(json.split(current.text)).toHaveLength(2);expect(json.split(old.text)).toHaveLength(2);
  expect(parsed.recentMessages.map((m:GroupMessage)=>m.id)).toEqual([old.id]);
  expect(parsed.references[current.id]).toMatchObject({messageRef:old.id});expect(parsed.references[current.id]).not.toHaveProperty('message');
  expect(r.references![current.id].message).toEqual(old);
});

it('keeps one authoritative body when a current original also appears in a reference',()=>{
  const current=message('current','CURRENT_IS_AUTHORITATIVE');
  const json=buildRouterPayload(request([current,current],{recentMessages:[{...current,text:'stale'}],references:{[current.id]:{status:'unbound',message:current,chain:[current.messageId]}}}),config,true);
  expect(JSON.parse(json).messages).toHaveLength(1);expect(JSON.parse(json).recentMessages).toEqual([]);expect(json.split(current.text)).toHaveLength(2);expect(json).not.toContain('stale');
  expect(()=>payload(request([current,{...current,text:'conflicting current body'}]))).toThrow('Conflicting current');
});

it('preserves long current questions and explicit quoted originals without legacy character clipping',()=>{
  const current=message('current','完整问题'.repeat(3000)),quoted=message('quoted','明确引用'.repeat(2500));
  const r=request([current],{recentMessages:[message('optional','可省略'.repeat(3000))],references:{[current.id]:{status:'unbound',message:quoted,chain:[quoted.messageId]}}});
  const minimal=buildRouterPayload({...r,recentMessages:[]},config,true);
  const result=payload(r,Buffer.byteLength(minimal)+250);
  expect(result.messages[0].text).toBe(current.text);expect(result.recentMessages.find(m=>m.id===quoted.id)?.text).toBe(quoted.text);
  expect(result.workingMemory?.omittedContext).toBe(true);
  expect(()=>payload(r,Buffer.byteLength(minimal)-1)).toThrow('cannot fit');
});

it('deduplicates confirmed replies and preserves the complete quoted reply',()=>{
  const current=message('current'),reply={messageId:'bot-1',text:'完整机器人回复'.repeat(2000),sentAt:1};
  const r=request([current],{recentReplies:[reply,reply],references:{[current.id]:{status:'unbound',reply,chain:['bot-1']}}});
  const json=buildRouterPayload(r,config,true),parsed=JSON.parse(json);
  expect(parsed.recentReplies).toEqual([reply]);expect(parsed.references[current.id].replyRef).toBe('bot-1');expect(parsed.references[current.id].reply).toBeUndefined();
  expect(json.split(reply.text)).toHaveLength(2);
  expect(()=>payload(r,1000)).toThrow('cannot fit');
});

it('accounts for the omission marker while selecting optional history under a tight byte budget',()=>{
  const current=message('current'),old1=message('old1','older'.repeat(100)),old2=message('old2','newer'.repeat(100));
  const marker={epoch:0,version:0,coveredSeq:0,cutoffSeq:0,notes:[],omittedContext:true};
  const fitting=request([current],{recentMessages:[old2],workingMemory:marker});
  const budget=Buffer.byteLength(buildRouterPayload(fitting,config,true));
  const json=buildRouterPayload(request([current],{recentMessages:[old1,old2]}),config,true,budget);
  expect(Buffer.byteLength(json)).toBeLessThanOrEqual(budget);expect(JSON.parse(json).recentMessages.map((m:GroupMessage)=>m.id)).toEqual([old2.id]);
});

it('never emits raw image locators but preserves the complete current text',()=>{
  const current={...message('current','图片条件'.repeat(1500)),attachments:[{kind:'image' as const,url:'https://private.invalid/token',file:'/private/image.png'}]};
  const json=buildRouterPayload(request([current]),config,true);expect(json).not.toContain('private');expect(JSON.parse(json).messages[0].text).toBe(current.text);
  expect(JSON.parse(json).messages[0].attachments).toEqual([{kind:'image',hasImage:true,attachmentIndex:0}]);
});

it('excludes foreign and future intake from memory attachment regardless of timestamps or supplied history',()=>{
  const s=store(),old=message('old'),current=message('current'),future=message('future','FUTURE_SECRET','room',-500),foreign=message('foreign','FOREIGN_SECRET','other',-1000);
  s.ingest(old,100);s.ingest(current,200);s.ingest(future,0);s.ingest(foreign,0);
  const result=attachRoomMemory(s,request([current],{recentMessages:[old,current,future,foreign]}),100000);
  expect(result.recentMessages.map(m=>m.id)).toEqual([old.id]);expect(JSON.stringify(result)).not.toContain('FUTURE_SECRET');expect(JSON.stringify(result)).not.toContain('FOREIGN_SECRET');
  expect(result.workingMemory?.cutoffSeq).toBe(s.roomMemory.event('room',1)?.seq);
  expect(()=>attachRoomMemory(s,request([current],{references:{[current.id]:{status:'unbound',message:future,chain:[future.messageId]}}}),100000)).toThrow('intake scope');
});

it('rejects foreign current inputs and foreign explicit references before serialization',()=>{
  const current=message('current'),foreign=message('foreign','private','other');
  expect(()=>payload(request([foreign]))).toThrow('scope');
  expect(()=>payload(request([current],{references:{[current.id]:{status:'unbound',message:foreign,chain:[foreign.messageId]}}}))).toThrow('scope');
});

it('permits an explicit quote of earlier current intake without admitting later unrelated history',()=>{
  const s=store(),first=message('first','FIRST_CURRENT'),second=message('second','引用第一条'),future=message('future','UNRELATED_FUTURE');
  s.ingest(first);s.enqueue({roomId:'room',text:'BETWEEN_REPLY'},{id:'between',status:'sent',sentAt:1,platformMessageId:'bot-between'});s.ingest(second);s.ingest(future);
  const referenced=request([first,second],{recentMessages:[future],references:{[second.id]:{status:'unbound',message:first,reply:{messageId:'bot-between',text:'BETWEEN_REPLY',sentAt:1},chain:['bot-between',first.messageId]}}});
  const attached=attachRoomMemory(s,referenced,100000),json=buildRouterPayload(attached,config,true),shown=JSON.parse(json);
  expect(shown.messages).toHaveLength(2);expect(shown.recentMessages).toEqual([]);expect(shown.recentReplies[0].text).toBe('BETWEEN_REPLY');expect(json).not.toContain('UNRELATED_FUTURE');expect(json.split(first.text)).toHaveLength(2);
  expect(()=>attachRoomMemory(s,request([first,second],{references:{[first.id]:{status:'unbound',message:second,chain:[second.messageId]}}}),100000)).toThrow('intake scope');
});

it('keeps unsummarized corrections in receipt order even if platform timestamps go backwards',()=>{
  const s=store(),old=message('old','预算20元','room',500),corrected=message('correction','预算改成5元','room',1),current=message('current','按新预算继续','room',-1);
  s.ingest(old);remember(s);s.ingest(corrected);s.ingest(current);
  const result=attachRoomMemory(s,request([current],{recentMessages:[old]}),100000);
  expect(result.workingMemory?.notes[0].text).toBe('预算20元');expect(result.recentMessages.map(m=>m.text)).toEqual(['预算20元','预算改成5元']);
  const model=payload(result);expect(model.recentMessages.at(-1)?.text).toBe(corrected.text);
});

it('exposes a bounded latest delta tail and an explicit gap for accumulated older originals',()=>{
  const s=store();for(let i=0;i<8;i++)s.ingest(message(String(i),`condition-${i} `+'文'.repeat(300)));
  const current=message('current');s.ingest(current);
  const result=attachRoomMemory(s,request([current]),16000);
  expect(result.recentMessages.at(-1)?.messageId).toBe('7');expect(result.recentMessages.length).toBeLessThan(8);
  expect(result.workingMemory?.gap?.fromSeq).toBe(1);expect(result.workingMemory?.gap?.toSeq).toBeLessThan(result.workingMemory!.cutoffSeq);
  expect(s.roomMemory.events('room',{inputBudgetBytes:100000})).toHaveLength(9);
});

it('uses a version covered before the current intake and never leaks a later summarized correction',()=>{
  const s=store(),old=message('old','旧条件'),current=message('current'),future=message('future','未来更正');
  s.ingest(old);const v1=remember(s,'旧条件','old');s.ingest(current);s.ingest(future);remember(s,'未来更正','future');
  const result=attachRoomMemory(s,request([current]),100000);
  expect(result.workingMemory).toMatchObject({version:v1.version,coveredSeq:v1.coveredSeq,cutoffSeq:v1.coveredSeq});
  expect(JSON.stringify(result)).not.toContain('未来更正');
});

it('renders note source identities as hints without authorizing historical action/context IDs',()=>{
  const s=store(),old=message('old','记住代号Star-83'),current=message('current','代号是什么');s.ingest(old);remember(s,'代号Star-83','code');s.ingest(current);
  const lookup=vi.spyOn(s.roomMemory,'eventsBySeq');
  const attached=attachRoomMemory(s,request([current]),100000),shown=payload(attached);
  expect(lookup).toHaveBeenCalledTimes(1);expect(shown.recentMessages).toEqual([]);
  expect(shown.workingMemory!.notes[0].sources).toEqual([{seq:1,kind:'message',id:old.id,authorId:'owner'}]);
  expect(()=>parseRoutesForRequest(JSON.stringify([{action:'open_thread',sourceMessageIds:[current.id],contextMessageIds:[old.id],subject:'继续'}]),shown)).toThrow('scope');
  expect(()=>parseRoutesForRequest(JSON.stringify([{action:'silence',sourceMessageIds:[old.id]}]),shown)).toThrow('source messages');
  expect(parseRoutesForRequest(JSON.stringify([{action:'reply_direct',sourceMessageIds:[current.id],text:'你记住的代号是Star-83。'}]),shown)).toHaveLength(1);
});

it('allows the same remembered original as context only after the host explicitly supplies it',()=>{
  const s=store(),old=message('old'),current=message('current');s.ingest(old);remember(s);s.ingest(current);
  const shown=payload(attachRoomMemory(s,request([current],{references:{[current.id]:{status:'unbound',message:old,chain:[old.messageId]}}}),100000));
  expect(parseRoutesForRequest(JSON.stringify([{action:'open_thread',sourceMessageIds:[current.id],contextMessageIds:[old.id],subject:'按引用继续'}]),shown)).toHaveLength(1);
});

it('filters confirmed replies by their indexed send boundary, not forged send timestamps',()=>{
  const s=store();s.enqueue({roomId:'room',text:'EARLIER'},{id:'earlier',status:'sent',sentAt:100,platformMessageId:'bot-old'});
  const current=message('current');s.ingest(current);
  s.enqueue({roomId:'room',text:'FUTURE_REPLY'},{id:'later',status:'sent',sentAt:1,platformMessageId:'bot-new'});
  s.enqueue({roomId:'other',text:'FOREIGN_REPLY'},{id:'foreign',status:'sent',sentAt:1,platformMessageId:'bot-foreign'});
  const result=attachRoomMemory(s,request([current],{recentReplies:[{messageId:'bot-old',text:'fake',sentAt:0},{messageId:'bot-new',text:'FUTURE_REPLY',sentAt:1},{messageId:'bot-foreign',text:'FOREIGN_REPLY',sentAt:1}]}),100000);
  expect(result.recentReplies?.map(r=>r.text)).toEqual(['EARLIER']);
});

it('selects whole relevant author notes within real capacity while retaining omitted notes in storage',async()=>{
  const s=store(),own=message('own','预算20元'),other={...message('other','预算500元'),authorId:'other'};
  s.ingest(own);s.ingest(other);const batch=s.roomMemory.batch('room',s.roomMemory.latestSeq('room'));
  const notes=[{id:'other-budget',authorId:'other',text:'预算500元',sourceSeqs:[batch.events[1].seq]},
    {id:'own-budget',authorId:'owner',text:'预算20元',sourceSeqs:[batch.events[0].seq]},
    {id:'large-background',authorId:'owner',text:'旧的无关背景'.repeat(10000),sourceSeqs:[batch.events[0].seq]}];
  s.roomMemory.commit({...batch,notes});const current=message('current','预算是多少');s.ingest(current);
  const attached=attachRoomMemory(s,request([current]),1000000),chosen=attached.workingMemory!.notes.find(n=>n.id==='own-budget')!;
  const shell={...attached,workingMemory:{...attached.workingMemory!,notes:[],omittedNotes:true,availableNotes:notes.length}};
  const budget=Buffer.byteLength(buildRouterPayload(shell,config,true))+Buffer.byteLength(JSON.stringify(chosen));
  const json=buildRouterPayload(attached,config,true,budget),shown=JSON.parse(json);
  expect(Buffer.byteLength(json)).toBeLessThanOrEqual(budget);expect(shown.messages[0].text).toBe(current.text);
  expect(shown.workingMemory).toMatchObject({omittedNotes:true,availableNotes:3});expect(shown.workingMemory.notes).toEqual([chosen]);
  expect(s.roomMemory.memory('room')?.notes).toEqual(notes);
  const page=await s.routerContextReader('room',current.id)({kind:'memory',id:'large-background'});
  expect(page.memories?.[0].text).toBe(notes[2].text);expect(page.messages).toBeUndefined();
  expect(page.memories?.[0].sources).toEqual([{seq:batch.events[0].seq,kind:'message',id:own.id,authorId:'owner'}]);
});

it('never rejects a fitting current question or explicit quote because persisted notes are too large',()=>{
  const current=message('current','当前完整问题'.repeat(1000)),quoted=message('quoted','明确引用原文'.repeat(1000));
  const r=request([current],{references:{[current.id]:{status:'unbound',message:quoted,chain:[quoted.messageId]}},workingMemory:{epoch:0,version:1,coveredSeq:1,cutoffSeq:1,
    notes:[{id:'oversized',authorId:'owner',text:'历史记忆'.repeat(20000),sourceSeqs:[1],sources:[{seq:1,kind:'message',id:'room:old',authorId:'owner'}]}]}});
  const essential=buildRouterPayload({...r,workingMemory:{...r.workingMemory!,notes:[],omittedNotes:true,availableNotes:1}},config,true);
  const result=payload(r,Buffer.byteLength(essential));
  expect(result.messages[0].text).toBe(current.text);expect(result.recentMessages[0].text).toBe(quoted.text);expect(result.workingMemory).toMatchObject({notes:[],omittedNotes:true,availableNotes:1});
});

it('preserves the configured task-card limit with explicit quoted threads pinned first',()=>{
  const s=store(),current=message('current'),first=s.createThread(message('a'),'first',true),second=s.createThread(message('b'),'second',true);
  const plain=payload(request([current],{threads:[first,second]}));expect(plain.threads.map(t=>t.id)).toEqual([first.id]);
  expect(()=>parseRoutesForRequest(JSON.stringify([{action:'append_thread',sourceMessageIds:[current.id],threadId:second.id}]),plain)).toThrow('Thread outside');
  const quoted=payload(request([current],{threads:[first,second],references:{[current.id]:{status:'resolved',threadId:second.id,chain:['quoted']}}}));
  expect(quoted.threads.map(t=>t.id)).toEqual([second.id]);
  expect(parseRoutesForRequest(JSON.stringify([{action:'append_thread',sourceMessageIds:[current.id],threadId:second.id}]),quoted)).toHaveLength(1);
});
