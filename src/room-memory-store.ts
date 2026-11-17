import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { BotReply, GroupMessage } from './types.js';

export interface MemoryNote { id:string; authorId:string|null; text:string; sourceSeqs:number[]; supersedes?:string[] }
export interface MemoryEvent { seq:number; roomId:string; kind:'message'|'reply'; sourceId:string; authorId:string|null; text:string; message?:GroupMessage; reply?:BotReply; threadId?:string; digest:string }
export interface MemoryVersion { roomId:string; epoch:number; version:number; coveredSeq:number; notes:MemoryNote[]; sourceDigest:string; createdAt:number }
export interface MemorySnapshot { roomId:string; epoch:number; version:MemoryVersion|null; cutoffSeq:number; events:MemoryEvent[]; gap?:{fromSeq:number;toSeq:number} }
export interface MemoryBatch { roomId:string; epoch:number; baseVersion:number; base:MemoryVersion|null; targetSeq:number; untilSeq:number; sourceDigest:string; events:MemoryEvent[]; hasMore:boolean; oversized?:boolean }
export interface MemoryCommit { roomId:string; epoch:number; baseVersion:number; untilSeq:number; sourceDigest:string; notes:MemoryNote[] }
export interface MemoryCaptureOptions { beforeMessageId?:string; cutoffSeq?:number; eventBudgetBytes?:number }
export interface MemoryEventsOptions { afterSeq?:number; throughSeq?:number; limit?:number; inputBudgetBytes?:number }
interface EventRow { seq:number;room:string;kind:'message'|'reply';source_id:string;source_digest:string;valid:number }
interface VersionRow { room:string;epoch:number;version:number;covered_seq:number;notes:string;source_digest:string;created_at:number }
type Source=Omit<MemoryEvent,'seq'>;
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
let savepointSequence=0;
/** SAVEPOINT composes with Store.transaction and rolls back source + index together. */
export function roomMemoryAtomic<T>(db:DatabaseSync,fn:()=>T):T {
  const name=`room_memory_${++savepointSequence}`;
  db.exec(`SAVEPOINT ${name}`);
  try{const value=fn();db.exec(`RELEASE ${name}`);return value;}
  catch(error){try{db.exec(`ROLLBACK TO ${name}`);}finally{db.exec(`RELEASE ${name}`);}throw error;}
}
const integer=(value:number,name:string)=>{if(!Number.isSafeInteger(value)||value<0)throw new Error(`Invalid memory ${name}`);return value;};
const byteSize=(value:unknown)=>Buffer.byteLength(JSON.stringify(value));

/** Append-only source identities and immutable, CAS-published memory versions.
 * Original text remains in messages/outbox; notes never authorize Router actions. */
