import {afterEach,expect,it,vi} from 'vitest';
import {setImmediate as nextTurn} from 'node:timers/promises';
import {Store} from '../src/store.js';
import {RoomMemoryStore,type MemoryNote} from '../src/room-memory-store.js';
import {RoomMemoryWorker,type MemorySummaryInput,type RoomMemoryWorkerOptions,type MemoryWorkerEvent} from '../src/room-memory-worker.js';
import type {GroupMessage} from '../src/types.js';

const cleanup:Array<()=>Promise<void>>=[];
afterEach(async()=>{vi.useRealTimers();for(const fn of cleanup.splice(0).reverse())await fn();});
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(r=>resolve=r);return {promise,resolve};}
async function until(check:()=>boolean){for(let i=0;i<200;i++){if(check())return;await nextTurn();}throw new Error('Expected background transition did not occur');}
const note=(id:string,seq:number,text='known condition',authorId:string|null='owner'):MemoryNote=>({id,authorId,text,sourceSeqs:[seq]});
function preserve(input:MemorySummaryInput):MemoryNote[]{
 const notes=new Map(input.previousNotes.map(n=>[n.id,n]));
 for(const event of input.events)notes.set('note-'+event.seq,note('note-'+event.seq,event.seq,event.text.slice(-80)||'Source has no textual detail',event.authorId));
 return [...notes.values()];
}
function fixture(overrides:Partial<Omit<RoomMemoryWorkerOptions,'store'>>={}){
 const store=new Store(':memory:'),memory=new RoomMemoryStore(store),calls:MemorySummaryInput[]=[],events:MemoryWorkerEvent[]=[];
 const worker=new RoomMemoryWorker({store:memory,concurrency:2,budget:()=>({inputBudgetBytes:200_000,outputTokens:32,maxOutputTokens:1024}),
  summarize:async input=>{calls.push(structuredClone(input));return preserve(input);},onEvent:event=>events.push(event),...overrides});
 cleanup.push(async()=>{await worker.close();store.close();});
 const add=(id:string,text=id,roomId='room',extra:Partial<GroupMessage>={})=>{
  const message:GroupMessage={id,roomId,messageId:id,platform:'replay',authorId:'owner',authorName:'Owner',text,
   timestamp:Date.now(),mentions:[],attachments:[],isMentioned:false,isAdmin:false,...extra};
  store.ingest(message);return memory.latestSeq(roomId);
 };
 return {store,memory,worker,calls,events,add};
}

it('coalesces immediate arrivals and starts without a message-count or idle-time gate',async()=>{
 const {worker,add,calls,memory}=fixture();add('one');worker.notify('room');const latest=add('two');
 expect(worker.notify('room')).toBeUndefined();expect(calls).toHaveLength(0);
 await worker.whenIdle();expect(calls).toHaveLength(1);expect(calls[0].events.map(e=>e.sourceId)).toEqual(['one','two']);
 expect(memory.memory('room')).toMatchObject({coveredSeq:latest,version:1});
});

it('stops after exhausted model retries and resumes only for a new source target',async()=>{
 let failed=true,attempts=0;
 const {worker,add,memory,events}=fixture({summarize:async input=>{
  attempts++;if(failed)throw Object.assign(new Error('model unavailable'),{code:'MODEL_RETRIES_EXHAUSTED'});
  return preserve(input);
 }});
 add('one');worker.notify('room');
 await expect(worker.whenIdle()).rejects.toMatchObject({code:'MODEL_RETRIES_EXHAUSTED'});
 expect(attempts).toBe(1);expect(memory.memory('room')).toBeNull();
 expect(events.at(-1)).toMatchObject({kind:'failed',code:'MODEL_RETRIES_EXHAUSTED'});expect(events.at(-1)).not.toHaveProperty('retryAt');
 worker.notify('room');await nextTurn();expect(attempts).toBe(1);
 failed=false;const latest=add('two');worker.notify('room');await worker.whenIdle();
 expect(attempts).toBe(2);expect(memory.memory('room')?.coveredSeq).toBe(latest);
});

