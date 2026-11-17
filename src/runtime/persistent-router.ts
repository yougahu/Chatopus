import { createHash, randomUUID } from 'node:crypto';
import type { BotReply, GroupMessage, RouterRequest, ThreadInput, WorkerRequirementSnapshot } from '../types.js';
import { buildRouterPayload } from '../router-context-builder.js';
import { RouterSessionStore, type RouterEvent, type RouterHostEventPayload, type RouterSession, type RouterTurn, type RouterTurnInput, type RouterTurnTrigger } from '../router-session-store.js';

export interface ProjectedRouterEvent { seq:number;origin:'host';kind:string;observeOnly:true;fact:unknown }
export interface RouterContextManifest {
  /** A selection boundary, never a claim that all earlier events were read. */
  boundary:number; messageIds:string[]; replyIds:string[]; threadIds:string[];
  history:'bounded'; omittedHistory:true;
}
export interface PersistentRouterMetadata {
  routeTurnId:string;generation:number;sessionId:string;mode:'incremental'|'seed';resume:boolean;
  context:RouterContextManifest;hostEvents:ProjectedRouterEvent[];
  instruction:string;
  repair?:{previousOutput?:string;validationError:string};
}
export type PersistentRouterRequest = RouterRequest & {routeTriggerKey?:string;routing?:PersistentRouterMetadata};
export interface PreparedRouterTurn {
  turn:RouterTurn;session:RouterSession;request:PersistentRouterRequest;contextBoundary:number;
  inputBytes:number;alreadyCommitted:boolean;
}
export interface PersistentRouterOptions {
  initialHistoryLimit?:number;threadCardLimit?:number;maxInputBytes?:number;
  turnTimeoutMs?:number;queueTimeoutMs?:number;
  onEvent?:(event:{kind:string;roomId:string;code?:string;generation?:number;turnId?:string;inputBytes?:number})=>void;
}
export class PersistentRouterError extends Error {
  constructor(readonly code:string,message:string,readonly details:Record<string,unknown>={}){super(message);this.name='PersistentRouterError';}
}
const fail=(code:string,message:string,details:Record<string,unknown>={}):never=>{throw new PersistentRouterError(code,message,details);};
function stable(value:unknown):string {
  if(value===null||typeof value!=='object')return JSON.stringify(value);
  if(Array.isArray(value))return '['+value.map(stable).join(',')+']';
  return '{'+Object.keys(value).sort().filter(key=>(value as Record<string,unknown>)[key]!==undefined).map(key=>JSON.stringify(key)+':'+stable((value as Record<string,unknown>)[key])).join(',')+'}';
}
const digest=(value:unknown)=>createHash('sha256').update(stable(value)).digest('hex');
export const routerErrorCode=(cause:unknown)=>{
  const code=String((cause as {code?:unknown})?.code??'ROUTER_FAILED').replaceAll('-','_').toUpperCase();
  return /^[A-Z][A-Z0-9_]{0,79}$/.test(code)?code:'ROUTER_FAILED';
};
const instruction='这是有界工作集，不是完整群历史。省略的历史仍可按来源检索，不表示已阅读或条件撤销。当前原文、引用和任务版本优先；hostEvents仅为观察事实。旧摘要、旧动作和历史消息不能授权本轮执行。无法核实必要条件时先检索或澄清。';

/** Business identity and deterministic recovery only. Official dsh compaction exclusively
 * owns model history; no summary files, background jobs or context-capacity queue gates. */