export class RoomMemoryStore {
  readonly db:DatabaseSync;
  constructor(store:DatabaseSync|{db:DatabaseSync}){
    this.db=store instanceof DatabaseSync?store:store.db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS room_memory_events(seq INTEGER PRIMARY KEY AUTOINCREMENT,room TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('message','reply')),source_id TEXT NOT NULL,source_digest TEXT NOT NULL,valid INTEGER NOT NULL DEFAULT 1,UNIQUE(room,kind,source_id));
      CREATE INDEX IF NOT EXISTS room_memory_events_room_seq ON room_memory_events(room,seq);
      CREATE INDEX IF NOT EXISTS room_memory_events_source ON room_memory_events(kind,source_id);
      CREATE TABLE IF NOT EXISTS room_memory_meta(room TEXT PRIMARY KEY,epoch INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS room_memory_versions(room TEXT NOT NULL,epoch INTEGER NOT NULL,version INTEGER NOT NULL,covered_seq INTEGER NOT NULL,notes TEXT NOT NULL,source_digest TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(room,epoch,version));
      CREATE INDEX IF NOT EXISTS room_memory_versions_coverage ON room_memory_versions(room,epoch,covered_seq,version);
      CREATE TABLE IF NOT EXISTS room_memory_dirty(kind TEXT NOT NULL,source_id TEXT NOT NULL,PRIMARY KEY(kind,source_id));
      CREATE TRIGGER IF NOT EXISTS room_memory_messages_changed AFTER UPDATE OF data,room ON messages BEGIN INSERT OR IGNORE INTO room_memory_dirty VALUES('message',OLD.id); END;
      CREATE TRIGGER IF NOT EXISTS room_memory_messages_deleted AFTER DELETE ON messages BEGIN INSERT OR IGNORE INTO room_memory_dirty VALUES('message',OLD.id); END;
      CREATE TRIGGER IF NOT EXISTS room_memory_messages_identity_changed AFTER UPDATE OF id ON messages BEGIN INSERT OR IGNORE INTO room_memory_dirty VALUES('message',OLD.id); INSERT OR IGNORE INTO room_memory_dirty VALUES('message',NEW.id); END;
      CREATE TRIGGER IF NOT EXISTS room_memory_replies_changed AFTER UPDATE OF data,status,room ON outbox BEGIN INSERT OR IGNORE INTO room_memory_dirty VALUES('reply',OLD.id); END;
      CREATE TRIGGER IF NOT EXISTS room_memory_replies_deleted AFTER DELETE ON outbox BEGIN INSERT OR IGNORE INTO room_memory_dirty VALUES('reply',OLD.id); END;
      CREATE TRIGGER IF NOT EXISTS room_memory_replies_identity_changed AFTER UPDATE OF id ON outbox BEGIN INSERT OR IGNORE INTO room_memory_dirty VALUES('reply',OLD.id); INSERT OR IGNORE INTO room_memory_dirty VALUES('reply',NEW.id); END;
    `);
    this.sync();
  }
  private epoch(room:string):number {
    this.db.prepare('INSERT OR IGNORE INTO room_memory_meta(room,epoch) VALUES(?,0)').run(room);
    return Number((this.db.prepare('SELECT epoch FROM room_memory_meta WHERE room=?').get(room) as {epoch:number}).epoch);
  }
  private invalidate(room:string){this.epoch(room);this.db.prepare('UPDATE room_memory_meta SET epoch=epoch+1 WHERE room=?').run(room);}
  private source(kind:'message'|'reply',id:string):Source|undefined {
    const row=this.db.prepare(`SELECT room,data${kind==='reply'?',status':''} FROM ${kind==='message'?'messages':'outbox'} WHERE id=?`).get(id) as {room:string;data:string;status?:string}|undefined;
    if(!row)return;
    let data:any;try{data=JSON.parse(row.data);}catch{return;}
    if(kind==='message'){
      if(data.id!==id||data.roomId!==row.room||typeof data.authorId!=='string'||typeof data.text!=='string')return;
      const message=data as GroupMessage;
      return {roomId:row.room,kind,sourceId:id,authorId:message.authorId,text:message.text,message,digest:digest({kind,room:row.room,id,message})};
    }
    if(row.status!=='sent'||data.status!=='sent'||data.message?.roomId!==row.room||typeof data.message.text!=='string'||typeof data.sentAt!=='number'||!Number.isFinite(data.sentAt))return;
    const reply:BotReply={...(typeof data.platformMessageId==='string'?{messageId:data.platformMessageId}:{}),...(typeof data.message.replyToMessageId==='string'?{replyToMessageId:data.message.replyToMessageId}:{}),text:data.message.text,sentAt:data.sentAt};
    const threadId=typeof(data.associationThreadId??data.threadId)==='string'?(data.associationThreadId??data.threadId) as string:undefined;
    return {roomId:row.room,kind,sourceId:id,authorId:null,text:reply.text,reply,...(threadId?{threadId}:{}),digest:digest({kind,room:row.room,id,reply,threadId})};
  }
  private index(kind:'message'|'reply',id:string,invalidated:Set<string>){
    const source=this.source(kind,id);
    const old=this.db.prepare('SELECT * FROM room_memory_events WHERE kind=? AND source_id=?').all(kind,id) as unknown as EventRow[];
    for(const event of old){
      const valid=source?.roomId===event.room?1:0,nextDigest=valid?source!.digest:digest({kind,id,room:event.room,unavailable:true});
      if(event.valid!==valid||event.source_digest!==nextDigest){
        this.db.prepare('UPDATE room_memory_events SET valid=?,source_digest=? WHERE seq=?').run(valid,nextDigest,event.seq);
        if(!invalidated.has(event.room)){this.invalidate(event.room);invalidated.add(event.room);}
      }
    }
    if(source){
      this.epoch(source.roomId);
      this.db.prepare('INSERT OR IGNORE INTO room_memory_events(room,kind,source_id,source_digest) VALUES(?,?,?,?)').run(source.roomId,kind,id,source.digest);
    }
    this.db.prepare('DELETE FROM room_memory_dirty WHERE kind=? AND source_id=?').run(kind,id);
  }
  /** Called inside the same savepoint as the source write. */
  indexMessage(id:string){this.index('message',id,new Set());}
  /** Pending/unknown/failed sends are not memories of something the bot said. */
  indexReply(id:string){this.index('reply',id,new Set());}
  /** Backfill missing sources only; afterwards inspect changed rows, not every body.
   * Ordering uses trusted receipt time (legacy fallback at), then kind/source ID. */
  sync(room?:string):void {
    roomMemoryAtomic(this.db,()=>{
      const invalidated=new Set<string>();
      for(const row of this.db.prepare('SELECT kind,source_id FROM room_memory_dirty ORDER BY kind,source_id').all() as unknown as {kind:'message'|'reply';source_id:string}[])this.index(row.kind,row.source_id,invalidated);
      const rows=this.db.prepare(`SELECT kind,source_id FROM (
        SELECT 'message' AS kind,m.id AS source_id,COALESCE(m.received_at,m.at) AS received FROM messages m
        WHERE (? IS NULL OR m.room=?) AND NOT EXISTS(SELECT 1 FROM room_memory_events e WHERE e.room=m.room AND e.kind='message' AND e.source_id=m.id)
        UNION ALL
        SELECT 'reply' AS kind,o.id AS source_id,json_extract(o.data,'$.sentAt') AS received FROM outbox o
        WHERE (? IS NULL OR o.room=?) AND o.status='sent' AND json_type(o.data,'$.sentAt') IN ('integer','real')
        AND NOT EXISTS(SELECT 1 FROM room_memory_events e WHERE e.room=o.room AND e.kind='reply' AND e.source_id=o.id)
      ) ORDER BY received,kind,source_id`).all(room??null,room??null,room??null,room??null) as unknown as {kind:'message'|'reply';source_id:string}[];
      for(const row of rows)this.index(row.kind,row.source_id,invalidated);
    });
  }
  rooms():string[]{this.sync();return (this.db.prepare('SELECT room FROM room_memory_meta ORDER BY room').all() as {room:string}[]).map(r=>r.room);}
  latestSeq(room:string):number {this.sync(room);return this.maxSeq(room);}
  private maxSeq(room:string):number{return Number((this.db.prepare('SELECT COALESCE(MAX(seq),0) AS n FROM room_memory_events WHERE room=?').get(room) as {n:number}).n);}
  private version(row:VersionRow|undefined):MemoryVersion|null{return row?{roomId:row.room,epoch:row.epoch,version:row.version,coveredSeq:row.covered_seq,notes:JSON.parse(row.notes),sourceDigest:row.source_digest,createdAt:row.created_at}:null;}
  private selectedVersion(room:string,epoch:number,cutoff:number):MemoryVersion|null {
    return this.version(this.db.prepare('SELECT * FROM room_memory_versions WHERE room=? AND epoch=? AND covered_seq<=? ORDER BY version DESC LIMIT 1').get(room,epoch,cutoff) as unknown as VersionRow|undefined);
  }
  head(room:string):{epoch:number;version:MemoryVersion|null}{this.sync(room);const epoch=this.epoch(room);return {epoch,version:this.selectedVersion(room,epoch,this.maxSeq(room))};}
  currentEpoch(room:string):number{this.sync(room);return this.epoch(room);}
  memory(room:string):MemoryVersion|null{return this.head(room).version;}
  private readEvent(row:EventRow):MemoryEvent|undefined {
    if(!row.valid)return;
    const source=this.source(row.kind,row.source_id);
    if(!source||source.roomId!==row.room||source.digest!==row.source_digest)throw new Error('Memory source changed outside its indexed transaction');
    return {seq:row.seq,...source};
  }
  event(room:string,seq:number):MemoryEvent|undefined {
    integer(seq,'sequence');this.sync(room);
    const row=this.db.prepare('SELECT * FROM room_memory_events WHERE room=? AND seq=?').get(room,seq) as unknown as EventRow|undefined;
    return row?this.readEvent(row):undefined;
  }
  /** One synchronization for an entire note source index; no per-source scans. */
  eventsBySeq(room:string,seqs:readonly number[]):MemoryEvent[]{
    this.sync(room);const read=this.db.prepare('SELECT * FROM room_memory_events WHERE room=? AND seq=?');
    return [...new Set(seqs)].flatMap(seq=>{integer(seq,'sequence');const row=read.get(room,seq) as unknown as EventRow|undefined;const event=row?this.readEvent(row):undefined;return event?[event]:[];});
  }
  /** Resolve known originals by identity within one captured intake boundary. */
  sourceEvents(room:string,options:{messageIds?:readonly string[];replyIds?:readonly string[];throughSeq:number}):MemoryEvent[]{
    integer(options.throughSeq,'through sequence');this.sync(room);
    const selected=new Map<number,MemoryEvent>();
    const messages=this.db.prepare("SELECT * FROM room_memory_events WHERE room=? AND kind='message' AND source_id=? AND seq<=? AND valid=1");
    const replies=this.db.prepare("SELECT e.* FROM room_memory_events e JOIN outbox o ON e.source_id=o.id WHERE e.room=? AND e.kind='reply' AND e.seq<=? AND e.valid=1 AND json_extract(o.data,'$.platformMessageId')=? ORDER BY e.seq");
    for(const id of new Set(options.messageIds??[])){const row=messages.get(room,id,options.throughSeq) as unknown as EventRow|undefined;const event=row?this.readEvent(row):undefined;if(event)selected.set(event.seq,event);}
    for(const id of new Set(options.replyIds??[]))for(const row of replies.all(room,options.throughSeq,id)){const event=this.readEvent(row as unknown as EventRow);if(event)selected.set(event.seq,event);}
    return [...selected.values()].sort((a,b)=>a.seq-b.seq);
  }
  private readEvents(room:string,options:MemoryEventsOptions):MemoryEvent[]{
    const after=integer(options.afterSeq??0,'after sequence'),through=integer(options.throughSeq??this.maxSeq(room),'through sequence');
    const limit=integer(options.limit??1000000,'event limit'),budget=integer(options.inputBudgetBytes??64000,'input budget');
    const events:MemoryEvent[]=[];let bytes=2;
    const rows=this.db.prepare('SELECT * FROM room_memory_events WHERE room=? AND seq>? AND seq<=? AND valid=1 ORDER BY seq LIMIT ?').iterate(room,after,through,limit);
    for(const value of rows){const event=this.readEvent(value as unknown as EventRow);if(!event)continue;const cost=byteSize(event)+(events.length?1:0);if(events.length&&bytes+cost>budget)break;events.push(event);bytes+=cost;if(bytes>=budget)break;}
    return events;
  }
  events(room:string,options:MemoryEventsOptions={}):MemoryEvent[]{this.sync(room);return this.readEvents(room,options);}
  /** Bounded intake metadata for batching; message timestamps are not trusted receipt times. */
  pendingWindow(room:string,options:{afterSeq:number;throughSeq:number;limit:number}):{count:number;oldestReceivedAt:number|null}{
    integer(options.afterSeq,'after sequence');integer(options.throughSeq,'through sequence');integer(options.limit,'event limit');
    this.sync(room);
    return this.db.prepare(`SELECT COUNT(*) AS count,MIN(received_at) AS oldestReceivedAt FROM (
      SELECT CASE WHEN e.kind='message' THEN COALESCE(m.received_at,m.at) ELSE json_extract(o.data,'$.sentAt') END AS received_at
      FROM room_memory_events e
      LEFT JOIN messages m ON e.kind='message' AND m.id=e.source_id AND m.room=e.room
      LEFT JOIN outbox o ON e.kind='reply' AND o.id=e.source_id AND o.room=e.room
      WHERE e.room=? AND e.seq>? AND e.seq<=? AND e.valid=1 ORDER BY e.seq LIMIT ?
    )`).get(room,options.afterSeq,options.throughSeq,options.limit) as {count:number;oldestReceivedAt:number|null};
  }
  private readTail(room:string,after:number,through:number,budget:number):MemoryEvent[]{
    integer(budget,'input budget');const events:MemoryEvent[]=[];let bytes=2;
    for(const row of this.db.prepare('SELECT * FROM room_memory_events WHERE room=? AND seq>? AND seq<=? AND valid=1 ORDER BY seq DESC').iterate(room,after,through)){
      const event=this.readEvent(row as unknown as EventRow);if(!event)continue;
      const cost=byteSize(event)+(events.length?1:0);if(bytes+cost>budget)break;events.push(event);bytes+=cost;
    }
    return events.reverse();
  }
  private prefixDigest(room:string,until:number):string {
    const hash=createHash('sha256');
    for(const row of this.db.prepare('SELECT seq,kind,source_id,source_digest,valid FROM room_memory_events WHERE room=? AND seq<=? ORDER BY seq').iterate(room,until))hash.update(JSON.stringify(row)).update('\n');
    return hash.digest('hex');
  }
  capture(room:string,options:MemoryCaptureOptions={}):MemorySnapshot {
    return roomMemoryAtomic(this.db,()=>{
      this.sync(room);const epoch=this.epoch(room),latest=this.maxSeq(room);
      let cutoff=options.cutoffSeq===undefined?latest:Math.min(integer(options.cutoffSeq,'cutoff'),latest);
      if(options.beforeMessageId){
        const row=this.db.prepare("SELECT seq FROM room_memory_events WHERE room=? AND kind='message' AND source_id=? AND valid=1").get(room,options.beforeMessageId) as {seq:number}|undefined;
        if(!row)throw new Error('Room memory intake boundary missing');cutoff=Math.min(cutoff,row.seq-1);
      }
      const version=this.selectedVersion(room,epoch,cutoff),after=version?.coveredSeq??0;
      // Foreground sees the latest corrections even when the summarizer has a
      // backlog. The middle remains an explicit gap, never silently "covered".
      const events=this.readTail(room,after,cutoff,options.eventBudgetBytes??64000);
      const gapEnd=events.length?events[0].seq-1:cutoff;
      const missing=this.db.prepare('SELECT MIN(seq) AS first,MAX(seq) AS last FROM room_memory_events WHERE room=? AND seq>? AND seq<=? AND valid=1').get(room,after,gapEnd) as {first:number|null;last:number|null};
      return {roomId:room,epoch,version,cutoffSeq:cutoff,events,...(missing.first!==null?{gap:{fromSeq:missing.first,toSeq:missing.last!}}:{})};
    });
  }
  batch(room:string,targetSeq:number,inputBudgetBytes=64000):MemoryBatch {
    integer(targetSeq,'target');integer(inputBudgetBytes,'input budget');
    return roomMemoryAtomic(this.db,()=>{
      this.sync(room);const epoch=this.epoch(room),target=Math.min(targetSeq,this.maxSeq(room));
      const base=this.selectedVersion(room,epoch,this.maxSeq(room));
      if((base?.coveredSeq??0)>target)throw new Error('Memory target predates current head');
      const after=base?.coveredSeq??0,events=this.readEvents(room,{afterSeq:after,throughSeq:target,inputBudgetBytes});
      const last=events.at(-1)?.seq??after;
      const hasMore=!!this.db.prepare('SELECT 1 FROM room_memory_events WHERE room=? AND seq>? AND seq<=? AND valid=1 LIMIT 1').get(room,last,target);
      const untilSeq=hasMore?last:target;
      return {roomId:room,epoch,baseVersion:base?.version??0,base,targetSeq:target,untilSeq,sourceDigest:this.prefixDigest(room,untilSeq),events,hasMore,...(byteSize(events)>inputBudgetBytes?{oversized:true}:{})};
    });
  }
  private validateNotes(room:string,until:number,notes:MemoryNote[],base:MemoryVersion|null){
    if(!Array.isArray(notes))throw new Error('Invalid memory notes');
    const ids=new Set<string>(),replaced=new Set<string>(),prior=new Map((base?.notes??[]).map(n=>[n.id,n]));
    for(const note of notes){
      if(!note||typeof note.id!=='string'||!note.id.trim()||ids.has(note.id)||!(note.authorId===null||typeof note.authorId==='string'&&note.authorId.length>0)||typeof note.text!=='string'||!note.text.trim()||!Array.isArray(note.sourceSeqs)||!note.sourceSeqs.length||new Set(note.sourceSeqs).size!==note.sourceSeqs.length)throw new Error('Invalid memory note');
      ids.add(note.id);
      const sources=note.sourceSeqs.map(seq=>{
        if(!Number.isSafeInteger(seq)||seq<1||seq>until)throw new Error('Memory source outside covered prefix');
        const row=this.db.prepare('SELECT * FROM room_memory_events WHERE room=? AND seq=? AND valid=1').get(room,seq) as unknown as EventRow|undefined;
        const source=row?this.readEvent(row):undefined;if(!source)throw new Error('Memory source outside room or unavailable');return source;
      });
      const authors=sources.filter(s=>s.kind==='message').map(s=>s.authorId);
      if(note.authorId===null?authors.length>0:!authors.includes(note.authorId)||authors.some(a=>a!==note.authorId))throw new Error('Memory note author does not match its sources');
      if(prior.has(note.id)&&prior.get(note.id)!.authorId!==note.authorId)throw new Error('Memory note cannot change author');
      if(note.supersedes!==undefined&&(!Array.isArray(note.supersedes)||new Set(note.supersedes).size!==note.supersedes.length))throw new Error('Invalid memory supersedes');
      for(const id of note.supersedes??[]){
        if(typeof id!=='string'||!id.trim()||id===note.id)throw new Error('Invalid memory supersedes');
        const old=prior.get(id);
        // A note's previously committed replacement audit is immutable history;
        // carrying it into the next version does not replace the old fact again.
        if(!old&&prior.get(note.id)?.supersedes?.includes(id))continue;
        if(!old||old.authorId!==note.authorId||replaced.has(id))throw new Error('Memory supersedes outside same-author previous notes');replaced.add(id);
      }
    }
    for(const id of replaced)if(ids.has(id))throw new Error('Superseded memory note is still present');
    for(const id of prior.keys())if(!ids.has(id)&&!replaced.has(id))throw new Error('Prior memory note omitted without an explicit successor');
  }
  commit(input:MemoryCommit):MemoryVersion|null {
    const {roomId:room,epoch,baseVersion,untilSeq,sourceDigest,notes}=input;
    integer(epoch,'epoch');integer(baseVersion,'base version');integer(untilSeq,'covered sequence');
    return roomMemoryAtomic(this.db,()=>{
      this.sync(room);if(this.epoch(room)!==epoch)return null;
      const base=this.selectedVersion(room,epoch,this.maxSeq(room));
      if((base?.version??0)!==baseVersion||untilSeq<(base?.coveredSeq??0)||untilSeq>this.maxSeq(room)||sourceDigest!==this.prefixDigest(room,untilSeq))return null;
      this.validateNotes(room,untilSeq,notes,base);
      const version:MemoryVersion={roomId:room,epoch,version:baseVersion+1,coveredSeq:untilSeq,notes:structuredClone(notes),sourceDigest,createdAt:Date.now()};
      this.db.prepare('INSERT INTO room_memory_versions(room,epoch,version,covered_seq,notes,source_digest,created_at) VALUES(?,?,?,?,?,?,?)').run(room,epoch,version.version,untilSeq,JSON.stringify(version.notes),sourceDigest,version.createdAt);
      return version;
    });
  }
  reset(room:string):number{return roomMemoryAtomic(this.db,()=>{this.sync(room);this.invalidate(room);return this.epoch(room);});}
}