it('processes an entire fitting backlog beyond former message and character limits',async()=>{
 const {worker,add,calls,memory}=fixture();let latest=0;
 for(let i=0;i<80;i++)latest=add('many-'+i,'Detailed source '+i+' '+String(i).repeat(200));
 worker.notify('room');await worker.whenIdle();expect(calls).toHaveLength(1);
 expect(calls[0].events).toHaveLength(80);expect(Buffer.byteLength(JSON.stringify(calls[0]))).toBeGreaterThan(16_000);
 expect(memory.memory('room')?.coveredSeq).toBe(latest);
});

it('commits its captured prefix after new arrivals and immediately follows with their correction',async()=>{
 const gate=deferred(),entered=deferred(),calls:MemorySummaryInput[]=[];
 const {worker,add,memory,events}=fixture({summarize:async input=>{
  calls.push(structuredClone(input));if(calls.length===1){entered.resolve();await gate.promise;return [note('budget',input.targetSeq,'预算10元')];}
  return [{...note('corrected-budget',input.targetSeq,'预算改为5元'),supersedes:['budget']}];
 }});
 const first=add('budget','预算10元');worker.notify('room');await entered.promise;
 const second=add('correction','不是10元，改成5元');worker.notify('room');gate.resolve();await worker.whenIdle();
 expect(calls.map(call=>call.targetSeq)).toEqual([first,second]);expect(calls[1].previousNotes[0].text).toBe('预算10元');
 expect(events.filter(event=>event.kind==='committed').map(event=>event.coveredSeq)).toEqual([first,second]);
 expect(memory.memory('room')).toMatchObject({version:2,coveredSeq:second,notes:[{id:'corrected-budget',text:'预算改为5元',supersedes:['budget']}]});
});

it('runs different rooms concurrently and gives waiting rooms priority over a hot room followup',async()=>{
 const gateA=deferred(),gateB=deferred(),started:string[]=[];
 const {worker,add}=fixture({concurrency:2,summarize:async input=>{
  started.push(input.roomId);if(input.roomId==='a'&&started.filter(r=>r==='a').length===1)await gateA.promise;
  if(input.roomId==='b')await gateB.promise;return preserve(input);
 }});
 add('a1','a','a');add('b1','b','b');add('c1','c','c');worker.notify('a');worker.notify('b');worker.notify('c');
 await until(()=>started.length===2);expect(started).toEqual(['a','b']);
 add('a2','new a','a');worker.notify('a');gateA.resolve();await until(()=>started.length===4);
 expect(started).toEqual(['a','b','c','a']);gateB.resolve();await worker.whenIdle();
});

it('preserves failure backoff despite new messages and retries the original uncovered prefix',async()=>{
 vi.useFakeTimers({toFake:['setTimeout','clearTimeout','Date']});
 const calls:MemorySummaryInput[]=[];
 const {worker,add,memory}=fixture({retryDelayMs:()=>1000,summarize:async input=>{
  calls.push(structuredClone(input));if(calls.length===1)throw Object.assign(new Error('temporary failure'),{code:'NETWORK'});return preserve(input);
 }});
 add('first');worker.notify('room');await until(()=>worker.status().backoff===1);
 const retryAt=worker.status().pendingRooms[0].retryAt;add('second');worker.notify('room');
 expect(worker.status().pendingRooms[0].retryAt).toBe(retryAt);expect(memory.memory('room')).toBeNull();
 await vi.advanceTimersByTimeAsync(999);expect(calls).toHaveLength(1);
 await vi.advanceTimersByTimeAsync(1);await worker.whenIdle();expect(calls).toHaveLength(2);
 expect(calls[1].coveredSeq).toBe(0);expect(calls[1].events.map(event=>event.sourceId)).toEqual(['first','second']);
});

it('expands output reserve after truncation without advancing the source cursor',async()=>{
 const budgets:number[]=[],calls:MemorySummaryInput[]=[];
 const {worker,add,memory}=fixture({retryDelayMs:()=>0,budget:request=>{
  const outputTokens=request.outputTokens??32;budgets.push(outputTokens);return {inputBudgetBytes:20_000,outputTokens,maxOutputTokens:128};
 },summarize:async input=>{
  calls.push(structuredClone(input));expect(memory.memory('room')).toBeNull();
  if(calls.length===1)throw Object.assign(new Error('truncated'),{code:'MEMORY_OUTPUT_TRUNCATED'});return preserve(input);
 }});
 const latest=add('original','Keep every original condition.');worker.notify('room');await worker.whenIdle();
 expect(budgets).toEqual([32,64]);expect(calls.map(call=>call.coveredSeq)).toEqual([0,0]);
 expect(memory.memory('room')?.coveredSeq).toBe(latest);
});

