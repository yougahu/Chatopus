import {handoffRecord} from './task-handoff.js';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { RoomMemoryStore, roomMemoryAtomic } from './room-memory-store.js';
import { RouterSessionStore } from './router-session-store.js';
import type { Schedule, ScheduleRun } from './scheduled-tasks/types.js';
import type { BotReply, GroupMessage, OutgoingMessage, RouteAction, ThreadCard, ThreadInput, WorkerReport,RouterContextReader,RouterContextQuery,SendReceipt } from './types.js';

export interface StoredThread extends ThreadCard { updatedAt: number; activeRunId?: string; failures: number;
  pendingInputs?:import('./worker-input-scheduling.js').PendingWorkerInputs;
  workerBudget?:{revision:number;remainingSteps:number;deadlineAt:number} }
export interface ResultRow { id: string; threadId: string; roomId: string; epoch: number; report: WorkerReport; status: string; dueAt: number; deferrals: number }
export interface FileDelivery {
  artifactId:string;status:'pending'|'sending'|'sent'|'failed'|'unknown';attempts:number;
  platformFileId?:string;reason?:string;sentAt?:number;attemptId?:string;
}
export interface OutboxRow { scheduleRunId?:string; hostLinks?:import('./tools/reply-links.js').ReplyLink[]; hostLinkTemplate?:string; id: string; message: OutgoingMessage; threadId?: string; associationThreadId?: string; revision?: number; epoch?: number; resultId?: string; kind?: 'acknowledgement'|'handoff'|'immediate';deliveryAttemptId?:string; status: string; attempts: number; dueAt: number; platformMessageId?: string; sentAt?: number; reason?: string;fileDeliveries?:FileDelivery[];fileDeliveryNoticeFor?:string }
export interface ReferenceResolution {
  status:'none'|'resolved'|'unbound'|'missing'|'ambiguous'|'cycle'|'depth_limit';
  threadId?:string;
  /** The directly quoted original, even when its thread was found through a chain. */
  message?:GroupMessage;
  reply?:BotReply;
  chain:string[];
}
export interface InputContext { contextReplies?:BotReply[]; routingContext?:ThreadInput['routingContext'] }
export type BindingResult='bound'|'existing'|'conflict';
const decode = <T>(row: unknown): T => JSON.parse((row as {data:string}).data);

