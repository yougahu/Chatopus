import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export type RouterTurnState = 'pending' | 'committed' | 'failed';
export interface RouterTurnInput { kind:'message'|'result'|'timer'; id:string }
export interface RouterTurnTrigger { kind:'messages'|'worker_result'|'timer'; key:string }
export interface RouterSession {
  roomId:string; generation:number; sessionId:string;
  /** Intake boundary used to select context; not proof that its full prefix was read. */
  contextBoundary:number;
  inflightTurnId?:string; needsRebuild:boolean; rebuildReason?:string;
  configHash:string; updatedAt:number;
}
export interface RouterTurn {
  id:string; roomId:string; trigger:RouterTurnTrigger; inputHash:string; inputs:RouterTurnInput[];
  generation:number; state:RouterTurnState; attempts:number;generationAttempts:number;
  deadlineAt?:number; modelCalls:number; summaryCalls:number; rebuilds:number;
  /** Fixed source identities; the host may refresh current task/reference views explicitly. */
  request:unknown; actions?:unknown; receipt?:unknown; error?:unknown; createdAt:number; updatedAt:number;
}
export type RouterHostEventPayload =
  | {kind:'turn_committed';turnId:string;receipt:unknown}
  | {kind:'task_changed';threadId:string;revision:number;epoch:number;status:string}
  | {kind:'memory_changed';memberId:string;revision:number;commitId:string}
  | {kind:'delivery_changed';outboxId:string;status:string;platformMessageId?:string}
  | {kind:'reply_sent';outboxId:string;sourceHash:string};
export interface RouterEvent {
  seq:number;roomId:string;origin:'input'|'host';sourceId:string;
  payload:{kind:'input';input:RouterTurnInput;sourceHash?:string}|RouterHostEventPayload;
  /** Only input events are claimed by a turn; host receipts never become actionable input. */
  ownerTurnId?:string;observeOnly:boolean;createdAt:number;
}
export interface BeginRouterTurn {
  roomId:string;trigger:RouterTurnTrigger;inputs:RouterTurnInput[];request:unknown;
  /** Reserve the fixed batch during recovery; inference still requires a healthy bound session. */
  allowUnready?:boolean;
}
export interface CommitRouterTurn {
  turnId:string;generation:number;actions:unknown;receipt?:unknown;
  /** Excludes the receipt being created now unless it was already represented separately. */
  contextBoundary?:number;
}
export interface RouterCommitResult {turn:RouterTurn;receipt:unknown;event:RouterEvent;alreadyCommitted:boolean}
export class RouterSessionStoreError extends Error {
  constructor(readonly code:string,message:string){super(message);this.name='RouterSessionStoreError';}
}
const error=(code:string,message:string):never=>{throw new RouterSessionStoreError(code,message);};
const id=(value:string,name:string)=>{
  if(typeof value!=='string'||!value.trim())error('ROUTER_INVALID_ARGUMENT',`Invalid ${name}`);
  return value;
};
const integer=(value:number,name:string)=>{
  if(!Number.isSafeInteger(value)||value<0)error('ROUTER_INVALID_ARGUMENT',`Invalid ${name}`);
  return value;
};
/** Stable JSON also makes dedup independent of object property insertion order. */
function json(value:unknown):string {
  const seen=new Set<object>();
  function canonical(item:unknown):unknown {
    if(item===null||typeof item==='string'||typeof item==='boolean')return item;
    if(typeof item==='number'&&Number.isFinite(item))return item;
    if(typeof item!=='object'||!item||seen.has(item))return error('ROUTER_INVALID_JSON','Expected finite, acyclic JSON data');
    if(Object.getPrototypeOf(item)!==Object.prototype&&!Array.isArray(item))return error('ROUTER_INVALID_JSON','Expected plain JSON data');
    seen.add(item);
    const result=Array.isArray(item)?item.map(canonical):Object.fromEntries(Object.keys(item).sort().filter(key=>(item as Record<string,unknown>)[key]!==undefined).map(key=>[key,canonical((item as Record<string,unknown>)[key])]));
    seen.delete(item);return result;
  }
  return JSON.stringify(canonical(value));
}
function inputsOf(inputs:RouterTurnInput[]):RouterTurnInput[] {
  if(!Array.isArray(inputs)||!inputs.length)error('ROUTER_INVALID_ARGUMENT','A turn requires input identities');
  const seen=new Set<string>();
  return inputs.map(input=>{
    if(!['message','result','timer'].includes(input.kind))error('ROUTER_INVALID_ARGUMENT','Invalid input kind');
    id(input.id,'input id');const key=json([input.kind,input.id]);
    if(seen.has(key))error('ROUTER_INPUT_CONFLICT','Repeated input in one batch');seen.add(key);
    return {kind:input.kind,id:input.id};
  });
}
/** Neither generation nor request/prompt content participates in the business identity. */
export function routerTurnHash(input:Pick<BeginRouterTurn,'roomId'|'trigger'|'inputs'>):string {
  id(input.roomId,'room');id(input.trigger.key,'trigger key');
  if(!['messages','worker_result','timer'].includes(input.trigger.kind))error('ROUTER_INVALID_ARGUMENT','Invalid trigger kind');
  return createHash('sha256').update(json({roomId:input.roomId,trigger:{kind:input.trigger.kind,key:input.trigger.key},inputs:inputsOf(input.inputs)})).digest('hex');
}
let savepointSequence=0;
function atomic<T>(db:DatabaseSync,fn:()=>T):T {
  const name=`router_session_${++savepointSequence}`;db.exec(`SAVEPOINT ${name}`);
  try{
    const result=fn();
    if(result&&typeof (result as {then?:unknown}).then==='function')error('ROUTER_ASYNC_TRANSACTION','Transaction callbacks must be synchronous');
    db.exec(`RELEASE ${name}`);return result;
  }catch(cause){try{db.exec(`ROLLBACK TO ${name}`);}finally{db.exec(`RELEASE ${name}`);}throw cause;}
}
interface SessionRow {room:string;generation:number;session_id:string;context_boundary:number;inflight_turn_id:string|null;needs_rebuild:number;rebuild_reason:string|null;config_hash:string;updated_at:number}
interface TurnRow {id:string;room:string;trigger_kind:RouterTurnTrigger['kind'];trigger_key:string;input_hash:string;inputs:string;generation:number;state:RouterTurnState;attempts:number;generation_attempts:number;deadline_at:number|null;model_calls:number;summary_calls:number;rebuilds:number;request:string;actions:string|null;receipt:string|null;error:string|null;created_at:number;updated_at:number}
interface EventRow {seq:number;room:string;origin:'input'|'host';source_id:string;payload:string;owner_turn_id:string|null;created_at:number}
const sessionOf=(row:SessionRow):RouterSession=>({roomId:row.room,generation:row.generation,sessionId:row.session_id,contextBoundary:row.context_boundary,
  needsRebuild:Boolean(row.needs_rebuild),configHash:row.config_hash,updatedAt:row.updated_at,
  ...(row.inflight_turn_id?{inflightTurnId:row.inflight_turn_id}:{}),...(row.rebuild_reason?{rebuildReason:row.rebuild_reason}:{})});