it('splits the actual overflowing prefix at the real output ceiling instead of clipping notes',async()=>{
 let truncated=0;const completed:number[][]=[];
 const {worker,add,memory}=fixture({retryDelayMs:()=>0,budget:()=>({inputBudgetBytes:200_000,outputTokens:32,maxOutputTokens:32}),summarize:async input=>{
  if(input.events.length>1){truncated++;throw Object.assign(new Error('actual output ceiling'),{code:'MEMORY_OUTPUT_TRUNCATED'});}
  completed.push(input.events.map(event=>event.seq));return preserve(input);
 }});
 add('first');add('second');const latest=add('third');worker.notify('room');await worker.whenIdle();
 expect(truncated).toBeLessThanOrEqual(2);expect(completed.flat()).toEqual([1,2,3]);
 expect(memory.memory('room')?.coveredSeq).toBe(latest);expect(memory.memory('room')?.notes).toHaveLength(3);
});

it('fragments a huge source losslessly and commits only after its final part, collapsing draft lineage',async()=>{
 const seen:MemorySummaryInput[]=[];
 const {worker,add,memory}=fixture({budget:()=>({inputBudgetBytes:1500,outputTokens:128,maxOutputTokens:1024}),summarize:async input=>{
  seen.push(structuredClone(input));expect(memory.memory('room')?.coveredSeq).toBe(1);
  return [{...note('draft-'+seen.length,input.targetSeq,'All original constraints retained; current source still provisional.'),supersedes:[input.previousNotes[0].id]}];
 }});
 add('anchor','Original condition');const batch=memory.batch('room',1,10_000);
 memory.commit({...batch,notes:[note('original-note',1)]});
 const original='新条件🌈'.repeat(700),latest=add('huge',original);worker.notify('room');await worker.whenIdle();
 expect(seen.length).toBeGreaterThan(1);expect(seen.map(call=>call.events[0].text).join('')).toBe(original);
 let offset=0;for(const input of seen){const event=input.events[0];expect(event.textOffset).toBe(offset);offset+=event.text.length;
  expect(Buffer.byteLength(JSON.stringify(input))).toBeLessThanOrEqual(1500);expect(input.coveredSeq).toBe(1);}
 expect(seen.at(-1)!.events[0].finalPart).toBe(true);
 expect(memory.memory('room')).toMatchObject({coveredSeq:latest,notes:[{id:'draft-'+seen.length,supersedes:['original-note']}]});
});

it.each(['foreign_author','future_source','unseen_old_source','silently_dropped_note'])('rejects invalid summary provenance before publication: %s',async kind=>{
 const {worker,add,memory}=fixture({retryDelayMs:()=>60_000,summarize:async input=>{
  if(kind==='silently_dropped_note')return [];
  return [note('invalid',kind==='future_source'?input.targetSeq+1:kind==='unseen_old_source'?1:input.targetSeq,'bad',kind==='foreign_author'?'other':'owner')];
 }});
 add('first');if(kind==='silently_dropped_note'){const base=memory.batch('room',1,20_000);memory.commit({...base,notes:[note('must-retain',1)]});add('next');}
 if(kind==='unseen_old_source'){const base=memory.batch('room',1,20_000);memory.commit({...base,notes:[]});add('next');}
 const old=memory.memory('room');worker.notify('room');await until(()=>worker.status().backoff===1);
 expect(memory.memory('room')).toEqual(old);expect(worker.status().pendingRooms[0].lastError).toMatch(/^MEMORY_(SOURCE|NOTES)_INVALID$/);
});

it('supplies a safe repair hint after invalid output while keeping rejected notes out of the next input',async()=>{
 const calls:MemorySummaryInput[]=[];
 const {worker,add,memory}=fixture({retryDelayMs:()=>0,summarize:async input=>{
  calls.push(structuredClone(input));if(calls.length===1)return [note('untrusted',input.targetSeq+1,'UNVERIFIED SECRET CONCLUSION')];return preserve(input);
 }});
 add('current');worker.notify('room');await worker.whenIdle();
 expect(calls).toHaveLength(2);expect(calls[1].repairHint).toMatchObject({code:'MEMORY_SOURCE_INVALID'});
 expect(calls[1].previousNotes).toEqual([]);expect(JSON.stringify(calls[1])).not.toContain('UNVERIFIED SECRET CONCLUSION');
 expect(memory.memory('room')?.version).toBe(1);
});