export class Store {
  readonly db: DatabaseSync;
  readonly roomMemory: RoomMemoryStore;
  readonly routerSessions: RouterSessionStore;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    const schemaVersion=Number(this.db.prepare('PRAGMA user_version').get()?.user_version??0);
    if(schemaVersion>2){this.db.close();throw new Error('Database schema is newer than this application; use the matching release');}
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY,room TEXT NOT NULL,at INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,data TEXT NOT NULL,received_at INTEGER);
      CREATE INDEX IF NOT EXISTS messages_room ON messages(room,at);
      CREATE INDEX IF NOT EXISTS messages_room_status ON messages(room,status);
      CREATE TABLE IF NOT EXISTS decisions(id TEXT PRIMARY KEY,message_id TEXT,event TEXT NOT NULL,data TEXT NOT NULL,at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS threads(id TEXT PRIMARY KEY,room TEXT NOT NULL,status TEXT NOT NULL,updated INTEGER NOT NULL,data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS threads_status_updated ON threads(status,updated);
      CREATE TABLE IF NOT EXISTS inputs(thread_id TEXT NOT NULL,seq INTEGER NOT NULL,message_id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(thread_id,seq),UNIQUE(thread_id,message_id));
      CREATE TABLE IF NOT EXISTS message_thread_bindings(room TEXT NOT NULL,message_id TEXT NOT NULL,thread_id TEXT NOT NULL,kind TEXT NOT NULL,source_id TEXT NOT NULL,at INTEGER NOT NULL,conflict INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(room,message_id));
      CREATE INDEX IF NOT EXISTS inputs_message ON inputs(message_id);
      CREATE INDEX IF NOT EXISTS messages_platform_id ON messages(room,json_extract(data,'$.messageId'));
      CREATE TABLE IF NOT EXISTS results(id TEXT PRIMARY KEY,thread_id TEXT NOT NULL,status TEXT NOT NULL,due INTEGER NOT NULL,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS outbox(id TEXT PRIMARY KEY,room TEXT NOT NULL,status TEXT NOT NULL,due INTEGER NOT NULL,data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS outbox_room_sent ON outbox(room,status,json_extract(data,'$.sentAt'));
      CREATE INDEX IF NOT EXISTS outbox_platform_id ON outbox(room,status,json_extract(data,'$.platformMessageId'));
      CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,thread_id TEXT NOT NULL,status TEXT NOT NULL,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS telemetry(id INTEGER PRIMARY KEY AUTOINCREMENT,kind TEXT NOT NULL,at INTEGER NOT NULL,data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS telemetry_delivery_outbox ON telemetry(json_extract(data,'$.outboxId'),id) WHERE kind IN ('delivery_attempt_started','delivery_attempt_settled');
      CREATE UNIQUE INDEX IF NOT EXISTS telemetry_event_id ON telemetry(kind,json_extract(data,'$.eventId')) WHERE json_type(data,'$.eventId')='text';
      `);
    if(!this.db.prepare('PRAGMA table_info(messages)').all().some(column=>column.name==='received_at'))
      this.db.exec('ALTER TABLE messages ADD COLUMN received_at INTEGER');
    this.roomMemory=new RoomMemoryStore(this);
    this.routerSessions=new RouterSessionStore(this.db);
    if(schemaVersion<2)this.db.exec('PRAGMA user_version=2');
  }
  transaction<T>(fn:()=>T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result=fn(); this.db.exec('COMMIT'); return result; }
    catch(e) { this.db.exec('ROLLBACK'); throw e; }
  }
  ingest(message:GroupMessage,receivedAt=Date.now()): boolean {
    return roomMemoryAtomic(this.db,()=>{
      const inserted=this.db.prepare('INSERT OR IGNORE INTO messages(id,room,at,data,received_at) VALUES (?,?,?,?,?)').run(message.id,message.roomId,message.timestamp,JSON.stringify(message),receivedAt).changes>0;
      if(inserted)this.roomMemory.indexMessage(message.id);return inserted;
    });
  }
  message(id:string):GroupMessage|undefined {
    const row=this.db.prepare('SELECT data FROM messages WHERE id=?').get(id); return row?decode(row):undefined;
  }
  /** Rehydrate a verified context ID using the same room and intake boundary. */
  messageBefore(room:string,id:string,beforeMessageId:string):GroupMessage|undefined {
    const row=this.db.prepare('SELECT data FROM messages WHERE room=? AND id=? AND rowid < (SELECT rowid FROM messages WHERE room=? AND id=?)').get(room,id,room,beforeMessageId);
    return row?decode(row):undefined;
  }
  /** Recall is fixed to intake order, not untrusted platform timestamps. */
  routerContextReader(room:string,beforeMessageId?:string,now=Date.now()):RouterContextReader {
    const first=beforeMessageId?this.db.prepare('SELECT rowid FROM messages WHERE room=? AND id=?').get(room,beforeMessageId) as {rowid:number}|undefined:undefined;
    if(beforeMessageId&&!first)throw new Error('Router context intake boundary missing');
    const lastMessage=first?first.rowid-1:Number((this.db.prepare('SELECT COALESCE(MAX(rowid),0) AS n FROM messages WHERE room=?').get(room) as {n:number}).n);
    const lastReply=Number((this.db.prepare('SELECT COALESCE(MAX(rowid),0) AS n FROM outbox WHERE room=?').get(room) as {n:number}).n);
    const lastThread=Number((this.db.prepare('SELECT COALESCE(MAX(rowid),0) AS n FROM threads WHERE room=?').get(room) as {n:number}).n);
    const memory=this.roomMemory.capture(room,{...(beforeMessageId?{beforeMessageId}:{}),eventBudgetBytes:0});
    return async(query:RouterContextQuery)=>{
      const limit=Math.max(1,Math.min(4,query.limit??3)),offset=query.offset??0;
      if(!Number.isInteger(limit)||!Number.isInteger(offset)||offset<0||offset>100000)throw new Error('Invalid context page');
      const term=(query.query??'').toLowerCase(),id=query.id??'',author=query.authorId??'';
      if(query.kind==='memory')return roomMemoryAtomic(this.db,()=>{
        // The callable reader is bound to one version as well as one intake
        // prefix. New commits do not add future facts to an in-flight request.
        if(this.roomMemory.currentEpoch(room)!==memory.epoch||!memory.version)return {memories:[],hasMore:false};
        const matches=memory.version.notes.filter(note=>(!id||note.id===id)&&(!author||note.authorId===author)&&(!term||`${note.id} ${note.text}`.toLowerCase().includes(term)));
        const selected=matches.slice(offset,offset+limit),sources=new Map(this.roomMemory.eventsBySeq(room,[...new Set(selected.flatMap(note=>note.sourceSeqs))]).map(event=>[event.seq,event]));
        const memories=selected.map(note=>({...structuredClone(note),sources:note.sourceSeqs.flatMap(seq=>{
          const event=sources.get(seq);if(!event||seq>memory.cutoffSeq||seq>memory.version!.coveredSeq)return [];
          const sourceId=event.message?.id??event.reply?.messageId;
          return sourceId?[{seq,kind:event.kind,id:sourceId,authorId:event.authorId}]:[];
        })}));
        const hasMore=matches.length>offset+limit;
        return {memories,hasMore,...(hasMore?{nextOffset:offset+limit}:{})};
      });
      if(query.kind==='messages'){
        const rows=this.db.prepare("SELECT data FROM messages WHERE room=? AND rowid<=? AND (?='' OR id=? OR json_extract(data,'$.messageId')=?) AND (?='' OR json_extract(data,'$.authorId')=?) AND (?='' OR instr(lower(json_extract(data,'$.text')),?)>0) ORDER BY rowid DESC LIMIT ? OFFSET ?")
          .all(room,lastMessage,id,id,id,author,author,term,term,limit+1,offset);
        return {messages:rows.slice(0,limit).map(row=>decode<GroupMessage>(row)),hasMore:rows.length>limit,...(rows.length>limit?{nextOffset:offset+limit}:{})};
      }
      if(query.kind==='handoffs'){
        if(!id)throw new Error('Handoff reads require an exact thread ID');
        const rows=this.db.prepare(`SELECT i.data FROM inputs i JOIN threads t ON t.id=i.thread_id JOIN messages m ON m.id=i.message_id
          WHERE t.room=? AND t.id=? AND m.rowid<=? ORDER BY i.seq DESC LIMIT ? OFFSET ?`).all(room,id,lastMessage,limit+1,offset);
        return {handoffs:rows.slice(0,limit).map(row=>handoffRecord(id,decode<ThreadInput>(row))),hasMore:rows.length>limit,...(rows.length>limit?{nextOffset:offset+limit}:{})};
      }
      if(query.kind==='task_inputs'){
        if(!id)throw new Error('Task input reads require an exact thread ID');
        const rows=this.db.prepare(`SELECT i.data FROM inputs i JOIN threads t ON t.id=i.thread_id JOIN messages m ON m.id=i.message_id
          WHERE t.room=? AND t.id=? AND m.rowid<=? ORDER BY i.seq LIMIT ? OFFSET ?`).all(room,id,lastMessage,limit+1,offset);
        return {taskInputs:rows.slice(0,limit).map(row=>{const input=decode<ThreadInput>(row);return {threadId:id,seq:input.seq,revision:input.revision,kind:input.kind,message:input.message};}),hasMore:rows.length>limit,...(rows.length>limit?{nextOffset:offset+limit}:{})};
      }
      if(query.kind==='threads'){
        const rows=this.db.prepare("SELECT data FROM threads WHERE room=? AND rowid<=? AND (?='' OR id=?) AND (?='' OR json_extract(data,'$.ownerId')=?) AND (?='' OR instr(lower(json_extract(data,'$.subject')||' '||json_extract(data,'$.summary')),?)>0) ORDER BY updated DESC,rowid DESC LIMIT ? OFFSET ?")
          .all(room,lastThread,id,id,author,author,term,term,limit+1,offset);
        return {threads:rows.slice(0,limit).map(row=>decode<ThreadCard>(row)),hasMore:rows.length>limit,...(rows.length>limit?{nextOffset:offset+limit}:{})};
      }
      if(query.kind!=='replies')throw new Error('Invalid context kind');
      const rows=this.db.prepare("SELECT data FROM outbox WHERE room=? AND rowid<=? AND status='sent' AND json_type(data,'$.sentAt') IN ('integer','real') AND json_extract(data,'$.sentAt')<=? AND (?='' OR json_extract(data,'$.platformMessageId')=?) AND (?='' OR instr(lower(json_extract(data,'$.message.text')),?)>0) ORDER BY json_extract(data,'$.sentAt') DESC,rowid DESC LIMIT ? OFFSET ?")
        .all(room,lastReply,now,id,id,term,term,limit+1,offset);
      return {replies:rows.slice(0,limit).map(row=>{const sent=decode<OutboxRow>(row);return {messageId:sent.platformMessageId,replyToMessageId:sent.message.replyToMessageId,text:sent.message.text,sentAt:sent.sentAt!};}),hasMore:rows.length>limit,...(rows.length>limit?{nextOffset:offset+limit}:{})};
    };
  }
  recent(room:string,limit:number,beforeMessageId?:string):GroupMessage[] {
    const rows=beforeMessageId
      ?this.db.prepare('SELECT data FROM messages WHERE room=? AND rowid < (SELECT rowid FROM messages WHERE id=? AND room=?) ORDER BY rowid DESC LIMIT ?').all(room,beforeMessageId,room,limit)
      :this.db.prepare("SELECT data FROM messages WHERE room=? AND status='routed' ORDER BY rowid DESC LIMIT ?").all(room,limit);
    return rows.map(x=>decode<GroupMessage>(x)).reverse();
  }
  /** Explicit references may exceed the recent window, but never cross rooms or see future intake. */
  referencedBefore(room:string,messageId:string,beforeMessageId:string):GroupMessage|undefined {
    const row=this.db.prepare("SELECT data FROM messages WHERE room=? AND json_extract(data,'$.messageId')=? AND rowid < (SELECT rowid FROM messages WHERE id=? AND room=?) ORDER BY rowid DESC LIMIT 1").get(room,messageId,beforeMessageId,room);
    return row?decode(row):undefined;
  }
  /** Association is independent of delivery staleness: silent/control messages can inherit too. */
  bindMessageThread(message:GroupMessage,threadId:string):BindingResult {
    return this.bindThread(message.roomId,message.messageId,threadId,'incoming',message.id,Date.now());
  }
  bindSentReply(row:OutboxRow):BindingResult|undefined {
    const threadId=row.associationThreadId??row.threadId;
    if(row.status!=='sent'||!row.platformMessageId||typeof row.sentAt!=='number'||!threadId)return;
    // A confirmed platform receipt remains valid even when old task metadata is missing or invalid.
    if(this.thread(threadId)?.roomId!==row.message.roomId)return;
    return this.bindThread(row.message.roomId,row.platformMessageId,threadId,'outgoing',row.id,row.sentAt);
  }
  /** Attach an unbound original when its quote creates/joins a task, without changing delivery metadata. */
  bindReferencedThread(message:GroupMessage,threadId:string,before=Date.now()):BindingResult|undefined {
    const reference=this.resolveReference(message,before);
    if(reference.status!=='unbound')return;
    if(reference.message)return this.bindMessageThread(reference.message,threadId);
    if(reference.reply?.messageId){
      const row=this.db.prepare("SELECT data FROM outbox WHERE room=? AND status='sent' AND json_extract(data,'$.platformMessageId')=? AND json_type(data,'$.sentAt') IN ('integer','real') AND json_extract(data,'$.sentAt')<=? ORDER BY rowid LIMIT 1")
        .get(message.roomId,reference.reply.messageId,reference.reply.sentAt);
      if(row)return this.bindSentReply({...decode<OutboxRow>(row),associationThreadId:threadId});
    }
  }
  private bindThread(room:string,messageId:string,threadId:string,kind:'incoming'|'outgoing',sourceId:string,at:number):BindingResult {
    const thread=this.thread(threadId);
    if(!thread||thread.roomId!==room)throw new Error('Message thread association outside room scope');
    const existing=this.db.prepare('SELECT thread_id,conflict FROM message_thread_bindings WHERE room=? AND message_id=?').get(room,messageId) as {thread_id:string;conflict:number}|undefined;
    if(existing){
      if(existing.conflict||existing.thread_id!==threadId){
        this.db.prepare('UPDATE message_thread_bindings SET conflict=1 WHERE room=? AND message_id=?').run(room,messageId);
        return 'conflict';
      }
      return 'existing';
    }
    this.db.prepare('INSERT INTO message_thread_bindings(room,message_id,thread_id,kind,source_id,at) VALUES(?,?,?,?,?,?)').run(room,messageId,threadId,kind,sourceId,at);
    return 'bound';
  }
  /** Resolve only earlier, same-room originals. Historical tables remain a read-only fallback. */
  resolveReference(message:GroupMessage,before=Date.now()):ReferenceResolution {
    if(!message.replyToMessageId)return {status:'none',chain:[]};
    const intake=this.db.prepare('SELECT rowid,received_at FROM messages WHERE id=? AND room=?').get(message.id,message.roomId) as {rowid:number;received_at:number|null}|undefined;
    if(!intake)return {status:'missing',chain:[]};
    let boundary=intake.rowid,cutoff=Math.min(before,intake.received_at??before),target=message.replyToMessageId;
    const chain:string[]=[],seen=new Set<string>();
    const direct:Pick<ReferenceResolution,'message'|'reply'>={};
    const finish=(status:ReferenceResolution['status'],threadId?:string):ReferenceResolution=>({status,...direct,...(threadId?{threadId}:{}),chain});
    for(let depth=0;depth<16;depth++){
      if(seen.has(target))return finish('cycle');
      seen.add(target);chain.push(target);
      const incoming=this.db.prepare("SELECT rowid,data,received_at FROM messages WHERE room=? AND json_extract(data,'$.messageId')=? AND rowid<? AND COALESCE(received_at,at)<=? ORDER BY rowid DESC LIMIT 2").all(message.roomId,target,boundary,cutoff) as {rowid:number;data:string;received_at:number|null}[];
      const outgoing=this.db.prepare("SELECT data FROM outbox WHERE room=? AND status='sent' AND json_extract(data,'$.platformMessageId')=? AND json_type(data,'$.sentAt') IN ('integer','real') AND json_extract(data,'$.sentAt')<=? ORDER BY rowid").all(message.roomId,target,cutoff).map(row=>decode<OutboxRow>(row));
      if(incoming.length>1||(incoming.length&&outgoing.length))return finish('ambiguous');
      if(!incoming.length&&!outgoing.length)return finish(depth?'unbound':'missing');
      const member=incoming[0]?JSON.parse(incoming[0].data) as GroupMessage:undefined;
      const sent=outgoing[0];
      if(!depth){
        if(member)direct.message=member;
        else direct.reply={messageId:sent.platformMessageId,replyToMessageId:sent.message.replyToMessageId,text:sent.message.text,sentAt:sent.sentAt!};
      }
      const candidates=new Set<string>();
      const add=(id:string|undefined)=>{if(id&&this.thread(id)?.roomId===message.roomId)candidates.add(id);};
      const binding=this.db.prepare('SELECT thread_id,conflict,kind,source_id,at FROM message_thread_bindings WHERE room=? AND message_id=?').get(message.roomId,target) as {thread_id:string;conflict:number;kind:string;source_id:string;at:number}|undefined;
      // Incoming associations may be added after ingestion while processing this batch.
      if(binding&&(member?binding.kind==='incoming'&&binding.source_id===member.id:binding.kind==='outgoing'&&binding.at<=cutoff)){
        if(binding.conflict)return finish('ambiguous');
        add(binding.thread_id);
      }
      if(member){
        for(const row of this.db.prepare('SELECT DISTINCT thread_id FROM inputs WHERE message_id=?').all(member.id) as {thread_id:string}[])add(row.thread_id);
      }else{
        if(new Set(outgoing.map(row=>JSON.stringify([row.message.text,row.message.replyToMessageId]))).size>1)return finish('ambiguous');
        for(const row of outgoing){add(row.threadId);add(row.associationThreadId);}
      }
      if(candidates.size>1)return finish('ambiguous');
      if(candidates.size===1)return finish('resolved',[...candidates][0]);
      const next=member?.replyToMessageId??sent?.message.replyToMessageId;
      if(!next)return finish('unbound');
      if(member){boundary=incoming[0].rowid;cutoff=Math.min(cutoff,incoming[0].received_at??member.timestamp);}
      else cutoff=Math.min(cutoff,sent.sentAt!);
      target=next;
    }
    return finish('depth_limit');
  }
  pendingMessages():GroupMessage[] { return this.db.prepare("SELECT data FROM messages WHERE status='pending' ORDER BY rowid").all().map(x=>decode(x)); }
  messageStatus(id:string,status:string) { this.db.prepare('UPDATE messages SET status=? WHERE id=?').run(status,id); }
  recordDecision(event:string,actions:RouteAction[],messageId?:string) {
    this.db.prepare('INSERT INTO decisions VALUES(?,?,?,?,?)').run(randomUUID(),messageId??null,event,JSON.stringify(actions),Date.now());
  }
  decisions() { return this.db.prepare('SELECT message_id,event,data FROM decisions ORDER BY at,rowid').all().map(x=>({...x,actions:JSON.parse(String(x.data))})); }
  saveThread(thread:StoredThread) {
    thread.updatedAt=Date.now();
    this.db.prepare('INSERT INTO threads VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,updated=excluded.updated,data=excluded.data').run(thread.id,thread.roomId,thread.status,thread.updatedAt,JSON.stringify(thread));
  }
  thread(id:string):StoredThread|undefined { const row=this.db.prepare('SELECT data FROM threads WHERE id=?').get(id);return row?decode(row):undefined; }
  threads(room?:string,limit=1000):StoredThread[] {
    const rows=room?this.db.prepare('SELECT data FROM threads WHERE room=? ORDER BY updated DESC LIMIT ?').all(room,limit):this.db.prepare('SELECT data FROM threads ORDER BY updated DESC LIMIT ?').all(limit);
    return rows.map(x=>decode(x));
  }
  /** Expire inactive routing context, retaining audit history and explicit quote bindings. */
  routingThreads(room:string,limit:number,idleTtlMs:number,now=Date.now()):StoredThread[] {
    return this.db.prepare("SELECT data FROM threads WHERE room=? AND COALESCE(json_extract(data,'$.scheduledTask.deliveryMode'),'room')<>'local' AND (status IN ('queued','running') OR updated>?) ORDER BY updated DESC LIMIT ?")
      .all(room,now-idleTtlMs,limit).map(x=>decode<StoredThread>(x));
  }
  /** Scheduling is independent of the bounded Thread-card/history query. */
  threadsInStatus(status:StoredThread['status']):StoredThread[] {
    return this.db.prepare('SELECT data FROM threads WHERE status=? ORDER BY updated,rowid').all(status).map(x=>decode(x));
  }
  hasThreadsInStatus(status:StoredThread['status']):boolean {
    return !!this.db.prepare('SELECT 1 FROM threads WHERE status=? LIMIT 1').get(status);
  }
  createThread(message:GroupMessage,subject:string,explicit:boolean,contextMessages?:GroupMessage[],context:InputContext={}):StoredThread {
    const id='t-'+randomUUID();
    const thread:StoredThread={id,roomId:message.roomId,subject,ownerId:message.authorId,sourceMessageId:message.messageId,explicit,participants:[message.authorId],status:'queued',revision:0,latestInputSeq:0,sessionId:'worker-'+id,epoch:0,summary:'',updatedAt:Date.now(),failures:0};
    this.append(thread,message,'question',contextMessages,context);return thread;
  }
  /** A scheduled source is host-owned and never inserted as a platform message. */
  createScheduledThread(run:ScheduleRun,schedule:Schedule):StoredThread {
    const id='t-'+run.id,existing=this.thread(id);if(existing)return existing;
    const thread:StoredThread={id,roomId:schedule.roomId,subject:schedule.title,ownerId:schedule.ownerId??'',sourceMessageId:'',
      explicit:true,participants:schedule.ownerId?[schedule.ownerId]:[],status:'queued',revision:1,latestInputSeq:1,sessionId:'worker-'+id,
      epoch:0,summary:'',updatedAt:Date.now(),failures:0,scheduledTask:{scheduleId:schedule.id,scheduleRunId:run.id,authority:schedule.authority,generation:run.generation,title:schedule.title,...(schedule.deliveryMode?{deliveryMode:schedule.deliveryMode}:{})}};
    this.saveThread(thread);return thread;
  }
  append(thread:StoredThread,message:GroupMessage,kind:ThreadInput['kind'],contextMessages?:GroupMessage[],context:InputContext={}):ThreadInput {
    if(thread.scheduledTask)throw new Error('Scheduled execution inputs are immutable; update the schedule or open a new topic');
    if(thread.roomId!==message.roomId)throw new Error('Input outside thread room scope');
    const existing=this.db.prepare('SELECT data FROM inputs WHERE thread_id=? AND message_id=?').get(thread.id,message.id);
    if(existing)return decode(existing);
    const input:ThreadInput={seq:++thread.latestInputSeq,revision:++thread.revision,message,kind,...(contextMessages?.length?{contextMessages}:{}),
      ...(context.contextReplies?.length?{contextReplies:context.contextReplies}:{}),...(context.routingContext?{routingContext:context.routingContext}:{})};
    if(!thread.participants.includes(message.authorId))thread.participants.push(message.authorId);
    this.db.prepare('INSERT INTO inputs VALUES(?,?,?,?)').run(thread.id,input.seq,message.id,JSON.stringify(input));
    if(thread.status!=='running')thread.status='queued';
    thread.failures=0;this.saveThread(thread);this.bindMessageThread(message,thread.id);
    this.telemetry('input_committed',{threadId:thread.id,sourceId:message.id,revision:input.revision,inputSeq:input.seq});return input;
  }
  inputs(threadId:string):ThreadInput[] { return this.db.prepare('SELECT data FROM inputs WHERE thread_id=? ORDER BY seq').all(threadId).map(x=>decode(x)); }
  requirementSnapshot(threadId:string):WorkerReport['requirementSnapshot'] {
    const row=this.db.prepare("SELECT json_extract(data,'$.report.requirementSnapshot') AS snapshot FROM runs WHERE thread_id=? AND status='completed' AND json_type(data,'$.report.requirementSnapshot')='object' ORDER BY json_extract(data,'$.report.requirementSnapshot.throughInputSeq') DESC,rowid DESC LIMIT 1").get(threadId) as {snapshot:string}|undefined;
    return row?JSON.parse(row.snapshot):undefined;
  }
  saveRun(id:string,threadId:string,status:string,data:unknown) { this.db.prepare('INSERT INTO runs VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,data=excluded.data').run(id,threadId,status,JSON.stringify(data)); }
  saveResult(result:ResultRow) { this.db.prepare('INSERT INTO results VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,due=excluded.due,data=excluded.data').run(result.id,result.threadId,result.status,result.dueAt,JSON.stringify(result)); }
  results(status='pending'):ResultRow[] { return this.db.prepare('SELECT data FROM results WHERE status=? ORDER BY due').all(status).map(x=>decode(x)); }
  enqueue(message:OutgoingMessage,meta:Partial<OutboxRow>={}):string {
    const row:OutboxRow={id:meta.id??randomUUID(),message,status:'pending',attempts:0,dueAt:Date.now(),...meta};
    roomMemoryAtomic(this.db,()=>{
      const inserted=this.db.prepare('INSERT OR IGNORE INTO outbox VALUES(?,?,?,?,?)').run(row.id,message.roomId,row.status,row.dueAt,JSON.stringify(row));
      if(inserted.changes){this.bindSentReply(row);this.roomMemory.indexReply(row.id);}
    });
    return row.id;
  }
  saveOutbox(row:OutboxRow) {
    roomMemoryAtomic(this.db,()=>{
      const saved=this.db.prepare('UPDATE outbox SET status=?,due=?,data=? WHERE id=?').run(row.status,row.dueAt,JSON.stringify(row),row.id);
      if(saved.changes){this.bindSentReply(row);this.roomMemory.indexReply(row.id);}
    });
  }
  outbox(status?:string):OutboxRow[] { return (status?this.db.prepare('SELECT data FROM outbox WHERE status=? ORDER BY due').all(status):this.db.prepare('SELECT data FROM outbox ORDER BY due').all()).map(x=>decode(x)); }
  /** Read confirmed sends only, at the routing snapshot time. Legacy rows without a send time are omitted. */
  sentReplies(room:string,limit:number,before=Date.now()):BotReply[] {
    if(!Number.isInteger(limit)||limit<0)throw new Error('Invalid sent reply limit');
    return this.db.prepare("SELECT data FROM outbox WHERE room=? AND status='sent' AND json_type(data,'$.sentAt') IN ('integer','real') AND json_extract(data,'$.sentAt')<=? ORDER BY json_extract(data,'$.sentAt') DESC,rowid DESC LIMIT ?")
      .all(room,before,limit).map(row=>{
        const sent=decode<OutboxRow>(row);
        return {messageId:sent.platformMessageId,replyToMessageId:sent.message.replyToMessageId,text:sent.message.text,sentAt:sent.sentAt!};
      }).reverse();
  }
  deliveryAttempt(row:OutboxRow,phase:'started'|'settled',receipt?:SendReceipt,part='message',attemptId=row.deliveryAttemptId,attempt=row.attempts) {
    if(!attemptId)return;
    this.telemetry('delivery_attempt_'+phase,{eventId:`delivery:${attemptId}:${phase}`,outboxId:row.id,roomId:row.message.roomId,
      threadId:row.threadId??row.associationThreadId,part,attemptId,attempt,...(receipt?{status:receipt.status,reason:receipt.reason,
        platformCode:receipt.platformCode,retryable:receipt.retryable,platformMessageId:receipt.platformMessageId,platformFileId:receipt.platformFileId}:{})});
  }
  telemetry(kind:string,data:unknown) { this.db.prepare('INSERT OR IGNORE INTO telemetry(kind,at,data) VALUES(?,?,?)').run(kind,Date.now(),JSON.stringify(data)); }
  recovery() {
    this.transaction(()=>{
      this.db.prepare("UPDATE messages SET status='pending' WHERE status='processing'").run();
      for(const thread of this.threadsInStatus('running')) {
        if(thread.activeRunId){
          const runId=thread.activeRunId;
          const saved=this.db.prepare('SELECT data FROM runs WHERE id=?').get(runId);
          const original=saved?JSON.parse(String(saved.data)):{epoch:thread.epoch,revision:thread.revision};
          const superseded=original.revision<thread.revision;
          const calls=this.db.prepare("SELECT data FROM telemetry WHERE kind='model_call' AND json_extract(data,'$.runId')=?").all(runId).map(row=>decode<any>(row));
          const settled=new Set(this.db.prepare("SELECT json_extract(data,'$.measurementId') AS id FROM telemetry WHERE kind='model' AND json_extract(data,'$.runId')=?").all(runId).map(row=>row.id));
          const pending=calls.filter(call=>!settled.has(call.measurementId)),usage={inputTokens:0,outputTokens:0,cacheReadTokens:0,cacheWriteTokens:0};
          for(const call of pending)for(const key of Object.keys(usage) as (keyof typeof usage)[])if(Number.isFinite(call.usage?.[key]))usage[key]+=Math.max(0,call.usage[key]);
          // An interrupted in-flight call may never return usage. Keep the known
          // portion and explicitly retain that uncertainty, even with no ledger rows.
          this.telemetry('model',{eventId:'interrupted:'+runId,measurementId:'interrupted:'+runId,role:'worker',threadId:thread.id,runId,sessionId:thread.sessionId,
            status:superseded?'superseded':'failed',code:superseded?'SUPERSEDED':'INTERRUPTED',usageStatus:pending.some(call=>call.usage)?'partial':'unknown',unsettled:true,...usage,
            modelCalls:pending.length,missingUsageCalls:pending.filter(call=>!call.usage).length});
          const steps=Math.max(0,...calls.map(call=>Number.isSafeInteger(call.step)?call.step:0));
          if(thread.workerBudget?.revision===thread.revision)thread.workerBudget.remainingSteps=Math.max(0,thread.workerBudget.remainingSteps-steps-1);
          if(!superseded)thread.lastFailure={runId,code:'INTERRUPTED',revision:thread.revision,steps,retryable:true};
          this.saveRun(runId,thread.id,superseded?'superseded':'interrupted',{...original,endedAt:Date.now(),steps,code:'INTERRUPTED',...(superseded?{supersededByRevision:thread.revision}:{})});
        }
        thread.epoch++;thread.activeRunId=undefined;thread.status='queued';this.saveThread(thread);
      }
      // A process may die after platform accepted a send. Never blindly repeat it.
      for(const row of this.outbox('sending')){
        row.status='unknown';row.reason='interrupted_delivery';this.deliveryAttempt(row,'settled',{status:'unknown',reason:row.reason});
        for(const file of row.fileDeliveries??[])if(file.status==='sending'){file.status='unknown';file.reason='interrupted_delivery';this.deliveryAttempt(row,'settled',{status:'unknown',reason:file.reason},file.artifactId,file.attemptId,file.attempts);}
        this.saveOutbox(row);
      }
    });
  }
  close(){this.db.close();}
}
