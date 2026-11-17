import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from './config.js';
import { Store, type ResultRow, type OutboxRow } from './store.js';
import { renderReplyLinks, assertLinkReferencesUnchanged } from './tools/reply-links.js';
import { routeSchema, reportSchema, validateRouteActions, enforceReferenceThreads, ROUTER_REPLY_HISTORY_LIMIT } from './protocol.js';
import { describeAddressing, type AddressingBotReply } from './router-context.js';
import { mergeRouterContext } from './runtime/router-recall.js';
import { modelRetriesExhausted, MODEL_ERROR_REPLY } from './runtime/model-retry.js';
import { enforceExplicitActivation, hasWakeCandidate, silentMessages } from './activation.js';
import { withinRouterDeadline } from './runtime/router-budget.js';
import { isSqliteBusy,retrySqliteBusy } from './runtime/sqlite-busy.js';
import { routerClock } from './runtime/router-request.js';
import { RoomMemoryWorker } from './room-memory-worker.js';
import { attachRoomMemory } from './router-context-builder.js';
import { PersistentRouterManager, routerErrorCode, type PreparedRouterTurn } from './runtime/persistent-router.js';
import { prepareMemberCommit, applyMemberCommit, enqueueMemberConfirmations, type MemberCommitProposal, type MemberCommitReceipt } from './memory/member-commit.js';
import { OpenVikingIngestion } from './memory/openviking-ingestion.js';
import { openVikingPrepareAfter } from './memory/openviking-maintenance.js';
import type { MemberMemoryProjection } from './memory/member-updates.js';
import { ScheduledTaskHost } from './scheduled-tasks/host.js';
import { MAX_OUTPUT_FILE_COUNT, MAX_OUTPUT_FILE_TOTAL_BYTES, readOutgoingFile } from './output-files.js';
import type { GroupMessage, PublisherPort, RouteAction, RouterRequest, RuntimePort, SendReceipt, ThreadCard, ThreadInput, WorkerRequest } from './types.js';

interface QueuedMessage { message:GroupMessage; resolve:()=>void; reject:(error:unknown)=>void }
interface RoomBatch { items:QueuedMessage[]; running?:Promise<void>; timer?:ReturnType<typeof setTimeout>;retryAt?:number }
interface PreferenceOutbox extends OutboxRow {hostMemberMemory?:MemberMemoryProjection[];preferenceSourceText?:string;preferenceFailures?:number;preferenceReadFailures?:number}

