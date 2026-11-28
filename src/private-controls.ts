import {threadDeliveryStatus} from './delivery-resolution.js';
import {parseQqRoomId} from './conversation.js';
import type {GroupMessage} from './types.js';
import type {Store} from './store.js';
import type {ScheduledTaskHost} from './scheduled-tasks/host.js';

export function privateControl(text:string):boolean {
  return /^\/(?:status|cancel)(?:\s+\S+)?$/.test(text.trim())
    ||/^\/schedule (?:list|(?:pause|stop|cancel) \S+)$/.test(text.trim())
    ||/^\/delivery (?:list|(?:received|abandon) \S+(?: \S+)?)$/.test(text.trim());
}
/** Exact host commands remain available when ordinary model input is rate limited. */
export function runPrivateControl(message:GroupMessage,store:Store,host:ScheduledTaskHost,cancel:(id:string)=>void,
  delivery?:(parts:string[])=>string):string {
  const room=parseQqRoomId(message.roomId);
  if(room?.kind!=='private'||room.peerId!==message.authorId||!store.privateAccess?.allows(message.roomId))throw new Error('private_access_denied');
  const [command,operation,id]=message.text.trim().split(/\s+/);
  if(command==='/delivery')return delivery?.(message.text.trim().split(/\s+/).slice(1))??'投递核对暂不可用。';
  if(command==='/schedule'){
    const actor={kind:'user' as const,roomId:message.roomId,memberId:message.authorId,accessKind:'private' as const,roleGroup:'unknown' as const,
      roleVerifiedAt:Date.now(),sourceMessageIds:[message.id],registeredBy:'router' as const};
    if(operation==='list')return host.service.list(actor,{limit:50}).items.map(s=>`${s.id} ${s.title}：${s.status}${s.stateReason?' ('+s.stateReason+')':''}`).join('\n')||'暂无个人计划。';
    const plan=host.service.get(actor,id);
    const result=host.service.command(actor,id,operation==='stop'?'stop_run':operation as 'pause'|'cancel',plan.version,'control:'+message.id);
    return host.receipt(result);
  }
  const candidates=(operation?(store.thread(operation)?[store.thread(operation)!]:[]):store.threads(message.roomId)).filter(t=>t.roomId===message.roomId&&t.ownerId===message.authorId&&!t.scheduledTask
    &&(operation?t.id===operation:command==='/status'||['queued','running','needs_input'].includes(t.status)));
  if(!candidates.length)return '未找到可操作的本人任务。';
  if(command==='/status'||candidates.length!==1)return candidates.slice(-10).map(t=>
    (command==='/cancel'?`${t.id} ${t.subject}：`:candidates.length>1?`${t.subject}：`:'')+threadDeliveryStatus(store,t.id)
  ).join('\n')+(command==='/cancel'?'\n请指定一个任务 ID。':'');
  const thread=candidates[0];if(thread.status==='cancelled')return '任务已取消。';
  thread.status='cancelled';thread.epoch++;thread.activeRunId=undefined;store.saveThread(thread);
  cancel(thread.id);return '已停止这个问题的处理。';
}
