import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { RoomMemoryStore, type MemoryBatch, type MemoryNote } from '../src/room-memory-store.js';
import type { GroupMessage } from '../src/types.js';

const stores:Store[]=[],dirs:string[]=[];
afterEach(()=>{for(const store of stores.splice(0))store.close();for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true});});
const message=(id:string,text=id,authorId='owner',roomId='room'):GroupMessage=>({id:`${roomId}:${id}`,roomId,messageId:id,platform:'replay',authorId,authorName:authorId,text,timestamp:1,mentions:[],attachments:[],isMentioned:false,isAdmin:false});
function fixture(path=':memory:'){const store=new Store(path);stores.push(store);return store;}
function note(batch:MemoryBatch,id='fact',text='预算20元'):MemoryNote{return {id,authorId:'owner',text,sourceSeqs:[batch.events[0].seq]};}
function commit(store:Store,batch:MemoryBatch,notes:MemoryNote[]){return store.roomMemory.commit({roomId:batch.roomId,epoch:batch.epoch,baseVersion:batch.baseVersion,untilSeq:batch.untilSeq,sourceDigest:batch.sourceDigest,notes});}

it('indexes each intake once in receipt order, independent of forged timestamps',()=>{
  const store=fixture();const first=message('first'),second={...message('second'),timestamp:-100000};
  expect(store.ingest(first,100)).toBe(true);expect(store.ingest(first,1)).toBe(false);store.ingest(second,0);
  const events=store.roomMemory.events('room');expect(events.map(e=>e.sourceId)).toEqual([first.id,second.id]);
  expect(events.map(e=>e.message)).toEqual([first,second]);
  const columns=store.db.prepare('PRAGMA table_info(room_memory_events)').all().map(r=>r.name);
  expect(columns).not.toContain('text');expect(columns).not.toContain('data');
});

it('rolls back source and memory index together, including existing outer transactions',()=>{
  const store=fixture();
  expect(()=>store.transaction(()=>{store.ingest(message('rolled-back'));throw new Error('abort');})).toThrow('abort');
  expect(store.message('room:rolled-back')).toBeUndefined();expect(store.roomMemory.latestSeq('room')).toBe(0);
  store.db.exec("CREATE TRIGGER fail_memory BEFORE INSERT ON room_memory_events BEGIN SELECT RAISE(ABORT,'index failed'); END;");
  expect(()=>store.ingest(message('failure'))).toThrow('index failed');expect(store.message('room:failure')).toBeUndefined();
  store.db.exec('DROP TRIGGER fail_memory');store.transaction(()=>store.ingest(message('ok')));
  expect(store.roomMemory.events('room').map(e=>e.sourceId)).toEqual(['room:ok']);
});

it('indexes only confirmed replies and atomically rolls back a failed send-index commit',()=>{
  const store=fixture();
  store.enqueue({roomId:'room',text:'未确认'},{id:'send'});
  const row=store.outbox()[0];row.status='unknown';store.saveOutbox(row);expect(store.roomMemory.events('room')).toEqual([]);
  row.status='sent';store.saveOutbox(row);expect(store.roomMemory.events('room')).toEqual([]);
  store.db.exec("CREATE TRIGGER fail_memory BEFORE INSERT ON room_memory_events BEGIN SELECT RAISE(ABORT,'index failed'); END;");
  row.sentAt=10;row.platformMessageId='bot-1';
  expect(()=>store.saveOutbox(row)).toThrow('index failed');expect(store.outbox()[0].sentAt).toBeUndefined();
  store.db.exec('DROP TRIGGER fail_memory');store.transaction(()=>store.saveOutbox(row));store.saveOutbox(row);
  const events=store.roomMemory.events('room');expect(events).toHaveLength(1);expect(events[0]).toMatchObject({kind:'reply',sourceId:'send',authorId:null,reply:{messageId:'bot-1',text:'未确认',sentAt:10}});
  const batch=store.roomMemory.batch('room',store.roomMemory.latestSeq('room'));
  expect(commit(store,batch,[{id:'said',authorId:null,text:'已发送回复',sourceSeqs:[events[0].seq]}])?.version).toBe(1);
  row.attempts++;store.saveOutbox(row);expect(store.roomMemory.head('room').epoch).toBe(batch.epoch);
});

