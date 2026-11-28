import type {AttachmentService,AttachmentRef} from '../attachments.js';
import {isPrivateRoom,parseQqRoomId} from '../conversation.js';
import {PrivateChatAccess} from '../private-chat.js';
import { reloadAgentConfig, type Config } from '../config.js';
import { resolveBusinessProfile } from '../business-config.js';
import { hasWakeCandidate } from '../activation.js';
import type { Store, StoredThread } from '../store.js';
import type { GroupMessage, OutgoingMessage, PublisherPort, RouterRequest, WorkerRequest, WorkerReport } from '../types.js';
import { ScheduledTaskService } from './service.js';
import { scheduledExecutionConfigRevision } from './execution-config.js';
import { ScheduleError, type ScheduleActor, type ScheduleMutation, type ScheduleRun, type Schedule, type ScheduleBinding } from './types.js';
import { createRouterScheduleQueryTool, createWorkerScheduleTool, type ScheduleModelMutation, type ScheduleWorkerMutation, type ScheduleToolQuery } from './tools.js';

const admin={kind:'admin'} as const;

/** Connects model-facing task tools to trusted identities and the existing execution host. */
export class ScheduledTaskHost {
  readonly service:ScheduledTaskService;
  private actors=new Map<string,Extract<ScheduleActor,{kind:'user'}>>();
  private lastScan=0;
  private preparedAttachments=new Map<string,AttachmentRef[]>();
  constructor(readonly config:Config,readonly store:Store,readonly publisher:PublisherPort,readonly privateAccess=new PrivateChatAccess(config.qq.selfId,config.qq.privateChat),readonly attachments?:AttachmentService){
    this.service=new ScheduledTaskService(store.db,{...config.scheduledTasks,
      canAccessRoom:roomId=>isPrivateRoom(roomId)?this.privateAccess.allows(roomId):config.qq.allowedGroupIds.some(id=>roomId===`qq:${config.qq.selfId}:${id}`),
      allowedRoomIds:config.qq.allowedGroupIds.map(id=>`qq:${config.qq.selfId}:${id}`)});
    this.service.validateExecution=schedule=>{
      const reason=this.unavailable(schedule,reloadAgentConfig(config).config);if(reason)throw new ScheduleError('BLOCKED',reason,409);
      if(schedule.attachmentRefs?.length)this.attachments?.validateCachedRefs(schedule.roomId,schedule.attachmentRefs);
    };
  }
  get enabled(){return this.config.scheduledTasks?.enabled===true;}
  recover(){this.store.transaction(()=>{
    // Older releases left completed local runs pending forever. Only a matching
    // durable result proves completion; unresolved platform deliveries stay fenced.
    const stored=this.store.db.prepare("SELECT data FROM results WHERE id=? AND thread_id=? AND status='stored'");
    for(const run of this.service.activeRuns()){
      if(run.snapshot.deliveryMode!=='local'||run.deliveryStatus!=='pending'||!run.resultId||!run.threadId||run.outboxId)continue;
      const row=stored.get(run.resultId,run.threadId),thread=this.store.thread(run.threadId);
      if(!row||!thread||thread.scheduledTask?.scheduleRunId!==run.id)continue;
      const result=JSON.parse(row.data as string) as ReturnType<Store['results']>[number];
      if(result.id===run.resultId&&result.threadId===run.threadId&&result.roomId===run.snapshot.roomId
        &&result.status==='stored'&&result.epoch===thread.epoch&&result.report.basedOnRevision===thread.revision)
        this.service.completeLocalResult(run.id,result.id);
    }
    this.service.recover();
  });}
  private requireEnabled(){if(!this.enabled)throw new ScheduleError('DISABLED','定时任务功能尚未启用。',403);}
  async actor(message:GroupMessage,registeredBy:'router'|'worker',force=false):Promise<Extract<ScheduleActor,{kind:'user'}>>{
    const privateRoom=parseQqRoomId(message.roomId);
    if(privateRoom?.kind==='private'){
      const lease=this.privateAccess.capture(message.roomId);
      if(privateRoom.peerId!==message.authorId||this.publisher.verifyFriend&&!await this.publisher.verifyFriend(message.roomId))throw new ScheduleError('FORBIDDEN','当前好友身份不可用。',403);
      this.privateAccess.assert(lease);
      return {kind:'user',roomId:message.roomId,memberId:message.authorId,accessKind:'private',roleGroup:'unknown',roleVerifiedAt:Date.now(),sourceMessageIds:[message.id],registeredBy};
    }
    const key=message.roomId+'\0'+message.authorId,now=Date.now(),maxAge=this.config.scheduledTasks?.roleMaxAgeMs??300_000;
    const cached=this.actors.get(key);
    let roleGroup=message.memberRoleGroup??'unknown',roleVerifiedAt=message.roleVerifiedAt??0;
    if(!force&&cached&&cached.roleVerifiedAt>roleVerifiedAt){roleGroup=cached.roleGroup;roleVerifiedAt=cached.roleVerifiedAt;}
    if((force||roleGroup==='unknown'||now-roleVerifiedAt>maxAge)&&this.publisher.resolveMemberRole){
      try{const verified=await this.publisher.resolveMemberRole(message.roomId,message.authorId);roleGroup=verified.roleGroup;roleVerifiedAt=verified.verifiedAt;}
      catch{roleGroup='unknown';roleVerifiedAt=0;}
    }
    const actor:Extract<ScheduleActor,{kind:'user'}>={kind:'user',roomId:message.roomId,memberId:message.authorId,roleGroup,roleVerifiedAt,
      sourceMessageIds:[message.id],registeredBy};
    this.actors.set(key,actor);return actor;
  }
  private currentActor(message:GroupMessage,registeredBy:'router'|'worker'):Extract<ScheduleActor,{kind:'user'}>{
    if(isPrivateRoom(message.roomId)){this.privateAccess.capture(message.roomId);return {kind:'user',roomId:message.roomId,memberId:message.authorId,accessKind:'private',roleGroup:'unknown',roleVerifiedAt:Date.now(),sourceMessageIds:[message.id],registeredBy};}
    const cached=this.actors.get(message.roomId+'\0'+message.authorId);
    return {kind:'user',roomId:message.roomId,memberId:message.authorId,roleGroup:cached?.roleGroup??message.memberRoleGroup??'unknown',
      roleVerifiedAt:cached?.roleVerifiedAt??message.roleVerifiedAt??0,sourceMessageIds:[message.id],registeredBy};
  }
  private query(actor:ScheduleActor,query:ScheduleToolQuery){
    if(query.operation==='get'){const schedule=this.service.get(actor,query.id!);return {...schedule,canManage:this.service.canManage(actor,schedule)};}
    if(query.operation==='runs')return this.service.runs(actor,query.id!,query);
    if(query.operation==='proposals'){
      const proposals=this.service.pendingProposals(actor),offset=query.offset??0,limit=query.limit??10;
      const hasMore=offset+limit<proposals.length;
      return {items:proposals.slice(offset,offset+limit),total:proposals.length,hasMore,...(hasMore?{nextOffset:offset+limit}:{})};
    }
    return this.service.list(actor,query);
  }
  routerTools(request:RouterRequest){
    if(!this.enabled||request.event!=='messages')return [];
    return [createRouterScheduleQueryTool(request,async(sourceId,query)=>{
      const message=request.messages.find(m=>m.id===sourceId);
      if(!message||!hasWakeCandidate(message,this.config.botCallNames))throw new ScheduleError('SOURCE','任务查询需要当前请求人的明确唤起。',403);
      return this.query(await this.actor(message,'router'),query);
    })];
  }
  private mutation(actor:Extract<ScheduleActor,{kind:'user'}>,operation:ScheduleWorkerMutation):ScheduleMutation{
    if(operation.op!=='create'&&operation.op!=='update')return operation;
    const data=operation.op==='create'?operation.input:operation.patch;
    const {attachmentIds,...rest}=data;
    const refs=attachmentIds===undefined?undefined:this.preparedAttachments.get(this.attachmentKey(actor.roomId,operation));
    if(attachmentIds!==undefined&&!refs)throw new ScheduleError('ATTACHMENTS_NOT_READY','请先核对所选文件。');
    if(operation.op==='update')return {...operation,patch:{...rest,...(refs?{attachmentRefs:refs}:{})}};
    const profile=resolveBusinessProfile(reloadAgentConfig(this.config).config,actor.roomId);
    return {op:'create',input:{...rest,roomId:actor.roomId,businessProfileId:profile.id,...(refs?{attachmentRefs:refs}:{})}} as ScheduleMutation;
  }
  private attachmentKey(roomId:string,operation:ScheduleWorkerMutation){return roomId+'\0'+JSON.stringify(operation);}
  async prepareRouter(message:GroupMessage,operation:ScheduleModelMutation,signal?:AbortSignal){
    if(operation.op==='withdraw_proposal')return;
    const lease=isPrivateRoom(message.roomId)?this.privateAccess.capture(message.roomId):undefined;
    if(operation.op==='resume'||operation.op==='run_now'){
      const schedule=this.service.get(await this.actor(message,'router'),operation.id);
      const reason=this.unavailable(schedule,reloadAgentConfig(this.config).config);if(reason)throw new ScheduleError('BLOCKED',reason,409);
      if(schedule.attachmentRefs?.length)await this.attachments?.validateRefs(schedule.roomId,schedule.attachmentRefs,signal);
    }
    if(operation.op!=='create'&&operation.op!=='update'){if(lease)this.privateAccess.assert(lease);return;}
    const data=operation.op==='create'?operation.input:operation.patch;
    if(data.attachmentIds===undefined)return;
    if(!isPrivateRoom(message.roomId)||!this.attachments)throw new ScheduleError('ATTACHMENTS_UNAVAILABLE','当前会话不支持计划文件绑定。');
    const kind=operation.op==='create'?operation.input.executionKind:operation.patch.executionKind??this.service.get(await this.actor(message,'router'),operation.id).executionKind;
    if(kind!=='worker'&&data.attachmentIds.length)throw new ScheduleError('INVALID_ATTACHMENTS','文字提醒不能绑定文件。');
    const sources=new Set(this.store.db.prepare('SELECT id FROM messages WHERE room=?').all(message.roomId).map(row=>String(row.id)));
    const refs=await this.attachments.refs(message.roomId,data.attachmentIds,sources,signal);
    if(lease)this.privateAccess.assert(lease);
    this.preparedAttachments.set(this.attachmentKey(message.roomId,operation),refs);
    while(this.preparedAttachments.size>1000)this.preparedAttachments.delete(this.preparedAttachments.keys().next().value!);
  }
  applyRouter(message:GroupMessage,operation:ScheduleModelMutation,slot='main'){
    this.requireEnabled();const actor=this.currentActor(message,'router');
    if(operation.op==='withdraw_proposal')return this.service.withdrawProposal(actor,operation.id);
    const mutation=this.mutation(actor,operation),key=`router:${message.id}:${slot}`;
    if(mutation.op==='create')return this.service.create(actor,mutation.input,key);
    if(mutation.op==='update')return this.service.update(actor,mutation.id,mutation.expectedVersion,mutation.patch,key);
    return this.service.command(actor,mutation.id,mutation.op,mutation.expectedVersion,key,mutation.runId);
  }
  receipt(value:unknown):string{
    const result=value as {id?:string;status?:string;nextRunAt?:number|null;receipt?:{scheduleId:string}};
    if(result.status==='superseded')return '已撤销待提交的任务登记，该提案不会生效。';
    const id=result.receipt?.scheduleId??result.id??'';
    const schedule=id?this.service.get(admin,id):undefined;
    const next=schedule?.nextRunAt?new Intl.DateTimeFormat('zh-CN',{timeZone:schedule.timezone,dateStyle:'medium',timeStyle:'short'}).format(schedule.nextRunAt)+'（'+schedule.timezone+'）':undefined;
    return `${schedule?.title??'任务'}：${({active:'已登记',paused:'已暂停',blocked:'暂不可执行',completed:'已完成',cancelled:'已取消'} as Record<string,string>)[schedule?.status??'']??'操作已保存'}。${next?'下次执行：'+next+'。':''}${schedule?.recipientIds?.length?'收件人：'+schedule.recipientIds.join('、')+'。':''}${result.status==='pending'?'操作已排队，等待服务执行。':''}`;
  }
  private source(thread:StoredThread){
    // Another participant's latest request cannot borrow the owner's older
    // authority to register or manage a schedule through this Worker.
    const latest=this.store.inputs(thread.id).at(-1)?.message;
    return latest?.authorId===thread.ownerId&&hasWakeCandidate(latest,this.config.botCallNames)?latest:undefined;
  }
  workerTools(request:WorkerRequest){
    if(!this.enabled||request.scheduledInput)return [];
    const source=this.source(request.thread as StoredThread);if(!source)return [];
    const binding:ScheduleBinding={threadId:request.thread.id,runId:request.runId,revision:request.thread.revision,epoch:request.thread.epoch};
    return [createWorkerScheduleTool(request,{
      query:async query=>this.query(await this.actor(source,'worker'),query),
      propose:async(operation,slot)=>{
        this.requireEnabled();this.assertBinding(binding);
        await this.prepareRouter(source,operation,request.signal);
        const actor=await this.actor(source,'worker'),mutation=this.mutation(actor,operation);
        this.assertBinding(binding);
        return this.service.propose(actor,mutation,binding,`worker:${binding.threadId}:${binding.revision}:${slot}`);
      },
    })];
  }
  private assertBinding(binding:ScheduleBinding){
    const thread=this.store.thread(binding.threadId);
    if(!thread||thread.status!=='running'||thread.activeRunId!==binding.runId||thread.epoch!==binding.epoch||thread.revision!==binding.revision)
      throw new ScheduleError('STALE_RUN','当前执行已被取消或更新。',409);
  }
  async refreshWorkerActor(thread:StoredThread){const source=this.source(thread);if(source)await this.actor(source,'worker',true);}
  commitWorker(thread:StoredThread,runId:string,report:WorkerReport){
    const binding={threadId:thread.id,runId,revision:report.basedOnRevision,epoch:thread.epoch};
    if(!report.scheduleProposalIds?.length)return;
    this.requireEnabled();this.assertBinding(binding);
    if(report.status!=='ready'||thread.scheduledTask)throw new ScheduleError('STALE_PROPOSAL','仅当前普通任务的完成报告可以提交登记。',409);
    const source=this.source(thread);if(!source)throw new ScheduleError('SOURCE','缺少任务请求人的授权来源。',403);
    const receipts=this.service.commitProposals(this.currentActor(source,'worker'),binding,report.scheduleProposalIds);
    report.shortAnswer+='\n\n'+receipts.map(receipt=>this.receipt(receipt)).join('\n');
  }
  rejectWorker(thread:StoredThread,runId:string,reason:string){this.service.rejectProposals({threadId:thread.id,runId,revision:thread.revision,epoch:thread.epoch},reason);}
  assertThreadControl(message:GroupMessage,thread:StoredThread){
    if(!thread.scheduledTask)return;
    this.requireEnabled();
    if(thread.scheduledTask.authority==='system')throw new ScheduleError('SYSTEM_TASK','这是系统任务，需要在后台管理。',403);
    const actor=this.currentActor(message,'router'),schedule=this.service.get(actor,thread.scheduledTask.scheduleId);
    // A read of one's own task remains allowed after write permission is revoked.
    const policy=this.service.readPolicy();
    if(actor.accessKind!=='private'&&(actor.roleGroup==='unknown'||!policy.allowedRoleGroups.includes(actor.roleGroup)||Date.now()-actor.roleVerifiedAt>(this.config.scheduledTasks?.roleMaxAgeMs??300_000)))
      throw new ScheduleError('ROLE_NOT_ALLOWED','当前角色没有任务管理权限。',403);
    return schedule;
  }
  readThread(message:GroupMessage,thread:StoredThread){return this.service.get(this.currentActor(message,'router'),thread.scheduledTask!.scheduleId);}
  stopThread(message:GroupMessage,thread:StoredThread){
    const schedule=this.assertThreadControl(message,thread);if(!schedule)return;
    return this.service.command(this.currentActor(message,'router'),schedule.id,'stop_run',schedule.version,`stop-thread:${message.id}`,thread.scheduledTask!.scheduleRunId);
  }
  private materialize=(run:ScheduleRun,schedule:Schedule)=>{
    if(schedule.executionKind==='reminder')return {outboxId:this.store.enqueue({roomId:schedule.roomId,text:schedule.content,...(schedule.recipientIds?.length?{recipientIds:[...schedule.recipientIds]}:{})},{id:'schedule-result:'+run.id,scheduleRunId:run.id})};
    return {threadId:this.store.createScheduledThread(run,schedule).id};
  };
  tick(){
    if(!this.enabled)return;
    const now=Date.now();if(now-this.lastScan<(this.config.scheduledTasks?.scanIntervalMs??1000))return;this.lastScan=now;
    this.reconcileProposals();
    let current:Config|undefined;
    try{current=reloadAgentConfig(this.config).config;}catch{/* Invalid hot configuration must fence Worker execution. */}
    for(let offset=0;;offset+=100){
      const page=this.service.list(admin,{includeEnded:true,limit:100,offset});
      for(const schedule of page.items){
        if(schedule.status==='cancelled'||schedule.status==='blocked'||schedule.archivedAt)continue;
        const reason=!current&&schedule.executionKind==='worker'?'configuration_unavailable':this.unavailable(schedule,current??this.config);
        if(reason)this.service.block(schedule.id,reason,{cancelRunning:true});
      }
      if(!page.hasMore)break;
    }
    this.service.dispatchCommands(this.materialize,now);this.service.dispatchDue(this.materialize,now);
  }
  reconcileProposals(){this.service.invalidateProposals(binding=>{
    const thread=this.store.thread(binding.threadId);
    return Boolean(thread&&thread.status==='running'&&thread.activeRunId===binding.runId&&thread.epoch===binding.epoch&&thread.revision===binding.revision);
  });}
  private unavailable(schedule:Schedule,current:Config){
    if(isPrivateRoom(schedule.roomId)){if(!this.privateAccess.allows(schedule.roomId))return 'private_access_denied';}
    else if(!current.qq.allowedGroupIds.some(id=>schedule.roomId===`qq:${current.qq.selfId}:${id}`))return 'room_not_allowed';
    if(schedule.executionKind==='reminder')return;
    const profile=resolveBusinessProfile(current,schedule.roomId);
    if(schedule.businessProfileId&&profile.id!==schedule.businessProfileId)return 'business_profile_changed';
    const available=new Set([...profile.skillIds.filter(id=>current.skills.some(skill=>skill.id===id)),
      ...profile.extensionIds.filter(id=>current.extensions.some(extension=>extension.id===id&&extension.enabled!==false))]);
    if(schedule.requiredCapabilityIds?.some(id=>!available.has(id)))return 'capability_unavailable';
    if(current.worker.model==='YOUR_MODEL_ID'||!current.workerApiKey)return 'worker_not_configured';
  }
  valid(thread:StoredThread){return !thread.scheduledTask||this.enabled&&this.service.canPublish(thread.scheduledTask.scheduleRunId);}
  start(thread:StoredThread){
    if(!thread.scheduledTask)return true;if(!this.enabled)return false;
    const run=this.service.getRun(thread.scheduledTask.scheduleRunId);if(!run)return false;
    let reason:string|undefined,revision:string|undefined;
    try{
      const current=reloadAgentConfig(this.config).config;
      reason=this.unavailable(run.snapshot,current);
      if(!reason){
        revision=scheduledExecutionConfigRevision(current,thread.roomId);
        if(thread.scheduledTask.executionConfigRevision&&thread.scheduledTask.executionConfigRevision!==revision)reason='execution_config_changed';
      }
    }catch{reason='configuration_unavailable';}
    if(reason){this.service.block(run.scheduleId,reason,{cancelRunning:true});return false;}
    return this.service.transaction(()=>{
      if(!this.service.startRun(run.id))return false;
      thread.scheduledTask!.executionConfigRevision=revision;this.store.saveThread(thread);return true;
    });
  }
  input(thread:StoredThread):WorkerRequest['scheduledInput']{
    if(!thread.scheduledTask)return;
    const run=this.service.getRun(thread.scheduledTask.scheduleRunId);if(!run)throw new Error('Scheduled run missing');
    const schedule=run.snapshot;
    return {kind:'scheduled',scheduleId:schedule.id,scheduleRunId:run.id,authority:schedule.authority,ownerId:schedule.ownerId,roomId:schedule.roomId,
      attachmentRefs:schedule.attachmentRefs,title:schedule.title,instructions:schedule.content,scheduledAt:run.scheduledAt,sourceRefs:schedule.sourceMessageIds,...this.recipients(thread)};
  }
  localResult(thread:StoredThread){return !!thread.scheduledTask&&this.service.getRun(thread.scheduledTask.scheduleRunId)?.snapshot.deliveryMode==='local';}
  recipients(thread:StoredThread):Pick<OutgoingMessage,'recipientIds'>{
    const ids=thread.scheduledTask&&this.service.getRun(thread.scheduledTask.scheduleRunId)?.snapshot.recipientIds;
    return ids?.length?{recipientIds:[...ids]}:{};
  }
  timeout(thread:StoredThread){return thread.scheduledTask?this.service.getRun(thread.scheduledTask.scheduleRunId)?.snapshot.timeoutMs:undefined;}
  finish(thread:StoredThread,status:'succeeded'|'failed'|'needs_input',meta:{resultId?:string;outboxId?:string;error?:string}){
    if(thread.scheduledTask)this.service.finishRun(thread.scheduledTask.scheduleRunId,status,meta);
  }
  delivery(runId:string,status:string){this.service.recordDelivery(runId,status);}
  title(thread:StoredThread,text:string){return thread.scheduledTask?`【${thread.scheduledTask.title}】\n${text}`:text;}
}
