import {randomUUID} from 'node:crypto';
import type {Store,OutboxRow} from './store.js';
import {roomMemoryAtomic} from './room-memory-store.js';
import {parseQqRoomId} from './conversation.js';
import type {ScheduledTaskService} from './scheduled-tasks/service.js';
import {readOutgoingFile} from './output-files.js';
import {readOutgoingImage} from './output-images.js';

export type DeliveryActor={kind:'admin';id:string}|{kind:'user';roomId:string;userId:string;sourceInputId:string};
export interface DeliveryResolution {partId:string;reason:'confirmed_received'|'abandoned'|'resent';resolvedAt:number;actor:DeliveryActor;key:string;attemptIds:string[];replacementId?:string}
export interface DeliveryPart {id:string;name:string;status:string;resolution?:DeliveryResolution}
export function deliveryParts(row:OutboxRow):DeliveryPart[]{
  const parts:DeliveryPart[]=(row.message.files??[]).map(file=>{
    const fact=row.fileDeliveries?.find(d=>d.artifactId===file.artifactId)?.status;
    return {id:file.artifactId,name:file.name,status:!fact||fact==='pending'?(['stale','failed'].includes(row.status)?row.status:row.invalidatedParts?.includes(file.artifactId)?'stale':'pending'):fact};
  });
  if(row.message.text.trim()||row.message.attachments?.length||!row.message.files?.length){
    const allFilesSent=!row.message.files?.some(file=>!row.fileDeliveries?.some(d=>d.artifactId===file.artifactId&&d.status==='sent'));
    parts.push({id:'message',name:'正文及图片',status:row.messageDelivery?.status??(allFilesSent?row.status:['stale','failed'].includes(row.status)?row.status:'pending')});
  }
  return parts.map(part=>({...part,resolution:row.deliveryResolutions?.find(r=>r.partId===part.id)}));
}
export function deliveryClosed(row:OutboxRow):boolean {
  return row.status!=='sending'&&deliveryParts(row).every(part=>part.status==='sent'||!!part.resolution||['stale','failed'].includes(part.status));
}
export function threadDeliveryStatus(store:Store,threadId:string):string {
  const thread=store.thread(threadId);if(!thread)return '没有找到这个问题的处理记录。';
  switch(thread.status){
    case 'queued':return '这个问题还在排队，轮到后我会继续处理。';
    case 'running':return '这个问题还在处理中，有结果后我会告诉你。';
    case 'needs_input':return '这个问题还需要你补充一些信息，才能继续处理。';
    case 'failed':return '处理这个问题时遇到了问题，暂时没能完成。';
    case 'cancelled':return '这个问题已经停止处理了。';
  }
  if(thread.scheduledTask?.deliveryMode==='local')return '这个问题已经处理完了，结果已保存。';
  // Only the current result describes completion. Acknowledgements, status
  // replies and older revisions must not become a delivery history in chat.
  const row=store.outbox().filter(row=>row.threadId===threadId&&row.resultId&&!row.resendOf
    &&row.epoch===thread.epoch&&row.revision===thread.revision).at(-1);
  if(!row)return '这个问题已经处理完了，回复还在准备中。';
  const pending=deliveryParts(row).filter(part=>part.status!=='sent'
    &&!['confirmed_received','resent'].includes(part.resolution?.reason??''));
  if(!pending.length)return '这个问题已经处理完了，结果已发出。';
  if(pending.some(part=>part.status==='unknown'&&!part.resolution))return '这个问题已经处理完了，但暂时无法确认结果是否全部发送成功。如果你没收到，可以让我补发。';
  if(pending.some(part=>['failed','stale'].includes(part.status)||part.resolution?.reason==='abandoned'))return '这个问题已经处理完了，但还有内容没有发出。如果需要，可以让我重新发送。';
  return '这个问题已经处理完了，结果正在发送中。';
}
export function deliveryText(row:OutboxRow):string {return `${row.id}：${deliveryParts(row).map(part=>`${part.name} ${part.resolution?({confirmed_received:'本人确认收到',abandoned:'已放弃',resent:'补发成功'} as const)[part.resolution.reason]:({sent:'平台已确认',unknown:'送达待核对',pending:'等待发送',sending:'发送中',failed:'发送失败',stale:'已失效'} as Record<string,string>)[part.status]??part.status}`).join('；')}${deliveryClosed(row)?(row.scheduleRunId?'。本次交付已结案，计划仍需明确恢复。':'。本次交付已结案。'):'。仍有项目待处理。'}`;}
/** Raw platform facts and human resolution are deliberately independent. */
export class DeliveryService {
  constructor(readonly store:Store,readonly schedules:ScheduledTaskService,readonly outputRoot:string){}
  private get(id:string){const row=this.store.outbox().find(row=>row.id===id);if(!row)throw new Error('投递不存在。');return row;}
  private authorize(actor:DeliveryActor,row:OutboxRow){
    if(actor.kind==='admin')return;
    const room=parseQqRoomId(row.message.roomId);
    if(room?.kind!=='private'||actor.roomId!==row.message.roomId||actor.userId!==room.peerId||!this.store.privateAccess?.allows(actor.roomId))throw new Error('无权操作此投递。');
    const source=this.store.message(actor.sourceInputId);if(!source||source.roomId!==actor.roomId||source.authorId!==actor.userId)throw new Error('请求来源无效。');
    const thread=row.threadId?this.store.thread(row.threadId):undefined;
    if(thread&&(thread.ownerId!==actor.userId||thread.scheduledTask?.authority==='system'))throw new Error('无权操作此投递。');
    if(row.scheduleRunId){const run=this.schedules.getRun(row.scheduleRunId);if(!run||run.snapshot.authority==='system'||run.snapshot.ownerId!==actor.userId)throw new Error('系统投递须在后台处理。');}
  }
  private related(row:OutboxRow){return this.store.outbox().filter(other=>other.resendOf===row.id&&!other.independentResend);}
  private busy(row:OutboxRow){return [row,...this.related(row)].some(r=>r.status==='sending'||r.messageDelivery?.status==='sending'||r.fileDeliveries?.some(f=>f.status==='sending'));}
  query(actor:DeliveryActor,id:string){const row=this.get(id);this.authorize(actor,row);return this.summary(row);}
  list(actor:DeliveryActor,includeClosed=false){return this.store.outbox().filter(row=>{
      try{this.authorize(actor,row);return !row.resendOf&&row.kind!=='acknowledgement'&&(includeClosed||!deliveryClosed(row));}catch{return false;}
  }).slice(-50).map(row=>({id:row.id,status:row.status,resolutionVersion:row.resolutionVersion??0,closed:deliveryClosed(row),threadId:row.threadId,scheduleRunId:row.scheduleRunId,parts:deliveryParts(row)}));}
  resolve(actor:DeliveryActor,input:{outboxId:string;partIds?:string[];decision:'received'|'abandon';expectedResolutionVersion:number;key:string}){
    return roomMemoryAtomic(this.store.db,()=>{
      const row=this.get(input.outboxId);this.authorize(actor,row);
      if(row.resendOf)throw new Error('请核对原交付 ID。');
      const previous=row.deliveryResolutions?.filter(r=>r.key===input.key);
      if(previous?.length){if(previous.some(r=>r.reason!==(input.decision==='received'?'confirmed_received':'abandoned'))||input.partIds&&JSON.stringify([...input.partIds].sort())!==JSON.stringify(previous.map(r=>r.partId).sort()))throw new Error('重复操作内容不一致。');return this.summary(row);}
      if(this.busy(row))throw new Error('投递仍在发送，请等待回执后核对。');
      if((row.resolutionVersion??0)!==input.expectedResolutionVersion)throw new Error('投递核对版本已变化，请重新查询。');
      const parts=deliveryParts(row),selected=input.partIds??parts.filter(p=>!p.resolution&&(input.decision==='received'?p.status==='unknown':p.status!=='sent')).map(p=>p.id);
      if(!selected.length||new Set(selected).size!==selected.length)throw new Error('没有可结案的项目。');
      for(const id of selected){const part=parts.find(p=>p.id===id);if(!part||part.resolution||part.status==='sent'||input.decision==='received'&&part.status!=='unknown')throw new Error('所选项目不能执行该结案操作。');}
      row.deliveryResolutions??=[];
      for(const partId of selected)row.deliveryResolutions.push({partId,reason:input.decision==='received'?'confirmed_received':'abandoned',resolvedAt:Date.now(),actor,key:input.key,
        attemptIds:[row.deliveryAttemptId,...(row.fileDeliveries??[]).filter(d=>d.artifactId===partId).map(d=>d.attemptId)].filter((id):id is string=>!!id)});
      row.resolutionVersion=(row.resolutionVersion??0)+1;
      if(row.status==='pending'&&deliveryParts(row).every(p=>p.status==='sent'||!!p.resolution)){row.status='stale';row.reason='delivery_resolved';}
      this.store.saveOutbox(row);
      for(const replacement of this.related(row))if(replacement.status==='pending'&&Object.values(replacement.resendParts??{}).some(id=>selected.includes(id))){
        replacement.invalidatedParts=[...new Set([...(replacement.invalidatedParts??[]),...Object.entries(replacement.resendParts??{}).filter(([,id])=>selected.includes(id)).map(([id])=>id)])];
        if(deliveryParts(replacement).every(p=>replacement.invalidatedParts?.includes(p.id)||p.status==='sent')){replacement.status='stale';replacement.reason='delivery_resolved';}
        this.store.saveOutbox(replacement);
      }
      this.store.telemetry('delivery_resolution',{outboxId:row.id,version:row.resolutionVersion,actor,decision:input.decision,partIds:selected,key:input.key});
      this.reconcileSchedule(row);return this.summary(row);
    });
  }
  summary(row:OutboxRow){return {id:row.id,status:row.status,text:row.message.text,originalScheduledAt:row.scheduleRunId?this.schedules.getRun(row.scheduleRunId)?.scheduledAt:undefined,resolutionVersion:row.resolutionVersion??0,closed:deliveryClosed(row),parts:deliveryParts(row),note:deliveryClosed(row)?'本次交付已结案，原平台回执保留；后续计划仍需明确恢复。':'仍有未处理项目，请逐项核对、补发或放弃。'};}
  outstanding(runId:string):boolean|undefined {
    const root=this.store.outbox().find(row=>row.scheduleRunId===runId&&!row.resendOf);
    return root?(!deliveryClosed(root)||this.related(root).some(row=>row.status==='sending'||row.status==='pending')):undefined;
  }
  private reconcileSchedule(row:OutboxRow){if(row.scheduleRunId)this.schedules.resolveDeliveryBlock(row.scheduleRunId);}
  /** Called in the same transaction that saves an actual replacement receipt. */
  settle(row:OutboxRow){
    if(!row.resendOf||row.independentResend)return;
    const root=this.get(row.resendOf);if(root.message.roomId!==row.message.roomId)return;
    let changed=false;root.deliveryResolutions??=[];
    for(const part of deliveryParts(row))if(part.status==='sent'){
      const original=row.resendParts?.[part.id];if(!original||!row.resendActor||root.deliveryResolutions.some(r=>r.partId===original))continue;
      if(original==='message'){
        if(row.message.text!==root.message.text||JSON.stringify(row.message.attachments)!==JSON.stringify(root.message.attachments))continue;
      }else{
        const sent=row.message.files?.find(f=>f.artifactId===part.id),source=root.message.files?.find(f=>f.artifactId===original);
        if(!sent||!source||JSON.stringify(sent)!==JSON.stringify(source))continue;
      }
      const a=deliveryParts(root).find(p=>p.id===original);if(!a||a.status==='sent')continue;
      root.deliveryResolutions.push({partId:original,reason:'resent',resolvedAt:Date.now(),actor:row.resendActor!,key:'replacement:'+row.id+':'+part.id,attemptIds:[row.deliveryAttemptId].filter((id):id is string=>!!id),replacementId:row.id});changed=true;
    }
    if(changed){root.resolutionVersion=(root.resolutionVersion??0)+1;this.store.saveOutbox(root);this.store.telemetry('delivery_resolution',{outboxId:root.id,decision:'resent',replacementId:row.id});}
    this.reconcileSchedule(root);
  }
  async resend(actor:DeliveryActor,input:Parameters<DeliveryService['prepareResend']>[1]){return (await this.prepareResend(actor,input))();}
  async prepareResend(actor:DeliveryActor,input:{outboxId:string;key:string;confirmedUnknown?:boolean;all?:boolean}){
    let row=this.get(input.outboxId);this.authorize(actor,row);
    const existing=this.store.outbox().find(r=>r.resendRequestKey===input.key&&r.message.roomId===row.message.roomId);if(existing){if(existing.resendOf!==row.id)throw new Error('重复补发请求内容不一致。');return ()=>existing.id;}
    if(['pending','sending'].includes(row.status)||this.busy(row)||this.related(row).some(r=>r.status==='pending'))throw new Error('已有投递正在处理，请先查询状态。');
    if(row.reason==='private_access_denied')throw new Error('原投递已撤权作废，请重新提出请求。');
    const thread=row.threadId?this.store.thread(row.threadId):undefined;
    if(thread&&(thread.status==='cancelled'||thread.epoch!==row.epoch||thread.revision!==row.revision))throw new Error('原结果已被取消或更正，请重新提出请求。');
    if(deliveryParts(row).some(p=>p.status==='unknown'&&!p.resolution)&&!input.confirmedUnknown)throw new Error('原投递可能已经送达。若仍需要，请明确确认仍然补发。');
    const lease=actor.kind==='user'?this.store.privateAccess!.capture(actor.roomId):undefined;
    const version=row.resolutionVersion??0,closed=deliveryClosed(row),parts=deliveryParts(row).filter(p=>input.all||closed||p.status!=='sent'&&!p.resolution);
    const files=(row.message.files??[]).filter(file=>parts.some(p=>p.id===file.artifactId));
    for(const file of files)await readOutgoingFile(file,this.outputRoot);
    if(parts.some(p=>p.id==='message'))for(const image of row.message.attachments??[])await readOutgoingImage(image,this.outputRoot);
    if(lease)this.store.privateAccess!.assert(lease);
    return ()=>roomMemoryAtomic(this.store.db,()=>{
      if(lease)this.store.privateAccess!.assert(lease);
      row=this.get(input.outboxId);this.authorize(actor,row);
      const currentThread=row.threadId?this.store.thread(row.threadId):undefined;
      if(row.reason==='private_access_denied'||currentThread&&(currentThread.status==='cancelled'||currentThread.epoch!==row.epoch||currentThread.revision!==row.revision))throw new Error('原结果已失效，请重新提出请求。');
      if(this.busy(row)||this.related(row).some(r=>r.status==='pending')||(row.resolutionVersion??0)!==version)throw new Error('投递已变化，请重新查询。');
      const repeat=this.store.outbox().find(r=>r.resendRequestKey===input.key&&r.message.roomId===row.message.roomId);if(repeat)return repeat.id;
      const body=parts.some(p=>p.id==='message'),id='resend-'+randomUUID();
      this.store.enqueue({...row.message,text:body?row.message.text:'',attachments:body?row.message.attachments:undefined,files,
        quoteReply:undefined,replyToMessageId:actor.kind==='user'?this.store.message(actor.sourceInputId)?.messageId:undefined},
        {id,resendOf:row.id,resendActor:actor,resendRequestKey:input.key,independentResend:closed,resendParts:Object.fromEntries(parts.map(p=>[p.id,p.id])),resultId:row.resultId,associationThreadId:row.threadId??row.associationThreadId,hostLinks:row.hostLinks});
      this.store.telemetry('delivery_resend',{outboxId:row.id,replacementId:id,actor,partIds:parts.map(p=>p.id)});return id;
    });
  }
}
