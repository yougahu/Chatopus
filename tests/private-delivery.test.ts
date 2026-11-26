import {afterEach,expect,it} from 'vitest';
import {Store} from '../src/store.js';
import {PrivateChatAccess} from '../src/private-chat.js';
import {DeliveryService,deliveryClosed,deliveryParts,threadDeliveryStatus} from '../src/delivery-resolution.js';
import {ScheduledTaskService} from '../src/scheduled-tasks/service.js';
import type {GroupMessage,OutgoingFile} from '../src/types.js';
const room='qq:900:private:901',peer='901';
const cleanup:Store[]=[];afterEach(()=>{for(const store of cleanup.splice(0))store.close();});
function fixture(){
 const store=new Store(':memory:');cleanup.push(store);store.privateAccess=new PrivateChatAccess('900',{enabled:true,allowedUserIds:[peer]});
 const schedules=new ScheduledTaskService(store.db),service=new DeliveryService(store,schedules,'/tmp/unavailable-output-root');schedules.deliveryOutstanding=id=>service.outstanding(id);
 const source:GroupMessage={id:room+':source',platform:'qq',roomId:room,messageId:'1',authorId:peer,authorName:'Member',text:'已收到',timestamp:Date.now(),mentions:[],attachments:[],isMentioned:false,isAdmin:false};store.ingest(source);
 const actor={kind:'user' as const,roomId:room,userId:peer,sourceInputId:source.id};
 return {store,schedules,service,actor};
}
const file=(id:string):OutgoingFile=>({kind:'file',artifactId:id,name:id+'.txt',file:'/tmp/unavailable-output-root/'+id,bytes:3,sha256:'a'.repeat(64)});
it('keeps partial file delivery blocked until every remaining item is handled',()=>{
 const {store,service,actor}=fixture();store.enqueue({roomId:room,text:'',files:[file('A'),file('B')]},{id:'root',status:'unknown',fileDeliveries:[{artifactId:'A',status:'unknown',attempts:1},{artifactId:'B',status:'pending',attempts:0}]});
 const first=service.resolve(actor,{outboxId:'root',decision:'received',partIds:['A'],expectedResolutionVersion:0,key:'received-A'});
 expect(first.closed).toBe(false);expect(first.parts[0]).toMatchObject({status:'unknown',resolution:{reason:'confirmed_received'}});
 expect(()=>service.resolve(actor,{outboxId:'root',decision:'received',partIds:['B'],expectedResolutionVersion:1,key:'wrong'})).toThrow();
 const result=service.resolve(actor,{outboxId:'root',decision:'abandon',partIds:['B'],expectedResolutionVersion:1,key:'skip-B'});expect(result.closed).toBe(true);expect(store.outbox()[0].status).toBe('unknown');
});
it('makes duplicate closure idempotent and rejects stale/conflicting decisions',()=>{
 const {store,service,actor}=fixture();store.enqueue({roomId:room,text:'result'},{id:'root',status:'unknown'});
 const input={outboxId:'root',decision:'received' as const,expectedResolutionVersion:0,key:'same'};const first=service.resolve(actor,input);
 expect(service.resolve(actor,input)).toEqual(first);
 expect(()=>service.resolve(actor,{...input,decision:'abandon'})).toThrow();expect(()=>service.resolve(actor,{...input,key:'new'})).toThrow();
 expect(store.outbox()[0].deliveryResolutions).toHaveLength(1);
});
it('refuses closure of an actual send or its active replacement',()=>{
 const {store,service,actor}=fixture();store.enqueue({roomId:room,text:'result'},{id:'root',status:'unknown'});store.enqueue({roomId:room,text:'result'},{id:'replacement',status:'sending',resendOf:'root'});
 expect(()=>service.resolve(actor,{outboxId:'root',decision:'abandon',expectedResolutionVersion:0,key:'one'})).toThrow(/发送/);
});
it('enforces peer, source and room scope and distinguishes administrative resolution',()=>{
 const {store,service,actor}=fixture();store.enqueue({roomId:room,text:'result'},{id:'root',status:'unknown'});
 for(const wrong of [{...actor,userId:'902'},{...actor,roomId:'qq:900:private:902'},{...actor,sourceInputId:'missing'}])expect(()=>service.resolve(wrong,{outboxId:'root',decision:'abandon',expectedResolutionVersion:0,key:'x'})).toThrow();
 service.resolve({kind:'admin',id:'local-admin'},{outboxId:'root',decision:'received',expectedResolutionVersion:0,key:'admin'});
 expect(store.outbox()[0].deliveryResolutions![0].actor.kind).toBe('admin');
});
it('closes missing artifacts without requiring bytes or claiming successful upload',()=>{
 const {store,service,actor}=fixture();store.enqueue({roomId:room,text:'',files:[file('lost')]},{id:'root',status:'unknown',fileDeliveries:[{artifactId:'lost',status:'unknown',attempts:1}]});
 service.resolve(actor,{outboxId:'root',decision:'abandon',expectedResolutionVersion:0,key:'skip'});
 expect(deliveryClosed(store.outbox()[0])).toBe(true);expect(store.outbox()[0].fileDeliveries![0].status).toBe('unknown');
});
it('successful explicit resend closes only mapped original parts, once',async()=>{
 const {store,service,actor}=fixture();store.enqueue({roomId:room,text:'result'},{id:'root',status:'unknown'});
 await expect(service.resend(actor,{outboxId:'root',key:'request'})).rejects.toThrow(/可能/);
 const id=await service.resend(actor,{outboxId:'root',key:'confirmed',confirmedUnknown:true});const replacement=store.outbox().find(r=>r.id===id)!;
 replacement.status='sent';replacement.messageDelivery={status:'sent',platformMessageId:'22'};store.saveOutbox(replacement);service.settle(replacement);service.settle(replacement);
 const root=store.outbox().find(r=>r.id==='root')!;expect(root.status).toBe('unknown');expect(root.deliveryResolutions).toHaveLength(1);expect(root.deliveryResolutions![0].reason).toBe('resent');
 const independent=await service.resend(actor,{outboxId:'root',key:'another'});expect(store.outbox().find(r=>r.id===independent)?.independentResend).toBe(true);
});
it('unresolved delivery blocks resume; complete resolution requires explicit future resume',()=>{
 const {store,service,schedules,actor}=fixture();const scheduleActor={kind:'user' as const,roomId:room,memberId:peer,accessKind:'private' as const,roleGroup:'unknown' as const,roleVerifiedAt:Date.now(),sourceMessageIds:[actor.sourceInputId],registeredBy:'router' as const};
 const at=Date.now()+1000,plan=schedules.create(scheduleActor,{roomId:room,title:'提醒',executionKind:'reminder',content:'内容',scheduleSpec:{kind:'interval',anchorAt:at,intervalMs:3600000}},'create');
 const [run]=schedules.dispatchDue((run)=>({outboxId:store.enqueue({roomId:room,text:'内容'},{id:'root',scheduleRunId:run.id,status:'unknown'})}),at);
 schedules.recordDelivery(run.id,'unknown');let current=schedules.get(scheduleActor,plan.id);expect(current.stateReason).toBe('delivery_unknown');
 expect(()=>schedules.command(scheduleActor,plan.id,'resume',current.version,'bad-resume')).toThrow(/待处理/);
 service.resolve(actor,{outboxId:'root',decision:'received',expectedResolutionVersion:0,key:'received'});current=schedules.get(scheduleActor,plan.id);expect(current.status).toBe('paused');expect(current.stateReason).toBe('delivery_resolved');
 schedules.recover();expect(schedules.get(scheduleActor,plan.id).status).toBe('paused');
 schedules.command(scheduleActor,plan.id,'resume',current.version,'resume');expect(schedules.get(scheduleActor,plan.id).status).toBe('active');expect(schedules.getRun(run.id)?.deliveryStatus).toBe('unknown');
});
it('recovery records interrupted body receipt instead of leaving it sending forever',()=>{
 const {store,service,actor}=fixture();store.enqueue({roomId:room,text:'result'},{id:'root',status:'sending',messageDelivery:{status:'sending'}});store.recovery();
 expect(deliveryParts(store.outbox()[0])[0].status).toBe('unknown');expect(service.resolve(actor,{outboxId:'root',decision:'received',expectedResolutionVersion:0,key:'after-restart'}).closed).toBe(true);
});

