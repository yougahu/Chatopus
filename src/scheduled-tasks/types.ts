export const HOUR_MS = 3_600_000;
export type ScheduleRoleGroup = 'group_admin' | 'member' | 'unknown';
export type ScheduleActor = {kind:'admin';id?:string} | {
  kind:'user'; roomId:string; memberId:string; roleGroup:ScheduleRoleGroup;
  accessKind?:'private';
  roleVerifiedAt:number; sourceMessageIds:string[]; registeredBy:'router'|'worker';
};
export type ScheduleSpec = {kind:'once';at:number} | {kind:'interval';anchorAt:number;intervalMs:number} | {kind:'cron';expression:string};
export interface ScheduleInput {
  attachmentRefs?:import('../attachments.js').AttachmentRef[];
  roomId:string; title:string; executionKind:'reminder'|'worker'; content:string;
  /** Optional members to mention on delivery; an empty array clears the list. */
  recipientIds?:string[];
  scheduleSpec:ScheduleSpec; timezone?:string; misfirePolicy?:'coalesce_once'|'skip';
  expiresAt?:number; maxRuns?:number; catchUpWindowMs?:number; timeoutMs?:number;
  requiredCapabilityIds?:string[]; businessProfileId?:string;
  deliveryMode?:'room'|'local';
}
export interface Schedule extends ScheduleInput {
  id:string;authority:'user'|'system';ownerId:string|null;registeredBy:'router'|'worker'|'admin';createdBy:string;
  sourceMessageIds:string[];timezone:string;misfirePolicy:'coalesce_once'|'skip';catchUpWindowMs:number;timeoutMs:number;
  status:'active'|'paused'|'blocked'|'completed'|'cancelled';stateReason?:string;archivedAt?:number;
  version:number;generation:number;createdAt:number;updatedAt:number;nextRunAt:number|null;
  lastStartedAt?:number;nextEligibleAt?:number;triggerCount:number;consecutiveFailures:number;
}
export type ScheduleRunStatus='queued'|'running'|'succeeded'|'failed'|'cancelled'|'skipped'|'needs_input';
export interface ScheduleRun {
  id:string;scheduleId:string;scheduleVersion:number;generation:number;triggerKey:string;
  trigger:'automatic'|'manual';scheduledAt:number;createdAt:number;startedAt?:number;finishedAt?:number;
  status:ScheduleRunStatus;reason?:string;snapshot:Schedule;threadId?:string;resultId?:string;outboxId?:string;
  deliveryExpiresAt?:number;
  deliveryStatus?:string;cancelRequestedAt?:number;error?:string;
}
export type ScheduleCommandOp='pause'|'resume'|'cancel'|'run_now'|'stop_run'|'archive';
export type ScheduleMutation = {op:'create';input:ScheduleInput} | {op:'update';id:string;expectedVersion:number;patch:Partial<ScheduleInput>} |
  {op:ScheduleCommandOp;id:string;expectedVersion:number;runId?:string};
export interface ScheduleBinding {threadId:string;runId:string;revision:number;epoch:number}
export interface ScheduleCommand {
  id:string;idempotencyKey:string;actor:ScheduleActor;mutation:ScheduleMutation;binding?:ScheduleBinding;policyVersion?:number;
  status:'proposed'|'pending'|'applied'|'rejected'|'superseded';createdAt:number;updatedAt:number;
  expiresAt?:number;receipt?:{scheduleId:string;version:number;runId?:string};error?:string;
}
export interface ScheduleAccessPolicy {allowedRoleGroups:Array<'group_admin'|'member'>;version:number;updatedAt:number;updatedBy:string}
export interface ScheduleQuery {conversationKind?:'private'|'group';scope?:'mine'|'room_users';roomId?:string;ownerId?:string;authority?:'user'|'system';status?:string;q?:string;offset?:number;limit?:number;includeEnded?:boolean;from?:number;to?:number}
export interface SchedulePage<T>{items:T[];total:number;hasMore:boolean;nextOffset?:number}
export interface ScheduleOptions {
  now?:()=>number;allowedRoomIds?:string[];canAccessRoom?:(roomId:string)=>boolean;defaultTimezone?:string;minIntervalMs?:number;
  maxPerOwner?:number;maxPerRoom?:number;maxSchedules?:number;failureThreshold?:number;
  catchUpWindowMs?:number;timeoutMs?:number;commandTtlMs?:number;roleMaxAgeMs?:number;
}
export type ScheduleMaterializer=(run:ScheduleRun,schedule:Schedule)=>{threadId?:string;outboxId?:string}|void;
export class ScheduleError extends Error {
  constructor(public code:string,message:string,public status=400,public details?:Record<string,unknown>){super(message);this.name='ScheduleError';}
}