export class Coordinator {
  private roomLocks=new Map<string,Promise<unknown>>();
  private active=new Map<string,{promise:Promise<void>;abort:AbortController}>();
  private resultActive=new Set<string>();
  private resultTasks=new Set<Promise<unknown>>();
  private dispatching=false;
  private dispatchTask?:Promise<void>;
  private stopped=false;
  private timer?:ReturnType<typeof setInterval>;
  private lastChatter=new Map<string,number>();
  private batches=new Map<string,RoomBatch>();
  private batchTasks=new Set<Promise<void>>();
  private steerTasks=new Set<Promise<void>>();
  private resultRetryAt=new Map<string,number>();
  readonly memoryWorker?:RoomMemoryWorker;
  readonly persistentRouter?:PersistentRouterManager;
  readonly memoryIngestion?:OpenVikingIngestion;
  readonly scheduledTasks:ScheduledTaskHost;
  private lastWorkerWasScheduled=false;
  constructor(readonly config:Config,readonly store:Store,readonly runtime:RuntimePort,readonly publisher:PublisherPort,readonly scheduleExecution=false){
    this.scheduledTasks=new ScheduledTaskHost(config,store,publisher);
    if(runtime.sharedMemory)this.memoryIngestion=new OpenVikingIngestion({db:store.db,sharedMemory:runtime.sharedMemory,source:store.roomMemory,
      concurrency:Math.max(1,config.concurrency-1),batchSize:config.memory?.ingestBatchSize,batchWindowMs:config.memory?.ingestBatchWindowMs,
      prepareAfter:()=>openVikingPrepareAfter(config.stateDir),
      onEvent:event=>store.telemetry('openviking_ingestion',event)});
    if(config.persistentRouter){
      this.persistentRouter=new PersistentRouterManager(store.routerSessions,{initialHistoryLimit:config.recentMessageLimit,threadCardLimit:config.threadCardLimit,
        turnTimeoutMs:config.routerTurnTimeoutMs,queueTimeoutMs:config.routerQueueTimeoutMs,
        onEvent:event=>store.telemetry('router_context_lifecycle',event)});
    }
    if(!runtime.sharedMemory&&!config.persistentRouter&&runtime.roomMemoryBudget&&runtime.summarizeRoomMemory)this.memoryWorker=new RoomMemoryWorker({
      store:store.roomMemory,concurrency:Math.max(1,config.concurrency-1),
      budget:(request,signal)=>runtime.roomMemoryBudget!(request,signal),
      summarize:(input,signal)=>runtime.summarizeRoomMemory!(input,signal),
      onEvent:event=>store.telemetry('room_memory',event),
    });
  }
  private room<T>(roomId:string,fn:()=>Promise<T>):Promise<T> {
    const previous=this.roomLocks.get(roomId)??Promise.resolve();
    const next=previous.catch(()=>{}).then(fn);this.roomLocks.set(roomId,next);
    void next.finally(()=>{if(this.roomLocks.get(roomId)===next)this.roomLocks.delete(roomId);}).catch(()=>{});
    return next;
  }
  async start() {
    if(!this.scheduledTasks.enabled)this.scheduledTasks.service.disable();
    this.store.recovery();
    this.scheduledTasks.recover();
    this.scheduledTasks.reconcileProposals();
    for(const row of this.store.outbox('unknown'))if(row.scheduleRunId)this.scheduledTasks.delivery(row.scheduleRunId,'unknown');
    for(const row of this.store.outbox('unknown'))this.enqueueFileDeliveryNotice(row);
    this.reconcileScheduledCancellation();
    this.persistentRouter?.recover();
    for(const roomId of this.store.roomMemory.rooms())this.memoryWorker?.notify(roomId);
    for(const roomId of this.store.roomMemory.rooms())this.memoryIngestion?.notify(roomId);
    const recovered=this.store.pendingMessages().map(message=>this.queue(message));
    this.timer=setInterval(()=>void this.tick().catch(e=>this.error('tick',e)),100);
    this.timer.unref();
    await Promise.all(recovered);await this.tick();
  }
  async receive(message:GroupMessage) {
    if(this.stopped)throw new Error('Coordinator closed');
    // Persist before waiting for a routing slot. The platform callback can remain pending.
    const receivedAt=Date.now();
    const inserted=await retrySqliteBusy(()=>this.store.transaction(()=>{
      const inserted=this.store.ingest(message,receivedAt);
      if(inserted)this.persistentRouter?.ingest(message);
      return inserted;
    }),{deadlineAt:receivedAt+(this.config.routerQueueTimeoutMs??180_000),stopped:()=>this.stopped});
    if(!inserted||this.stopped)return;
    const queued=this.queue(message);
    this.memoryWorker?.notify(message.roomId);
    this.memoryIngestion?.notify(message.roomId);
    await queued;
  }
  private queue(message:GroupMessage):Promise<void> {
    let batch=this.batches.get(message.roomId);
    if(!batch){batch={items:[]};this.batches.set(message.roomId,batch);}
    const promise=new Promise<void>((resolve,reject)=>batch!.items.push({message,resolve,reject}));
    this.scheduleBatch(message.roomId,batch);
    return promise;
  }
  private scheduleBatch(roomId:string,batch:RoomBatch) {
    if(this.stopped||batch.running||!batch.items.length)return;
    if(batch.retryAt&&batch.retryAt>Date.now()){
      if(!batch.timer)batch.timer=setTimeout(()=>{batch.timer=undefined;this.flushBatch(roomId,batch);},batch.retryAt-Date.now());
      return;
    }
    if(batch.items.length>=this.config.routerBatchSize){
      if(batch.timer)clearTimeout(batch.timer);batch.timer=undefined;
      this.flushBatch(roomId,batch);return;
    }
    if(!batch.timer)batch.timer=setTimeout(()=>{batch.timer=undefined;this.flushBatch(roomId,batch);},this.config.routerBatchWindowMs);
  }
  private flushBatch(roomId:string,batch:RoomBatch) {
    if(this.stopped||batch.running||!batch.items.length)return;
    if(batch.retryAt&&batch.retryAt>Date.now()){this.scheduleBatch(roomId,batch);return;}
    const pending=this.persistentRouter?this.store.routerSessions.pendingTurns(roomId)[0]:undefined;
    if(pending&&pending.trigger.kind!=='messages'){batch.retryAt=Date.now()+1000;this.scheduleBatch(roomId,batch);return;}
    // Selecting at flush preserves order; arrivals during a slow Router collect for the next call.
    const prior=new Set<string>();let size=0;
    for(const item of batch.items.slice(0,this.config.routerBatchSize)){
      if(item.message.replyToMessageId&&prior.has(item.message.replyToMessageId))break;
      prior.add(item.message.messageId);size++;
    }
    const selected=pending?pending.inputs.map(input=>{
      if(input.kind!=='message')throw new Error('Message Router turn owns a non-message source');
      const index=batch.items.findIndex(item=>item.message.id===input.id);
      if(index>=0)return batch.items.splice(index,1)[0];
      const message=this.store.message(input.id);if(!message||message.roomId!==roomId)throw new Error('Pending Router source is unavailable');
      return {message,resolve:()=>{},reject:()=>{}};
    }):batch.items.splice(0,size);
    const release=()=>{
      if(batch.running!==task)return;
      batch.running=undefined;
      if(this.stopped)return;
      if(batch.items.length)this.scheduleBatch(roomId,batch);
      else if(!batch.timer&&this.batches.get(roomId)===batch)this.batches.delete(roomId);
    };
    const task=this.routeBatch(selected.map(item=>item.message)).then(async()=>{
      // Publishing may be slow; release the routing slot before dispatching replies.
      release();
      try{await this.tick();}catch(error){this.error('batch_tick',error);}
      for(const item of selected)item.resolve();
    }).catch(error=>{
      const requeue=()=>{
        const present=new Set(batch.items.map(item=>item.message.id));
        batch.items.unshift(...selected.filter(item=>!present.has(item.message.id)));
        batch.retryAt=Date.now()+1000;
      };
      try{
      if(isSqliteBusy(error)&&!this.stopped){requeue();return;}
      if(this.stopped){
        for(const item of selected){
          const status=this.store.db.prepare('SELECT status FROM messages WHERE id=?').get(item.message.id)?.status;
          if(status!=='routed'&&status!=='failed')this.store.messageStatus(item.message.id,'pending');item.resolve();
        }
        return;
      }
      const durable=this.persistentRouter?this.store.routerSessions.pendingTurns(roomId)[0]:undefined;
      if(durable?.deadlineAt&&Date.now()>=durable.deadlineAt){
        this.store.transaction(()=>{
          this.store.routerSessions.failTurn({turnId:durable.id,generation:durable.generation,error:{code:'ROUTER_DEADLINE',proposalRetained:Boolean(durable.actions)}});
          for(const item of selected){this.store.messageStatus(item.message.id,'failed');if(hasWakeCandidate(item.message,this.config.botCallNames))this.store.enqueue({roomId,replyToMessageId:item.message.messageId,text:'这条请求已超时，原文和处理记录已保留。尚未确认的资料写入需要核对，本次不会自动重做。'},{id:'route-failed:'+item.message.id});}
        });
        for(const item of selected)item.resolve();return;
      }
      if(durable&&!this.stopped){
        // Only bounded remote-write reconciliation retains this original proposal.
        const present=new Set(batch.items.map(item=>item.message.id));
        batch.items.unshift(...selected.filter(item=>!present.has(item.message.id)));
        const retryAt=Number((error as {details?:{retryAt?:number}})?.details?.retryAt??0);
        batch.retryAt=Math.max(Date.now()+1000,Number.isFinite(retryAt)?retryAt:0);
        this.error('router_pending',{turnId:durable.id,code:(error as {code?:string})?.code??'ROUTER_PENDING'});return;
      }
      // Unexpected processing errors remain durable for restart/manual recovery.
      for(const item of selected){
        const status=this.store.db.prepare('SELECT status FROM messages WHERE id=?').get(item.message.id)?.status;
        if(status!=='routed'&&status!=='failed')this.store.messageStatus(item.message.id,'pending');item.reject(error);
      }
      this.error('batch_failed',error);
      }catch(recoveryError){
        // Failure bookkeeping can contend too; keep ownership in the live queue.
        if(isSqliteBusy(recoveryError)&&!this.stopped){requeue();return;}
        for(const item of selected)item.reject(recoveryError);
        this.error('batch_recovery_failed',recoveryError);
      }
    }).finally(()=>{release();this.batchTasks.delete(task);});
    batch.running=task;this.batchTasks.add(task);
  }
  private async routeBatch(messages:GroupMessage[]) {
    const roomId=messages[0].roomId;
    let split=false;
    await this.room(roomId,async()=>{
      if(this.stopped)return;
      const intakeAt=Math.min(...messages.map(message=>Number(this.store.db.prepare('SELECT received_at FROM messages WHERE id=?').get(message.id)?.received_at??Date.now())));
      const preparationDeadline=Math.min(Date.now()+(this.config.routerTurnTimeoutMs??120_000),intakeAt+(this.config.routerQueueTimeoutMs??180_000));
      const databaseOptions={deadlineAt:preparationDeadline,stopped:()=>this.stopped};
      const expired=await retrySqliteBusy(()=>this.store.transaction(()=>{
        const expired=!this.persistentRouter&&Date.now()>=preparationDeadline;
        for(const message of messages){
          this.store.messageStatus(message.id,expired?'failed':'processing');
          if(expired&&hasWakeCandidate(message,this.config.botCallNames))this.store.enqueue({roomId,replyToMessageId:message.messageId,text:'这条请求已超过排队时限，原文已保留，本次尚未执行任务。'},{id:'route-failed:'+message.id});
        }
        return expired;
      }),databaseOptions);
      if(this.stopped||expired)return;
      const recentMessages=this.store.recent(roomId,this.config.recentMessageLimit,messages[0].id);
      const seen=new Set(recentMessages.map(message=>message.id));
      for(const message of messages)if(message.replyToMessageId){
        const quoted=this.store.referencedBefore(roomId,message.replyToMessageId,messages[0].id);
        if(quoted&&!seen.has(quoted.id)){seen.add(quoted.id);recentMessages.push(quoted);}
      }
      const currentTime=Date.now(),currentTimeContext=routerClock(currentTime,this.config.scheduledTasks?.defaultTimezone??'UTC');
      const references=Object.fromEntries(messages.filter(message=>message.replyToMessageId).map(message=>[message.id,this.store.resolveReference(message,currentTime)]));
      const recentReplies=this.store.sentReplies(roomId,Math.min(this.config.recentMessageLimit,ROUTER_REPLY_HISTORY_LIMIT),currentTime);
      const memberMessages=Object.fromEntries(messages.map(message=>[message.id,message.replyToMessageId
        ?this.store.referencedBefore(roomId,message.replyToMessageId,message.id):undefined]));
      // A quoted bot reply may be older than the bounded reply history. Describe
      // only platform-confirmed sends as of this routing snapshot, not plans.
      const referencedIds=new Set(messages.map(message=>message.replyToMessageId).filter(Boolean));
      const sentReplies:AddressingBotReply[]=this.store.outbox('sent').filter(row=>row.message.roomId===roomId
        &&row.platformMessageId&&referencedIds.has(row.platformMessageId)&&typeof row.sentAt==='number'&&row.sentAt<=currentTime).map(row=>{
          const associated=row.associationThreadId??row.threadId;
          const thread=associated?this.store.thread(associated):undefined;
          return {roomId,messageId:row.platformMessageId!,...(thread?.roomId===roomId?{threadId:thread.id}:{})};
        });
      const pinned=[...new Set(Object.values(references).flatMap(ref=>ref.status==='resolved'&&ref.threadId?[ref.threadId]:[]))]
        .map(id=>this.store.thread(id)!).filter(Boolean);
      const threads=[...pinned,...this.store.routingThreads(roomId,this.config.threadCardLimit,this.config.threadIdleTtlMs,currentTime).filter(thread=>!pinned.some(p=>p.id===thread.id))]
        .slice(0,Math.max(this.config.threadCardLimit,pinned.length));
      let request:RouterRequest={roomId,currentTime,currentTimeContext,botUserId:this.config.qq.selfId,references,
        addressing:describeAddressing(messages,this.config.qq.selfId,memberMessages,sentReplies),
        event:'messages',messages,recentMessages,recentReplies,threads};
      if(!this.runtime.sharedMemory&&!this.persistentRouter&&messages.some(m=>hasWakeCandidate(m,this.config.botCallNames))){
        try{
        const budget=await this.runtime.routerContextBudget?.(request.roomId)??this.config.routerContextChars;
        request=attachRoomMemory(this.store,request,budget);
        this.store.telemetry('router_context',{roomId,memoryVersion:request.workingMemory?.version,cutoff:request.workingMemory?.cutoffSeq,
          coveredSeq:request.workingMemory?.coveredSeq,gap:request.workingMemory?.gap,
          memoryCharacters:JSON.stringify(request.workingMemory?.notes??[]).length,recentMessages:request.recentMessages.length});
        }catch(error){this.error('room_memory_snapshot',error);}
      }
      const lookup=this.store.routerContextReader(roomId,messages[0].id,currentTime);
      const readContext:Parameters<RuntimePort['route']>[1]=async query=>{
        const page=await lookup(query);mergeRouterContext(request,page);return page;
      };
      let actions:RouteAction[]|undefined=messages.some(m=>hasWakeCandidate(m,this.config.botCallNames))?undefined:silentMessages(messages),rawActions:RouteAction[]|undefined;
      let prepared:PreparedRouterTurn|undefined;
      let inferenceStarted=false;
      let capacityFailed=false;
      let modelFailed=false,lastFailureCode='ROUTER_FAILED';
      for(let attempt=0;attempt<2&&!actions&&!this.stopped;attempt++) {
        prepared=undefined;
        inferenceStarted=false;
        try {
          if(this.persistentRouter){
            const configHash=this.routerConfigHash(roomId),reserved=await retrySqliteBusy(()=>this.store.transaction(()=>this.persistentRouter!.reserve(request,configHash)),databaseOptions);
            if(reserved.turn.state==='committed')return;
            const deadline=(await retrySqliteBusy(()=>this.store.routerSessions.bindBudget(reserved.turn.id,preparationDeadline),databaseOptions)).deadlineAt!;
            this.store.routerSessions.checkBudget(reserved.turn.id);
            const budget=await withinRouterDeadline(deadline,async()=>await this.runtime.routerContextBudget?.(roomId)??this.config.routerContextChars);
            await withinRouterDeadline(deadline,()=>this.attachMemberMemory(request));
            prepared=await retrySqliteBusy(()=>this.persistentRouter!.prepare(request,configHash,budget),{...databaseOptions,deadlineAt:deadline});
            request=prepared.request;
            if(prepared.alreadyCommitted)return;
            // A validated remote-write proposal is fixed before I/O. Resume it without another
            // model call; a timeout must not let the model invent a replacement write intent.
            const proposal=prepared.turn.actions as MemberCommitProposal|undefined;
            if(proposal?.version===1&&Array.isArray(proposal.actions)&&Array.isArray(proposal.memoryIntents)){
              const bound=enforceReferenceThreads(routeSchema.parse(proposal.actions),request);this.validateActions(bound,request);rawActions=proposal.actions;actions=bound;break;
            }
            await retrySqliteBusy(()=>this.persistentRouter!.startAttempt(prepared!,2),{...databaseOptions,deadlineAt:deadline});
            inferenceStarted=true;
          }else await this.attachMemberMemory(request);
          const parsed=routeSchema.parse(await this.executeRouter(request,readContext,prepared));const bound=enforceReferenceThreads(parsed,request);this.validateActions(bound,request);rawActions=parsed;actions=bound;break;
        }
        catch(e){if(isSqliteBusy(e))throw e;
          this.error('router_attempt',{messageIds:messages.map(message=>message.id),attempt,code:routerErrorCode(e),causeCode:(e as {causeCode?:unknown})?.causeCode,error:String(e)});
          const code=String((e as {code?:unknown})?.code??'');lastFailureCode=routerErrorCode(e);
          if(this.persistentRouter){
            if(code==='ROUTER_PENDING_TURN')throw e;
            if(code==='ROUTER_PAYLOAD_OVERSIZED'){capacityFailed=true;break;}
            if(prepared)this.persistentRouter.markFailure(prepared,e);
            if(!prepared)break;
          }
          if(modelRetriesExhausted(e)){modelFailed=true;break;}
          if(code==='ROUTER_PAYLOAD_OVERSIZED'&&messages.length>1&&!this.persistentRouter){split=true;break;}
          if(['ROUTER_RETRY_EXHAUSTED','ROUTER_DEADLINE','ROUTER_CALL_LIMIT','ROUTER_REBUILD_LIMIT','ROUTER_PROVIDER_UNAVAILABLE'].includes(code))break;
          if(!this.persistentRouter&&['ROUTER_COMPACTION_TRUNCATED','ROUTER_COMPACTION_EMPTY','STRUCTURED_OUTPUT_INVALID','ROUTER_RECOVERY_FAILED'].includes(code))break;}
      }
      if(this.stopped){for(const message of messages)this.store.messageStatus(message.id,'pending');return;}
      if(!actions){
        if(split){for(const message of messages)this.store.messageStatus(message.id,'pending');return;}
        await retrySqliteBusy(()=>this.store.transaction(()=>{
          for(const message of messages){
            this.store.messageStatus(message.id,'failed');
            if(hasWakeCandidate(message,this.config.botCallNames))this.store.enqueue({roomId,replyToMessageId:message.messageId,text:modelFailed?MODEL_ERROR_REPLY:capacityFailed?'这条输入及必要引用超过了当前处理容量，原文已保留，本次尚未执行任务。':'暂时没能处理这条消息，请稍后再试。'},{id:'route-failed:'+message.id});
          }
          if(prepared&&this.persistentRouter)this.finishFailedTurn(prepared,{code:lastFailureCode});
          else if(this.persistentRouter){const pending=this.store.routerSessions.pendingTurns(roomId)[0];if(pending)this.store.routerSessions.failTurn({turnId:pending.id,generation:pending.generation,error:{code:capacityFailed?'ROUTER_PAYLOAD_OVERSIZED':lastFailureCode}});}
        }),databaseOptions);
        return;
      }
      actions=enforceExplicitActivation(actions,messages,this.config.botCallNames);
      if(this.scheduledTasks.enabled)await Promise.all(messages.filter(message=>actions!.some(action=>'sourceMessageIds'in action&&action.sourceMessageIds.includes(message.id)
        &&(action.action==='manage_schedule'||action.action==='open_thread'&&action.scheduleOperations?.length||'threadId'in action&&this.store.thread(action.threadId)?.scheduledTask)))
        .map(message=>this.scheduledTasks.actor(message,'router',true)));
      let proposal:MemberCommitProposal|undefined,memberReceipts:MemberCommitReceipt[]=[];
      if(prepared&&this.runtime.sharedMemory){
        this.store.routerSessions.checkBudget(prepared.turn.id);this.persistentRouter?.validateSources(prepared);
        proposal=await withinRouterDeadline(prepared.turn.deadlineAt!,()=>retrySqliteBusy(()=>prepareMemberCommit(this.store,this.runtime.sharedMemory!,this.store.routerSessions.turn(prepared!.turn.id)!,request,actions!),{...databaseOptions,deadlineAt:prepared!.turn.deadlineAt!}));
        actions=enforceReferenceThreads(proposal.actions,request);this.validateActions(actions,request);
        memberReceipts=await withinRouterDeadline(prepared.turn.deadlineAt!,()=>applyMemberCommit(this.runtime.sharedMemory!,proposal!));
      }
      if(this.stopped)return;
      const steers:{threadId:string;input:ThreadInput}[]=[];const cancels=new Set<string>();
      const bySource=new Map<string,RouteAction>();
      for(const action of actions)if('sourceMessageIds'in action)for(const source of action.sourceMessageIds)bySource.set(source,action);
      const emitted=new Set<RouteAction>();const created=new Map<RouteAction,string>();
      const acknowledgements=new Map<string,{text:string;replyToMessageId:string}>();
      const applied:RouteAction[]=[];
      const apply=()=>{
        const existingOutbox=new Set(this.store.outbox('pending').map(row=>row.id));
        // Process sources in intake order, regardless of model action/source ordering.
        for(const message of messages) {
          const originalAction=bySource.get(message.id)!;
          let action=originalAction;
          // Re-resolve in intake order: a preceding message in this batch may
          // have acquired a thread after the model received its snapshot.
          const reference=this.store.resolveReference(message,currentTime);
          if(reference.status==='resolved'&&reference.threadId&&!this.store.thread(reference.threadId)?.scheduledTask
            &&action.action!=='manage_schedule'&&!(action.action==='open_thread'&&action.scheduleOperations?.length)){
            this.store.bindMessageThread(message,reference.threadId);
            if(action.action==='open_thread'||('threadId'in action&&action.threadId!==reference.threadId)){
              action=enforceReferenceThreads([{...action,sourceMessageIds:[message.id]} as RouteAction],{...request,references:{[message.id]:reference}})[0];
            }
          }
          applied.push('sourceMessageIds'in action?{...action,sourceMessageIds:[message.id]}:action);
          if(action.action==='silence')continue;
          if(action.action==='manage_schedule'){
            if(emitted.has(originalAction))continue;emitted.add(originalAction);
            try{
              const receipt=this.scheduledTasks.applyRouter(message,action.operation);
              this.store.enqueue({roomId,replyToMessageId:message.messageId,text:this.scheduledTasks.receipt(receipt)},{id:'schedule-control:'+message.id});
            }catch(error){this.store.enqueue({roomId,replyToMessageId:message.messageId,text:this.taskError(error)},{id:'schedule-control:'+message.id});}
          }else if(action.action==='reply_direct'||action.action==='clarify'){
            if(emitted.has(action))continue;emitted.add(action);
            const explicit=messages.some(source=>'sourceMessageIds'in action&&action.sourceMessageIds.includes(source.id)&&hasWakeCandidate(source,this.config.botCallNames));
            const last=this.lastChatter.get(roomId)??0;
            if(explicit||action.action==='clarify'||Date.now()-last>=20_000){
              this.store.enqueue({roomId,replyToMessageId:message.messageId,text:action.text},{id:'direct:'+message.id,associationThreadId:reference.threadId});
              this.lastChatter.set(roomId,Date.now());
            }
          }else if(action.action==='open_thread'){
            if(action.scheduleOperations?.length&&!emitted.has(originalAction)){
              emitted.add(originalAction);
              try{
                const receipts=this.scheduledTasks.service.transaction(()=>action.action==='open_thread'?action.scheduleOperations!.map((operation,index)=>this.scheduledTasks.applyRouter(message,operation,String(index))):[]);
                this.store.enqueue({roomId,replyToMessageId:message.messageId,text:receipts.map(receipt=>this.scheduledTasks.receipt(receipt)).join('\n')},{id:'schedule-control:'+message.id});
              }catch(error){this.store.enqueue({roomId,replyToMessageId:message.messageId,text:this.taskError(error)},{id:'schedule-control:'+message.id});}
            }
            const context=this.inputContext(message,action,request);
            const existing=created.get(action);
            if(existing)this.store.append(this.store.thread(existing)!,message,'supplement',context.messages,context.metadata);
            else {
              const explicit=messages.some(source=>action.sourceMessageIds.includes(source.id)&&hasWakeCandidate(source,this.config.botCallNames));
              const thread=this.store.createThread(message,action.subject,explicit,context.messages,context.metadata);created.set(action,thread.id);
              if(reference.status==='unbound')this.store.bindReferencedThread(message,thread.id,currentTime);
              acknowledgements.set(thread.id,{text:action.acknowledgement?.trim()||'我来核对一下这个问题，查清楚再回复你。',replyToMessageId:message.messageId});
            }
          }else if('threadId' in action){
            const thread=this.store.thread(action.threadId)!;
            if(thread.scheduledTask){
              try{
                if(action.action==='request_status'){
                  this.scheduledTasks.readThread(message,thread);
                  this.store.enqueue({roomId,replyToMessageId:message.messageId,text:`本次定时任务状态：${thread.status}。`},{id:'control:'+message.id});
                }else if(action.action==='request_cancel'){
                  this.scheduledTasks.stopThread(message,thread);cancels.add(thread.id);
                  this.store.enqueue({roomId,replyToMessageId:message.messageId,text:'已请求停止本次执行；后续循环仍保留。取消整个计划请明确取消定时任务。'},{id:'control:'+message.id});
                }else if(action.action==='append_thread'){
                  this.scheduledTasks.assertThreadControl(message,thread);
                  const context=this.inputContext(message,action,request),followup=this.store.createThread(message,action.resolvedRequest??message.text,true,context.messages,context.metadata);
                  created.set(action,followup.id);acknowledgements.set(followup.id,{text:action.acknowledgement?.trim()||'我接着核对这个问题。',replyToMessageId:message.messageId});
                }
              }catch(error){this.store.enqueue({roomId,replyToMessageId:message.messageId,text:this.taskError(error)},{id:'control:'+message.id});}
              continue;
            }
            if(action.action==='append_thread'){
              if(thread.status==='cancelled'){
                if(message.authorId!==thread.ownerId&&!message.isAdmin){
                  this.store.enqueue({roomId,replyToMessageId:message.messageId,text:'这个问题已停止，只有原提问者或群管理员可以恢复处理。'},
                    {id:'control:'+message.id,associationThreadId:thread.id});continue;
                }
                thread.epoch++;
              }
              // A pending confirmation follows newer conditions. Once sending
              // starts, its identity and text must stay fixed for delivery dedupe.
              const needsAcknowledgement=!['queued','running'].includes(thread.status)||acknowledgements.has(thread.id)
                ||this.store.outbox('pending').some(row=>row.kind==='acknowledgement'&&row.threadId===thread.id);
              const context=this.inputContext(message,action,request);
              const input=this.store.append(thread,message,action.kind??'supplement',context.messages,context.metadata);
              if(reference.status==='unbound')this.store.bindReferencedThread(message,thread.id,currentTime);
              if(needsAcknowledgement)acknowledgements.set(thread.id,{text:action.acknowledgement?.trim()||'收到，我接着核对你补充的内容。',replyToMessageId:message.messageId});
              if(this.active.has(thread.id))steers.push({threadId:thread.id,input});
            }else if(action.action==='request_cancel'){
              const allowed=message.authorId===thread.ownerId||message.isAdmin;
              if(allowed){thread.status='cancelled';thread.epoch++;thread.activeRunId=undefined;this.store.saveThread(thread);cancels.add(thread.id);}
              this.store.bindMessageThread(message,thread.id);
              this.store.enqueue({roomId,replyToMessageId:message.messageId,text:allowed?'已停止这个问题的处理。':'只有提问者或群管理员可以停止这个任务。'},{id:'control:'+message.id,associationThreadId:thread.id});
            }else if(action.action==='request_status'){
              this.store.bindMessageThread(message,thread.id);
              this.store.enqueue({roomId,replyToMessageId:message.messageId,text:`这个问题当前状态：${({queued:'排队中',running:'正在处理',needs_input:'等待补充',idle:'已回答',failed:'处理失败',cancelled:'已停止'} as const)[thread.status]}。`},{id:'control:'+message.id,associationThreadId:thread.id});
            }
          }
        }
        // Use the final revision after every source in this batch is appended.
        for(const [threadId,ack]of acknowledgements){
          const thread=this.store.thread(threadId)!;
          for(const pending of this.store.outbox('pending'))if(pending.kind==='acknowledgement'&&pending.threadId===threadId){pending.status='stale';this.store.saveOutbox(pending);}
          if(!['queued','running'].includes(thread.status))continue;
          this.store.enqueue({roomId,replyToMessageId:ack.replyToMessageId,text:ack.text},
            {id:`ack:${threadId}:${thread.revision}`,kind:'acknowledgement',threadId,revision:thread.revision});
        }
        this.store.recordDecision('messages',applied,messages[0].id);
        this.store.telemetry('router_binding',{messageIds:messages.map(message=>message.id),rawActions,appliedActions:applied,
          references:Object.fromEntries(messages.filter(message=>message.replyToMessageId).map(message=>{
            const {status,threadId,chain}=this.store.resolveReference(message,currentTime);return [message.id,{status,threadId,chain}];
          }))});
        for(const message of messages)this.store.messageStatus(message.id,'routed');
        if(proposal){
          enqueueMemberConfirmations(this.store,request,proposal,memberReceipts);
          for(const receipt of memberReceipts)this.persistentRouter?.hostEvent({roomId,sourceId:'memory:'+receipt.commitId,payload:{kind:'memory_changed',memberId:receipt.memberId,revision:receipt.revision,commitId:receipt.commitId}});
        }
        this.stampReplyPreferences(request,existingOutbox);
        const threadIds=[...new Set([...created.values(),...applied.flatMap(action=>'threadId'in action?[action.threadId]:[])])];
        for(const threadId of threadIds)this.recordTaskEvent(threadId);
        return {actions:applied,threadIds,memory:memberReceipts};
      };
      if(prepared&&this.persistentRouter){
        this.persistentRouter.validateSources(prepared);
        // Acquire the write lock before apply mutates task state. A lock retry
        // retains this validated model output and never re-runs inference.
        await retrySqliteBusy(()=>this.store.transaction(()=>{
          this.store.routerSessions.commitTurn({turnId:prepared!.turn.id,generation:prepared!.session.generation,actions,contextBoundary:prepared!.contextBoundary},apply);
          if(!inferenceStarted)this.store.routerSessions.markNeedsRebuild(roomId,'proposal_committed_without_native');
        }),{...databaseOptions,deadlineAt:prepared.turn.deadlineAt!});

      }else await retrySqliteBusy(()=>this.store.transaction(apply),databaseOptions);
      // The input is durable before steering. Mark the runtime dirty immediately,
      // but never hold the room routing lock while its new images download.
      for(const x of steers)if(!cancels.has(x.threadId)){
        const task=this.runtime.steer(x.threadId,x.input).catch(e=>this.error('steer',e)).finally(()=>this.steerTasks.delete(task));
        this.steerTasks.add(task);
      }
      for(const id of cancels){this.active.get(id)?.abort.abort();await this.runtime.cancel(id).catch(e=>this.error('cancel',e));}
    });
    if(split&&!this.stopped){
      this.store.telemetry('router_batch_split',{messageIds:messages.map(message=>message.id),reason:'input_size_limit'});
      const middle=Math.ceil(messages.length/2);
      await this.routeBatch(messages.slice(0,middle));await this.routeBatch(messages.slice(middle));
    }
  }
  private replyTarget(thread:ThreadCard,inputSeq=thread.latestInputSeq):string|undefined {
    if(thread.scheduledTask)return undefined;
    // Use the platform ID of the covered input, not the thread origin, a quoted
    // context message, or newer room chatter. Persist this target in the outbox.
    return this.store.inputs(thread.id).find(input=>input.seq===inputSeq)?.message.messageId??thread.sourceMessageId;
  }
  private inputContext(message:GroupMessage,action:Extract<RouteAction,{action:'open_thread'|'append_thread'}>,request:RouterRequest) {
    // A reference is context for this input, not a new question or a change of ownership.
    // The intake boundary includes earlier messages in the same batch but excludes future or other-room images.
    const context=new Map<string,GroupMessage>();
    const reference=this.store.resolveReference(message,request.currentTime);
    const quoted=reference.message;
    if(quoted)context.set(quoted.id,quoted);
    for(const id of action.contextMessageIds??[]){
      // Router snapshots intentionally omit locators. Only the validated ID
      // authorizes a lookup; all metadata and attachments come from storage.
      const candidate=request.recentMessages.some(item=>item.id===id)
        ?this.store.messageBefore(message.roomId,id,message.id):undefined;
      if(candidate&&candidate.roomId===message.roomId
        &&(!candidate.attachments.length||candidate.authorId===message.authorId||candidate.messageId===message.replyToMessageId))context.set(candidate.id,candidate);
    }
    const replies=(request.recentReplies??[]).filter(reply=>reply.messageId&&action.contextReplyIds?.includes(reply.messageId));
    if(reference.reply&&!replies.some(reply=>reply.messageId===reference.reply!.messageId))replies.push(reference.reply);
    return {messages:[...context.values()],metadata:{
      ...(replies.length?{contextReplies:replies}:{}),
      routingContext:{resolvedRequest:action.resolvedRequest??(action.action==='open_thread'?action.subject:message.text),
        ...(action.routingMetadata===undefined?{}:{routingMetadata:action.routingMetadata}),
        sourceMessageIds:[...action.sourceMessageIds],contextMessageIds:[...context.keys()],contextReplyIds:replies.flatMap(reply=>reply.messageId?[reply.messageId]:[]),
        ...(action.correctionTarget?{correctionTarget:action.correctionTarget}:{})},
    }};
  }
  private validateActions(actions:RouteAction[],request:RouterRequest) {
    validateRouteActions(actions,request);
  }
  private workerInputs(threadId:string) {
    return this.store.inputs(threadId).map(input=>{
      // Repair historical inputs persisted from an address-redacted Router
      // projection as well as supplying intact context after a restart.
      const contextMessages=(input.contextMessages??[]).flatMap(saved=>{
        const original=this.store.messageBefore(input.message.roomId,saved.id,input.message.id);
        return original&&(!original.attachments.length||original.authorId===input.message.authorId
          ||original.messageId===input.message.replyToMessageId)?[original]:[];
      });
      return {...input,...(input.contextMessages?{contextMessages}:{})};
    });
  }
  private routerConfigHash(roomId:string):string {
    return this.runtime.routerConfigurationHash?.(roomId)??createHash('sha256').update(JSON.stringify({router:this.config.router,botCallNames:this.config.botCallNames,protocol:1})).digest('hex');
  }
  private async executeRouter(request:RouterRequest,readContext:Parameters<RuntimePort['route']>[1],prepared?:PreparedRouterTurn){
    const taskTools=this.scheduledTasks.routerTools(request);
    if(!prepared)return this.runtime.route(request,readContext,undefined,taskTools);
    const turn=this.store.routerSessions.checkBudget(prepared.turn.id),deadline=turn.deadlineAt!;
    const provider=JSON.stringify([this.config.router.provider,this.config.router.model,this.config.router.baseUrl??this.config.baseUrl]);
    const databaseOptions={deadlineAt:deadline,stopped:()=>this.stopped};
    await retrySqliteBusy(()=>this.store.routerSessions.admitProvider(provider,turn.id,Math.max(1,deadline-Date.now())),databaseOptions);
    const startedAt=Date.now(),signal=AbortSignal.timeout(Math.max(1,deadline-Date.now()));
    try{
      const result=await withinRouterDeadline(deadline,()=>this.runtime.route(request,readContext,{signal,
        consumeModelCall:summary=>this.store.routerSessions.consumeModelCall(turn.id,summary),
        onModelCall:event=>this.store.telemetry('router_model_call',{turnId:turn.id,roomId:turn.roomId,...event}),
      },taskTools));
      this.store.routerSessions.checkBudget(turn.id);
      await retrySqliteBusy(()=>this.store.routerSessions.providerSucceeded(provider,turn.id,startedAt),databaseOptions);
      this.store.routerSessions.checkBudget(turn.id);return result;
    }catch(error){
      const code=routerErrorCode(error);
      if(modelRetriesExhausted(error)||signal.aborted||code==='ROUTER_DEADLINE')await retrySqliteBusy(()=>this.store.routerSessions.providerFailed(provider),databaseOptions);
      if(signal.aborted)throw Object.assign(new Error('Router total deadline expired'),{code:'ROUTER_DEADLINE'});
      throw error;
    }
  }
  private async attachMemberMemory(request:RouterRequest):Promise<void>{
    if(!this.runtime.sharedMemory)return;
    const memberIds=[...new Set([...request.messages.map(message=>message.authorId),...Object.values(request.references??{}).flatMap(ref=>ref.message?[ref.message.authorId]:[]),
      ...(request.result?request.threads.filter(thread=>thread.id===request.result!.threadId).flatMap(thread=>[thread.ownerId]):[])])];
    request.memberMemory=await this.runtime.sharedMemory.project(request.roomId,memberIds.slice(0,20));request.memoryAvailable=Boolean(this.persistentRouter);
  }
  private finishFailedTurn(prepared:PreparedRouterTurn,error:unknown){
    const turn=this.store.routerSessions.turn(prepared.turn.id);
    if(turn?.state==='pending')this.store.routerSessions.failTurn({turnId:turn.id,generation:turn.generation,error});
  }
  private recordTaskEvent(threadId:string){
    if(!this.persistentRouter)return;const thread=this.store.thread(threadId);if(!thread||this.scheduledTasks.localResult(thread)||!this.store.routerSessions.session(thread.roomId))return;
    this.persistentRouter.hostEvent({roomId:thread.roomId,sourceId:`task:${thread.id}:${thread.revision}:${thread.epoch}:${thread.status}`,
      payload:{kind:'task_changed',threadId:thread.id,revision:thread.revision,epoch:thread.epoch,status:thread.status}});
  }
  /** Baseline is the data used to render this text, not a newer external-write receipt. */
  private stampReplyPreferences(request:RouterRequest,existing:Set<string>){
    if(!this.runtime.sharedMemory)return;
    const sourceText=request.messages.map(message=>`${message.authorId}: ${message.text}`).join('\n');
    for(const original of this.store.outbox('pending')){
      if(original.message.roomId!==request.roomId||existing.has(original.id))continue;
      const row=original as PreferenceOutbox;row.hostMemberMemory=structuredClone(request.memberMemory??[]);row.preferenceSourceText=sourceText;this.store.saveOutbox(row);
    }
  }
  private preferenceRevisions(values:MemberMemoryProjection[]){
    const keys=['preferredName','language','responseDetail','formatPreference','terminology'] as const;
    return JSON.stringify(values.map(value=>[value.memberId,value.revision,keys.map(key=>[key,value.fields[key]??null])]).sort((a,b)=>String(a[0]).localeCompare(String(b[0]))));
  }
  private workerPreferenceSource(threadId:string,through:number):string {
    const inputs=this.store.inputs(threadId).filter(input=>input.seq<=through),latest=inputs.at(-1);if(!latest)return '';
    const authored=inputs.filter(input=>input.message.authorId===latest.message.authorId);
    // Supply originals, never a host interpretation of what the temporary preference means.
    // Preserve the latest explicit expression request even after later technical supplements.
    const expression=authored.findLast(input=>/(这次|本次|回复|回答|称呼|叫我|语言|格式|简短|详细|中文|英文|English|language|answer|reply)/iu.test(input.message.text));
    return [...new Map([...(expression?[expression]:[]),...authored.slice(-3)].map(input=>[input.seq,input])).values()]
      .sort((a,b)=>a.seq-b.seq).map(input=>`${input.message.authorId}: ${input.message.text}`).join('\n');
  }
  private async prepareReplyPreferences(original:OutboxRow,freeze:()=>boolean):Promise<boolean>{
    // Host receipts and failure notices must remain deliverable when the memory
    // backend or model is unavailable. Rewriting could also invert their status.
    if(original.scheduleRunId||original.fileDeliveryNoticeFor||original.fileDeliveries?.some(file=>file.status==='sent')||['schedule-control:','memory-confirm:','route-failed:','worker-failed:','result-model-failed:'].some(prefix=>original.id.startsWith(prefix)))return freeze();
    if(!this.runtime.sharedMemory)return freeze();
    const row=original as PreferenceOutbox,previous=row.hostMemberMemory??[];
    const target=row.message.replyToMessageId?this.store.db.prepare("SELECT data FROM messages WHERE room=? AND json_extract(data,'$.messageId')=? ORDER BY rowid DESC LIMIT 1").get(row.message.roomId,row.message.replyToMessageId) as {data:string}|undefined:undefined;
    const targetMember=target?(JSON.parse(target.data) as GroupMessage).authorId:row.threadId?this.store.thread(row.threadId)?.ownerId:undefined;
    const memberIds=[...new Set([...(targetMember?[targetMember]:[]),...previous.map(value=>value.memberId)])].slice(0,20);if(!memberIds.length)return freeze();
    let phase:'read'|'rewrite'|'verify'='read';
    try{
      const latest=await this.runtime.sharedMemory.project(row.message.roomId,memberIds);
      const before=new Map(previous.map(value=>[value.memberId,value]));
      const changed=this.preferenceRevisions(latest)!==this.preferenceRevisions(latest.map(value=>before.get(value.memberId)??{memberId:value.memberId,revision:0,fields:{},omittedKeys:[]}));
      let text=row.hostLinkTemplate??row.message.text;
      const originalTemplate=text;
      if(changed){
        phase='rewrite';
        if(!this.runtime.refreshReplyPreferences)throw new Error('Reply preference refresh is unavailable');
        text=await this.runtime.refreshReplyPreferences({roomId:row.message.roomId,text,memberMemory:latest,previousMemberMemory:previous,
          ...(targetMember?{replyToMemberId:targetMember}:{}),...(row.preferenceSourceText?{sourceText:row.preferenceSourceText}:{})});
      }
      assertLinkReferencesUnchanged(originalTemplate,text);
      phase='verify';
      // A preference changed while the model was rewriting: leave this exact outbox pending.
      const verified=changed?await this.runtime.sharedMemory.project(row.message.roomId,memberIds):latest;
      if(this.preferenceRevisions(latest)!==this.preferenceRevisions(verified))throw new Error('Reply preferences changed during refresh');
      const current=this.store.outbox('pending').find(value=>value.id===row.id) as PreferenceOutbox|undefined;
      if(!current||current.message.text!==row.message.text)return false;
      current.message={...current.message,text};if(current.hostLinks?.length)current.hostLinkTemplate=text;current.hostMemberMemory=structuredClone(verified);current.preferenceFailures=0;current.preferenceReadFailures=0;this.store.saveOutbox(current);Object.assign(row,current);
      // No await is allowed between the final revision verification and registration as sending.
      return freeze();
    }catch(error){
      const current=this.store.outbox('pending').find(value=>value.id===row.id) as PreferenceOutbox|undefined;
      const rawCode=(error as {code?:unknown})?.code,code=typeof rawCode==='string'&&/^[A-Z][A-Z0-9_]{0,79}$/.test(rawCode)?rawCode:'PREFERENCE_REFRESH_FAILED';
      if(current){
        const count=phase==='rewrite'?(current.preferenceFailures=(current.preferenceFailures??0)+1):(current.preferenceReadFailures=(current.preferenceReadFailures??0)+1);
        current.dueAt=Math.max(current.dueAt,Date.now()+[5000,15_000,60_000][Math.min(count-1,2)]);
        if(phase==='rewrite'&&count>=3){current.status='failed';current.reason='preference_refresh_exhausted:'+code;}
        this.store.saveOutbox(current);
      }
      this.error('reply_preferences_pending',{outboxId:row.id,code});return false;
    }
  }
  private registerSend(row:OutboxRow):boolean {
    if(row.scheduleRunId)return this.store.transaction(()=>this.registerScheduledSend(row));
    return this.registerScheduledSend(row);
  }
  private registerScheduledSend(row:OutboxRow):boolean {
    if(this.stopped)return false;
    if(!this.deliveryCurrent(row))return false;
    try{
      const template=row.hostLinkTemplate??row.message.text;
      const rendered=renderReplyLinks(template,row.hostLinks,{threadId:row.threadId,revision:row.revision});
      if(row.hostLinks?.length)row.hostLinkTemplate=template;
      row.message={...row.message,text:rendered};
    }catch(error){row.status='failed';row.reason='REPLY_LINK_INVALID';this.store.saveOutbox(row);if(row.scheduleRunId)this.scheduledTasks.delivery(row.scheduleRunId,'failed');this.error('reply_link_invalid',{outboxId:row.id});return false;}
    row.status='sending';row.attempts++;this.store.saveOutbox(row);
    if(row.scheduleRunId)this.scheduledTasks.delivery(row.scheduleRunId,'sending');
    return true;
  }
  /** Recheck between file actions so cancellation stops the remaining delivery. */
  private deliveryCurrent(row:OutboxRow):boolean {
    if(row.fileDeliveryNoticeFor){
      const parent=this.store.outbox().find(value=>value.id===row.fileDeliveryNoticeFor);
      if(!parent||parent.message.roomId!==row.message.roomId||parent.scheduleRunId&&(!this.scheduledTasks.enabled||!this.scheduledTasks.service.canPublish(parent.scheduleRunId))){row.status='stale';this.store.saveOutbox(row);return false;}
    }
    if(row.scheduleRunId&&(!this.scheduledTasks.enabled||!this.scheduledTasks.service.canPublish(row.scheduleRunId))){row.status='stale';this.store.saveOutbox(row);this.scheduledTasks.delivery(row.scheduleRunId,'stale');return false;}
    if(row.threadId){
      const thread=this.store.thread(row.threadId);
      const stale=!thread||thread.revision!==row.revision||(row.kind==='acknowledgement'
        ?!['queued','running'].includes(thread.status):thread.status==='cancelled'||thread.epoch!==row.epoch);
      if(stale){row.status='stale';this.store.saveOutbox(row);if(row.scheduleRunId)this.scheduledTasks.delivery(row.scheduleRunId,'stale');return false;}
    }
    return true;
  }
  async tick() {
    if(this.stopped)return;
    if(this.scheduleExecution)this.scheduledTasks.tick();
    this.reconcileScheduledCancellation();
    const queued=this.store.threadsInStatus('queued');
    const immediate=queued.filter(t=>!t.scheduledTask),scheduled=queued.filter(t=>t.scheduledTask);
    // Allocate the capped scheduled share before the remaining interactive
    // slots so a steady chat queue cannot starve due work.
    const fair=this.config.concurrency===1&&this.lastWorkerWasScheduled?[...immediate,...scheduled]:[...scheduled,...immediate];
    for(const thread of fair) {
      if(this.active.size>=this.config.concurrency)break;
      if(this.active.has(thread.id))continue;
      if(thread.scheduledTask){
        if(!this.scheduleExecution)continue;
        const limit=Math.min(this.config.scheduledTasks?.concurrency??1,Math.max(1,this.config.concurrency-1));
        const activeScheduled=[...this.active.keys()].filter(id=>this.store.thread(id)?.scheduledTask).length;
        if(activeScheduled>=limit)continue;
      }
      this.lastWorkerWasScheduled=Boolean(thread.scheduledTask);
      const abort=new AbortController();const promise=this.run(thread.id,abort).catch(e=>this.error('worker',e)).finally(()=>this.active.delete(thread.id));
      this.active.set(thread.id,{promise,abort});
    }
    for(const result of this.store.results()){
      const pending=this.persistentRouter?this.store.routerSessions.pendingTurns(result.roomId)[0]:undefined;
      const ownsPending=pending?.inputs.some(input=>input.kind==='result'&&input.id===result.id||input.kind==='timer'&&pending.trigger.key.startsWith(result.id+':'));
      if(result.dueAt>Date.now()||(this.resultRetryAt.get(result.id)??0)>Date.now()||this.resultActive.has(result.id)
        ||(pending&&!ownsPending)||(this.batches.get(result.roomId)?.items.length&&!ownsPending))continue;
      this.resultActive.add(result.id);
      const task=this.routeResult(result).catch(e=>{this.resultRetryAt.set(result.id,Date.now()+1000);this.error('result',e);}).finally(()=>{this.resultActive.delete(result.id);this.resultTasks.delete(task);});
      this.resultTasks.add(task);
    }
    await this.dispatch();
  }
  private async run(threadId:string,abort:AbortController) {
    const thread=this.store.thread(threadId)!;
    if(!this.scheduledTasks.start(thread)){thread.status='cancelled';thread.epoch++;this.store.saveThread(thread);return;}
    const runId='r-'+randomUUID();thread.status='running';thread.activeRunId=runId;thread.epoch++;
    if(thread.workerBudget?.revision!==thread.revision)thread.workerBudget={revision:thread.revision,remainingSteps:this.config.maxWorkerSteps,deadlineAt:Date.now()+Math.min(this.config.workerTimeoutMs,this.scheduledTasks.timeout(thread)??Infinity)};
    const epoch=thread.epoch;this.store.saveThread(thread);
    this.recordTaskEvent(thread.id);
    this.store.saveRun(runId,threadId,'running',{epoch,revision:thread.revision,budget:thread.workerBudget});
    const workspace=join(this.config.stateDir,'workspaces',threadId,runId);mkdirSync(workspace,{recursive:true,mode:0o700});
    try {
      if(thread.workerBudget.remainingSteps<=0)throw Object.assign(new Error('Worker step budget exhausted'),{code:'STEP_LIMIT'});
      if(thread.workerBudget.deadlineAt<=Date.now())throw Object.assign(new Error('Worker deadline exceeded'),{code:'TIMEOUT'});
      const scheduledInput=this.scheduledTasks.input(thread);
      const workerRequest:WorkerRequest={thread,runId,inputs:this.workerInputs(threadId),workspace,signal:AbortSignal.any([abort.signal,AbortSignal.timeout(Math.max(1,thread.workerBudget.deadlineAt-Date.now()))]),
        budget:{remainingSteps:thread.workerBudget.remainingSteps,deadlineAt:thread.workerBudget.deadlineAt},previousRequirementSnapshot:this.store.requirementSnapshot(threadId),scheduledInput};
      workerRequest.taskTools=this.scheduledTasks.workerTools(workerRequest);
      const report=reportSchema.parse(await this.runtime.runWorker(workerRequest));
      if(this.stopped)return;
      if(report.scheduleProposalIds?.length)await this.scheduledTasks.refreshWorkerActor(thread);
      const current=this.store.thread(threadId)!;
      if(current.epoch!==epoch||current.activeRunId!==runId||current.status==='cancelled'||!this.scheduledTasks.valid(current)){this.scheduledTasks.rejectWorker(thread,runId,'stale_run');return;}
      if(report.threadId!==threadId||report.runId!==runId||report.coveredInputSeq>current.latestInputSeq||report.basedOnRevision>current.revision)throw new Error('Worker report identity or version mismatch');
      this.store.transaction(()=>{
        if(!this.scheduledTasks.valid(current))return;
        if(report.coveredInputSeq<current.latestInputSeq||report.basedOnRevision<current.revision){this.scheduledTasks.rejectWorker(thread,runId,'superseded');current.activeRunId=undefined;current.status='queued';this.store.saveThread(current);return;}
        if(report.status==='ready')this.scheduledTasks.commitWorker(current,runId,report);
        else this.scheduledTasks.rejectWorker(thread,runId,report.status);
        this.store.saveRun(runId,threadId,'completed',{epoch,report});current.activeRunId=undefined;
        current.status=report.status==='needs_input'?'needs_input':report.status==='failed'?'failed':'idle';
        current.lastFailure=undefined;
        current.summary=report.shortAnswer.slice(0,700);this.store.saveThread(current);
        this.recordTaskEvent(current.id);
        this.store.saveResult({id:'result-'+runId,threadId,roomId:current.roomId,epoch,report,status:'pending',dueAt:Date.now(),deferrals:0});
        this.scheduledTasks.finish(current,report.status==='ready'?'succeeded':report.status==='needs_input'?'needs_input':'failed',{resultId:'result-'+runId});
      });
    }catch(e){
      if(this.stopped)return;
      this.scheduledTasks.rejectWorker(thread,runId,'run_failed');
      const current=this.store.thread(threadId)!;
      const code=routerErrorCode(e),measured=(e as {workerProgress?:{steps?:number}})?.workerProgress?.steps;
      const steps=Number.isSafeInteger(measured)&&measured!>=0?Math.min(measured!,thread.workerBudget.remainingSteps):0;
      this.store.saveRun(runId,threadId,'failed',{epoch,revision:thread.revision,code,steps,error:this.safeError(e),budget:thread.workerBudget});
      if(current.epoch!==epoch||current.status==='cancelled')return;
      if(code==='SCHEDULE_CONFIG_CHANGED'&&current.scheduledTask){
        this.scheduledTasks.service.block(current.scheduledTask.scheduleId,'execution_config_changed',{cancelRunning:true});
        current.activeRunId=undefined;current.status='cancelled';current.epoch++;this.store.saveThread(current);return;
      }
      const modelFailed=modelRetriesExhausted(e);
      const budget={...thread.workerBudget,remainingSteps:Math.max(0,thread.workerBudget.remainingSteps-steps)};
      const terminal=modelFailed||['STEP_LIMIT','TIMEOUT','ABORTED','CANCELLED','CONTEXT_LIMIT','STRUCTURED_OUTPUT_INVALID','UNSUPPORTED','UNSUPPORTED_CAPABILITY','ROLE_NOT_ALLOWED','ROLE_UNVERIFIED','STALE_PROPOSAL','VERSION_CONFLICT','IDEMPOTENCY_CONFLICT','FORBIDDEN'].includes(code)
        ||budget.remainingSteps<=0||budget.deadlineAt<=Date.now();
      const superseded=current.revision!==thread.revision;
      current.failures++;current.activeRunId=undefined;
      current.lastFailure={runId,code,revision:thread.revision,steps,retryable:!terminal};
      if(!superseded)current.workerBudget=budget;
      current.status=superseded||!terminal&&current.failures<2?'queued':'failed';this.store.saveThread(current);
      this.recordTaskEvent(current.id);
      const reason=code==='STEP_LIMIT'?'本轮已达到处理步数上限':code==='TIMEOUT'?'本轮已达到处理时间上限':code==='CONTEXT_LIMIT'?'本轮材料超过了处理容量':'本轮工具或模型处理未能完成';
      if(current.status==='failed'){
        const outboxId=this.scheduledTasks.localResult(current)?undefined:this.store.enqueue({roomId:current.roomId,replyToMessageId:this.replyTarget(current),text:this.scheduledTasks.title(current,modelFailed?MODEL_ERROR_REPLY:reason+'，已停止自动重试。原问题和已有执行记录已保留。'),...this.scheduledTasks.recipients(current)},{id:'worker-failed:'+runId,threadId,revision:current.revision,epoch,scheduleRunId:current.scheduledTask?.scheduleRunId});
        this.scheduledTasks.finish(current,'failed',{outboxId,error:code});
      }
      this.store.telemetry('run_failed',{threadId,runId,revision:thread.revision,code,steps,retryable:!terminal,error:this.safeError(e)});
    }
  }
  private async routeResult(result:ResultRow){
    await this.room(result.roomId,async()=>{
      const thread=this.store.thread(result.threadId)!;
      if(thread.scheduledTask){
        const scheduledTask=thread.scheduledTask;
        this.store.transaction(()=>{
          if(thread.epoch!==result.epoch||thread.status==='cancelled'||thread.revision!==result.report.basedOnRevision||!this.scheduledTasks.valid(thread)){result.status='stale';this.store.saveResult(result);return;}
          if(this.scheduledTasks.localResult(thread)){
            result.status='stored';this.store.saveResult(result);
            if(!this.scheduledTasks.service.completeLocalResult(scheduledTask.scheduleRunId,result.id))throw new Error('Local scheduled result does not match its completed run');
            return;
          }
          const text=scheduledTask.authority==='system'&&result.report.status==='needs_input'?'本次任务需要补充信息，循环已暂停，请在后台查看并处理。':result.report.shortAnswer;
          const outboxId=this.store.enqueue({roomId:thread.roomId,text:this.scheduledTasks.title(thread,text),...this.scheduledTasks.recipients(thread),...(result.report.attachments?.length?{attachments:result.report.attachments}:{}),...(result.report.fileAttachments?.length?{files:result.report.fileAttachments}:{})},
            {id:'schedule-result:'+scheduledTask.scheduleRunId,threadId:thread.id,revision:thread.revision,epoch:thread.epoch,resultId:result.id,scheduleRunId:scheduledTask.scheduleRunId,hostLinks:result.report.hostLinks});
          this.scheduledTasks.service.attachRun(scheduledTask.scheduleRunId,{resultId:result.id,outboxId});
          result.status='queued';this.store.saveResult(result);
        });return;
      }
      if(thread.epoch!==result.epoch||thread.status==='cancelled'||thread.revision!==result.report.basedOnRevision){
        this.store.transaction(()=>{
          result.status='stale';this.store.saveResult(result);
          const pending=this.persistentRouter?this.store.routerSessions.pendingTurns(result.roomId)[0]:undefined;
          if(pending&&pending.inputs.some(input=>input.kind==='result'&&input.id===result.id||input.kind==='timer'&&pending.trigger.key.startsWith(result.id+':')))
            this.store.routerSessions.failTurn({turnId:pending.id,generation:pending.generation,error:{code:'RESULT_STALE'}});
        });return;
      }
      const currentTime=Date.now();
      const recentReplies=this.store.sentReplies(result.roomId,Math.min(this.config.recentMessageLimit,ROUTER_REPLY_HISTORY_LIMIT),currentTime);
      const threads=[thread,...this.store.routingThreads(result.roomId,this.config.threadCardLimit,this.config.threadIdleTtlMs,currentTime).filter(t=>t.id!==thread.id)].slice(0,this.config.threadCardLimit);
      const request:RouterRequest={roomId:result.roomId,currentTime,currentTimeContext:routerClock(currentTime,this.config.scheduledTasks?.defaultTimezone??'UTC'),event:result.deferrals?'timer':'worker_result',messages:[],recentMessages:this.store.recent(result.roomId,this.config.recentMessageLimit),recentReplies,threads,result:{id:result.id,threadId:thread.id,report:result.report,explicit:thread.explicit}};
      if(this.persistentRouter){await this.routePersistentResult(result,request);return;}
      let actions:RouteAction[];
      try{actions=routeSchema.parse(await this.runtime.route(request));this.validateActions(actions,request);}
      catch(e){
        this.error('result_router',e);
        if(modelRetriesExhausted(e)){
          if(this.stopped)return;
          this.store.transaction(()=>{
            this.store.enqueue({roomId:thread.roomId,replyToMessageId:this.replyTarget(thread,result.report.coveredInputSeq),text:MODEL_ERROR_REPLY},
              {id:'result-model-failed:'+result.id,threadId:thread.id,epoch:result.epoch,revision:result.report.basedOnRevision});
            result.status='failed';this.store.saveResult(result);
          });
          return;
        }
        actions=[{action:'publish_result',resultId:result.id}];
      }
      if(this.stopped)return;
      const action=actions[0];
      if(action.action==='defer_result'&&result.deferrals<2){result.deferrals++;result.dueAt=Date.now()+action.delayMs;this.store.saveResult(result);return;}
      this.store.transaction(()=>{
        this.store.recordDecision(request.event,actions);
        this.store.enqueue({roomId:thread.roomId,replyToMessageId:this.replyTarget(thread,result.report.coveredInputSeq),text:result.report.shortAnswer,
          ...(result.report.attachments?.length?{attachments:result.report.attachments}:{}),...(result.report.fileAttachments?.length?{files:result.report.fileAttachments}:{})},
          {id:result.id,threadId:thread.id,epoch:result.epoch,revision:result.report.basedOnRevision,resultId:result.id,
            hostLinks:result.report.hostLinks,hostMemberMemory:result.report.hostMemberMemory,preferenceSourceText:this.workerPreferenceSource(thread.id,result.report.coveredInputSeq)} as Partial<PreferenceOutbox>);
        result.status='queued';this.store.saveResult(result);
      });
    });
  }
  private async routePersistentResult(result:ResultRow,request:RouterRequest){
    const manager=this.persistentRouter!;
    const databaseOptions={deadlineAt:Date.now()+(this.config.routerTurnTimeoutMs??120_000),stopped:()=>this.stopped};
    if(request.event==='timer')request.routeTriggerKey=`${result.id}:timer:${result.deferrals}:${result.dueAt}`;
    let prepared:PreparedRouterTurn|undefined,actions:RouteAction[]|undefined,modelFailed=false,lastFailureCode='ROUTER_FAILED';
    for(let attempt=0;attempt<2&&!this.stopped;attempt++){
      prepared=undefined;
      try{
        const configHash=this.routerConfigHash(result.roomId),reserved=await retrySqliteBusy(()=>this.store.transaction(()=>manager.reserve(request,configHash)),databaseOptions);
        if(reserved.turn.state==='committed')return;
        const deadline=this.store.routerSessions.checkBudget(reserved.turn.id).deadlineAt!;
        databaseOptions.deadlineAt=deadline;
        const budget=await withinRouterDeadline(deadline,async()=>await this.runtime.routerContextBudget?.(result.roomId)??this.config.routerContextChars);
        await withinRouterDeadline(deadline,()=>this.attachMemberMemory(request));
        prepared=await retrySqliteBusy(()=>manager.prepare(request,configHash,budget),databaseOptions);
        request=prepared.request;
        if(prepared.alreadyCommitted)return;
        await retrySqliteBusy(()=>manager.startAttempt(prepared!,2),databaseOptions);
        actions=routeSchema.parse(await this.executeRouter(request,this.store.routerContextReader(result.roomId,undefined,request.currentTime),prepared));this.validateActions(actions,request);break;
      }catch(error){
        if(isSqliteBusy(error))throw error;
        lastFailureCode=routerErrorCode(error);
        this.error('router_result_attempt',{resultId:result.id,attempt,code:lastFailureCode,causeCode:(error as {causeCode?:unknown})?.causeCode,error:String(error)});
        const code=String((error as {code?:unknown})?.code??'');
        if(code==='ROUTER_PENDING_TURN')throw error;
        if(!prepared)break;manager.markFailure(prepared,error);
        if(modelRetriesExhausted(error)){modelFailed=true;break;}
        if(['ROUTER_RETRY_EXHAUSTED','ROUTER_DEADLINE','ROUTER_CALL_LIMIT','ROUTER_REBUILD_LIMIT','ROUTER_PROVIDER_UNAVAILABLE'].includes(code))break;
      }
    }
    if(this.stopped)return;
    if(!actions){
      await retrySqliteBusy(()=>this.store.transaction(()=>{
        const thread=this.store.thread(result.threadId)!;
        this.store.enqueue({roomId:result.roomId,replyToMessageId:this.replyTarget(thread,result.report.coveredInputSeq),text:modelFailed?MODEL_ERROR_REPLY:'暂时无法完成这条结果的发布判断，已保留处理结果。'},
          {id:'result-model-failed:'+result.id,threadId:thread.id,epoch:result.epoch,revision:result.report.basedOnRevision});
        result.status='failed';this.store.saveResult(result);if(prepared)this.finishFailedTurn(prepared,{code:lastFailureCode});
        else {const pending=this.store.routerSessions.pendingTurns(result.roomId)[0];if(pending)this.store.routerSessions.failTurn({turnId:pending.id,generation:pending.generation,error:{code:lastFailureCode}});}
      }),databaseOptions);return;
    }
    await retrySqliteBusy(()=>this.store.transaction(()=>this.store.routerSessions.commitTurn({turnId:prepared!.turn.id,generation:prepared!.session.generation,actions,contextBoundary:prepared!.contextBoundary},()=>{
      const current=this.store.thread(result.threadId)!;
      if(current.epoch!==result.epoch||current.status==='cancelled'||current.revision!==result.report.basedOnRevision){result.status='stale';this.store.saveResult(result);return {resultId:result.id,status:'stale'};}
      const action=actions![0];this.store.recordDecision(request.event,actions!);
      if(action.action==='defer_result'&&result.deferrals<2){result.deferrals++;result.dueAt=Date.now()+action.delayMs;this.store.saveResult(result);return {resultId:result.id,status:'deferred',deferrals:result.deferrals,dueAt:result.dueAt};}
      this.store.enqueue({roomId:result.roomId,replyToMessageId:this.replyTarget(current,result.report.coveredInputSeq),text:result.report.shortAnswer,...(result.report.attachments?.length?{attachments:result.report.attachments}:{}),...(result.report.fileAttachments?.length?{files:result.report.fileAttachments}:{})},
        {id:result.id,threadId:current.id,epoch:result.epoch,revision:result.report.basedOnRevision,resultId:result.id,
          hostLinks:result.report.hostLinks,preferenceSourceText:this.workerPreferenceSource(current.id,result.report.coveredInputSeq),...(result.report.hostMemberMemory?{hostMemberMemory:result.report.hostMemberMemory}:{})} as Partial<PreferenceOutbox>);
      result.status='queued';this.store.saveResult(result);return {resultId:result.id,status:'queued',outboxId:result.id};
    })),databaseOptions);
    this.resultRetryAt.delete(result.id);
  }
  private dispatch():Promise<void>{
    if(this.dispatchTask)return Promise.resolve();
    const task=this.performDispatch().finally(()=>{if(this.dispatchTask===task)this.dispatchTask=undefined;});
    this.dispatchTask=task;return task;
  }
  private async deliverMessage(row:OutboxRow):Promise<SendReceipt|undefined>{
    const files=row.message.files??[];
    if(files.length){
      if(!this.publisher.uploadFile)return {status:'failed',reason:'file_upload_unavailable'};
      const ids=new Set(files.map(file=>file.artifactId));
      if(files.length>MAX_OUTPUT_FILE_COUNT||ids.size!==files.length||files.reduce((sum,file)=>sum+file.bytes,0)>MAX_OUTPUT_FILE_TOTAL_BYTES)
        return {status:'failed',reason:'invalid_output_file'};
      row.fileDeliveries??=files.map(file=>({artifactId:file.artifactId,status:'pending',attempts:0}));
      if(row.fileDeliveries.length!==files.length||row.fileDeliveries.some((delivery,index)=>delivery.artifactId!==files[index].artifactId))
        return {status:'failed',reason:'file_delivery_mismatch'};
      // Preflight all outstanding files before publishing the first one. The
      // platform repeats this validation immediately before each upload.
      for(const [index,file] of files.entries()){
        const delivery=row.fileDeliveries[index];
        if(delivery.status==='sent')continue;
        if(delivery.status==='unknown'||delivery.status==='sending')return {status:'unknown',reason:delivery.reason??'file_delivery_unknown'};
        try{await readOutgoingFile(file,join(this.config.stateDir,'workspaces'));}
        catch{delivery.status='failed';delivery.reason='invalid_output_file';this.store.saveOutbox(row);return {status:'failed',reason:'invalid_output_file'};}
      }
      for(const [index,file] of files.entries()){
        const delivery=row.fileDeliveries[index];
        if(delivery.status==='sent')continue;
        if(this.stopped)return {status:'deferred',reason:'service_stopping'};
        if(!this.deliveryCurrent(row))return;
        delivery.status='sending';delivery.attempts++;delete delivery.reason;
        this.store.saveOutbox(row);
        let receipt:SendReceipt;
        try{receipt=await this.publisher.uploadFile(row.message.roomId,file,`${row.id}:file:${file.artifactId}`);}
        catch{receipt={status:'unknown',reason:'file_upload_error'};}
        delivery.status=receipt.status==='deferred'?'pending':receipt.status;
        if(receipt.status==='deferred')delivery.attempts--;
        delivery.reason=receipt.reason;delivery.platformFileId=receipt.platformFileId;
        delivery.sentAt=receipt.status==='sent'?Date.now():undefined;
        // Persist each confirmed file before starting the next platform action.
        this.store.saveOutbox(row);
        if(receipt.status!=='sent')return receipt;
      }
      if(this.stopped)return {status:'deferred',reason:'service_stopping'};
      if(!this.deliveryCurrent(row))return;
    }
    const {files:_,...message}=row.message;
    if(files.length&&!message.text.trim()&&!message.attachments?.length&&!message.recipientIds?.length)return {status:'sent'};
    return this.publisher.send(message,row.id);
  }
  private enqueueFileDeliveryNotice(row:OutboxRow){
    if(!row.message.files?.length||!['failed','unknown'].includes(row.status))return;
    const confirmed=row.fileDeliveries?.filter(file=>file.status==='sent').length??0;
    const outstanding=row.message.files.filter(file=>!row.fileDeliveries?.some(delivery=>delivery.artifactId===file.artifactId&&delivery.status==='sent'));
    const names=(files:typeof outstanding)=>files.map(file=>'「'+file.name+'」').join('、');
    const detail=row.reason==='file_upload_unavailable'?'当前服务没有可用的群文件上传接口。':row.reason==='invalid_output_file'?'文件内容校验未通过。':'';
    const uncertain=outstanding.filter(file=>row.fileDeliveries?.some(delivery=>delivery.artifactId===file.artifactId&&['unknown','sending'].includes(delivery.status)));
    const unattempted=outstanding.filter(file=>!uncertain.includes(file));
    const unknownText=uncertain.length?`${names(uncertain)}的上传结果尚未确认。${unattempted.length?names(unattempted)+'尚未上传。':''}`:`${names(outstanding)}尚未确认上传。`;
    const text=outstanding.length
      ? `${confirmed?`已确认上传 ${confirmed} 个文件；`:''}${row.status==='unknown'?unknownText+'已停止自动重传，避免重复文件。':names(outstanding)+'未能上传到群，已停止本轮重试。'+detail}`
      : '文件已上传到群，但配套回复'+(row.status==='unknown'?'的送达结果尚未确认，已停止自动重发。':'发送失败。');
    const thread=row.threadId?this.store.thread(row.threadId):undefined;
    this.store.enqueue({roomId:row.message.roomId,replyToMessageId:row.message.replyToMessageId,text:thread?this.scheduledTasks.title(thread,text):text,...(row.message.recipientIds?.length?{recipientIds:[...row.message.recipientIds]}:{})},
      {id:'file-delivery:'+row.id,fileDeliveryNoticeFor:row.id,threadId:row.threadId,revision:row.revision,epoch:row.epoch});
  }
  private async performDispatch(){
    if(this.dispatching)return;this.dispatching=true;
    try{for(const row of this.store.outbox('pending')){
      if(this.stopped)break;
      if(row.dueAt>Date.now())continue;
      if(!await this.prepareReplyPreferences(row,()=>this.registerSend(row)))continue;
      let receipt;
      try{receipt=await this.deliverMessage(row);}catch{receipt={status:'unknown' as const,reason:'send raised after registration'};}
      if(!receipt)continue;
      row.status=receipt.status;
      if(receipt.status==='deferred'){
        row.attempts--;row.status='pending';row.dueAt=Date.now()+5000;
      }
      if(receipt.status==='failed'&&row.attempts<3){row.status='pending';row.dueAt=Date.now()+row.attempts*1000;}
      Object.assign(row,{platformMessageId:receipt.platformMessageId,reason:receipt.reason,sentAt:receipt.status==='sent'?Date.now():undefined});
      this.store.transaction(()=>{
        if(receipt.status==='failed'&&row.attempts<3&&row.kind==='acknowledgement'&&row.threadId){
          const thread=this.store.thread(row.threadId);
          // New input can arrive while a send awaits its receipt. Only a definite
          // failure permits replacing that obsolete confirmation and trying again.
          if(thread&&thread.revision!==row.revision&&['queued','running'].includes(thread.status)){
            const latest=this.store.inputs(thread.id).at(-1)!;
            row.status='stale';
            this.store.enqueue({roomId:thread.roomId,replyToMessageId:latest.message.messageId,text:'收到，你补充的条件我也会一起核对。'},
              {id:`ack:${thread.id}:${thread.revision}`,kind:'acknowledgement',threadId:thread.id,revision:thread.revision,dueAt:row.dueAt});
          }
        }
        this.store.saveOutbox(row);
        this.enqueueFileDeliveryNotice(row);
        if(row.scheduleRunId)this.scheduledTasks.delivery(row.scheduleRunId,row.status);
        if(this.persistentRouter&&this.store.routerSessions.session(row.message.roomId))this.store.routerSessions.appendEvent({roomId:row.message.roomId,sourceId:`delivery:${row.id}:${row.attempts}:${row.status}`,
          payload:{kind:'delivery_changed',outboxId:row.id,status:row.status,...(row.platformMessageId?{platformMessageId:row.platformMessageId}:{})}});
      });
      if(receipt.status==='sent'){this.memoryWorker?.notify(row.message.roomId);this.memoryIngestion?.notify(row.message.roomId);}
    }}finally{this.dispatching=false;}
  }
  private safeError(error:unknown){return String(error).replace(/(?:sk-|Bearer\s+)[A-Za-z0-9_\-.]+/gi,'[redacted]').replaceAll(this.config.apiKey||'\0','[redacted]').slice(0,1200);}
  private taskError(error:unknown){this.error('schedule_operation',error);return '任务操作未完成：'+this.safeError(error instanceof Error?error.message:error);}
  private reconcileScheduledCancellation(){
    for(const thread of [...this.store.threadsInStatus('queued'),...this.store.threadsInStatus('running')]){
      if(!thread.scheduledTask||this.scheduledTasks.valid(thread))continue;
      thread.status='cancelled';thread.epoch++;thread.activeRunId=undefined;this.store.saveThread(thread);
      const active=this.active.get(thread.id);active?.abort.abort();
      if(active)void this.runtime.cancel(thread.id).catch(error=>this.error('scheduled_cancel',error));
    }
  }
  private error(kind:string,error:unknown){this.store.telemetry(kind,{error:this.safeError(typeof error==='object'&&!(error instanceof Error)?JSON.stringify(error):error)});}
  async drain(timeoutMs=30_000){
    const until=Date.now()+timeoutMs;
    while(Date.now()<until){
      await this.tick();
      if(!this.batches.size&&!this.batchTasks.size&&!this.steerTasks.size&&!this.active.size&&!this.roomLocks.size&&!this.resultActive.size&&!this.store.results().length&&!this.dispatchTask&&!this.store.outbox('pending').length&&!this.store.outbox('sending').length&&!this.store.hasThreadsInStatus('queued'))return;
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    throw new Error('Coordinator drain timed out');
  }
  async close(){
    this.stopped=true;if(this.timer)clearInterval(this.timer);
    for(const batch of this.batches.values()){
      if(batch.timer)clearTimeout(batch.timer);
      // These messages are already persisted and will route on the next startup.
      for(const item of batch.items.splice(0))item.resolve();
    }
    for(const [id,x]of this.active){x.abort.abort();await this.runtime.cancel(id).catch(()=>{});}
    const memoryClosing=this.memoryWorker?.close();
    const ingestionClosing=this.memoryIngestion?.close();
    const routerClosing=this.persistentRouter?.close();
    await this.runtime.close();await memoryClosing;await routerClosing;await ingestionClosing;
    await Promise.allSettled([...this.active.values()].map(x=>x.promise).concat([...this.roomLocks.values(),...this.resultTasks,...this.batchTasks,...this.steerTasks,this.dispatchTask].filter(Boolean) as Promise<void>[]));
    this.batches.clear();
  }
}