it('returns all visible author mismatches together and commits only after precise source repair',async()=>{
 vi.useFakeTimers({toFake:['setTimeout','clearTimeout','Date']});
 const calls:MemorySummaryInput[]=[];
 const {worker,add,memory}=fixture({retryDelayMs:()=>1000,summarize:async input=>{
  calls.push(structuredClone(input));
  if(calls.length===1)return [...input.previousNotes,{id:'mixed-condition',authorId:'owner',text:'UNVERIFIED NOTE BODY',sourceSeqs:input.events.map(event=>event.seq)}];
  expect(memory.memory('room')?.coveredSeq).toBe(1);
  return preserve(input);
 }});
 const anchor=add('anchor','Original private requirement');
 memory.commit({...memory.batch('room',anchor,20_000),notes:[note('retain-anchor',anchor,'Existing condition')]});
 const own=add('current-own','PRIVATE OWNER BODY');
 const foreignSources=Array.from({length:15},(_,i)=>add('member-'+i,'PRIVATE MEMBER BODY '+i,'room',{authorId:'member-'+i}));
 worker.notify('room');await until(()=>worker.status().backoff===1);
 expect(memory.memory('room')?.coveredSeq).toBe(anchor);
 expect(worker.status().pendingRooms[0].lastError).toBe('MEMORY_SOURCE_INVALID');
 await vi.advanceTimersByTimeAsync(1000);await worker.whenIdle();
 expect(calls).toHaveLength(2);
 const reason=calls[1].repairHint!.reason,diagnostic=JSON.parse(reason.slice(reason.indexOf('{"issues":')));
 expect(diagnostic).toMatchObject({totalIssues:15,omittedIssues:0});
 expect(diagnostic.issues).toEqual(foreignSources.map((sourceSeq,i)=>({noteId:'mixed-condition',noteIndex:1,reason:'authorMismatch',sourceSeq,expectedAuthorId:'owner',actualAuthorId:'member-'+i})));
 expect(reason).not.toContain('PRIVATE');expect(reason).not.toContain('UNVERIFIED NOTE BODY');
 expect(calls[1].previousNotes.map(note=>note.id)).toEqual(['retain-anchor']);
 expect(memory.memory('room')?.coveredSeq).toBe(foreignSources.at(-1));
 expect(memory.memory('room')?.notes.map(note=>note.id)).toContain('retain-anchor');
 expect(memory.memory('room')?.notes.find(note=>note.sourceSeqs.includes(own))?.authorId).toBe('owner');
});

it('diagnoses an unavailable source without looking up or disclosing another room',async()=>{
 const calls:MemorySummaryInput[]=[];let foreignSeq=0;
 const {worker,add,memory}=fixture({retryDelayMs:()=>0,summarize:async input=>{
  calls.push(structuredClone(input));
  if(calls.length===1)return [{...note('bad-source',input.targetSeq,'UNVERIFIED BODY'),sourceSeqs:[input.targetSeq,foreignSeq,input.targetSeq+1]}];
  return preserve(input);
 }});
 foreignSeq=add('hidden-platform-id','OTHER ROOM SECRET','foreign-room',{authorId:'private-foreign-owner'});
 const latest=add('current','CURRENT SOURCE SECRET');worker.notify('room');await worker.whenIdle();
 const reason=calls[1].repairHint!.reason,diagnostic=JSON.parse(reason.slice(reason.indexOf('{"issues":')));
 expect(diagnostic).toMatchObject({totalIssues:2,omittedIssues:0,issues:[
  {noteId:'bad-source',reason:'sourceNotVisible',sourceSeq:foreignSeq},
  {noteId:'bad-source',reason:'sourceNotVisible',sourceSeq:latest+1},
 ]});
 for(const issue of diagnostic.issues){expect(issue).not.toHaveProperty('actualAuthorId');expect(issue).not.toHaveProperty('expectedAuthorId');}
 for(const secret of ['PRIVATE','SECRET','UNVERIFIED BODY','foreign-room','private-foreign-owner','hidden-platform-id'])expect(reason).not.toContain(secret);
 expect(memory.memory('foreign-room')).toBeNull();expect(memory.memory('room')?.coveredSeq).toBe(latest);
});