it('backfills missing historical sources deterministically and survives a restart without duplicates',()=>{
  const dir=mkdtempSync(join(tmpdir(),'boe-memory-'));dirs.push(dir);const path=join(dir,'state.db'),store=fixture(path);
  for(const [id,at]of [['z',10],['a',10],['first',5]] as const){const m=message(id);store.db.prepare('INSERT INTO messages(id,room,at,data,received_at) VALUES(?,?,?,?,?)').run(m.id,m.roomId,m.timestamp,JSON.stringify(m),at);}
  const row={id:'reply',message:{roomId:'room',text:'已确认'},status:'sent',attempts:0,dueAt:0,sentAt:10};
  store.db.prepare('INSERT INTO outbox VALUES(?,?,?,?,?)').run(row.id,'room','sent',0,JSON.stringify(row));
  new RoomMemoryStore(store);
  const events=store.roomMemory.events('room');expect(events.map(e=>e.sourceId)).toEqual(['room:first','room:a','room:z','reply']);
  stores.splice(stores.indexOf(store),1);store.close();
  const reopened=fixture(path);expect(reopened.roomMemory.events('room')).toEqual(events);expect(reopened.roomMemory.rooms()).toEqual(['room']);
});

it('captures before current intake and selects the version valid for that earlier boundary',()=>{
  const store=fixture();store.ingest(message('old','预算20元'));const first=store.roomMemory.batch('room',store.roomMemory.latestSeq('room'));
  const v1=commit(store,first,[note(first)])!;
  store.ingest(message('current'));store.ingest(message('future','预算999元'));
  const later=store.roomMemory.batch('room',store.roomMemory.latestSeq('room'));
  const v2=commit(store,later,[...v1.notes,{id:'later',authorId:'owner',text:'later',sourceSeqs:[later.events.at(-1)!.seq]}])!;
  const snapshot=store.roomMemory.capture('room',{beforeMessageId:'room:current'});
  expect(snapshot.version).toEqual(v1);expect(snapshot.cutoffSeq).toBe(first.untilSeq);expect(snapshot.events).toEqual([]);
  expect(store.roomMemory.capture('room').version).toEqual(v2);
  expect(()=>store.roomMemory.capture('other',{beforeMessageId:'room:current'})).toThrow('boundary missing');
});

it('commits a fixed prefix despite later intake, but rejects another writer on the same base',()=>{
  const store=fixture();store.ingest(message('old','预算20元'));const batch=store.roomMemory.batch('room',store.roomMemory.latestSeq('room'));
  store.ingest(message('new','新问题'));
  const published=commit(store,batch,[note(batch)]);expect(published?.coveredSeq).toBe(batch.untilSeq);
  expect(commit(store,batch,[note(batch,'stale')])).toBeNull();
  const snapshot=store.roomMemory.capture('room');expect(snapshot.events.map(e=>e.sourceId)).toEqual(['room:new']);
});

it('reset invalidates an in-flight result while retaining source records and old version audit',()=>{
  const store=fixture();store.ingest(message('old'));const batch=store.roomMemory.batch('room',store.roomMemory.latestSeq('room'));
  commit(store,batch,[note(batch)]);const next=store.roomMemory.batch('room',store.roomMemory.latestSeq('room'));
  expect(store.roomMemory.reset('room')).toBe(batch.epoch+1);expect(commit(store,next,next.base!.notes)).toBeNull();
  expect(store.roomMemory.head('room').version).toBeNull();expect(store.roomMemory.events('room')).toHaveLength(1);
  expect(store.db.prepare('SELECT COUNT(*) AS n FROM room_memory_versions').get()?.n).toBe(1);
});

it('invalidates versions and in-flight prefixes when a referenced source is rewritten',()=>{
  const store=fixture();const original=message('old','预算20元');store.ingest(original);const batch=store.roomMemory.batch('room',store.roomMemory.latestSeq('room'));commit(store,batch,[note(batch)]);
  const next=store.roomMemory.batch('room',store.roomMemory.latestSeq('room'));
  store.db.prepare('UPDATE messages SET data=? WHERE id=?').run(JSON.stringify({...original,text:'预算5元'}),original.id);
  expect(commit(store,next,next.base!.notes)).toBeNull();const head=store.roomMemory.head('room');expect(head.epoch).toBe(batch.epoch+1);expect(head.version).toBeNull();
  expect(store.roomMemory.events('room')[0]).toMatchObject({seq:batch.events[0].seq,text:'预算5元'});
});