it('settles expired unattempted tails without erasing confirmed or unknown file facts',()=>{
 const {store}=fixture();store.enqueue({roomId:room,text:'',files:[file('a'),file('b')]},{id:'expired',status:'stale',reason:'delivery_expired',fileDeliveries:[{artifactId:'a',status:'sent',attempts:1},{artifactId:'b',status:'pending',attempts:0}]});
 const row=store.outbox()[0];expect(deliveryParts(row).map(p=>p.status)).toEqual(['sent','stale']);expect(deliveryClosed(row)).toBe(true);
 row.fileDeliveries![0].status='unknown';expect(deliveryClosed(row)).toBe(false);expect(deliveryParts(row)[0].status).toBe('unknown');
});

it.each([
 ['queued','还在排队'],['running','还在处理中'],['needs_input','需要你补充'],
 ['failed','暂时没能完成'],['cancelled','已经停止处理'],
] as const)('explains %s without exposing identifiers or old delivery history',(status,expected)=>{
 const {store,actor}=fixture(),thread=store.createThread(store.message(actor.sourceInputId)!,'整理文档',true);
 thread.status=status;store.saveThread(thread);
 store.enqueue({roomId:room,text:'旧回复'},{id:'old-result',threadId:thread.id,resultId:'old-result',epoch:thread.epoch,revision:thread.revision-1,status:'sent'});
 store.enqueue({roomId:room,text:'旧进度'},{id:'control-reply',associationThreadId:thread.id,status:'unknown'});
 const text=threadDeliveryStatus(store,thread.id);expect(text).toContain(expected);
 for(const internal of [thread.id,'old-result','control-reply','投递','当前状态'])expect(text).not.toContain(internal);
 expect(text.split('\n')).toHaveLength(1);
});
it.each([
 ['pending','正在发送中'],['sending','正在发送中'],['sent','结果已发出'],
 ['unknown','无法确认'],['failed','还有内容没有发出'],['stale','还有内容没有发出'],
])('reports an idle result with %s delivery truthfully',(status,expected)=>{
 const {store,actor}=fixture(),thread=store.createThread(store.message(actor.sourceInputId)!,'整理文档',true);
 thread.status='idle';store.saveThread(thread);
 store.enqueue({roomId:room,text:'结果'},{id:'current-result',threadId:thread.id,resultId:'current-result',epoch:thread.epoch,revision:thread.revision,status});
 store.enqueue({roomId:room,text:'收到'},{id:'ack',kind:'acknowledgement',threadId:thread.id,revision:thread.revision,status:'sent'});
 store.enqueue({roomId:room,text:'旧进度'},{id:'control',associationThreadId:thread.id,status:'sent'});
 const text=threadDeliveryStatus(store,thread.id);expect(text).toContain(expected);
 expect(text).not.toContain(thread.id);expect(text).not.toContain('current-result');
});
it('does not treat an older revision or execution as the current result',()=>{
 const {store,actor}=fixture(),thread=store.createThread(store.message(actor.sourceInputId)!,'整理文档',true);
 thread.status='idle';store.saveThread(thread);
 for(const [id,epoch,revision] of [['old-revision',thread.epoch,thread.revision-1],['old-run',thread.epoch-1,thread.revision]] as const)
  store.enqueue({roomId:room,text:'旧结果'},{id,threadId:thread.id,resultId:id,epoch,revision,status:'sent'});
 expect(threadDeliveryStatus(store,thread.id)).toContain('回复还在准备中');
});
it('distinguishes partial delivery, confirmed receipt and abandoned content',()=>{
 const {store,service,actor}=fixture(),thread=store.createThread(store.message(actor.sourceInputId)!,'整理文档',true);
 thread.status='idle';store.saveThread(thread);
 store.enqueue({roomId:room,text:'结果',files:[file('A'),file('B')]},{id:'result',threadId:thread.id,resultId:'result',epoch:thread.epoch,revision:thread.revision,status:'unknown',
  messageDelivery:{status:'sent'},fileDeliveries:[{artifactId:'A',status:'unknown',attempts:1},{artifactId:'B',status:'pending',attempts:0}]});
 expect(threadDeliveryStatus(store,thread.id)).toContain('无法确认');
 service.resolve(actor,{outboxId:'result',decision:'received',partIds:['A'],expectedResolutionVersion:0,key:'received'});
 expect(threadDeliveryStatus(store,thread.id)).toContain('正在发送中');
 service.resolve(actor,{outboxId:'result',decision:'abandon',partIds:['B'],expectedResolutionVersion:1,key:'skip'});
 expect(threadDeliveryStatus(store,thread.id)).toContain('还有内容没有发出');
});
it('recognizes a successful resend without replaying its identifiers',async()=>{
 const {store,service,actor}=fixture(),thread=store.createThread(store.message(actor.sourceInputId)!,'整理文档',true);
 thread.status='idle';store.saveThread(thread);
 store.enqueue({roomId:room,text:'结果'},{id:'result',threadId:thread.id,resultId:'result',epoch:thread.epoch,revision:thread.revision,status:'unknown'});
 const id=await service.resend(actor,{outboxId:'result',key:'resend',confirmedUnknown:true}),replacement=store.outbox().find(row=>row.id===id)!;
 replacement.status='sent';store.saveOutbox(replacement);service.settle(replacement);
 expect(threadDeliveryStatus(store,thread.id)).toBe('这个问题已经处理完了，结果已发出。');
});