it('locates changed note authors and author notes with only bot reply sources without relaxing either check',async()=>{
 const calls:MemorySummaryInput[]=[];
 const {worker,add,memory,store}=fixture({retryDelayMs:()=>0,summarize:async input=>{
  calls.push(structuredClone(input));
  if(calls.length===1)return [note('fixed-owner',input.events.find(event=>event.kind==='message')!.seq,'UNVERIFIED CHANGED OWNER','other'),
   note('reply-only',input.events.find(event=>event.kind==='reply')!.seq,'UNVERIFIED REPLY OWNER')];
  return preserve(input);
 }});
 const anchor=add('anchor');memory.commit({...memory.batch('room',anchor,20_000),notes:[note('fixed-owner',anchor)]});
 add('other','OTHER PRIVATE MESSAGE','room',{authorId:'other'});
 store.enqueue({roomId:'room',text:'PRIVATE BOT BODY'},{id:'confirmed',status:'sent',sentAt:Date.now(),platformMessageId:'confirmed-id'});
 worker.notify('room');await worker.whenIdle();
 const reason=calls[1].repairHint!.reason,diagnostic=JSON.parse(reason.slice(reason.indexOf('{"issues":')));
 expect(diagnostic.issues).toEqual([
  {noteId:'fixed-owner',noteIndex:0,reason:'noteAuthorChanged',expectedAuthorId:'owner',actualAuthorId:'other'},
  {noteId:'reply-only',noteIndex:1,reason:'missingAuthorSource',expectedAuthorId:'owner'},
 ]);
 expect(reason).not.toContain('PRIVATE');expect(reason).not.toContain('UNVERIFIED');
 expect(memory.memory('room')?.notes.find(note=>note.id==='fixed-owner')?.authorId).toBe('owner');
});

it('bounds only diagnostic metadata while preserving all corrected facts',async()=>{
 const calls:MemorySummaryInput[]=[];
 const {worker,add,memory}=fixture({retryDelayMs:()=>0,summarize:async input=>{
  calls.push(structuredClone(input));
  if(calls.length===1)return [{id:'untrusted-id-'.repeat(100),authorId:'untrusted-owner-'.repeat(100),text:'UNVERIFIED BODY',sourceSeqs:input.events.map(event=>event.seq)}];
  return preserve(input);
 }});
 for(let i=0;i<40;i++)add('source-'+i,'PRIVATE ORIGINAL '+i);
 worker.notify('room');await worker.whenIdle();
 const reason=calls[1].repairHint!.reason,diagnostic=JSON.parse(reason.slice(reason.indexOf('{"issues":')));
 expect(diagnostic).toMatchObject({totalIssues:40,omittedIssues:8});expect(diagnostic.issues).toHaveLength(32);
 expect(diagnostic.issues[0]).toMatchObject({noteIdTruncated:true,expectedAuthorIdTruncated:true});
 expect(diagnostic.issues[0].noteId.length).toBe(256);expect(diagnostic.issues[0].expectedAuthorId.length).toBe(256);
 expect(Buffer.byteLength(reason)).toBeLessThan(32_000);expect(reason).not.toContain('PRIVATE ORIGINAL');expect(reason).not.toContain('UNVERIFIED BODY');
 expect(memory.memory('room')?.notes).toHaveLength(40);
});

