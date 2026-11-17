import {afterEach,expect,it} from 'vitest';
import {mkdtempSync,rmSync,mkdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.js';
import {auditPrewarmUsage,createSourceSnapshot,exportMemory,prewarmSnapshot,promoteMemory,rawDataDigest,validatePromotion,type SourceManifest} from '../scripts/room-memory-prewarm.js';
import type {GroupMessage} from '../src/types.js';
const stores:Store[]=[],roots:string[]=[];
afterEach(()=>{for(const store of stores.splice(0))store.close();for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
const message=(id:string,text=id,roomId='room'):GroupMessage=>({id:roomId+':'+id,messageId:id,roomId,platform:'replay',authorId:'owner',authorName:'Owner',text,timestamp:1,mentions:[],attachments:[],isMentioned:false,isAdmin:false});
const open=(path:string)=>{const store=new Store(path);stores.push(store);return store;};
function publish(store:Store,id='fact',supersedes?:string[]){const batch=store.roomMemory.batch('room',store.roomMemory.latestSeq('room'));return store.roomMemory.commit({...batch,notes:[{id,authorId:'owner',text:'budget=20元',sourceSeqs:[batch.events.at(-1)?.seq??batch.base!.notes[0].sourceSeqs[0]],...(supersedes?{supersedes}:{})}]})!;}
async function fixture(){
 const root=mkdtempSync(join(tmpdir(),'boe-memory-prewarm-'));roots.push(root);const target=open(join(root,'production-simulated.sqlite'));
 target.ingest(message('a','budget=20元'),1);target.ingest(message('b','remember it'),2);
 const rawBefore=rawDataDigest(target.db),manifest=await createSourceSnapshot(join(root,'production-simulated.sqlite'),join(root,'snapshot'));
 const snapshot=open(manifest.snapshotDatabase);const version=publish(snapshot);
 return {root,target,manifest,snapshot,version,rawBefore};
}
it('online-backs up an open WAL database without changing its business records',async()=>{
 const {target,snapshot,manifest,rawBefore}=await fixture();
 expect(snapshot.message('room:a')?.text).toBe('budget=20元');expect(manifest.rooms[0].sources).toHaveLength(2);
 expect(rawDataDigest(target.db)).toBe(rawBefore);expect(target.roomMemory.memory('room')).toBeNull();
});
it('promotes a verified complete prefix while allowing appended originals and changing no business rows',async()=>{
 const {target,snapshot,manifest,version}=await fixture(),artifact=exportMemory(snapshot,manifest,'room',version.epoch,version.version);
 target.ingest(message('later','new untouched input'),3);const before=rawDataDigest(target.db);
 expect(validatePromotion(target,manifest,artifact).sourceCount).toBe(2);
 const published=promoteMemory(target,manifest,artifact);expect(published.coveredSeq).toBe(2);expect(target.roomMemory.capture('room').events.map(e=>e.sourceId)).toEqual(['room:later']);
 expect(rawDataDigest(target.db)).toBe(before);expect(target.message('room:later')?.text).toBe('new untouched input');
});
it('maps source sequences across globally interleaved other-room records',async()=>{
 const {root,snapshot,manifest,version}=await fixture(),artifact=exportMemory(snapshot,manifest,'room',version.epoch,version.version),target=open(join(root,'different-global-seqs.sqlite'));
 target.ingest(message('foreign','private','other'),0);target.ingest(message('a','budget=20元'),1);target.ingest(message('b','remember it'),2);
 const published=promoteMemory(target,manifest,artifact);expect(published.coveredSeq).toBe(3);expect(published.notes[0].sourceSeqs).toEqual([3]);
 expect(target.roomMemory.memory('other')).toBeNull();
});
it('rejects changed sources before publishing any memory version',async()=>{
 const {target,snapshot,manifest,version}=await fixture(),artifact=exportMemory(snapshot,manifest,'room',version.epoch,version.version);
 target.db.prepare('UPDATE messages SET data=? WHERE id=?').run(JSON.stringify(message('a','budget=5元')),'room:a');const before=rawDataDigest(target.db);
 expect(()=>promoteMemory(target,manifest,artifact)).toThrow(/differ|source/i);expect(target.roomMemory.memory('room')).toBeNull();expect(rawDataDigest(target.db)).toBe(before);
});
it('rejects an unverified intervening source instead of skipping to a matching later message',async()=>{
 const {root,snapshot,manifest,version}=await fixture(),artifact=exportMemory(snapshot,manifest,'room',version.epoch,version.version),target=open(join(root,'intervening.sqlite'));
 target.ingest(message('a','budget=20元'),1);target.ingest(message('unexpected','not summarized'),2);target.ingest(message('b','remember it'),3);
 expect(()=>promoteMemory(target,manifest,artifact)).toThrow('intervening');expect(target.roomMemory.memory('room')).toBeNull();
});
it('refuses experimental suffixes and synthetic source identities during export',async()=>{
 const {snapshot,manifest}=await fixture();snapshot.ingest(message('synthetic-case','invented validation memory'),3);
 const next=snapshot.roomMemory.batch('room',snapshot.roomMemory.latestSeq('room'));
 const v=snapshot.roomMemory.commit({...next,notes:[...next.base!.notes,{id:'case',authorId:'owner',text:'invented',sourceSeqs:[next.events[0].seq]}]})!;
 expect(()=>exportMemory(snapshot,manifest,'room',v.epoch,v.version)).toThrow('real source history');
 expect(exportMemory(snapshot,manifest,'room',v.epoch,v.version-1).selectedVersion).toBe(v.version-1);
});
it('exports an explicit later version and preserves its entire supersession chain on promotion',async()=>{
 const {snapshot,target,manifest}=await fixture();const revised=publish(snapshot,'revised',['fact']);
 const artifact=exportMemory(snapshot,manifest,'room',revised.epoch,revised.version);expect(artifact.versions.map(v=>v.version)).toEqual([1,2]);
 const result=promoteMemory(target,manifest,artifact);expect(result.version).toBe(2);expect(result.notes[0]).toMatchObject({id:'revised',supersedes:['fact']});
});
it('rejects a changed target checkpoint or reset instead of overwriting it',async()=>{
 const {target,snapshot,manifest,version}=await fixture(),artifact=exportMemory(snapshot,manifest,'room',version.epoch,version.version);
 target.roomMemory.reset('room');expect(()=>promoteMemory(target,manifest,artifact)).toThrow('epoch or version');
 expect(target.roomMemory.memory('room')).toBeNull();
});
it('rolls back publication if any database trigger changes raw business data',async()=>{
 const {target,snapshot,manifest,version}=await fixture(),artifact=exportMemory(snapshot,manifest,'room',version.epoch,version.version),before=rawDataDigest(target.db);
 target.db.exec("CREATE TRIGGER bad_memory_write AFTER INSERT ON room_memory_versions BEGIN UPDATE messages SET status='failed'; END;");
 expect(()=>promoteMemory(target,manifest,artifact)).toThrow('business rows');expect(rawDataDigest(target.db)).toBe(before);expect(target.roomMemory.memory('room')).toBeNull();
});
it('requires the exact reviewed manifest instead of trusting an artifact version number',async()=>{
 const {target,snapshot,manifest,version}=await fixture(),artifact=exportMemory(snapshot,manifest,'room',version.epoch,version.version);
 const altered:SourceManifest={...manifest,createdAt:'not reviewed'};
 expect(()=>promoteMemory(target,altered,artifact)).toThrow('reviewed source manifest');
});
it('plans prewarm without loading credentials, creating a runtime or calling a model',async()=>{
 const {root,manifest,snapshot}=await fixture();
 const before=rawDataDigest(snapshot.db),plan=await prewarmSnapshot(join(root,'snapshot'),join(root,'missing-project'),0);
 expect(plan).toMatchObject({mode:'prepared-no-model-calls',targets:[{roomId:'room',cutoffSeq:manifest.rooms[0].cutoffSeq,sources:2}]});
 expect(rawDataDigest(snapshot.db)).toBe(before);
});
it('verifies confirmed reply identity and body instead of accepting a synthetic reply reference',async()=>{
 const root=mkdtempSync(join(tmpdir(),'boe-memory-reply-'));roots.push(root);const target=open(join(root,'target.sqlite'));
 target.enqueue({roomId:'room',text:'Already sent'},{id:'actual-outbox-id'});
 const reply=target.outbox()[0];reply.status='sent';reply.sentAt=4;reply.platformMessageId='platform-id';target.saveOutbox(reply);
 const manifest=await createSourceSnapshot(join(root,'target.sqlite'),join(root,'snapshot')),snapshot=open(manifest.snapshotDatabase);
 const batch=snapshot.roomMemory.batch('room',snapshot.roomMemory.latestSeq('room'));
 const version=snapshot.roomMemory.commit({...batch,notes:[{id:'reply-fact',authorId:null,text:'Already sent',sourceSeqs:[batch.events[0].seq]}]})!;
 const artifact=exportMemory(snapshot,manifest,'room',version.epoch,version.version);
 expect(artifact.sources[0]).toMatchObject({kind:'reply',sourceId:'actual-outbox-id'});
 reply.message.text='Changed after snapshot';target.saveOutbox(reply);
 expect(()=>promoteMemory(target,manifest,artifact)).toThrow(/differ|source/i);
 expect(target.roomMemory.memory('room')).toBeNull();
});
it('counts final failed-attempt usage exactly once and marks missing failed usage as unknown',()=>{
 const root=mkdtempSync(join(tmpdir(),'boe-memory-usage-'));roots.push(root);mkdirSync(join(root,'s'));
 const usage={inputTokens:10,cacheReadTokens:20,outputTokens:5,totalTokens:35};
 const stream=(values:typeof usage[])=>values.map(value=>({type:'chunk',time:1,chunk:{type:'usage',usage:value}}));
 const events=[{id:'session',seq:0,type:'session/start'},
 {seq:1,time:1,type:'assistant/message',data:{usage,stream:stream([usage])}},
 {seq:2,time:2,type:'assistant/attempt',data:{stream:stream([{...usage,inputTokens:1},usage])}},
 {seq:3,time:3,type:'assistant/attempt',data:{stream:[]}},
 {seq:4,time:4,type:'assistant/message',data:{stream:stream([usage])}}];
 writeFileSync(join(root,'s','session.v4.jsonl'),events.map(e=>JSON.stringify(e)).join('\n'));
 const result=auditPrewarmUsage(root,{});
 expect(result.usage).toMatchObject({assistant:{events:2,contextInputTokens:60,outputTokens:10},failed:{events:1,contextInputTokens:30,outputTokens:5},combined:{events:3,contextInputTokens:90,outputTokens:15},failedAttempts:2,failedAttemptsMissingUsage:1,missingUsage:1});
});
it('treats explicit SDK default-zero usage on transport failure and cancellation as unknown',()=>{
 const root=mkdtempSync(join(tmpdir(),'boe-memory-zero-'));roots.push(root);mkdirSync(join(root,'s'));
 const zero={inputTokens:0,outputTokens:0,totalTokens:0};
 const failedStream=(kind:'error'|'aborted')=>[
  {type:'reasoning-chunks',time0:1,index:0,dt:[],texts:['A streamed response before the connection failed']},
  {type:'chunk',time:2,chunk:{type:'usage',usage:zero}},
  {type:'chunk',time:3,chunk:{type:'finish',reason:kind==='error'?{kind,failure:{code:'TRANSPORT',message:'OpenAI Responses stream ended before a terminal response event'}}:{kind}}}];
 const events=[{id:'session',seq:0,type:'session/start'},
  {seq:1,time:1,type:'assistant/attempt',data:{stream:failedStream('error')}},
  {seq:2,time:2,type:'assistant/attempt',data:{stream:failedStream('aborted')}},
  {seq:3,time:3,type:'assistant/message',data:{interrupted:true,usage:zero,stream:failedStream('aborted')}}];
 writeFileSync(join(root,'s','session.v4.jsonl'),events.map(e=>JSON.stringify(e)).join('\n'));
 const result=auditPrewarmUsage(root,{});
 expect(result.trace.usage).toEqual([]);
 expect(result.usage).toMatchObject({overallProviderTotalTokens:null,totalsScope:'known-usage-only',combined:{events:0},failedAttempts:3,failedAttemptsMissingUsage:3,failedAttemptsUnverifiedZeroUsage:3,missingUsage:3});
 expect(result.usage.unknownUsage.map(e=>e.reason)).toEqual(['unverified-zero-usage','unverified-zero-usage','unverified-zero-usage']);
});
it('preserves previously reported nonzero failed usage when an error emits a later default zero',()=>{
 const root=mkdtempSync(join(tmpdir(),'boe-memory-known-'));roots.push(root);mkdirSync(join(root,'s'));
 const known={inputTokens:10,cacheReadTokens:20,outputTokens:5,totalTokens:35};
 const stream=[known,{inputTokens:0,outputTokens:0,totalTokens:0}].map(usage=>({type:'chunk',time:1,chunk:{type:'usage',usage}}));
 const events=[{id:'session',seq:0,type:'session/start'},{seq:1,time:1,type:'assistant/attempt',data:{stream}}];
 writeFileSync(join(root,'s','session.v4.jsonl'),events.map(e=>JSON.stringify(e)).join('\n'));
 const result=auditPrewarmUsage(root,{});
 expect(result.usage).toMatchObject({combined:{events:1,contextInputTokens:30,outputTokens:5},failedAttempts:1,failedAttemptsMissingUsage:0,missingUsage:0});
 expect(result.usage.unknownUsage).toEqual([]);
});