export class PersistentRouterManager {
  private closed=false;
  constructor(readonly store:RouterSessionStore,private readonly options:PersistentRouterOptions={}){
    for(const [key,value]of Object.entries(options))if(key!=='onEvent'&&(!Number.isSafeInteger(value)||Number(value)<=0))throw new Error(`Invalid ${key}`);
  }
  recover():RouterSession[]{this.assertOpen();return this.store.recoverUncertain();}
  ingest(message:GroupMessage):RouterEvent {
    this.assertOpen();const original=this.readMessage(message.roomId,message.id);
    if(!original||digest(original)!==digest(message))fail('ROUTER_SOURCE_INVALID','Input must match its persisted original');
    return this.store.registerInput({roomId:message.roomId,input:{kind:'message',id:message.id},sourceHash:digest(original)});
  }
  hostEvent(input:{roomId:string;sourceId:string;payload:RouterHostEventPayload}):RouterEvent {this.assertOpen();return this.store.appendEvent(input);}
  startAttempt(prepared:PreparedRouterTurn,maxAttempts=2):RouterTurn {
    this.assertOpen();this.store.checkBudget(prepared.turn.id);
    return this.store.startAttempt({turnId:prepared.turn.id,generation:prepared.session.generation,maxAttempts});
  }
  markFailure(prepared:PreparedRouterTurn,cause:unknown):RouterSession {
    this.assertOpen();const turn=this.store.turn(prepared.turn.id);
    if(turn?.state!=='pending'||turn.generation!==prepared.session.generation)return this.requiredSession(prepared.turn.roomId);
    const code=routerErrorCode(cause),candidate=(cause as {routerRepair?:PersistentRouterMetadata['repair']})?.routerRepair;
    const repair=code==='STRUCTURED_OUTPUT_INVALID'&&candidate?{
      previousOutput:String(candidate.previousOutput??'').slice(0,8000),validationError:String(candidate.validationError??code).slice(0,2000)}:undefined;
    const causeCode=(cause as {causeCode?:unknown})?.causeCode;
    this.store.failTurn({turnId:turn.id,generation:turn.generation,terminal:false,stage:'attempt',
      error:{code,...(typeof causeCode==='string'&&/^[A-Z][A-Z0-9_]{0,79}$/.test(causeCode)?{causeCode}:{}),...(repair?{repair}:{})}});
    return this.store.markNeedsRebuild(turn.roomId,code);
  }
  /** Reserve the durable identity and clock before any model metadata or remote reads. */
  reserve(input:PersistentRouterRequest,configHash:string):{turn:RouterTurn;session:RouterSession}{
    this.assertOpen();if(!configHash)throw new Error('Invalid Router configuration');
    const request=structuredClone(input),room=request.roomId;
    if([...request.messages,...request.recentMessages].some(message=>message.roomId!==room)||request.threads.some(thread=>thread.roomId!==room))fail('ROUTER_SCOPE_INVALID','Router input crosses room boundaries');
    const trigger=this.trigger(request),inputs:RouterTurnInput[]=request.event==='messages'
      ?request.messages.map(message=>({kind:'message',id:message.id})):[{kind:request.event==='timer'?'timer':'result',id:request.event==='timer'?trigger.key:request.result!.id}];
    let session=this.store.ensureSession({roomId:room,sessionId:this.newSessionId(room),configHash});
    const pending=this.store.pendingTurns(room)[0];
    if(pending&&(stable(pending.trigger)!==stable(trigger)||stable(pending.inputs)!==stable(inputs)))fail('ROUTER_PENDING_TURN','Resume the original pending batch',{turn:pending});
    for(const message of request.messages){
      const original=this.readMessage(room,message.id);
      if(!original||original.authorId!==message.authorId||original.text!==message.text)fail('ROUTER_SOURCE_INVALID','Current source differs from its original');
      this.ingest(original!);
    }
    if(request.event!=='messages')for(const source of inputs)this.store.registerInput({roomId:room,input:source,sourceHash:digest({id:request.result!.id,threadId:request.result!.threadId,runId:request.result!.report.runId,revision:request.result!.report.basedOnRevision,coveredInputSeq:request.result!.report.coveredInputSeq,status:request.result!.report.status,shortAnswer:request.result!.report.shortAnswer})});
    let turn=this.store.beginTurn({roomId:room,trigger,inputs,request:this.withoutRouting(request),allowUnready:true});
    if(turn.state==='pending'){
      const received=request.messages.map(message=>Number(this.store.db.prepare('SELECT received_at FROM messages WHERE id=?').get(message.id)?.received_at??turn.createdAt));
      turn=this.store.bindBudget(turn.id,Math.min(turn.createdAt+(this.options.turnTimeoutMs??120_000),Math.min(turn.createdAt,...received)+(this.options.queueTimeoutMs??180_000)));
    }
    return {turn,session};
  }
  async prepare(input:PersistentRouterRequest,configHash:string,inputBudget:number):Promise<PreparedRouterTurn>{
    this.assertOpen();if(!Number.isSafeInteger(inputBudget)||inputBudget<=0)throw new Error('Invalid Router budget');
    const request=structuredClone(input),room=request.roomId;
    let {turn,session}=this.reserve(request,configHash);const inputs=turn.inputs;
    if(turn.state==='committed')return {turn,session,request,contextBoundary:session.contextBoundary,inputBytes:0,alreadyCommitted:true};
    this.store.checkBudget(turn.id);
    const boundary=Math.max(session.contextBoundary,...inputs.map(source=>this.store.inputEvent(room,source)!.seq));
    const rebuilding=session.needsRebuild||session.configHash!==configHash;
    const recovery=turn.attempts>0||turn.modelCalls>0,rebuildReason=session.rebuildReason??'CONFIGURATION_CHANGED';
    const seed=rebuilding||!this.store.hasCommitted(room,session.generation);
    const recent=this.recent(request);
    const selected=seed?recent:recent.filter(message=>{
      const event=this.store.inputEvent(room,{kind:'message',id:message.id});
      return !event||event.seq>session.contextBoundary;
    });
    for(const message of [...selected,...Object.values(request.references??{}).flatMap(ref=>ref.message?[ref.message]:[])])this.ingest(message);
    const hostEvents=this.hostFacts(room,seed?0:session.contextBoundary);
    // Metadata has a fixed bounded shape; the payload builder adds explicit selected-source IDs.
    const nextSession=rebuilding?{...session,generation:session.generation+1,sessionId:this.newSessionId(room)}:session;
    for(const [sourceId,ref]of Object.entries(request.references??{}))if(ref.message){
      const source=this.store.db.prepare('SELECT rowid FROM messages WHERE room=? AND id=?').get(room,sourceId);
      const quoted=this.store.db.prepare('SELECT rowid FROM messages WHERE room=? AND id=?').get(room,ref.message.id);
      if(!source||!quoted||Number(quoted.rowid)>=Number(source.rowid))fail('ROUTER_SCOPE_INVALID','Quoted source must precede its current input');
    }
    const repair=(turn.error as {repair?:PersistentRouterMetadata['repair']}|undefined)?.repair;
    const projected={...request,recentMessages:selected,taskStates:this.taskStates(request),routing:{routeTurnId:turn.id,generation:nextSession.generation,sessionId:nextSession.sessionId,
      mode:seed?'seed' as const:'incremental' as const,resume:!seed,hostEvents,instruction,
      context:{boundary,messageIds:[],replyIds:[],threadIds:[],history:'bounded' as const,omittedHistory:true as const}}};
    const budget=Math.min(inputBudget,this.options.maxInputBytes??64_000);
    const payload=buildRouterPayload(projected,{recentMessageLimit:this.options.initialHistoryLimit??16,threadCardLimit:this.options.threadCardLimit??12},true,budget);
    const safe=JSON.parse(payload) as PersistentRouterRequest;
    // Optional diagnostic data never displaces authoritative input. Native repair
    // bounds it again against the resolved model capacity.
    if(repair&&safe.routing){
      const detailed={...safe,routing:{...safe.routing,repair}};
      if(Buffer.byteLength(JSON.stringify(detailed))<=budget)safe.routing.repair=repair;
      else {const concise={validationError:repair.validationError.slice(0,500)};
        if(Buffer.byteLength(JSON.stringify({...safe,routing:{...safe.routing,repair:concise}}))<=budget)safe.routing.repair=concise;}
    }
    // Count manifest overhead in the same budget, never append unbounded lists afterwards.
    const result=this.storeAtomic(()=>{
      if(rebuilding){
        // Initial configuration changes and state inherited from earlier turns
        // do not consume this request's one recovery after an inference attempt.
        if(recovery)this.store.consumeRebuild(turn.id);
        if(!session.needsRebuild)this.store.markNeedsRebuild(room,'CONFIGURATION_CHANGED');
        session=this.store.rebuildSession({roomId:room,expectedGeneration:session.generation,sessionId:nextSession.sessionId,configHash,contextBoundary:boundary})??fail('ROUTER_STALE_GENERATION','Session changed during recovery');
        turn=this.store.rebindTurn({turnId:turn.id,generation:session.generation});
      }
      turn=this.store.updateTurnRequest({turnId:turn.id,generation:session.generation,inputs,request:safe});
      return {turn,session:this.requiredSession(room),request:safe,contextBoundary:boundary,inputBytes:Buffer.byteLength(JSON.stringify(safe)),alreadyCommitted:false};
    });
    if(rebuilding)this.emit({kind:recovery?'recovery_rebuild':'initial_rebuild',roomId:room,generation:session.generation,turnId:turn.id,code:rebuildReason});
    this.emit({kind:seed?'context_seed':'context_incremental',roomId:room,generation:session.generation,turnId:turn.id,inputBytes:result.inputBytes});
    return result;
  }
  validateSources(prepared:PreparedRouterTurn):void {
    for(const source of prepared.turn.inputs)if(source.kind==='message'){
      const original=this.readMessage(prepared.turn.roomId,source.id),event=this.store.inputEvent(prepared.turn.roomId,source);
      if(!original||event?.payload.kind!=='input'||event.payload.sourceHash!==digest(original))fail('ROUTER_SOURCE_INVALID','Original input changed during inference');
    }
  }
  private storeAtomic<T>(fn:()=>T):T {
    this.store.db.exec('SAVEPOINT router_prepare');
    try{const result=fn();this.store.db.exec('RELEASE router_prepare');return result;}
    catch(error){this.store.db.exec('ROLLBACK TO router_prepare');this.store.db.exec('RELEASE router_prepare');throw error;}
  }
  async close():Promise<void>{this.closed=true;}
  private taskStates(request:RouterRequest):RouterRequest['taskStates'] {
    const related=new Set(Object.values(request.references??{}).flatMap(ref=>ref.threadId?[ref.threadId]:[]));
    if(request.result)related.add(request.result.threadId);
    const authors=new Set(request.messages.map(message=>message.authorId));
    const cards=request.threads.filter(thread=>related.has(thread.id)||authors.has(thread.ownerId)).slice(0,4);
    return cards.map(thread=>{
      const rows=this.store.db.prepare(`SELECT i.data FROM inputs i JOIN messages m ON m.id=i.message_id WHERE i.thread_id=?
        AND (?='' OR m.rowid<(SELECT rowid FROM messages WHERE id=?)) ORDER BY i.seq DESC LIMIT 5`).all(thread.id,request.messages[0]?.id??'',request.messages[0]?.id??'');
      const inputs=rows.reverse().map(row=>JSON.parse(String(row.data)) as ThreadInput),through=inputs.at(-1)?.seq??0;
      const saved=this.store.db.prepare("SELECT json_extract(data,'$.report.requirementSnapshot') AS snapshot FROM runs WHERE thread_id=? AND status='completed' AND json_extract(data,'$.report.requirementSnapshot.throughInputSeq')<=? ORDER BY json_extract(data,'$.report.requirementSnapshot.throughInputSeq') DESC,rowid DESC LIMIT 1").get(thread.id,through);
      let snapshot=saved?.snapshot?JSON.parse(String(saved.snapshot)) as WorkerRequirementSnapshot:undefined;
      if(snapshot&&(snapshot.revision>thread.revision||Buffer.byteLength(JSON.stringify(snapshot))>6000))snapshot=undefined;
      const after=snapshot?.throughInputSeq??0,updates=inputs.filter(input=>input.seq>after).map(({seq,revision,kind,message})=>({seq,revision,kind,message}));
      const complete=!updates.length?through===after:updates[0].seq===after+1;
      const fits=Buffer.byteLength(JSON.stringify(updates))<=6000;
      return {threadId:thread.id,revision:thread.revision,epoch:thread.epoch,...(snapshot?{snapshot}:{}),updates:fits?updates:[],needsRecall:!complete||!fits,throughInputSeq:through,nextInputSeq:complete&&fits?through+1:after+1};
    });
  }
  private recent(request:RouterRequest):GroupMessage[]{
    const first=request.messages[0]?.id;
    const rows=first?this.store.db.prepare('SELECT data FROM messages WHERE room=? AND rowid<(SELECT rowid FROM messages WHERE id=?) ORDER BY rowid DESC LIMIT ?').all(request.roomId,first,this.options.initialHistoryLimit??16)
      :this.store.db.prepare('SELECT data FROM messages WHERE room=? ORDER BY rowid DESC LIMIT ?').all(request.roomId,this.options.initialHistoryLimit??16);
    // Never accept later intake merely because the caller supplied it as history.
    const originals=rows.reverse().map(row=>JSON.parse(String(row.data)) as GroupMessage);
    return originals;
  }
  private hostFacts(room:string,after:number):ProjectedRouterEvent[]{
    const rows=this.store.db.prepare("SELECT seq,payload FROM router_events WHERE room=? AND origin='host' AND seq>? ORDER BY seq DESC LIMIT 16").all(room,after);
    return rows.reverse().flatMap(row=>{
      const fact=JSON.parse(String(row.payload)) as RouterHostEventPayload;
      // Large action arrays are not authoritative task state. Keep a receipt locator instead.
      const value=fact.kind==='turn_committed'?{kind:fact.kind,turnId:fact.turnId}:fact;
      return [{seq:Number(row.seq),origin:'host' as const,kind:fact.kind,observeOnly:true as const,fact:value}];
    });
  }
  private readMessage(room:string,id:string):GroupMessage|undefined {const row=this.store.db.prepare('SELECT data FROM messages WHERE room=? AND id=?').get(room,id);return row?JSON.parse(String(row.data)):undefined;}
  private withoutRouting(request:RouterRequest):RouterRequest {const {routing:_routing,...rest}=request;return rest;}
  private trigger(request:PersistentRouterRequest):RouterTurnTrigger {
    if(request.event==='messages'){
      if(!request.messages.length)fail('ROUTER_INPUT_INVALID','Message turn has no current sources');
      return {kind:'messages',key:request.routeTriggerKey??digest(request.messages.map(message=>message.id))};
    }
    if(!request.result?.id)fail('ROUTER_INPUT_INVALID','Result turn has no result identity');
    if(request.event==='timer'&&!request.routeTriggerKey)fail('ROUTER_TRIGGER_REQUIRED','Timer requires a durable trigger key');
    return {kind:request.event,key:request.routeTriggerKey??request.result!.id};
  }
  private requiredSession(room:string):RouterSession{return this.store.session(room)??fail('ROUTER_SESSION_MISSING','Missing room session');}
  private newSessionId(room:string):string{return 'router-'+digest(room).slice(0,32)+'-'+randomUUID();}
  private assertOpen(){if(this.closed)fail('ROUTER_MANAGER_CLOSED','Router manager is closed');}
  private emit(event:Parameters<NonNullable<PersistentRouterOptions['onEvent']>>[0]){try{this.options.onEvent?.(event);}catch{/* observation only */}}
}