it('keeps complete inactive facts when durable memory exceeds actual capacity and still covers a new correction',async()=>{
 const calls:MemorySummaryInput[]=[];
 const {worker,add,memory}=fixture({budget:()=>({inputBudgetBytes:1500,outputTokens:128,maxOutputTokens:1024}),summarize:async input=>{
  calls.push(structuredClone(input));return [...input.previousNotes,note('new-budget',input.events[0].seq,'最新明确更正：预算5元；未提供旧记录的其他条件仍保留')];
 }});
 const oldSeq=add('old','预算10元，并保留全部原始条件');
 const large=note('large-old-condition',oldSeq,'预算10元；'+ '不得丢失的旧条件🌈'.repeat(800));
 const oldBatch=memory.batch('room',oldSeq,20_000);memory.commit({...oldBatch,notes:[large]});
 const latest=add('new','预算改成5元，其他条件不变');worker.notify('room');await worker.whenIdle();
 expect(calls).toHaveLength(1);expect(calls[0]).toMatchObject({partialMemory:true,inactiveNotesCount:1,previousNotes:[]});
 expect(Buffer.byteLength(JSON.stringify(calls[0]))).toBeLessThanOrEqual(1500);
 expect(memory.memory('room')?.coveredSeq).toBe(latest);
 expect(memory.memory('room')?.notes).toEqual([large,note('new-budget',latest,'最新明确更正：预算5元；未提供旧记录的其他条件仍保留')]);
});

it.each(['overwrite','supersede'])('rejects a model attempt to %s an inactive unseen old note',async mode=>{
 const {worker,add,memory}=fixture({budget:()=>({inputBudgetBytes:1500,outputTokens:128,maxOutputTokens:1024}),retryDelayMs:()=>60_000,summarize:async input=>{
  expect(input).toMatchObject({partialMemory:true,inactiveNotesCount:1,previousNotes:[]});
  return [{...note(mode==='overwrite'?'protected-old':'replacement',input.targetSeq,'未读原条件不能被撤销'),...(mode==='supersede'?{supersedes:['protected-old']}:{} )}];
 }});
 const oldSeq=add('old');const large=note('protected-old',oldSeq,'完整原始条件'.repeat(800));
 const batch=memory.batch('room',oldSeq,20_000);memory.commit({...batch,notes:[large]});const before=memory.memory('room');
 add('new');worker.notify('room');await until(()=>worker.status().backoff===1);
 expect(memory.memory('room')).toEqual(before);
 expect(worker.status().pendingRooms[0].lastError).toMatch(/^MEMORY_(SOURCE|SUPERSEDES)_INVALID$/);
});

it('keeps all prior notes active whenever the complete memory fits actual capacity',async()=>{
 const {worker,add,memory,calls}=fixture();const oldSeq=add('old');
 const existing=[note('first-condition',oldSeq,'预算10元'),note('second-condition',oldSeq,'不要使用稀有文档')];
 const batch=memory.batch('room',oldSeq,20_000);memory.commit({...batch,notes:existing});
 add('new','继续');worker.notify('room');await worker.whenIdle();
 expect(calls).toHaveLength(1);expect(calls[0].previousNotes).toEqual(existing);expect(calls[0]).not.toHaveProperty('partialMemory');
 expect(memory.memory('room')?.notes.slice(0,existing.length)).toEqual(existing);
});

it('freezes complete growing fragment drafts when they exceed capacity without skipping original text',async()=>{
 const calls:MemorySummaryInput[]=[],created:MemoryNote[]=[];
 const {worker,add,memory}=fixture({budget:()=>({inputBudgetBytes:1500,outputTokens:256,maxOutputTokens:1024}),summarize:async input=>{
  calls.push(structuredClone(input));expect(memory.memory('room')).toBeNull();
  const current=note('fragment-'+calls.length,input.events[0].seq,'Source offset '+input.events[0].textOffset+'; '+ 'preserve this fact '.repeat(45));
  created.push(current);return [...input.previousNotes,current];
 }});
 const original='Every source character remains available 🌈. '.repeat(120),latest=add('huge',original);
 worker.notify('room');await worker.whenIdle();
 expect(calls.length).toBeGreaterThan(3);expect(calls.some(input=>input.partialMemory)).toBe(true);
 expect(calls.map(input=>input.events[0].text).join('')).toBe(original);
 for(const input of calls)expect(Buffer.byteLength(JSON.stringify(input))).toBeLessThanOrEqual(1500);
 expect(calls.at(-1)?.events[0].finalPart).toBe(true);
 expect(memory.memory('room')?.coveredSeq).toBe(latest);
 expect(memory.memory('room')?.notes).toHaveLength(created.length);
 for(const originalNote of created)expect(memory.memory('room')?.notes).toContainEqual(originalNote);
});

