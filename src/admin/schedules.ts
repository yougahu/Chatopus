import {PrivateChatAccess} from '../private-chat.js';
import {DeliveryService} from '../delivery-resolution.js';
import {AttachmentService} from '../attachments.js';
import {isPrivateRoom} from '../conversation.js';
import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { reloadAgentConfig, type Config } from '../config.js';
import { resolveBusinessProfile } from '../business-config.js';
import { Store } from '../store.js';
import { ScheduledTaskService } from '../scheduled-tasks/service.js';
import { resolveLocalTime } from '../scheduled-tasks/schedule-spec.js';
import { ScheduleError, type ScheduleCommandOp, type ScheduleInput, type ScheduleQuery, type ScheduleSpec } from '../scheduled-tasks/types.js';
import { readThreadTokenUsage } from './token-usage.js';

const admin = {kind:'admin' as const,id:'local-admin'};
function object(input:unknown):Record<string,unknown>{
  if(!input||typeof input!=='object'||Array.isArray(input))throw new ScheduleError('INVALID_REQUEST','请求必须为 JSON 对象。');
  return input as Record<string,unknown>;
}
function integer(value:unknown,name:string,min=0,max=1_000_000):number{
  const n=typeof value==='string'&&/^\d+$/.test(value)?Number(value):value;
  if(!Number.isSafeInteger(n)||(n as number)<min||(n as number)>max)throw new ScheduleError('INVALID_REQUEST',`${name} 无效。`);
  return n as number;
}
function key(input:Record<string,unknown>):string{
  if(typeof input.idempotencyKey!=='string'||!input.idempotencyKey.trim()||input.idempotencyKey.length>200)throw new ScheduleError('INVALID_REQUEST','操作标识缺失，请刷新后重试。');
  return 'admin:'+input.idempotencyKey;
}
function only(input:Record<string,unknown>,keys:string[]){if(Object.keys(input).some(k=>!keys.includes(k)))throw new ScheduleError('INVALID_REQUEST','请求包含不支持的字段。');}
const inputFields=['deliveryMode','roomId','title','executionKind','content','recipientIds','scheduleSpec','timezone','misfirePolicy','expiresAt','maxRuns','catchUpWindowMs','timeoutMs','requiredCapabilityIds','businessProfileId','attachmentIds'];
function fileSelection(store:Store,config:Config,input:Record<string,unknown>,roomId:string){
  const {attachmentIds,...rest}=input;if(attachmentIds===undefined)return rest;
  if(!Array.isArray(attachmentIds)||attachmentIds.length>4||new Set(attachmentIds).size!==attachmentIds.length||attachmentIds.some(id=>typeof id!=='string'))throw new ScheduleError('INVALID_ATTACHMENTS','最多选择四个附件。');
  if(attachmentIds.length&&!isPrivateRoom(roomId))throw new ScheduleError('INVALID_ATTACHMENTS','文件绑定仅支持私聊。');
  const messages=store.db.prepare('SELECT data FROM messages WHERE room=?').all(roomId).map(row=>JSON.parse(String(row.data)));
  const refs=attachmentIds.map(id=>{
    const source=messages.find(m=>m.attachments.some((a:any)=>a.attachmentId===id)),file=source?.attachments.find((a:any)=>a.attachmentId===id);
    if(!file?.sha256||!file.bytes)throw new ScheduleError('ATTACHMENT_UNAVAILABLE','文件尚未下载或已不可用，请在原会话重新上传并选择。');
    return {attachmentId:id,sourceInputId:source.id,name:file.name,bytes:file.bytes,sha256:file.sha256};
  });
  if(refs.length)new AttachmentService(config,store).validateCachedRefs(roomId,refs);
  return {...rest,attachmentRefs:refs};
}
function normalizedSpec(value:unknown,timezone:string):ScheduleSpec{
  const spec={...object(value)};
  const field=spec.kind==='once'?'at':spec.kind==='interval'?'anchorAt':undefined;
  if(field&&typeof spec[field]==='string')spec[field]=resolveLocalTime(spec[field],timezone);
  return spec as unknown as ScheduleSpec;
}
function normalizedInput(input:Record<string,unknown>,defaultTimezone:string){
  const timezone=typeof input.timezone==='string'?input.timezone:defaultTimezone;
  return {...input,...(input.scheduleSpec?{scheduleSpec:normalizedSpec(input.scheduleSpec,timezone)}:{}),...(typeof input.expiresAt==='string'?{expiresAt:resolveLocalTime(input.expiresAt,timezone)}:{})};
}
export function scheduleServiceOnline(config:Config):boolean{
  try{const owner=JSON.parse(readFileSync(join(config.stateDir,'instance.lock'),'utf8'));if(owner.host!==hostname()||!Number.isInteger(owner.pid)||owner.pid<=0)return false;process.kill(owner.pid,0);return true;}catch{return false;}
}
/** A local admin actor can never be supplied through a model or request body. */
export class AdminSchedulesApi {
  constructor(private config:Config){}
  handles(path:string){return path==='/api/schedules'||path.startsWith('/api/schedules/')||path==='/api/schedule-permissions'||path.startsWith('/api/schedule-commands/');}
  handle(method:string,url:URL,input?:unknown):{status:number;value:unknown}{
    const source=url.searchParams.get('source')??'main';
    if(source!=='main'){
      if(method==='GET'&&url.pathname==='/api/schedules')return {status:200,value:{available:false,reason:'历史验证数据源仅供审计，不提供任务管理。',items:[],total:0,hasMore:false}};
      throw new ScheduleError('READ_ONLY_SOURCE','历史验证数据源不支持任务管理。',403);
    }
    // The first task-page visit can create the state file. Initialize the whole
    // host schema and its version guard, without starting runtime recovery.
    const store=new Store(join(this.config.stateDir,'state.sqlite')),db=store.db;
    try{
      const applied=db.prepare("SELECT data FROM telemetry WHERE kind='private_config_applied' ORDER BY id DESC LIMIT 1").get();
      const access=new PrivateChatAccess(this.config.qq.selfId,applied?JSON.parse(String(applied.data)).settings:this.config.qq.privateChat);
      const roomIds=[...this.config.qq.allowedGroupIds.map(id=>`qq:${this.config.qq.selfId}:${id}`),...access.rooms()];
      const service=new ScheduledTaskService(db,{...this.config.scheduledTasks,allowedRoomIds:roomIds});
      const deliveries=new DeliveryService(store,service,join(this.config.stateDir,'workspaces'));service.deliveryOutstanding=id=>deliveries.outstanding(id);
      service.validateExecution=schedule=>{
        if(isPrivateRoom(schedule.roomId)&&!access.allows(schedule.roomId))throw new ScheduleError('FORBIDDEN','private_access_denied',403);
        if(schedule.attachmentRefs?.length)new AttachmentService(this.config,store).validateCachedRefs(schedule.roomId,schedule.attachmentRefs);
      };
      const running=scheduleServiceOnline(this.config),enabled=this.config.scheduledTasks?.enabled===true;
      const metadata={running,enabled,allowedRoomIds:roomIds,defaultTimezone:this.config.scheduledTasks?.defaultTimezone??'Asia/Shanghai',minIntervalMs:Math.max(3_600_000,this.config.scheduledTasks?.minIntervalMs??0)};
      const path=url.pathname;
      if(path==='/api/schedule-permissions'){
        if(method==='GET')return {status:200,value:service.readPolicy()};
        if(method==='POST'){const body=object(input);only(body,['allowedRoleGroups','expectedVersion']);return {status:200,value:service.updatePolicy(admin,body.allowedRoleGroups as Array<'group_admin'|'member'>,integer(body.expectedVersion,'版本',1))};}
      }
      if(method==='GET'&&path==='/api/schedules'){
        const params=url.searchParams,query:ScheduleQuery={offset:integer(params.get('offset')??'0','偏移量'),limit:integer(params.get('limit')??'50','每页数量',1,100),includeEnded:params.get('includeEnded')==='true'};
        for(const field of ['roomId','ownerId','authority','status','q'] as const){const value=params.get(field)??(field==='roomId'?params.get('room'):null);if(value)(query as Record<string,unknown>)[field]=value;}
        const kind=params.get('kind');if(kind==='private'||kind==='group')query.conversationKind=kind;
        const page=service.list(admin,query);
        return {status:200,value:{...page,items:page.items.map(schedule=>({...schedule,lastRun:service.runs(admin,schedule.id,{limit:1}).items[0]??null})),...metadata,available:true}};
      }
      if(method==='POST'&&path==='/api/schedules/preview'){
        const body=object(input);only(body,['scheduleSpec','timezone']);
        const timezone=typeof body.timezone==='string'?body.timezone:metadata.defaultTimezone;
        return {status:200,value:{times:service.preview(normalizedSpec(body.scheduleSpec,timezone),timezone),timezone}};
      }
      if(method==='POST'&&path==='/api/schedules'){
        const body=object(input);only(body,['input','idempotencyKey']);const draft=object(body.input);only(draft,inputFields);
        const normalized={...normalizedInput(fileSelection(store,this.config,draft,String(draft.roomId)),metadata.defaultTimezone),businessProfileId:resolveBusinessProfile(reloadAgentConfig(this.config).config,typeof draft.roomId==='string'?draft.roomId:'').id};
        return {status:201,value:{schedule:service.create(admin,normalized as unknown as ScheduleInput,key(body)),...metadata,message:!enabled?'已保存；定时任务功能尚未启用。':!running?'已保存，等待机器人服务启动。':'已保存，等待计划时间执行。'}};
      }
      const commandMatch=/^\/api\/schedule-commands\/([^/]+)$/.exec(path);
      if(method==='GET'&&commandMatch)return {status:200,value:{command:service.getCommand(admin,decodeURIComponent(commandMatch[1])),...metadata}};
      const match=/^\/api\/schedules\/([^/]+)(?:\/(runs|update|commands))?$/.exec(path);
      if(match){
        const id=decodeURIComponent(match[1]),action=match[2];
        if(method==='GET'&&!action){
          const schedule=service.get(admin,id);
          const audits=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='telemetry'").get()?db.prepare("SELECT at,kind,data FROM telemetry WHERE kind LIKE 'schedule%' AND (json_extract(data,'$.scheduleId')=? OR json_extract(data,'$.id')=? OR json_extract(data,'$.data.scheduleId')=? OR json_extract(data,'$.data.id')=?) ORDER BY rowid DESC LIMIT 100").all(id,id,id,id).map(row=>({...row,data:JSON.parse(String(row.data))})):[];
          return {status:200,value:{schedule,...metadata,audits}};
        }
        if(method==='GET'&&action==='runs'){
          const result=service.runs(admin,id,{offset:integer(url.searchParams.get('offset')??'0','偏移量'),limit:integer(url.searchParams.get('limit')??'30','每页数量',1,100)});
          const hasResults=!!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='results'").get();
          const hasOutbox=!!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='outbox'").get();
          const hasUsage=['telemetry','runs'].every(name=>db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name));
          const usage=hasUsage?readThreadTokenUsage(db,result.items.flatMap(run=>run.threadId?[run.threadId]:[])):new Map();
          return {status:200,value:{...result,items:result.items.map(run=>({...run,result:hasResults&&run.resultId?(()=>{const row=db.prepare('SELECT data FROM results WHERE id=?').get(run.resultId);return row?JSON.parse(String(row.data)):undefined;})():undefined,tokenUsage:run.threadId?usage.get(run.threadId):undefined,outbox:hasOutbox?db.prepare("SELECT id,status,data FROM outbox WHERE (? IS NOT NULL AND id=?) OR json_extract(data,'$.scheduleRunId')=? ORDER BY rowid DESC LIMIT 10").all(run.outboxId??null,run.outboxId??null,run.id).map(row=>({...row,data:JSON.parse(String(row.data))})):[]}))}};
        }
        if(method==='POST'&&action==='update'){const body=object(input);only(body,['expectedVersion','patch','idempotencyKey']);const patch=object(body.patch);only(patch,inputFields);const timezone=service.get(admin,id).timezone;return {status:200,value:{schedule:service.update(admin,id,integer(body.expectedVersion,'版本',1),normalizedInput(fileSelection(store,this.config,patch,service.get(admin,id).roomId),timezone),key(body)),...metadata}};}
        if(method==='POST'&&action==='commands'){
          const body=object(input);only(body,['expectedVersion','op','runId','idempotencyKey']);
          if(!['pause','resume','cancel','run_now','stop_run','archive'].includes(String(body.op)))throw new ScheduleError('INVALID_REQUEST','不支持的任务操作。');
          if(body.runId!==undefined&&typeof body.runId!=='string')throw new ScheduleError('INVALID_REQUEST','执行标识无效。');
          const command=service.command(admin,id,body.op as ScheduleCommandOp,integer(body.expectedVersion,'版本',1),key(body),body.runId as string|undefined);
          return {status:command.status==='pending'?202:200,value:{command,...metadata,message:command.status==='pending'?(!enabled?'已请求；功能未启用，等待服务处理。':!running?'已请求，等待机器人服务启动。':'请求已入队，等待服务处理。'):'操作已保存。'}};
        }
      }
      throw new ScheduleError('METHOD_NOT_ALLOWED','不支持的任务接口或方法。',405);
    }finally{store.close();}
  }
}