it('does not expose deleted or moved sources to old-room notes',()=>{
  const store=fixture();const old=message('old');store.ingest(old);const batch=store.roomMemory.batch('room',store.roomMemory.latestSeq('room'));commit(store,batch,[note(batch)]);
  store.db.prepare('UPDATE messages SET room=?,data=? WHERE id=?').run('other',JSON.stringify({...old,roomId:'other'}),old.id);
  expect(store.roomMemory.capture('room').version).toBeNull();expect(store.roomMemory.events('room')).toEqual([]);
  expect(store.roomMemory.events('other')[0].roomId).toBe('other');
  store.db.prepare('DELETE FROM messages WHERE id=?').run(old.id);expect(store.roomMemory.events('other')).toEqual([]);
});

it('invalidates the old source when a storage identity is rewritten',()=>{
  const store=fixture();store.ingest(message('old'));const batch=store.roomMemory.batch('room',store.roomMemory.latestSeq('room'));commit(store,batch,[note(batch)]);
  const renamed=message('renamed');store.db.prepare('UPDATE messages SET id=?,data=? WHERE id=?').run(renamed.id,JSON.stringify(renamed),'room:old');
  expect(store.roomMemory.head('room').version).toBeNull();expect(store.roomMemory.events('room').map(e=>e.sourceId)).toEqual([renamed.id]);
  expect(store.roomMemory.event('room',batch.events[0].seq)).toBeUndefined();
});

it('returns a continuous bounded prefix and reports an explicit snapshot gap',()=>{
  const store=fixture();for(let i=0;i<4;i++)store.ingest(message(String(i),'中文'.repeat(100)));
  const all=store.roomMemory.events('room'),budget=Buffer.byteLength(JSON.stringify([all[0]]))+10;
  const batch=store.roomMemory.batch('room',all.at(-1)!.seq,budget);expect(batch.events.map(e=>e.seq)).toEqual([all[0].seq]);expect(batch.hasMore).toBe(true);expect(batch.untilSeq).toBe(all[0].seq);
  const snapshot=store.roomMemory.capture('room',{eventBudgetBytes:budget});expect(snapshot.events.map(e=>e.seq)).toEqual([all.at(-1)!.seq]);expect(snapshot.gap).toEqual({fromSeq:all[0].seq,toSeq:all.at(-2)!.seq});
  const tiny=store.roomMemory.batch('room',all.at(-1)!.seq,1);expect(tiny.events[0].text).toBe('中文'.repeat(100));expect(tiny.oversized).toBe(true);expect(tiny.untilSeq).toBe(all[0].seq);
});

it('keeps per-room prefixes correct with globally interleaved sequence numbers',()=>{
  const store=fixture();store.ingest(message('a'));store.ingest(message('foreign','private','owner','other'));store.ingest(message('b'));
  const batch=store.roomMemory.batch('room',store.roomMemory.latestSeq('room'));
  expect(batch.events.map(e=>e.seq)).toEqual([1,3]);expect(store.roomMemory.event('room',2)).toBeUndefined();
  const invalid={id:'leak',authorId:'owner',text:'private',sourceSeqs:[2]};expect(()=>commit(store,batch,[invalid])).toThrow('outside room');
});

it('validates author attribution, future source references, and genuine explicit supersession',()=>{
  const store=fixture();store.ingest(message('old'));store.ingest(message('other','别人的预算','other'));
  const batch=store.roomMemory.batch('room',store.roomMemory.latestSeq('room'));
  expect(()=>commit(store,batch,[{...note(batch),sourceSeqs:[batch.events[1].seq]}])).toThrow('author');
  expect(()=>commit(store,batch,[{...note(batch),authorId:null}])).toThrow('author');
  expect(()=>commit(store,batch,[{...note(batch),sourceSeqs:[999]}])).toThrow('covered prefix');
  const v1=commit(store,batch,[note(batch)])!;store.ingest(message('correction','预算改成5元'));
  const next=store.roomMemory.batch('room',store.roomMemory.latestSeq('room'));
  expect(()=>commit(store,next,[])).toThrow('omitted');
  expect(()=>commit(store,next,[{id:'new',authorId:'other',text:'changed',sourceSeqs:[batch.events[1].seq],supersedes:['fact']}])).toThrow('same-author');
  const revised=commit(store,next,[{id:'revised',authorId:'owner',text:'预算5元',sourceSeqs:[next.events[0].seq],supersedes:['fact']}]);
  expect(revised?.version).toBe(v1.version+1);expect(revised?.notes).toHaveLength(1);
  store.ingest(message('later','继续'));const later=store.roomMemory.batch('room',store.roomMemory.latestSeq('room'));
  expect(commit(store,later,revised!.notes)?.notes).toEqual(revised!.notes);
});