it('reduces active prior memory only after observing the real output ceiling, preserving the full ledger',async()=>{
 const calls:MemorySummaryInput[]=[];
 const {worker,add,memory}=fixture({retryDelayMs:()=>0,budget:()=>({inputBudgetBytes:20_000,outputTokens:32,maxOutputTokens:32}),summarize:async input=>{
  calls.push(structuredClone(input));if(input.previousNotes.length)throw Object.assign(new Error('actual output ceiling'),{code:'MEMORY_OUTPUT_TRUNCATED'});
  return [note('new-delta',input.events[0].seq,'Latest explicit correction; all other existing facts retained')];
 }});
 const oldSeq=add('old'),large=note('existing-condition',oldSeq,'Existing fact '.repeat(150));
 const batch=memory.batch('room',oldSeq,20_000);memory.commit({...batch,notes:[large]});
 const latest=add('new','A new correction');worker.notify('room');await worker.whenIdle();
 expect(calls).toHaveLength(2);expect(calls[0].previousNotes).toEqual([large]);expect(calls[0]).not.toHaveProperty('partialMemory');
 expect(calls[1]).toMatchObject({partialMemory:true,inactiveNotesCount:1,previousNotes:[]});
 expect(memory.memory('room')?.coveredSeq).toBe(latest);expect(memory.memory('room')?.notes[0]).toEqual(large);
 expect(memory.memory('room')?.notes[1].id).toBe('new-delta');
});

it('discards a stale epoch and rebuilds from originals without cancelling for ordinary arrivals',async()=>{
 const entered=deferred(),gate=deferred();let attempts=0,firstSignal:AbortSignal|undefined;
 const {worker,add,memory,events}=fixture({summarize:async(input,signal)=>{
  attempts++;if(attempts===1){firstSignal=signal;entered.resolve();await gate.promise;}return preserve(input);
 }});
 add('original');worker.notify('room');await entered.promise;const epoch=memory.reset('room');
 worker.notify('room');expect(firstSignal!.aborted).toBe(false);gate.resolve();await worker.whenIdle();
 expect(attempts).toBe(2);expect(events.some(event=>event.kind==='superseded')).toBe(true);
 expect(memory.memory('room')).toMatchObject({epoch,version:1});
});

it('advances an invalidated empty prefix without a hot retry loop or invented notes',async()=>{
 const {worker,add,memory,store,calls}=fixture();add('deleted');store.db.prepare('DELETE FROM messages WHERE id=?').run('deleted');
 worker.notify('room');await worker.whenIdle();expect(calls).toHaveLength(0);
 expect(memory.memory('room')).toMatchObject({coveredSeq:1,notes:[]});
});

it('keeps reference and image-existence facts without attachment locators or source object fields',async()=>{
 const {worker,add,calls}=fixture();add('image','请看图','room',{replyToMessageId:'prior',mentions:['other'],attachments:[{kind:'image',url:'https://private.invalid/token-secret',file:'/private/source'}]});
 worker.notify('room');await worker.whenIdle();const encoded=JSON.stringify(calls);
 expect(encoded).not.toContain('private');expect(encoded).not.toContain('token-secret');expect(calls[0].events[0]).not.toHaveProperty('message');
 expect(calls[0].events[0]).toMatchObject({messageId:'image',replyToMessageId:'prior',mentions:['other'],hasImage:true,authorName:'Owner'});
});

it('lets an offline idle wait expire without aborting work, then cancels all work on close',async()=>{
 const entered=deferred();let aborted=false,calls=0;
 const {worker,add,memory}=fixture({concurrency:1,summarize:async(_input,signal)=>{
  calls++;entered.resolve();await new Promise<void>((_resolve,reject)=>signal.addEventListener('abort',()=>{aborted=true;reject(signal.reason);},{once:true}));return [];
 }});
 add('one','one','a');add('two','two','b');worker.notify('a');worker.notify('b');await entered.promise;
 const waitAbort=new AbortController(),waiting=worker.whenIdle(waitAbort.signal);waitAbort.abort(new Error('offline deadline'));
 await expect(waiting).rejects.toThrow('offline deadline');expect(aborted).toBe(false);
 await worker.close();expect(aborted).toBe(true);expect(calls).toBe(1);expect(memory.memory('a')).toBeNull();expect(memory.memory('b')).toBeNull();
 expect(worker.status()).toMatchObject({closed:true,running:0,queued:0});
});