const turnOf=(row:TurnRow):RouterTurn=>({id:row.id,roomId:row.room,trigger:{kind:row.trigger_kind,key:row.trigger_key},inputHash:row.input_hash,inputs:JSON.parse(row.inputs),
  generation:row.generation,state:row.state,attempts:row.attempts,generationAttempts:row.generation_attempts,...(row.deadline_at?{deadlineAt:row.deadline_at}:{}),modelCalls:row.model_calls,summaryCalls:row.summary_calls,rebuilds:row.rebuilds,request:JSON.parse(row.request),createdAt:row.created_at,updatedAt:row.updated_at,
  ...(row.actions!==null?{actions:JSON.parse(row.actions)}:{}),...(row.receipt!==null?{receipt:JSON.parse(row.receipt)}:{}),...(row.error!==null?{error:JSON.parse(row.error)}:{})});
const eventOf=(row:EventRow):RouterEvent=>({seq:row.seq,roomId:row.room,origin:row.origin,sourceId:row.source_id,payload:JSON.parse(row.payload),observeOnly:row.origin==='host'||!row.owner_turn_id,createdAt:row.created_at,...(row.owner_turn_id?{ownerTurnId:row.owner_turn_id}:{})});

/** Three logical records, sharing the business SQLite transaction. No model/network calls belong here.
 * Input events double as the unique source-to-turn ownership index. Their sequence numbers and
 * host event sequence numbers form one room-filtered log; only explicitly claimed inputs authorize actions.
 * Construction is read/write schema initialization, never an implicit startup recovery. */
