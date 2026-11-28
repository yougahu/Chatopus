import {parseQqRoomId} from '../conversation.js';
import {ScheduleError,type Schedule,type ScheduleActor,type ScheduleAccessPolicy} from './types.js';
export function assertFreshActor(actor:ScheduleActor,policy:ScheduleAccessPolicy,now:number,maxAgeMs:number){
  if(actor.kind==='admin')return;
  if(!actor.memberId||!actor.roomId||!Number.isFinite(actor.roleVerifiedAt)||actor.roleVerifiedAt>now+5000||now-actor.roleVerifiedAt>maxAgeMs)throw new ScheduleError('ROLE_UNVERIFIED','当前群角色需要重新核验。',403);
  const room=parseQqRoomId(actor.roomId);
  if(room?.kind==='private'){if(actor.accessKind!=='private'||room.peerId!==actor.memberId)throw new ScheduleError('FORBIDDEN','私聊仅本人可管理任务。',403);return;}
  if(actor.accessKind==='private')throw new ScheduleError('FORBIDDEN','会话身份不匹配。',403);
  if(actor.roleGroup==='unknown'||!policy.allowedRoleGroups.includes(actor.roleGroup))throw new ScheduleError('ROLE_NOT_ALLOWED','当前角色没有任务登记或管理权限。',403);
}
export function assertReadable(actor:ScheduleActor,schedule:Schedule,policy:ScheduleAccessPolicy,now:number,maxAgeMs:number){
  if(actor.kind==='admin')return;
  if(schedule.authority==='system'||schedule.roomId!==actor.roomId)throw new ScheduleError('NOT_FOUND','任务不存在或无权访问。',404);
  if(schedule.ownerId===actor.memberId)return;
  if(parseQqRoomId(actor.roomId)?.kind==='private')throw new ScheduleError('NOT_FOUND','任务不存在或无权访问。',404);
  assertFreshActor(actor,policy,now,maxAgeMs);
  if(actor.roleGroup!=='group_admin')throw new ScheduleError('NOT_FOUND','任务不存在或无权访问。',404);
}
export function assertManageable(actor:ScheduleActor,schedule:Schedule,policy:ScheduleAccessPolicy,now:number,maxAgeMs:number){
  assertReadable(actor,schedule,policy,now,maxAgeMs);assertFreshActor(actor,policy,now,maxAgeMs);
}