it('leaves an explicit gap for an oversized foreground event without truncating its original',()=>{
  const store=fixture();store.ingest(message('large','中文'.repeat(2000)));
  const seq=store.roomMemory.latestSeq('room'),snapshot=store.roomMemory.capture('room',{eventBudgetBytes:100});
  expect(snapshot.events).toEqual([]);expect(snapshot.gap).toEqual({fromSeq:seq,toSeq:seq});
  expect(store.roomMemory.event('room',seq)?.text).toBe('中文'.repeat(2000));
  expect(store.roomMemory.eventsBySeq('room',[seq,seq,999]).map(e=>e.seq)).toEqual([seq]);
});

it('stores model-budgeted notes without arbitrary count or text caps',()=>{
  const store=fixture();store.ingest(message('old'));const batch=store.roomMemory.batch('room',store.roomMemory.latestSeq('room'));
  const notes=Array.from({length:257},(_,i)=>note(batch,`note-${i}`,i===0?'字'.repeat(12001):String(i)));
  expect(commit(store,batch,notes)?.notes).toEqual(notes);
});

it('recalls a fixed memory version with filters and pagination while new commits remain invisible',async()=>{
  const store=fixture();store.ingest(message('owner'));store.ingest(message('other','other author','other'));
  const batch=store.roomMemory.batch('room',store.roomMemory.latestSeq('room'));
  const notes=[note(batch,'budget','预算20元'),note(batch,'code','代号Star-83'),{id:'other-budget',authorId:'other',text:'预算500元',sourceSeqs:[batch.events[1].seq]}];
  commit(store,batch,notes);const reader=store.routerContextReader('room');
  const first=await reader({kind:'memory',authorId:'owner',limit:1});expect(first.memories?.map(n=>n.id)).toEqual(['budget']);expect(first).toMatchObject({hasMore:true,nextOffset:1});
  expect((await reader({kind:'memory',authorId:'owner',limit:1,offset:1})).memories?.map(n=>n.id)).toEqual(['code']);
  expect((await reader({kind:'memory',query:'500元'})).memories?.map(n=>n.id)).toEqual(['other-budget']);
  store.ingest(message('new','future'));const next=store.roomMemory.batch('room',store.roomMemory.latestSeq('room'));commit(store,next,[...notes,note(next,'future','未来代号')]);
  expect((await reader({kind:'memory',id:'future'})).memories).toEqual([]);
  expect((await store.routerContextReader('room')({kind:'memory',id:'future'})).memories?.[0].text).toBe('未来代号');
  expect((await store.routerContextReader('other')({kind:'memory'})).memories).toEqual([]);
});

it('rejects recalled old notes after reset or source invalidation and excludes versions beyond intake',async()=>{
  const store=fixture(),original=message('old','预算20元');store.ingest(original);const batch=store.roomMemory.batch('room',store.roomMemory.latestSeq('room'));commit(store,batch,[note(batch)]);
  store.ingest(message('current'));const scoped=store.routerContextReader('room','room:current'),live=store.routerContextReader('room');
  store.ingest(message('future'));const next=store.roomMemory.batch('room',store.roomMemory.latestSeq('room'));commit(store,next,[...next.base!.notes,note(next,'newer','后来的记忆')]);
  expect((await store.routerContextReader('room','room:current')({kind:'memory'})).memories?.map(n=>n.id)).toEqual(['fact']);
  expect((await scoped({kind:'memory'})).memories?.map(n=>n.id)).toEqual(['fact']);
  store.db.prepare('UPDATE messages SET data=? WHERE id=?').run(JSON.stringify({...original,text:'预算5元'}),original.id);
  expect((await scoped({kind:'memory'})).memories).toEqual([]);expect((await live({kind:'memory'})).memories).toEqual([]);
  const fresh=store.roomMemory.batch('room',store.roomMemory.latestSeq('room'));commit(store,fresh,[note(fresh)]);const resetReader=store.routerContextReader('room');store.roomMemory.reset('room');
  expect((await resetReader({kind:'memory'})).memories).toEqual([]);
});

it('rejects stale source digests and preserves the last good version on invalid notes',()=>{
  const store=fixture();store.ingest(message('old'));const batch=store.roomMemory.batch('room',store.roomMemory.latestSeq('room'));
  expect(commit(store,{...batch,sourceDigest:'wrong'},[note(batch)])).toBeNull();const version=commit(store,batch,[note(batch)])!;
  const next=store.roomMemory.batch('room',store.roomMemory.latestSeq('room'));
  expect(()=>commit(store,next,[...version.notes,version.notes[0]])).toThrow('Invalid memory note');expect(store.roomMemory.memory('room')).toEqual(version);
});
