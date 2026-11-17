import {createHash,randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {z} from 'zod';
import {recipientIdsSchema} from '../message-recipients.js';
import {assertFreshActor,assertManageable,assertReadable} from './policy.js';
import {nextOccurrence,previewSchedule,scheduleSpecSchema,validateScheduleSpec} from './schedule-spec.js';
import {HOUR_MS,ScheduleError,type Schedule,type ScheduleActor,type ScheduleBinding,type ScheduleCommand,type ScheduleCommandOp,type ScheduleInput,type ScheduleMaterializer,type ScheduleMutation,type ScheduleOptions,type SchedulePage,type ScheduleQuery,type ScheduleRun,type ScheduleRunStatus,type ScheduleAccessPolicy,type ScheduleSpec} from './types.js';
export * from './types.js';
const inputSchema=z.strictObject({deliveryMode:z.enum(['room','local']).optional(),roomId:z.string().min(1).max(200),title:z.string().trim().min(1).max(200),executionKind:z.enum(['reminder','worker']),content:z.string().trim().min(1).max(12000),recipientIds:recipientIdsSchema.optional(),scheduleSpec:scheduleSpecSchema,
  timezone:z.string().min(1).max(100).optional(),misfirePolicy:z.enum(['coalesce_once','skip']).optional(),expiresAt:z.number().int().positive().optional(),maxRuns:z.number().int().min(1).max(100000).optional(),catchUpWindowMs:z.number().int().min(0).max(30*24*HOUR_MS).optional(),timeoutMs:z.number().int().min(1000).max(24*HOUR_MS).optional(),requiredCapabilityIds:z.array(z.string().min(1).max(200)).max(64).optional(),businessProfileId:z.string().min(1).max(200).optional()});
const clone=<T>(value:T):T=>structuredClone(value);
const canonical=(value:unknown):string=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))):item);
const decode=<T>(row:unknown):T=>JSON.parse((row as {data:string}).data);
const activeStatuses=new Set(['active','paused','blocked']);
let transactionSequence=0;
export class ScheduledTaskService {
  readonly options:Required<Omit<ScheduleOptions,'allowedRoomIds'>> & Pick<ScheduleOptions,'allowedRoomIds'>;
  constructor(readonly db:DatabaseSync,options:ScheduleOptions={}){
    this.options={now:Date.now,defaultTimezone:'Asia/Shanghai',minIntervalMs:HOUR_MS,maxPerOwner:20,maxPerRoom:100,maxSchedules:1000,failureThreshold:3,catchUpWindowMs:24*HOUR_MS,timeoutMs:HOUR_MS,commandTtlMs:300000,roleMaxAgeMs:300000,...options};
    if(this.options.minIntervalMs<HOUR_MS)throw new ScheduleError('FREQUENCY_LIMIT','周期任务最多每小时执行一次。');
    this.db.exec(`PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS schedules(id TEXT PRIMARY KEY,room_id TEXT NOT NULL,owner_id TEXT,authority TEXT NOT NULL CHECK(authority IN ('user','system')),status TEXT NOT NULL,next_run_at INTEGER,version INTEGER NOT NULL,data TEXT NOT NULL,CHECK((authority='user' AND owner_id IS NOT NULL) OR (authority='system' AND owner_id IS NULL)));
      CREATE INDEX IF NOT EXISTS schedules_due ON schedules(status,next_run_at);
      CREATE INDEX IF NOT EXISTS schedules_owner ON schedules(room_id,owner_id,status);
      CREATE TABLE IF NOT EXISTS schedule_runs(id TEXT PRIMARY KEY,schedule_id TEXT NOT NULL REFERENCES schedules(id),trigger_key TEXT NOT NULL UNIQUE,status TEXT NOT NULL,thread_id TEXT UNIQUE,created_at INTEGER NOT NULL,data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS schedule_runs_plan ON schedule_runs(schedule_id,created_at);
      CREATE TABLE IF NOT EXISTS schedule_commands(id TEXT PRIMARY KEY,idempotency_key TEXT NOT NULL UNIQUE,status TEXT NOT NULL,schedule_id TEXT,created_at INTEGER NOT NULL,data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS schedule_commands_status ON schedule_commands(status,created_at);
      CREATE TABLE IF NOT EXISTS schedule_access_policy(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS schedule_schema(version INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS telemetry(id INTEGER PRIMARY KEY AUTOINCREMENT,kind TEXT NOT NULL,at INTEGER NOT NULL,data TEXT NOT NULL);`);
    const initialized=this.db.prepare('SELECT version FROM schedule_schema LIMIT 1').get();
    if(!initialized){this.db.exec('BEGIN IMMEDIATE');try{this.db.prepare('INSERT OR IGNORE INTO schedule_access_policy VALUES(1,1,?)').run(JSON.stringify({allowedRoleGroups:['group_admin','member'],version:1,updatedAt:this.now(),updatedBy:'initialization'}));this.db.prepare('INSERT INTO schedule_schema VALUES(1)').run();this.db.exec('COMMIT');}catch(error){this.db.exec('ROLLBACK');throw error;}}
    this.readPolicy();
  }
  private now(){return this.options.now();}
  transaction<T>(fn:()=>T):T{
    const name='schedule_'+(++transactionSequence);this.db.exec(`SAVEPOINT ${name}`);
    try{this.db.prepare('UPDATE schedule_access_policy SET version=version WHERE id=1').run();const result=fn();this.db.exec(`RELEASE ${name}`);return result;}
    catch(error){this.db.exec(`ROLLBACK TO ${name}`);this.db.exec(`RELEASE ${name}`);throw error;}
  }
  private audit(event:string,data:unknown){this.db.prepare('INSERT INTO telemetry(kind,at,data) VALUES(?,?,?)').run('scheduled_task',this.now(),JSON.stringify({event,data}));}
  readPolicy():ScheduleAccessPolicy{
    const row=this.db.prepare('SELECT data FROM schedule_access_policy WHERE id=1').get();if(!row)throw new ScheduleError('POLICY_UNAVAILABLE','任务角色策略不可用。',503);
    try{return z.object({allowedRoleGroups:z.array(z.enum(['group_admin','member'])).max(2),version:z.number().int().positive(),updatedAt:z.number(),updatedBy:z.string()}).parse(decode(row));}catch{throw new ScheduleError('POLICY_UNAVAILABLE','任务角色策略不可用。',503);}
  }
  updatePolicy(actor:ScheduleActor,allowedRoleGroups:unknown,expectedVersion:number){
    if(actor.kind!=='admin')throw new ScheduleError('FORBIDDEN','只能在后台修改任务权限。',403);
    const parsed=z.array(z.enum(['group_admin','member'])).max(2).safeParse(allowedRoleGroups);if(!parsed.success||new Set(parsed.data).size!==parsed.data.length)throw new ScheduleError('INVALID_ROLES','角色组选项无效。');
    return this.transaction(()=>{const policy=this.readPolicy();this.version(policy.version,expectedVersion);const next={allowedRoleGroups:parsed.data,version:policy.version+1,updatedAt:this.now(),updatedBy:actor.id??'local-admin'};this.db.prepare('UPDATE schedule_access_policy SET version=?,data=? WHERE id=1').run(next.version,JSON.stringify(next));this.audit('policy_updated',next);return next;});
  }
  private version(actual:number,expected:number){if(!Number.isInteger(expected)||actual!==expected)throw new ScheduleError('VERSION_CONFLICT','任务或权限配置已被修改，请重新读取。',409,{actualVersion:actual});}
  private permittedRoom(roomId:string){if(this.options.allowedRoomIds&&!this.options.allowedRoomIds.includes(roomId))throw new ScheduleError('ROOM_NOT_ALLOWED','目标群不在允许列表中。',403);}
  private fresh(actor:ScheduleActor){assertFreshActor(actor,this.readPolicy(),this.now(),this.options.roleMaxAgeMs);if(actor.kind==='user')this.permittedRoom(actor.roomId);}
  private raw(id:string):Schedule{const row=this.db.prepare('SELECT data FROM schedules WHERE id=?').get(id);if(!row)throw new ScheduleError('NOT_FOUND','任务不存在或无权访问。',404);return decode(row);}
  get(actor:ScheduleActor,id:string):Schedule{const s=this.raw(id);assertReadable(actor,s,this.readPolicy(),this.now(),this.options.roleMaxAgeMs);return s;}
  canManage(actor:ScheduleActor,schedule:Schedule):boolean{try{this.manage(actor,schedule);return true;}catch{return false;}}
  private manage(actor:ScheduleActor,s:Schedule){assertManageable(actor,s,this.readPolicy(),this.now(),this.options.roleMaxAgeMs);if(actor.kind==='user')this.permittedRoom(actor.roomId);}
  private save(s:Schedule){s.updatedAt=this.now();this.db.prepare('INSERT INTO schedules VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,next_run_at=excluded.next_run_at,version=excluded.version,data=excluded.data').run(s.id,s.roomId,s.ownerId,s.authority,s.status,s.nextRunAt,s.version,JSON.stringify(s));}
  private bounds(query:{offset?:number;limit?:number}){const offset=query.offset??0,limit=query.limit??25;if(!Number.isInteger(offset)||offset<0||offset>100000||!Number.isInteger(limit)||limit<1||limit>100)throw new ScheduleError('INVALID_PAGE','分页参数无效。');return {offset,limit};}
  private page<T>(items:T[],query:{offset?:number;limit?:number}):SchedulePage<T>{const {offset,limit}=this.bounds(query),hasMore=offset+limit<items.length;return {items:items.slice(offset,offset+limit),total:items.length,hasMore,...(hasMore?{nextOffset:offset+limit}:{})};}
  list(actor:ScheduleActor,query:ScheduleQuery={}):SchedulePage<Schedule & {canManage:boolean}>{
    this.bounds(query);if(actor.kind==='user'&&query.scope==='room_users'){this.fresh(actor);if(actor.roleGroup!=='group_admin')throw new ScheduleError('FORBIDDEN','仅获准的群主或管理员可查询本群用户任务。',403);}
    const all=this.db.prepare('SELECT data FROM schedules ORDER BY rowid DESC').all().map(row=>decode<Schedule>(row));
    const items=all.filter(s=>{
      if(actor.kind==='user'&&(s.authority!=='user'||s.roomId!==actor.roomId||(query.scope!=='room_users'&&s.ownerId!==actor.memberId)))return false;
      if(query.roomId&&query.roomId!==s.roomId||query.ownerId&&query.ownerId!==s.ownerId||query.authority&&query.authority!==s.authority||query.status&&query.status!==s.status)return false;
      if(!query.includeEnded&&!query.status&&(!activeStatuses.has(s.status)||s.archivedAt))return false;
      if(query.q&&!`${s.id} ${s.title}`.toLowerCase().includes(query.q.toLowerCase()))return false;
      if(query.from!==undefined&&(s.nextRunAt===null||s.nextRunAt<query.from)||query.to!==undefined&&(s.nextRunAt===null||s.nextRunAt>query.to))return false;return true;
    }).map(s=>({...s,canManage:this.canManage(actor,s)}));return this.page(items,query);
  }
  runs(actor:ScheduleActor,id:string,query:{offset?:number;limit?:number}={}){this.get(actor,id);return this.page(this.db.prepare('SELECT data FROM schedule_runs WHERE schedule_id=? ORDER BY created_at DESC,rowid DESC').all(id).map(row=>decode<ScheduleRun>(row)),query);}
  preview(spec:unknown,timezone=this.options.defaultTimezone,after=this.now(),count=5){return previewSchedule(spec,timezone,after,count,this.options.minIntervalMs);}
  private input(value:unknown):ScheduleInput{
    const parsed=inputSchema.safeParse(value);if(!parsed.success)throw new ScheduleError('INVALID_INPUT','任务字段无效。',400,{issues:parsed.error.issues.map(x=>({path:x.path.join('.'),message:x.message}))});
    const input=parsed.data;if(input.recipientIds)input.recipientIds=[...new Set(input.recipientIds)];this.permittedRoom(input.roomId);validateScheduleSpec(input.scheduleSpec,input.timezone??this.options.defaultTimezone,this.options.minIntervalMs);return input;
  }
  private key(actor:ScheduleActor,key:string){if(typeof key!=='string'||!key.trim()||key.length>500)throw new ScheduleError('INVALID_IDEMPOTENCY_KEY','缺少有效的操作来源标识。');return createHash('sha256').update(JSON.stringify([actor.kind,actor.kind==='user'?actor.roomId:'',actor.kind==='user'?actor.memberId:actor.id??'local-admin',key])).digest('hex');}
  private saveCommand(c:ScheduleCommand){this.db.prepare('INSERT INTO schedule_commands VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,schedule_id=excluded.schedule_id,data=excluded.data').run(c.id,c.idempotencyKey,c.status,c.mutation.op==='create'?c.receipt?.scheduleId??null:c.mutation.id,c.createdAt,JSON.stringify(c));}
  private existing(actor:ScheduleActor,key:string){const row=this.db.prepare('SELECT data FROM schedule_commands WHERE idempotency_key=?').get(this.key(actor,key));return row?decode<ScheduleCommand>(row):undefined;}
  private makeCommand(actor:ScheduleActor,mutation:ScheduleMutation,key:string,status:ScheduleCommand['status']):ScheduleCommand{return {id:'sc-'+randomUUID(),idempotencyKey:this.key(actor,key),actor:clone(actor),mutation:clone(mutation),policyVersion:this.readPolicy().version,status,createdAt:this.now(),updatedAt:this.now()};}
  private assertDelivery(input:ScheduleInput,authority:'system'|'user'){if(input.deliveryMode==='local'&&(authority!=='system'||input.executionKind!=='worker'))throw new ScheduleError('INVALID_DELIVERY','仅系统 Worker 任务可只保存后台结果。');}
  private applyCreate(actor:ScheduleActor,value:ScheduleInput):Schedule{
    this.fresh(actor);const input=this.input(value);this.assertDelivery(input,actor.kind==='admin'?'system':'user');if(actor.kind==='user'&&input.roomId!==actor.roomId)throw new ScheduleError('FORBIDDEN','不能跨群登记任务。',403);
    const count=(sql:string,...args:(string|number)[])=>Number(this.db.prepare(sql).get(...args)?.n);
    if(count("SELECT count(*) n FROM schedules WHERE status IN ('active','paused','blocked')")>=this.options.maxSchedules)throw new ScheduleError('QUOTA','任务总量达到上限。',409);
    if(actor.kind==='user'&&(count("SELECT count(*) n FROM schedules WHERE authority='user' AND room_id=? AND owner_id=? AND status IN ('active','paused','blocked')",actor.roomId,actor.memberId)>=this.options.maxPerOwner||count("SELECT count(*) n FROM schedules WHERE authority='user' AND room_id=? AND status IN ('active','paused','blocked')",actor.roomId)>=this.options.maxPerRoom))throw new ScheduleError('QUOTA','用户或群任务数量达到上限。',409);
    const now=this.now(),timezone=input.timezone??this.options.defaultTimezone,nextRunAt=nextOccurrence(input.scheduleSpec,timezone,now);
    if(nextRunAt===null||input.expiresAt!==undefined&&input.expiresAt<nextRunAt)throw new ScheduleError('PAST_SCHEDULE','请指定结束时间之前的有效未来执行时间。');
    const s:Schedule={...input,id:'s-'+randomUUID(),authority:actor.kind==='admin'?'system':'user',ownerId:actor.kind==='user'?actor.memberId:null,registeredBy:actor.kind==='user'?actor.registeredBy:'admin',createdBy:actor.kind==='user'?actor.memberId:actor.id??'local-admin',sourceMessageIds:actor.kind==='user'?[...actor.sourceMessageIds]:[],timezone,misfirePolicy:input.misfirePolicy??'coalesce_once',catchUpWindowMs:input.catchUpWindowMs??this.options.catchUpWindowMs,timeoutMs:input.timeoutMs??this.options.timeoutMs,status:'active',version:1,generation:1,createdAt:now,updatedAt:now,nextRunAt,triggerCount:0,consecutiveFailures:0};this.save(s);this.audit('created',{id:s.id,authority:s.authority,actor});return s;
  }
  private applyUpdate(actor:ScheduleActor,id:string,expectedVersion:number,patch:Partial<ScheduleInput>):Schedule{
    const s=this.raw(id);this.manage(actor,s);this.version(s.version,expectedVersion);if(s.status==='cancelled'||s.archivedAt)throw new ScheduleError('ENDED','已取消任务不能编辑，请新建。',409);
    if(patch.roomId!==undefined&&patch.roomId!==s.roomId)throw new ScheduleError('IMMUTABLE_SCOPE','不能修改任务所属群。');
    const values:Record<string,unknown>={};for(const key of Object.keys(inputSchema.shape))if(key in s)values[key]=(s as unknown as Record<string,unknown>)[key];
    for(const [key,value]of Object.entries(patch)){if(!Object.hasOwn(inputSchema.shape,key))throw new ScheduleError('INVALID_INPUT','不可修改任务身份字段。');if(value===null)delete values[key];else if(value!==undefined)values[key]=value;}
    const input=this.input(values);this.assertDelivery(input,s.authority);const next=nextOccurrence(input.scheduleSpec,input.timezone??s.timezone,this.now());if(next===null||input.expiresAt!==undefined&&input.expiresAt<next)throw new ScheduleError('PAST_SCHEDULE','请指定结束时间之前的有效未来执行时间。');
    for(const key of Object.keys(inputSchema.shape))delete (s as unknown as Record<string,unknown>)[key];Object.assign(s,input);s.timezone=input.timezone??this.options.defaultTimezone;s.misfirePolicy=input.misfirePolicy??'coalesce_once';s.timeoutMs=input.timeoutMs??this.options.timeoutMs;s.catchUpWindowMs=input.catchUpWindowMs??this.options.catchUpWindowMs;
    s.version++;s.nextRunAt=next;if(s.status==='completed'){s.status='paused';s.stateReason='edited_completed';}this.cancelRuns(s.id,'superseded',true);this.save(s);this.audit('updated',{id,actor,version:s.version});return s;
  }
  create(actor:ScheduleActor,input:ScheduleInput,key:string){return this.transaction(()=>{const existing=this.existing(actor,key);if(existing?.receipt)return this.get(actor,existing.receipt.scheduleId);if(existing)throw new ScheduleError('COMMAND_STATE','该操作尚未提交或已拒绝。',409);const c=this.makeCommand(actor,{op:'create',input},key,'applied'),s=this.applyCreate(actor,input);c.receipt={scheduleId:s.id,version:s.version};this.saveCommand(c);return s;});}
  update(actor:ScheduleActor,id:string,expectedVersion:number,patch:Partial<ScheduleInput>,key:string){return this.transaction(()=>{const existing=this.existing(actor,key);if(existing?.receipt)return this.get(actor,existing.receipt.scheduleId);if(existing)throw new ScheduleError('COMMAND_STATE','该操作尚未提交或已拒绝。',409);const c=this.makeCommand(actor,{op:'update',id,expectedVersion,patch},key,'applied'),s=this.applyUpdate(actor,id,expectedVersion,patch);c.receipt={scheduleId:s.id,version:s.version};this.saveCommand(c);return s;});}
  private runRows(id:string){return this.db.prepare('SELECT data FROM schedule_runs WHERE schedule_id=? ORDER BY rowid').all(id).map(row=>decode<ScheduleRun>(row));}
  private outstanding(id:string){return this.runRows(id).filter(r=>['queued','running'].includes(r.status)||['pending','sending','unknown','deferred'].includes(r.deliveryStatus??''));}
  private cancelRuns(id:string,reason:string,queuedOnly=false){for(const r of this.runRows(id)){if(queuedOnly?r.status!=='queued':!this.outstanding(id).some(x=>x.id===r.id))continue;r.cancelRequestedAt=this.now();r.status='cancelled';r.reason=reason;r.finishedAt=this.now();if(r.deliveryStatus==='pending'||r.deliveryStatus==='deferred')r.deliveryStatus='stale';this.saveRun(r);}}
  private applyControl(actor:ScheduleActor,mutation:Exclude<ScheduleMutation,{op:'create'|'update'}>,command:ScheduleCommand){
    const s=this.raw(mutation.id);this.manage(actor,s);this.version(s.version,mutation.expectedVersion);const now=this.now();
    if(mutation.op==='run_now'){
      if(s.status==='cancelled'||s.archivedAt||s.scheduleSpec.kind==='once'&&s.status==='completed'||s.maxRuns!==undefined&&s.triggerCount>=s.maxRuns||s.expiresAt!==undefined&&now>s.expiresAt)throw new ScheduleError('ENDED','已结束任务不能再次执行，请新建或修改规则。',409);this.permittedRoom(s.roomId);if(s.status==='blocked')throw new ScheduleError('BLOCKED','任务受阻，请先处理原因并恢复。',409);
      if(s.scheduleSpec.kind!=='once'&&(s.nextEligibleAt??0)>now)throw new ScheduleError('FREQUENCY_LIMIT','周期任务最多每小时执行一次。',409,{nextEligibleAt:s.nextEligibleAt});
      if(this.outstanding(s.id).length||this.db.prepare("SELECT 1 FROM schedule_commands WHERE schedule_id=? AND status='pending' LIMIT 1").get(s.id))throw new ScheduleError('OVERLAP','已有执行或待执行命令。',409);
      command.status='pending';command.expiresAt=now+this.options.commandTtlMs;command.receipt={scheduleId:s.id,version:s.version};return;
    }
    if(mutation.op==='stop_run'){
      const run=mutation.runId?this.getRun(mutation.runId):this.outstanding(s.id)[0];if(!run||run.scheduleId!==s.id||!this.outstanding(s.id).some(active=>active.id===run.id))throw new ScheduleError('RUN_NOT_FOUND','没有可停止的执行。',404);
      run.cancelRequestedAt=now;run.status='cancelled';run.reason='stopped';run.finishedAt=now;if(run.deliveryStatus==='pending'||run.deliveryStatus==='deferred')run.deliveryStatus='stale';this.saveRun(run);command.receipt={scheduleId:s.id,version:s.version,runId:run.id};return;
    }
    if(mutation.op==='archive'){if(!['completed','cancelled'].includes(s.status))throw new ScheduleError('ACTIVE','请先取消尚未结束的计划。',409);s.archivedAt=now;}
    else if(mutation.op==='cancel'){s.status='cancelled';s.stateReason='cancelled';s.nextRunAt=null;s.generation++;this.cancelRuns(s.id,'plan_cancelled');this.rejectPlanCommands(s.id);}
    else if(mutation.op==='pause'){if(s.status==='cancelled')throw new ScheduleError('ENDED','已取消任务不能暂停。',409);s.status='paused';s.stateReason='manual';this.cancelRuns(s.id,'paused',true);}
    else if(mutation.op==='resume'){if(s.status==='cancelled'||s.archivedAt)throw new ScheduleError('ENDED','已取消任务不能恢复。',409);this.permittedRoom(s.roomId);const next=nextOccurrence(s.scheduleSpec,s.timezone,now);if(next===null||s.expiresAt!==undefined&&next>s.expiresAt||s.maxRuns!==undefined&&s.triggerCount>=s.maxRuns)throw new ScheduleError('PAST_SCHEDULE','任务已结束，请先修改规则。');s.status='active';delete s.stateReason;s.nextRunAt=next;s.consecutiveFailures=0;}
    s.version++;this.save(s);command.receipt={scheduleId:s.id,version:s.version};this.audit(mutation.op,{id:s.id,actor});
  }
  command(actor:ScheduleActor,id:string,op:ScheduleCommandOp,expectedVersion:number,key:string,runId?:string):ScheduleCommand{return this.transaction(()=>{const old=this.existing(actor,key);if(old)return this.getCommand(actor,old.id);if(!['pause','resume','cancel','run_now','stop_run','archive'].includes(op))throw new ScheduleError('INVALID_OPERATION','任务操作无效。');const c=this.makeCommand(actor,{op,id,expectedVersion,...(runId?{runId}:{})},key,'applied');this.applyControl(actor,c.mutation as Exclude<ScheduleMutation,{op:'create'|'update'}>,c);this.saveCommand(c);return c;});}
  getCommand(actor:ScheduleActor,id:string):ScheduleCommand{const row=this.db.prepare('SELECT data FROM schedule_commands WHERE id=?').get(id);if(!row)throw new ScheduleError('NOT_FOUND','操作不存在。',404);const c=decode<ScheduleCommand>(row);if(actor.kind==='user'&&(c.actor.kind!=='user'||c.actor.roomId!==actor.roomId||c.actor.memberId!==actor.memberId)){if(c.mutation.op==='create')throw new ScheduleError('NOT_FOUND','操作不存在或无权访问。',404);this.get(actor,c.mutation.id);}return c;}
  propose(actor:ScheduleActor,mutation:ScheduleMutation,binding:ScheduleBinding,key:string):ScheduleCommand{return this.transaction(()=>{this.fresh(actor);if(actor.kind!=='user')throw new ScheduleError('FORBIDDEN','后台不通过 Worker 提案登记。',403);const old=this.existing(actor,key);if(old){
      if(!old.binding||old.binding.threadId!==binding.threadId||old.binding.revision!==binding.revision)throw new ScheduleError('STALE_PROPOSAL','登记来源与原提案不匹配。',409);
      if(canonical(old.mutation)!==canonical(mutation))throw new ScheduleError('IDEMPOTENCY_CONFLICT','同一操作标识不能更换任务内容。',409);
      if(old.status==='applied')return old;
      if(old.status==='rejected'||old.error==='withdrawn')throw new ScheduleError('STALE_PROPOSAL','原提案已经拒绝。',409);
      if(old.binding.runId===binding.runId&&old.binding.epoch===binding.epoch&&old.status==='proposed')return old;
      old.binding=clone(binding);old.actor=clone(actor);old.policyVersion=this.readPolicy().version;old.mutation=clone(mutation);old.status='proposed';delete old.error;old.updatedAt=this.now();
      if(mutation.op==='create'){this.input(mutation.input);if(mutation.input.roomId!==actor.roomId)throw new ScheduleError('FORBIDDEN','不能跨群登记。',403);}else{const s=this.raw(mutation.id);this.manage(actor,s);this.version(s.version,mutation.expectedVersion);}
      this.saveCommand(old);return old;
    }if(mutation.op==='create'){this.input(mutation.input);if(mutation.input.roomId!==actor.roomId)throw new ScheduleError('FORBIDDEN','不能跨群登记。',403);}else{const s=this.raw(mutation.id);this.manage(actor,s);this.version(s.version,mutation.expectedVersion);}const c=this.makeCommand(actor,mutation,key,'proposed');c.binding=clone(binding);this.saveCommand(c);return c;});}
  commitProposals(actor:ScheduleActor,binding:ScheduleBinding,ids:string[]):ScheduleCommand[]{return this.transaction(()=>{if(ids.length>10||new Set(ids).size!==ids.length)throw new ScheduleError('INVALID_PROPOSALS','登记提案数量无效。');this.fresh(actor);return ids.map(id=>{const c=this.getCommand(actor,id);if(c.status==='applied'&&c.binding?.threadId===binding.threadId&&c.binding.revision===binding.revision)return c;if(!c.binding||c.binding.threadId!==binding.threadId||c.binding.runId!==binding.runId||c.binding.revision!==binding.revision||c.binding.epoch!==binding.epoch)throw new ScheduleError('STALE_PROPOSAL','登记提案已失效。',409);if(c.status==='applied')return c;if(c.status!=='proposed')throw new ScheduleError('STALE_PROPOSAL','登记提案已失效。',409);if(c.actor.kind!==actor.kind||c.actor.kind==='user'&&(actor.kind!=='user'||c.actor.memberId!==actor.memberId||c.actor.roomId!==actor.roomId))throw new ScheduleError('FORBIDDEN','登记来源不匹配。',403);c.actor=clone(actor);c.policyVersion=this.readPolicy().version;c.status='applied';c.updatedAt=this.now();if(c.mutation.op==='create'){const s=this.applyCreate(actor,c.mutation.input);c.receipt={scheduleId:s.id,version:s.version};}else if(c.mutation.op==='update'){const s=this.applyUpdate(actor,c.mutation.id,c.mutation.expectedVersion,c.mutation.patch);c.receipt={scheduleId:s.id,version:s.version};}else this.applyControl(actor,c.mutation,c);this.saveCommand(c);return c;});});}
  pendingProposals(actor:ScheduleActor){
    const rows=actor.kind==='admin'?this.db.prepare("SELECT data FROM schedule_commands WHERE status='proposed' ORDER BY created_at DESC").all():this.db.prepare("SELECT data FROM schedule_commands WHERE status='proposed' AND json_extract(data,'$.actor.kind')='user' AND json_extract(data,'$.actor.memberId')=? AND json_extract(data,'$.actor.roomId')=? ORDER BY created_at DESC").all(actor.memberId,actor.roomId);
    return rows.map(row=>decode<ScheduleCommand>(row));
  }
  rejectProposals(binding:ScheduleBinding,reason='superseded'){return this.transaction(()=>{for(const row of this.db.prepare("SELECT data FROM schedule_commands WHERE status='proposed' AND json_extract(data,'$.binding.threadId')=? AND json_extract(data,'$.binding.runId')=? AND json_extract(data,'$.binding.revision')=? AND json_extract(data,'$.binding.epoch')=?").all(binding.threadId,binding.runId,binding.revision,binding.epoch)){const c=decode<ScheduleCommand>(row);c.status='superseded';c.error=reason;c.updatedAt=this.now();this.saveCommand(c);}});}
  withdrawProposal(actor:ScheduleActor,id:string):ScheduleCommand{return this.transaction(()=>{
    const c=this.getCommand(actor,id);this.fresh(actor);
    if(actor.kind==='user'&&(c.actor.kind!=='user'||c.actor.roomId!==actor.roomId||c.actor.memberId!==actor.memberId)){if(c.actor.kind!=='user'||actor.roleGroup!=='group_admin')throw new ScheduleError('FORBIDDEN','不能撤销他人的登记提案。',403);}
    if(c.status==='superseded')return c;if(c.status!=='proposed')throw new ScheduleError('PROPOSAL_COMMITTED','该提案已提交或已拒绝，请通过计划管理操作处理。',409);
    c.status='superseded';c.error='withdrawn';c.updatedAt=this.now();this.saveCommand(c);this.audit('proposal_withdrawn',{id:c.id,actor});return c;
  });}
  invalidateProposals(isBindingCurrent:(binding:ScheduleBinding)=>boolean):number{return this.transaction(()=>{
    let count=0;for(const row of this.db.prepare("SELECT data FROM schedule_commands WHERE status='proposed'").all()){
      const c=decode<ScheduleCommand>(row);if(c.binding&&isBindingCurrent(c.binding))continue;c.status='superseded';c.error='stale_run';c.updatedAt=this.now();this.saveCommand(c);count++;
    }return count;
  });}
  private rejectPlanCommands(id:string){for(const row of this.db.prepare("SELECT data FROM schedule_commands WHERE schedule_id=? AND status IN ('pending','proposed')").all(id)){const c=decode<ScheduleCommand>(row);c.status='superseded';c.error='plan_cancelled';this.saveCommand(c);}}
  getRun(id:string):ScheduleRun|undefined{const row=this.db.prepare('SELECT data FROM schedule_runs WHERE id=?').get(id);return row?decode(row):undefined;}
  runForThread(id:string):ScheduleRun|undefined{const row=this.db.prepare('SELECT data FROM schedule_runs WHERE thread_id=?').get(id);return row?decode(row):undefined;}
  activeRuns():ScheduleRun[]{return this.db.prepare("SELECT data FROM schedule_runs WHERE status IN ('queued','running') OR json_extract(data,'$.deliveryStatus') IN ('pending','sending','unknown','deferred')").all().map(row=>decode(row));}
  private saveRun(r:ScheduleRun){this.db.prepare('INSERT INTO schedule_runs VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,thread_id=excluded.thread_id,data=excluded.data').run(r.id,r.scheduleId,r.triggerKey,r.status,r.threadId??null,r.createdAt,JSON.stringify(r));}
  private newRun(s:Schedule,at:number,trigger:'automatic'|'manual',key:string):ScheduleRun{const old=this.db.prepare('SELECT data FROM schedule_runs WHERE trigger_key=?').get(key);if(old)return decode(old);return {id:'sr-'+randomUUID(),scheduleId:s.id,scheduleVersion:s.version,generation:s.generation,triggerKey:key,trigger,scheduledAt:at,createdAt:this.now(),status:'queued',snapshot:clone(s)};}
  isRunValid(id:string){const run=this.getRun(id);if(!run||run.cancelRequestedAt||run.status==='cancelled'||run.status==='skipped')return false;const s=this.raw(run.scheduleId);if(s.status==='cancelled'||s.generation!==run.generation)return false;if(run.startedAt===undefined&&run.trigger!=='manual'&&(s.status!=='active'&&s.status!=='completed'||s.version!==run.scheduleVersion))return false;return true;}
  canPublish(id:string){return this.isRunValid(id);}
  startRun(id:string):boolean{return this.transaction(()=>{const r=this.getRun(id);if(!r||!['queued','running'].includes(r.status)||!this.isRunValid(id))return false;const s=this.raw(r.scheduleId),now=this.now();if(r.startedAt!==undefined){r.status='running';this.saveRun(r);return true;}
    let reason:string|undefined;if(s.expiresAt!==undefined&&now>s.expiresAt||r.trigger==='automatic'&&now-r.scheduledAt>s.catchUpWindowMs)reason='expired';else if(s.scheduleSpec.kind!=='once'&&(s.nextEligibleAt??0)>now)reason='frequency_limit';
    if(reason){r.status='skipped';r.reason=reason;r.finishedAt=now;this.saveRun(r);return false;}this.permittedRoom(s.roomId);r.status='running';r.startedAt=now;if(s.scheduleSpec.kind!=='once'){s.lastStartedAt=now;s.nextEligibleAt=now+this.options.minIntervalMs;this.save(s);}this.saveRun(r);return true;});}
  private materialize(r:ScheduleRun,s:Schedule,fn:ScheduleMaterializer){this.saveRun(r);if(s.executionKind==='reminder'&&!this.startRun(r.id))return;const current=this.getRun(r.id)!;const refs=fn(current,s);if(refs)Object.assign(current,refs);if(current.outboxId)current.deliveryStatus='pending';if(s.executionKind==='reminder'){current.status='succeeded';current.finishedAt=this.now();}this.saveRun(current);}
  dispatchDue(materialize:ScheduleMaterializer,now=this.now(),limit=50):ScheduleRun[]{
    const ids=this.db.prepare("SELECT id FROM schedules WHERE status='active' AND next_run_at<=? ORDER BY next_run_at LIMIT ?").all(now,limit).map(x=>String(x.id)),result:ScheduleRun[]=[];
    for(const id of ids)this.transaction(()=>{const s=this.raw(id);if(s.status!=='active'||s.nextRunAt===null||s.nextRunAt>now)return;
      const due=s.nextRunAt,key=`auto:${s.id}:${s.version}:${due}`,r=this.newRun(s,due,'automatic',key);if(this.getRun(r.id))return;
      let reason:string|undefined;const allowed=!this.options.allowedRoomIds||this.options.allowedRoomIds.includes(s.roomId);
      if(!allowed){s.status='blocked';s.stateReason='room_not_allowed';this.save(s);return;}
      if(s.expiresAt!==undefined&&now>s.expiresAt||s.maxRuns!==undefined&&s.triggerCount>=s.maxRuns)reason='ended';
      else if(now-due>s.catchUpWindowMs||s.misfirePolicy==='skip'&&now-due>60_000)reason='missed';
      else if(this.outstanding(s.id).length)reason='overlap';else if(s.scheduleSpec.kind!=='once'&&(s.nextEligibleAt??0)>now)reason='frequency_limit';
      s.triggerCount++;s.nextRunAt=nextOccurrence(s.scheduleSpec,s.timezone,Math.max(now,s.nextEligibleAt??0)-1);if(s.nextRunAt!==null&&s.nextRunAt<=now)s.nextRunAt=nextOccurrence(s.scheduleSpec,s.timezone,now);
      if(s.nextRunAt===null||reason==='ended'||s.expiresAt!==undefined&&s.nextRunAt>s.expiresAt||s.maxRuns!==undefined&&s.triggerCount>=s.maxRuns){s.status='completed';s.nextRunAt=null;}
      this.save(s);if(reason){r.status='skipped';r.reason=reason;r.finishedAt=now;this.saveRun(r);}else this.materialize(r,s,materialize);result.push(this.getRun(r.id)!);this.audit('triggered',{id:r.id,scheduleId:s.id,status:this.getRun(r.id)!.status});});return result;
  }
  dispatchCommands(materialize:ScheduleMaterializer,now=this.now()):ScheduleCommand[]{const result:ScheduleCommand[]=[];for(const row of this.db.prepare("SELECT data FROM schedule_commands WHERE status='pending' ORDER BY created_at LIMIT 50").all())this.transaction(()=>{const c=decode<ScheduleCommand>(row),fresh=this.getCommand({kind:'admin'},c.id);if(fresh.status!=='pending'||c.mutation.op!=='run_now')return;const mutation=c.mutation;
    try{this.transaction(()=>{if((c.expiresAt??0)<now)throw new ScheduleError('COMMAND_EXPIRED','立即执行请求已过期。');const s=this.raw(mutation.id);this.manage(c.actor,s);this.version(s.version,mutation.expectedVersion);if(s.status==='blocked')throw new ScheduleError('BLOCKED','任务受阻，请先处理原因并恢复。',409);if(s.status==='cancelled'||s.archivedAt||s.scheduleSpec.kind==='once'&&s.status==='completed'||s.maxRuns!==undefined&&s.triggerCount>=s.maxRuns||s.expiresAt!==undefined&&now>s.expiresAt)throw new ScheduleError('ENDED','计划已结束。');if(this.outstanding(s.id).length)throw new ScheduleError('OVERLAP','已有执行。');if(s.scheduleSpec.kind!=='once'&&(s.nextEligibleAt??0)>now)throw new ScheduleError('FREQUENCY_LIMIT','周期任务最多每小时执行一次。');const run=this.newRun(s,now,'manual','manual:'+c.id);s.triggerCount++;if(s.scheduleSpec.kind==='once'||s.maxRuns!==undefined&&s.triggerCount>=s.maxRuns){s.status='completed';s.nextRunAt=null;}this.save(s);this.materialize(run,s,materialize);c.status='applied';c.receipt={scheduleId:s.id,version:s.version,runId:run.id};});}
    catch(error){c.status='rejected';c.error=error instanceof ScheduleError?error.code:String(error);}c.updatedAt=now;this.saveCommand(c);result.push(c);});return result;}
  finishRun(id:string,status:Extract<ScheduleRunStatus,'succeeded'|'failed'|'needs_input'>,data:{resultId?:string;outboxId?:string;error?:string}={}):boolean{return this.transaction(()=>{if(!this.isRunValid(id))return false;const r=this.getRun(id)!;if(['succeeded','failed','needs_input'].includes(r.status)){Object.assign(r,data);if((data.resultId||data.outboxId)&&!r.deliveryStatus)r.deliveryStatus='pending';this.saveRun(r);return true;}r.status=status;r.finishedAt=this.now();Object.assign(r,data);if(data.resultId||data.outboxId)r.deliveryStatus='pending';this.saveRun(r);const s=this.raw(r.scheduleId);if(status==='failed'){s.consecutiveFailures++;if(s.consecutiveFailures>=this.options.failureThreshold){s.status='paused';s.stateReason='consecutive_failures';}}else if(status==='needs_input'){s.status='paused';s.stateReason='needs_input';}else s.consecutiveFailures=0;this.save(s);return true;});}
  recordDelivery(id:string,status:string){this.transaction(()=>{const r=this.getRun(id);if(!r)return;r.deliveryStatus=status;this.saveRun(r);if(status==='unknown'){const s=this.raw(r.scheduleId);if(s.status!=='cancelled'){s.status='blocked';s.stateReason='delivery_unknown';this.save(s);}}});}
  /** A local result has no platform delivery. Call only in the transaction that
   * stores its result, or after verifying that exact stored result on recovery. */
  completeLocalResult(id:string,resultId:string):boolean{return this.transaction(()=>{
    const r=this.getRun(id);
    if(!r||r.snapshot.deliveryMode!=='local'||r.snapshot.authority!=='system'||r.snapshot.executionKind!=='worker'
      ||!['succeeded','failed','needs_input'].includes(r.status)||r.resultId!==resultId||r.outboxId
      ||r.deliveryStatus!==undefined&&!['pending','stored'].includes(r.deliveryStatus))return false;
    if(r.deliveryStatus!=='stored'){r.deliveryStatus='stored';this.saveRun(r);this.audit('local_result_stored',{id,resultId});}
    return true;
  });}
  attachRun(id:string,refs:{threadId?:string;outboxId?:string;resultId?:string}){this.transaction(()=>{const r=this.getRun(id);if(!r)throw new ScheduleError('RUN_NOT_FOUND','执行不存在。',404);Object.assign(r,refs);if(refs.outboxId)r.deliveryStatus='pending';this.saveRun(r);});}
  recover(){this.transaction(()=>{for(const r of this.activeRuns()){if(!this.isRunValid(r.id)){r.status='cancelled';r.reason='recovery_invalid';r.finishedAt=this.now();}else if(r.status==='running')r.status='queued';if(r.deliveryStatus==='sending')r.deliveryStatus='unknown';this.saveRun(r);if(r.deliveryStatus==='unknown'){const s=this.raw(r.scheduleId);if(s.status!=='cancelled'){s.status='blocked';s.stateReason='delivery_unknown';this.save(s);}}}});}
  block(id:string,reason:string,options:{cancelRunning?:boolean}={}){this.transaction(()=>{const s=this.raw(id);if(s.status==='cancelled')return;s.status='blocked';s.stateReason=reason;if(options.cancelRunning){s.generation++;this.cancelRuns(id,reason);}else this.cancelRuns(id,reason,true);this.save(s);});}
  disable(){this.transaction(()=>{for(const row of this.db.prepare("SELECT data FROM schedules WHERE status IN ('active','blocked','paused','completed')").all()){const s=decode<Schedule>(row);if(s.status==='paused'&&s.stateReason==='feature_disabled'&&!this.outstanding(s.id).length)continue;if(s.status==='completed'&&!this.outstanding(s.id).length)continue;s.status='paused';s.stateReason='feature_disabled';s.generation++;this.cancelRuns(s.id,'feature_disabled');this.rejectPlanCommands(s.id);this.save(s);}});}
}