export class RouterSessionStore {
  constructor(readonly db:DatabaseSync){
    db.exec(`
      CREATE TABLE IF NOT EXISTS router_sessions(room TEXT PRIMARY KEY,generation INTEGER NOT NULL CHECK(generation>=1),session_id TEXT NOT NULL,context_boundary INTEGER NOT NULL DEFAULT 0,inflight_turn_id TEXT,needs_rebuild INTEGER NOT NULL DEFAULT 0,rebuild_reason TEXT,config_hash TEXT NOT NULL,updated_at INTEGER NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS router_sessions_active_id ON router_sessions(session_id);
      CREATE TABLE IF NOT EXISTS router_turns(id TEXT PRIMARY KEY,room TEXT NOT NULL,trigger_kind TEXT NOT NULL,trigger_key TEXT NOT NULL,input_hash TEXT NOT NULL,inputs TEXT NOT NULL,generation INTEGER NOT NULL,state TEXT NOT NULL CHECK(state IN ('pending','committed','failed')),attempts INTEGER NOT NULL DEFAULT 0,request TEXT NOT NULL,actions TEXT,receipt TEXT,error TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,UNIQUE(room,trigger_kind,trigger_key));
      CREATE INDEX IF NOT EXISTS router_turns_room_state ON router_turns(room,state,created_at);
      CREATE INDEX IF NOT EXISTS router_turns_updated ON router_turns(updated_at);
      CREATE UNIQUE INDEX IF NOT EXISTS router_turns_one_pending ON router_turns(room) WHERE state='pending';
      CREATE TABLE IF NOT EXISTS router_events(seq INTEGER PRIMARY KEY AUTOINCREMENT,room TEXT NOT NULL,origin TEXT NOT NULL CHECK(origin IN ('input','host')),source_id TEXT NOT NULL,payload TEXT NOT NULL,owner_turn_id TEXT,created_at INTEGER NOT NULL,UNIQUE(room,origin,source_id),CHECK(origin='input' OR owner_turn_id IS NULL));
      CREATE INDEX IF NOT EXISTS router_events_room_seq ON router_events(room,seq);
      CREATE INDEX IF NOT EXISTS router_events_turn ON router_events(owner_turn_id);
    `);
    // One-way schema migration: old semantic checkpoints no longer own admission.
    atomic(db,()=>{
      const columns=db.prepare('PRAGMA table_info(router_sessions)').all().map(row=>String(row.name));
      if(columns.includes('represented_through')){
        db.exec('ALTER TABLE router_sessions RENAME COLUMN represented_through TO context_boundary');
        db.prepare("UPDATE router_sessions SET needs_rebuild=1,rebuild_reason='context_architecture_v2',updated_at=?").run(Date.now());
      }
      for(const column of ['checkpoint_ref','candidate','checkpoint_failure'])if(columns.includes(column))db.exec(`ALTER TABLE router_sessions DROP COLUMN ${column}`);
      const turnColumns=db.prepare('PRAGMA table_info(router_turns)').all().map(row=>String(row.name));
      for(const [column,definition] of Object.entries({generation_attempts:'INTEGER NOT NULL DEFAULT 0',deadline_at:'INTEGER',model_calls:'INTEGER NOT NULL DEFAULT 0',summary_calls:'INTEGER NOT NULL DEFAULT 0',rebuilds:'INTEGER NOT NULL DEFAULT 0'}))
        if(!turnColumns.includes(column))db.exec(`ALTER TABLE router_turns ADD COLUMN ${column} ${definition}`);
      db.exec('CREATE TABLE IF NOT EXISTS router_provider_health(provider TEXT PRIMARY KEY,retry_at INTEGER NOT NULL,probe_turn TEXT,updated_at INTEGER NOT NULL)');
    });
  }
  session(roomId:string):RouterSession|undefined {
    const row=this.db.prepare('SELECT * FROM router_sessions WHERE room=?').get(roomId) as unknown as SessionRow|undefined;
    return row?sessionOf(row):undefined;
  }
  ensureSession(input:{roomId:string;sessionId:string;configHash:string}):RouterSession {
    id(input.roomId,'room');id(input.sessionId,'session id');id(input.configHash,'config hash');
    return atomic(this.db,()=>{
      this.db.prepare('INSERT OR IGNORE INTO router_sessions(room,generation,session_id,config_hash,updated_at) VALUES(?,1,?,?,?)').run(input.roomId,input.sessionId,input.configHash,Date.now());
      // Existing configuration and native identity are authoritative until an explicit rebuild.
      return this.requiredSession(input.roomId);
    });
  }
  private requiredSession(room:string):RouterSession {return this.session(room)??error('ROUTER_SESSION_MISSING','Room session does not exist');}
  turn(turnId:string):RouterTurn|undefined {
    const row=this.db.prepare('SELECT * FROM router_turns WHERE id=?').get(turnId) as unknown as TurnRow|undefined;
    return row?turnOf(row):undefined;
  }
  private requiredTurn(turnId:string):RouterTurn {return this.turn(turnId)??error('ROUTER_TURN_MISSING','Router turn does not exist');}
  pendingTurns(roomId?:string):RouterTurn[] {
    const rows=roomId===undefined?this.db.prepare("SELECT * FROM router_turns WHERE state='pending' ORDER BY created_at,rowid").all():this.db.prepare("SELECT * FROM router_turns WHERE room=? AND state='pending' ORDER BY created_at,rowid").all(roomId);
    return (rows as unknown as TurnRow[]).map(turnOf);
  }
  turns(roomId:string,generation?:number):RouterTurn[] {
    const rows=generation===undefined?this.db.prepare('SELECT * FROM router_turns WHERE room=? ORDER BY created_at,rowid').all(roomId):this.db.prepare('SELECT * FROM router_turns WHERE room=? AND generation=? ORDER BY created_at,rowid').all(roomId,generation);
    return (rows as unknown as TurnRow[]).map(turnOf);
  }
  hasCommitted(roomId:string,generation:number):boolean{return Boolean(this.db.prepare("SELECT 1 FROM router_turns WHERE room=? AND generation=? AND state='committed' LIMIT 1").get(roomId,generation));}
  inputEvent(roomId:string,input:RouterTurnInput):RouterEvent|undefined {
    const checked=inputsOf([input])[0];
    const row=this.db.prepare("SELECT * FROM router_events WHERE room=? AND origin='input' AND source_id=?").get(roomId,json([checked.kind,checked.id])) as unknown as EventRow|undefined;
    return row?eventOf(row):undefined;
  }
  /** Called after original intake persistence, including messages filtered out of model routing.
   * Registration observes a source; it does not claim an action or create a Router turn. */
  registerInput(input:{roomId:string;input:RouterTurnInput;sourceHash:string}):RouterEvent {
    id(input.roomId,'room');id(input.sourceHash,'source hash');const source=inputsOf([input.input])[0];
    return atomic(this.db,()=>this.insertEvent(input.roomId,'input',json([source.kind,source.id]),{kind:'input',input:source,sourceHash:input.sourceHash}));
  }
  turnForInput(roomId:string,input:RouterTurnInput):RouterTurn|undefined {
    const key=json([inputsOf([input])[0].kind,input.id]);
    const row=this.db.prepare("SELECT owner_turn_id FROM router_events WHERE room=? AND origin='input' AND source_id=?").get(roomId,key) as {owner_turn_id:string|null}|undefined;
    return row?.owner_turn_id?this.turn(row.owner_turn_id):undefined;
  }
  beginTurn(input:BeginRouterTurn):RouterTurn {
    const hash=routerTurnHash(input),inputs=inputsOf(input.inputs),request=json(input.request);
    return atomic(this.db,()=>{
      const prior=this.db.prepare('SELECT * FROM router_turns WHERE room=? AND trigger_kind=? AND trigger_key=?').get(input.roomId,input.trigger.kind,input.trigger.key) as unknown as TurnRow|undefined;
      if(prior){
        if(prior.input_hash!==hash)error('ROUTER_TRIGGER_CONFLICT','A stable trigger cannot change its original batch');
        return turnOf(prior);
      }
      const session=this.requiredSession(input.roomId);if(!input.allowUnready)this.requireReady(session);
      if(session.inflightTurnId||this.pendingTurns(input.roomId).length)error('ROUTER_TURN_BUSY','Resume the existing pending room turn first');
      const turnId='rt-'+hash,now=Date.now();
      this.db.prepare("INSERT INTO router_turns(id,room,trigger_kind,trigger_key,input_hash,inputs,generation,state,request,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'pending',?,?,?)")
        .run(turnId,input.roomId,input.trigger.kind,input.trigger.key,hash,json(inputs),session.generation,request,now,now);
      for(const source of inputs){
        const event=this.inputEvent(input.roomId,source)??this.insertEvent(input.roomId,'input',json([source.kind,source.id]),{kind:'input',input:source});
        if(event.ownerTurnId&&event.ownerTurnId!==turnId)error('ROUTER_INPUT_CLAIMED','Input already belongs to another turn');
        this.db.prepare('UPDATE router_events SET owner_turn_id=? WHERE seq=?').run(turnId,event.seq);
      }
      this.db.prepare('UPDATE router_sessions SET inflight_turn_id=?,updated_at=? WHERE room=?').run(turnId,now,input.roomId);
      return this.requiredTurn(turnId);
    });
  }
  /** Refresh live task/reference views without changing the original trigger, batch, or attempts. */
  updateTurnRequest(input:{turnId:string;generation:number;inputs:RouterTurnInput[];request:unknown}):RouterTurn {
    const encoded=json(input.request);
    return atomic(this.db,()=>{
      const turn=this.requiredTurn(input.turnId);this.requireBound(turn,input.generation);
      if(json(inputsOf(input.inputs))!==json(turn.inputs))error('ROUTER_INPUT_CONFLICT','Cannot refresh a turn with different source identities');
      this.db.prepare('UPDATE router_turns SET request=?,updated_at=? WHERE id=?').run(encoded,Date.now(),turn.id);
      return this.requiredTurn(turn.id);
    });
  }
  /** Save the host-validated proposal (including external write intents) before network work.
   * It is still a proposal, not an executed action; restart recovery must inspect/reconcile it. */
  saveTurnProposal(input:{turnId:string;generation:number;actions:unknown}):RouterTurn {
    const encoded=json(input.actions);
    return atomic(this.db,()=>{
      const turn=this.requiredTurn(input.turnId);this.requireBound(turn,input.generation);
      this.db.prepare('UPDATE router_turns SET actions=?,updated_at=? WHERE id=?').run(encoded,Date.now(),turn.id);
      return this.requiredTurn(turn.id);
    });
  }
  startAttempt(input:{turnId:string;generation:number;maxAttempts?:number}):RouterTurn {
    return atomic(this.db,()=>{
      const turn=this.requiredTurn(input.turnId);this.requireBound(turn,input.generation);
      if(input.maxAttempts!==undefined&&turn.attempts>=integer(input.maxAttempts,'max attempts'))error('ROUTER_RETRY_EXHAUSTED','Router attempt budget exhausted');
      this.db.prepare('UPDATE router_turns SET attempts=attempts+1,generation_attempts=generation_attempts+1,updated_at=? WHERE id=?').run(Date.now(),turn.id);
      return this.requiredTurn(turn.id);
    });
  }
  rebindTurn(input:{turnId:string;generation:number}):RouterTurn {
    return atomic(this.db,()=>{
      const turn=this.requiredTurn(input.turnId),session=this.requiredSession(turn.roomId);this.requireReady(session);
      if(turn.state!=='pending')error('ROUTER_TURN_TERMINAL','Only an uncommitted pending turn can be rebound');
      if(session.generation!==input.generation)error('ROUTER_STALE_GENERATION','Generation no longer active');
      if(session.inflightTurnId&&session.inflightTurnId!==turn.id)error('ROUTER_TURN_BUSY','Another turn owns the room');
      this.db.prepare('UPDATE router_turns SET generation=?,generation_attempts=?,updated_at=? WHERE id=?').run(input.generation,input.generation===turn.generation?turn.generationAttempts:0,Date.now(),turn.id);
      this.db.prepare('UPDATE router_sessions SET inflight_turn_id=?,updated_at=? WHERE room=?').run(turn.id,Date.now(),turn.roomId);
      return this.requiredTurn(turn.id);
    });
  }
  /** Release a stopped native generation while retaining ownership of the business input. */
  parkTurn(turnId:string):RouterTurn {
    return atomic(this.db,()=>{
      const turn=this.requiredTurn(turnId),session=this.requiredSession(turn.roomId);
      if(turn.state!=='pending'||(turn.attempts>0&&!session.needsRebuild))error('ROUTER_TURN_BUSY','Cannot park an active inference');
      if(session.inflightTurnId&&session.inflightTurnId!==turn.id)error('ROUTER_TURN_BUSY','Another turn owns the room');
      this.db.prepare('UPDATE router_sessions SET inflight_turn_id=NULL,updated_at=? WHERE room=?').run(Date.now(),turn.roomId);return turn;
    });
  }
  /** apply must be synchronous and only write through this same db. Its return value is the
   * receipt, so newly allocated thread IDs can be committed without guessing them beforehand.
   * External memory writes must have been verified before creating a success receipt here. */
  commitTurn(input:CommitRouterTurn,apply?:()=>unknown):RouterCommitResult {
    return atomic(this.db,()=>{
      const turn=this.requiredTurn(input.turnId);
      if(turn.state==='committed')return {turn,receipt:turn.receipt,event:this.commitEvent(turn),alreadyCommitted:true};
      const session=this.requireBound(turn,input.generation);
      this.checkBudget(turn.id);
      const represented=input.contextBoundary??session.contextBoundary;this.validateCursor(session,represented);
      const actions=json(input.actions),applied=apply?.();
      if(applied&&typeof (applied as {then?:unknown}).then==='function')error('ROUTER_ASYNC_TRANSACTION','Business commit callback must be synchronous');
      // A nested business callback may invalidate source/config state. Do not publish a receipt
      // after such invalidation; roll the entire outer savepoint back instead.
      this.requireBound(this.requiredTurn(turn.id),input.generation);
      const receipt=applied===undefined?(input.receipt??null):applied,encoded=json(receipt),now=Date.now();
      const event=this.insertEvent(turn.roomId,'host','turn:'+turn.id,{kind:'turn_committed',turnId:turn.id,receipt});
      this.db.prepare("UPDATE router_turns SET state='committed',actions=?,receipt=?,error=NULL,updated_at=? WHERE id=?").run(actions,encoded,now,turn.id);
      this.db.prepare('UPDATE router_sessions SET context_boundary=?,inflight_turn_id=NULL,updated_at=? WHERE room=?').run(represented,now,turn.roomId);
      return {turn:this.requiredTurn(turn.id),receipt:JSON.parse(encoded),event,alreadyCommitted:false};
    });
  }
  /** Terminal failures retain ownership and attempts. Nonterminal failures stay pending for
   * conservative rebuild/rebind; neither path silently starts a new trigger or resets budgets. */
  failTurn(input:{turnId:string;generation:number;error:unknown;terminal?:boolean;stage?:'attempt'|'terminal'}):RouterTurn {
    return atomic(this.db,()=>{
      const turn=this.requiredTurn(input.turnId),session=this.requiredSession(turn.roomId);
      if(turn.state!=='pending')error('ROUTER_TURN_TERMINAL','Turn is no longer pending');
      if(turn.generation!==input.generation||session.generation!==input.generation)error('ROUTER_STALE_GENERATION','Cannot fail an inactive generation');
      if(session.inflightTurnId!==turn.id&&!session.needsRebuild)error('ROUTER_TURN_NOT_BOUND','Turn is not bound to its room');
      const next=input.error as {code?:unknown;causeCode?:unknown},prior=turn.error as {code?:string;causeCode?:string;rootCode?:string;history?:unknown[];repair?:unknown}|undefined;
      // Keep the first cause when a later preparation/budget failure ends the
      // turn. Codes and bounded entries avoid duplicating model output in audit.
      const diagnostic=next&&typeof next==='object'&&typeof next.code==='string'?{
        ...(prior?.repair?{repair:prior.repair}:{}),...next,
        rootCode:prior?.rootCode??prior?.causeCode??prior?.code??next.causeCode??next.code,
        history:[...(Array.isArray(prior?.history)?prior.history.slice(-7):[]),{
          code:next.code,...(typeof next.causeCode==='string'?{causeCode:next.causeCode}:{}),
          stage:input.stage??(input.terminal===false?'attempt':'terminal'),attempt:turn.attempts,generation:turn.generation,at:Date.now(),
        }],
      }:input.error;
      const encoded=json(diagnostic);
      this.db.prepare('UPDATE router_turns SET state=?,error=?,updated_at=? WHERE id=?').run(input.terminal===false?'pending':'failed',encoded,Date.now(),turn.id);
      this.db.prepare('UPDATE router_sessions SET inflight_turn_id=?,needs_rebuild=1,rebuild_reason=?,updated_at=? WHERE room=?')
        .run(input.terminal===false?turn.id:null,'turn_failed',Date.now(),turn.roomId);
      return this.requiredTurn(turn.id);
    });
  }
  markNeedsRebuild(roomId:string,reason:string):RouterSession {
    id(reason,'rebuild reason');return atomic(this.db,()=>{
      this.requiredSession(roomId);
      this.db.prepare('UPDATE router_sessions SET needs_rebuild=1,rebuild_reason=?,updated_at=? WHERE room=?').run(reason,Date.now(),roomId);
      return this.requiredSession(roomId);
    });
  }
  /** Call once at startup, before serving. A pending native turn is never trusted to auto-resume. */
  recoverUncertain():RouterSession[] {
    return atomic(this.db,()=>{
      this.db.prepare("UPDATE router_sessions SET needs_rebuild=1,rebuild_reason=COALESCE(rebuild_reason,'startup_unsettled_turn'),updated_at=? WHERE inflight_turn_id IS NOT NULL OR EXISTS(SELECT 1 FROM router_turns t WHERE t.room=router_sessions.room AND t.state='pending')").run(Date.now());
      return (this.db.prepare('SELECT * FROM router_sessions WHERE needs_rebuild=1 ORDER BY room').all() as unknown as SessionRow[]).map(sessionOf);
    });
  }
  /** The durable business request can seed a fresh native session without an LLM call.
   * A crash before native creation is recovered from the pending turn on startup. */
  rebuildSession(input:{roomId:string;expectedGeneration:number;sessionId:string;configHash:string;contextBoundary?:number}):RouterSession|null {
    id(input.sessionId,'session id');id(input.configHash,'config hash');
    return atomic(this.db,()=>{
      const session=this.requiredSession(input.roomId);
      if(session.generation!==input.expectedGeneration)return null;
      if(!session.needsRebuild)error('ROUTER_REBUILD_NOT_REQUIRED','Mark the uncertain session before rebuilding');
      if(input.sessionId===session.sessionId)error('ROUTER_INVALID_ARGUMENT','A new generation needs a distinct native session');
      const through=input.contextBoundary??session.contextBoundary;this.validateCursor(session,through);
      this.db.prepare('UPDATE router_sessions SET generation=generation+1,session_id=?,context_boundary=?,config_hash=?,inflight_turn_id=NULL,needs_rebuild=0,rebuild_reason=NULL,updated_at=? WHERE room=?')
        .run(input.sessionId,through,input.configHash,Date.now(),input.roomId);
      return this.requiredSession(input.roomId);
    });
  }
  bindBudget(turnId:string,deadlineAt:number):RouterTurn {
    integer(deadlineAt,'deadline');
    this.db.prepare("UPDATE router_turns SET deadline_at=MIN(COALESCE(deadline_at,?),?) WHERE id=? AND state='pending'").run(deadlineAt,deadlineAt,turnId);
    return this.requiredTurn(turnId);
  }
  checkBudget(turnId:string):RouterTurn {
    const turn=this.requiredTurn(turnId);
    if(turn.state!=='pending')error('ROUTER_TURN_TERMINAL','Turn is no longer pending');
    if(turn.deadlineAt!==undefined&&Date.now()>=turn.deadlineAt)error('ROUTER_DEADLINE','Router total execution/queue deadline expired');
    return turn;
  }
  consumeModelCall(turnId:string,summary:boolean,maxCalls=12,maxSummaries=2):void {
    atomic(this.db,()=>{
      const turn=this.checkBudget(turnId);
      if(turn.modelCalls>=maxCalls||summary&&turn.summaryCalls>=maxSummaries)error('ROUTER_CALL_LIMIT','Router shared model-call budget exhausted');
      this.db.prepare('UPDATE router_turns SET model_calls=model_calls+1,summary_calls=summary_calls+?,updated_at=? WHERE id=?').run(Number(summary),Date.now(),turnId);
    });
  }
  consumeRebuild(turnId:string):void {
    atomic(this.db,()=>{
      const turn=this.checkBudget(turnId);
      if(turn.rebuilds>=1)error('ROUTER_REBUILD_LIMIT','Router reconstruction budget exhausted');
      const prior=turn.error as {history?:unknown[]}|undefined;
      const diagnostic={...(prior&&typeof prior==='object'?prior:{}),history:[...(Array.isArray(prior?.history)?prior.history.slice(-7):[]),
        {code:'ROUTER_REBUILD',stage:'rebuild',attempt:turn.attempts,generation:turn.generation,at:Date.now()}]};
      this.db.prepare('UPDATE router_turns SET rebuilds=rebuilds+1,error=?,updated_at=? WHERE id=?').run(json(diagnostic),Date.now(),turnId);
    });
  }
  admitProvider(provider:string,turnId:string,leaseMs:number):void {
    atomic(this.db,()=>{
      const row=this.db.prepare('SELECT retry_at,probe_turn FROM router_provider_health WHERE provider=?').get(provider);
      if(!row)return;
      if(Number(row.retry_at)>Date.now()&&row.probe_turn!==turnId)error('ROUTER_PROVIDER_UNAVAILABLE','Router provider recovery is pending');
      this.db.prepare('UPDATE router_provider_health SET retry_at=?,probe_turn=?,updated_at=? WHERE provider=?').run(Date.now()+leaseMs,turnId,Date.now(),provider);
    });
  }
  providerFailed(provider:string):void {
    this.db.prepare('INSERT INTO router_provider_health(provider,retry_at,probe_turn,updated_at) VALUES(?,?,NULL,?) ON CONFLICT(provider) DO UPDATE SET retry_at=excluded.retry_at,probe_turn=NULL,updated_at=excluded.updated_at').run(provider,Date.now()+30_000,Date.now());
  }
  providerSucceeded(provider:string,turnId:string,startedAt:number):void {
    this.db.prepare('DELETE FROM router_provider_health WHERE provider=? AND (probe_turn=? OR updated_at<=?)').run(provider,turnId,startedAt);
  }
  appendEvent(input:{roomId:string;sourceId:string;payload:RouterHostEventPayload}):RouterEvent {
    // turn_committed is reserved for commitTurn, so callers cannot forge a commit receipt.
    if(input.payload.kind==='turn_committed'||input.sourceId.startsWith('turn:'))error('ROUTER_INVALID_ARGUMENT','Commit receipts are written by commitTurn');
    return atomic(this.db,()=>{this.requiredSession(input.roomId);return this.insertEvent(input.roomId,'host',input.sourceId,input.payload);});
  }
  events(roomId:string,options:{afterSeq?:number;throughSeq?:number;limit?:number}={}):RouterEvent[] {
    const after=integer(options.afterSeq??0,'event start'),through=integer(options.throughSeq??this.latestEventSeq(roomId),'event end');
    const limit=integer(options.limit??1000,'event limit');
    return (this.db.prepare('SELECT * FROM router_events WHERE room=? AND seq>? AND seq<=? ORDER BY seq LIMIT ?').all(roomId,after,through,limit) as unknown as EventRow[]).map(eventOf);
  }
  latestEventSeq(roomId:string):number {return Number((this.db.prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM router_events WHERE room=?').get(roomId) as {seq:number}).seq);}
  private insertEvent(room:string,origin:'input'|'host',sourceId:string,payload:RouterEvent['payload']):RouterEvent {
    id(sourceId,'event source');const encoded=json(payload);
    const prior=this.db.prepare('SELECT * FROM router_events WHERE room=? AND origin=? AND source_id=?').get(room,origin,sourceId) as unknown as EventRow|undefined;
    if(prior){if(prior.payload!==encoded)error('ROUTER_EVENT_CONFLICT','Stable event source has different content');return eventOf(prior);}
    const result=this.db.prepare('INSERT INTO router_events(room,origin,source_id,payload,created_at) VALUES(?,?,?,?,?)').run(room,origin,sourceId,encoded,Date.now());
    return eventOf(this.db.prepare('SELECT * FROM router_events WHERE seq=?').get(result.lastInsertRowid) as unknown as EventRow);
  }
  private commitEvent(turn:RouterTurn):RouterEvent {
    const row=this.db.prepare("SELECT * FROM router_events WHERE room=? AND origin='host' AND source_id=?").get(turn.roomId,'turn:'+turn.id) as unknown as EventRow|undefined;
    if(!row)return error('ROUTER_STATE_CORRUPT','Committed turn is missing its receipt event');return eventOf(row);
  }
  private requireReady(session:RouterSession){if(session.needsRebuild)error('ROUTER_REBUILD_REQUIRED','Room session must be rebuilt before inference or commit');}
  private requireBound(turn:RouterTurn,generation:number):RouterSession {
    const session=this.requiredSession(turn.roomId);
    if(turn.state!=='pending')error('ROUTER_TURN_TERMINAL','Turn is no longer pending');
    if(session.generation!==generation||turn.generation!==generation)error('ROUTER_STALE_GENERATION','Router result belongs to an inactive generation');
    this.requireReady(session);
    if(session.inflightTurnId!==turn.id)error('ROUTER_TURN_NOT_BOUND','Turn is not the active room input');
    return session;
  }
  private validateRoomSeq(room:string,seq:number){
    integer(seq,'event cursor');
    if(seq!==0&&!this.db.prepare('SELECT 1 FROM router_events WHERE room=? AND seq=?').get(room,seq))error('ROUTER_INVALID_CURSOR','Event cursor is outside the room log');
  }
  private validateCursor(session:RouterSession,seq:number){
    this.validateRoomSeq(session.roomId,seq);
    if(seq<session.contextBoundary)error('ROUTER_INVALID_CURSOR','Context intake boundary cannot move backwards');
  }
}
