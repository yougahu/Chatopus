import {Store} from '../store.js';
import {ScheduledTaskService} from '../scheduled-tasks/service.js';
import {DeliveryService,deliveryParts,deliveryClosed} from '../delivery-resolution.js';
import {readPrivateSettings,savePrivateSettings} from './private-chat-config.js';
import { createServer, type Server } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync, readdirSync, statSync, mkdirSync, realpathSync } from 'node:fs';
import { readSessionTail } from './session-tail.js';
import { readThreadTokenUsage } from './token-usage.js';
import { join, dirname, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Config } from '../config.js';
import { loadConfig,safeConfig } from '../config.js';
import { saveModelSettings } from './model-config.js';
import { saveActivationSettings } from './activation-config.js';
import { BusinessConfigError, readBusinessSettings, saveBusinessSettings, businessHistory, rollbackBusinessSettings, previewBusinessSettings } from './business-config.js';
import { AdminMemoryApi, AdminMemoryError } from './memory.js';
import { AdminOpenVikingModel, OpenVikingModelError } from './openviking-model.js';
import { AdminSchedulesApi } from './schedules.js';
import { ScheduleError } from '../scheduled-tasks/types.js';
import { readOutgoingImage, MAX_OUTPUT_IMAGE_COUNT } from '../output-images.js';
import type { OutgoingImage } from '../types.js';

export function redactAudit(value:unknown,secrets:string[]=[]):unknown {
  if(typeof value==='string'){
    let s=value.replace(/\b(?:sk-|Bearer\s+)[A-Za-z0-9_.-]+/gi,'[redacted]').replace(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/g,'[image attachment]');
    for(const secret of secrets)if(secret)s=s.replaceAll(secret,'[redacted]');return s.length>30_000?s.slice(0,30_000)+'… [truncated]':s;
  }
  if(Array.isArray(value))return value.map(v=>redactAudit(v,secrets));
  if(value&&typeof value==='object'){
    const image=(value as {type?:string}).type==='image';
    return Object.fromEntries(Object.entries(value).filter(([k])=>!['thinking','reasoning','reasoning_content'].includes(k)).map(([k,v])=>[k,image&&k==='data'?'[image attachment]':/^(api.?key|authorization|access.?token|password|secret)$/i.test(k)?'[redacted]':redactAudit(v,secrets)]));
  }
  return value;
}
function parseRows(rows:Record<string,unknown>[]):Record<string,unknown>[]{return rows.map(x=>({...x,...(typeof x.data==='string'?{data:JSON.parse(x.data)}:{})}));}
function within(root:string,file:string){const rel=relative(realpathSync(root),realpathSync(file));return rel!== '..'&&!rel.startsWith('../')&&!isAbsolute(rel);}

export class AdminServer {
  private server?:Server;
  private origins=new Set<string>();
  private readonly memory:AdminMemoryApi;
  private readonly memoryModel:AdminOpenVikingModel;
  private readonly schedules:AdminSchedulesApi;
  constructor(readonly config:Config,private port=8092){
    mkdirSync(config.stateDir,{recursive:true,mode:0o700});
    this.memory=new AdminMemoryApi(config);
    this.memoryModel=new AdminOpenVikingModel(config);
    this.schedules=new AdminSchedulesApi(config);
  }
  sources(){
    const result=[{id:'main',label:'当前服务',dir:this.config.stateDir}];
    const ask=join(this.config.stateDir,'ask');
    if(existsSync(ask))for(const name of readdirSync(ask).sort().reverse().slice(0,30)){
      const dir=join(ask,name);if(existsSync(join(dir,'state.sqlite'))&&within(this.config.stateDir,dir))result.push({id:'ask-'+name,label:'终端验证 '+new Date(Number(name)).toLocaleString('zh-CN'),dir});
    }
    return result;
  }
  private async image(url:URL){
    const match=/^\/api\/outbox\/([^/]+)\/images\/(\d+)$/.exec(url.pathname);
    if(!match)throw new Error('Image not found');
    const id=decodeURIComponent(match[1]),index=Number(match[2]);
    if(!id||id.length>250||!Number.isInteger(index)||index<0||index>=MAX_OUTPUT_IMAGE_COUNT)throw new Error('Image not found');
    const source=this.sources().find(x=>x.id===(url.searchParams.get('source')??'main'));
    if(!source)throw new Error('Image not found');
    const db=new DatabaseSync(join(source.dir,'state.sqlite'),{readOnly:true});
    let image:OutgoingImage|undefined;
    try{
      const row=db.prepare('SELECT data FROM outbox WHERE id=?').get(id);
      if(row)image=JSON.parse(String(row.data)).message?.attachments?.[index];
    }finally{db.close();}
    if(!image)throw new Error('Image not found');
    const data=await readOutgoingImage(image,join(source.dir,'workspaces'));
    return {image,data,index};
  }
  private data(url:URL){
    if(url.pathname==='/api/config'){
      let current=this.config;try{current=loadConfig(this.config.root,{stateDir:this.config.stateDir});}catch{}
      return {...safeConfig(current),privateChatStatus:readPrivateSettings(this.config)};
    }
    if(url.pathname==='/api/sources')return this.sources().map(({id,label})=>({id,label}));
    const source=this.sources().find(x=>x.id===(url.searchParams.get('source')??'main'));if(!source)throw new Error('Unknown source');
    const traceRoot=join(source.dir,'dsh/sessions');
    if(url.pathname==='/api/sessions'){
      const found:{id:string;updated:number;bytes:number}[]=[];
      if(existsSync(traceRoot))for(const workspace of readdirSync(traceRoot,{withFileTypes:true})){
        if(!workspace.isDirectory())continue;
        const dir=join(traceRoot,workspace.name);if(!within(traceRoot,dir))continue;
        for(const session of readdirSync(dir,{withFileTypes:true})){
          const file=join(dir,session.name,'session.v4.jsonl');
          if(session.isDirectory()&&existsSync(file)&&within(traceRoot,file)){const stat=statSync(file);found.push({id:session.name,updated:stat.mtimeMs,bytes:stat.size});}
        }
      }
      return found.sort((a,b)=>b.updated-a.updated).slice(0,150);
    }
    if(url.pathname.startsWith('/api/sessions/')){
      const id=decodeURIComponent(url.pathname.slice('/api/sessions/'.length));if(!/^[a-zA-Z0-9_-]{1,180}$/.test(id))throw new Error('Invalid session id');
      if(existsSync(traceRoot))for(const workspace of readdirSync(traceRoot,{withFileTypes:true})){
        if(!workspace.isDirectory())continue;const file=join(traceRoot,workspace.name,id,'session.v4.jsonl');
        if(existsSync(file)&&within(traceRoot,file)){
          const tail=readSessionTail(file);
          const visible=tail.events.filter(x=>!['system/message','agent/inbox/spliced','step/start','step/end'].includes(x.type));
          const events=visible.slice(-300).map(x=>{
            const message=x.data?.message??x.data;
            if(Array.isArray(message?.content))message.content=message.content.filter((b:{type:string})=>!['thinking','reasoning'].includes(b.type));
            // The safe checkpoint is sufficient for audit; raw summarizer output can include reasoning.
            if(x.type==='compaction/summary'&&x.data){
              delete x.data.rawOutput;
              if(Array.isArray(x.data.summary))x.data.summary=x.data.summary.filter((b:{type:string})=>b.type==='text');
            }
            if(x.data?.stream)delete x.data.stream;return x;
          });
          if(tail.truncated||tail.skipped||visible.length>300)events.unshift({type:'audit/preview',data:{note:'仅展示最近的完整记录，完整日志保留在磁盘。',bytes:tail.bytes,skipped:tail.skipped}});
          return events;
        }
      }
      throw new Error('Session not found');
    }
    const file=join(source.dir,'state.sqlite');
    if(!existsSync(file))return url.pathname==='/api/overview'?{messages:0,threads:[],outbox:[],metrics:[],errors:[],running:false}:[];
    const db=new DatabaseSync(file,{readOnly:true});
    try{
      if(url.pathname==='/api/overview'){
        let running=false;const lock=join(source.dir,'instance.lock');
        if(existsSync(lock))try{const owner=JSON.parse(readFileSync(lock,'utf8'));process.kill(owner.pid,0);running=true;}catch{}
        const hasRouterBudget=db.prepare('PRAGMA table_info(router_turns)').all().some(column=>column.name==='deadline_at');
        const router=hasRouterBudget?{turns:db.prepare('SELECT id,room,state,attempts,model_calls,summary_calls,rebuilds,deadline_at,created_at,updated_at,error FROM router_turns ORDER BY updated_at DESC LIMIT 30').all(),
          waiting:db.prepare("SELECT count(*) AS count,MIN(received_at) AS oldestAt FROM messages WHERE status IN ('pending','processing')").get(),
          calls:parseRows(db.prepare("SELECT * FROM telemetry WHERE kind='router_model_call' ORDER BY id DESC LIMIT 200").all())}:undefined;
        return {router,running,messages:db.prepare('SELECT count(*) AS n FROM messages').get()?.n,
          threads:db.prepare('SELECT status,count(*) AS n FROM threads GROUP BY status').all(),outbox:db.prepare('SELECT status,count(*) AS n FROM outbox GROUP BY status').all(),
          metrics:parseRows(db.prepare("SELECT * FROM telemetry WHERE kind='model' ORDER BY id DESC LIMIT 300").all()),
          // Acquisition fallback failures remain in the thread audit; only the final model input failure is an alert.
          errors:parseRows(db.prepare("SELECT * FROM telemetry WHERE kind NOT IN ('model','model_call','image_receive','image_input','domain_tool','router_context_lifecycle','router_model_call','scheduled_task','input_committed','run_started','run_supersede_requested','run_superseded','handoff_reply_queued','delivery_attempt_started','delivery_attempt_settled') OR (kind='delivery_attempt_settled' AND json_extract(data,'$.status') IN ('failed','unknown')) OR (kind='scheduled_task' AND (json_extract(data,'$.data.status')='failed' OR json_extract(data,'$.event') IN ('failed','blocked'))) OR (kind='router_model_call' AND json_extract(data,'$.code') IS NOT NULL) OR (kind='image_input' AND json_extract(data,'$.status')='failed') ORDER BY id DESC LIMIT 30").all())};
      }
      const offset=Math.max(0,Math.min(1_000_000,Number(url.searchParams.get('offset'))||0));
      const room=url.searchParams.get('room')??'';const status=url.searchParams.get('status')??'';
      const kind=url.searchParams.get('kind'),kindFilter=kind==='private'?" AND room GLOB 'qq:*:private:*'":kind==='group'?" AND room GLOB 'qq:*:*' AND room NOT GLOB 'qq:*:private:*'":'';
      if(url.pathname==='/api/threads'){
        const limit=Math.max(1,Math.min(100,Math.floor(Number(url.searchParams.get('limit'))||100)));
        const threads=parseRows(db.prepare('SELECT * FROM threads WHERE (?=\'\' OR room=?) AND (?=\'\' OR status=?) '+kindFilter+' ORDER BY updated DESC LIMIT ? OFFSET ?').all(room,room,status,status,limit,offset));
        const usage=readThreadTokenUsage(db,threads.map(thread=>String(thread.id)));
        return threads.map(thread=>({...thread,tokenUsage:usage.get(String(thread.id))}));
      }
      if(url.pathname==='/api/messages')return parseRows(db.prepare('SELECT * FROM messages WHERE (?=\'\' OR room=?) AND (?=\'\' OR status=?) '+kindFilter+' ORDER BY rowid DESC LIMIT 100 OFFSET ?').all(room,room,status,status,offset));
      if(url.pathname==='/api/decisions')return parseRows(db.prepare('SELECT * FROM decisions ORDER BY rowid DESC LIMIT 100 OFFSET ?').all(offset));
      if(url.pathname==='/api/outbox')return parseRows(db.prepare('SELECT * FROM outbox WHERE (?=\'\' OR status=?) AND (?=\'\' OR room=?) '+kindFilter+' ORDER BY rowid DESC LIMIT 100 OFFSET ?').all(status,status,room,room,offset)).map(row=>({...row,deliveryParts:deliveryParts(row.data as any),deliveryClosed:deliveryClosed(row.data as any),deliveryEvents:parseRows(db.prepare("SELECT * FROM telemetry WHERE kind IN ('delivery_attempt_started','delivery_attempt_settled') AND json_extract(data,'$.outboxId')=? ORDER BY id DESC LIMIT 100").all(String(row.id))).reverse()}));
      if(url.pathname.startsWith('/api/threads/')){
        const id=decodeURIComponent(url.pathname.slice('/api/threads/'.length));
        return {thread:parseRows(db.prepare('SELECT * FROM threads WHERE id=?').all(id))[0],
          tokenUsage:readThreadTokenUsage(db,[id],true).get(id),
          workerSessionIds:[...new Set(db.prepare("SELECT json_extract(data,'$.sessionId') AS session FROM telemetry WHERE kind='model' AND json_extract(data,'$.threadId')=? AND json_extract(data,'$.role')='worker' ORDER BY id DESC").all(id).map(row=>row.session).filter(value=>typeof value==='string'))],
          inputs:parseRows(db.prepare('SELECT * FROM inputs WHERE thread_id=? ORDER BY seq').all(id)),
          runs:parseRows(db.prepare('SELECT * FROM runs WHERE thread_id=? ORDER BY rowid').all(id)),
          results:parseRows(db.prepare('SELECT * FROM results WHERE thread_id=? ORDER BY rowid').all(id)),
          decisions:parseRows(db.prepare('SELECT d.* FROM decisions d JOIN inputs i ON d.message_id=i.message_id WHERE i.thread_id=? ORDER BY d.rowid').all(id)),
          imageEvents:parseRows(db.prepare("SELECT * FROM telemetry WHERE kind IN ('image_receive','image_input') AND json_extract(data,'$.threadId')=? ORDER BY id DESC LIMIT 200").all(id)).reverse(),
          domainEvents:parseRows(db.prepare("SELECT * FROM telemetry WHERE kind='domain_tool' AND json_extract(data,'$.threadId')=? ORDER BY id DESC LIMIT 200").all(id)).reverse(),
          domainSummary:db.prepare(`WITH calls AS (
            SELECT id,data,json_extract(data,'$.runId') AS runId,json_extract(data,'$.requestFingerprint') AS fingerprint,
              lag(json_extract(data,'$.status')) OVER (
                PARTITION BY json_extract(data,'$.runId'),json_extract(data,'$.revision'),json_extract(data,'$.tool'),json_extract(data,'$.requestFingerprint') ORDER BY id
              ) AS previousStatus
            FROM telemetry WHERE kind='domain_tool' AND json_extract(data,'$.threadId')=?
          ) SELECT json_extract(data,'$.tool') AS tool,json_extract(data,'$.category') AS category,
            count(*) AS calls,sum(json_extract(data,'$.status')='error') AS errors,sum(json_extract(data,'$.status')='partial') AS partial,
            sum(json_extract(data,'$.status')='empty') AS empty,sum(json_extract(data,'$.truncated')=1) AS truncated,
            sum(json_extract(data,'$.repeatedRequest')=1) AS repeated,sum(json_extract(data,'$.elapsedMs')) AS elapsedMs,
            sum(json_extract(data,'$.responseCharacters')) AS responseCharacters,
            sum((SELECT count(*) FROM json_each(CASE WHEN json_type(data,'$.items')='array' THEN json_extract(data,'$.items') ELSE '[]' END))) AS itemsTotal,
            sum((SELECT count(*) FROM json_each(CASE WHEN json_type(data,'$.items')='array' THEN json_extract(data,'$.items') ELSE '[]' END) AS item WHERE CASE WHEN item.type='object' THEN json_extract(item.value,'$.status') END='ok')) AS itemsOk,
            sum((SELECT count(*) FROM json_each(CASE WHEN json_type(data,'$.items')='array' THEN json_extract(data,'$.items') ELSE '[]' END) AS item WHERE CASE WHEN item.type='object' THEN json_extract(item.value,'$.status') END='error')) AS itemsErrors,
            sum((SELECT count(*) FROM json_each(CASE WHEN json_type(data,'$.items')='array' THEN json_extract(data,'$.items') ELSE '[]' END) AS item WHERE CASE WHEN item.type='object' THEN json_extract(item.value,'$.status') END='empty')) AS itemsEmpty,
            sum(CASE WHEN json_type(data,'$.runId')='text' AND length(trim(runId))>0
              AND json_type(data,'$.requestFingerprint')='text' AND length(trim(fingerprint))>0
              AND json_type(data,'$.revision')='integer' AND json_extract(data,'$.revision')>=1
              AND json_type(data,'$.tool')='text' AND length(trim(json_extract(data,'$.tool')))>0
              AND previousStatus IN ('error','partial') AND json_extract(data,'$.status')='ok' THEN 1 ELSE 0 END) AS recoveredRetries
            FROM calls GROUP BY tool,category ORDER BY calls DESC`).all(id),
          lifecycleEvents:parseRows(db.prepare("SELECT * FROM telemetry WHERE kind IN ('input_committed','run_started','run_supersede_requested','run_superseded','worker_cleanup_blocked','handoff_reply_queued','delivery_attempt_started','delivery_attempt_settled') AND json_extract(data,'$.threadId')=? ORDER BY id DESC LIMIT 200").all(id)).reverse(),
          outbox:parseRows(db.prepare("SELECT * FROM outbox WHERE json_extract(data,'$.threadId')=? OR json_extract(data,'$.associationThreadId')=? ORDER BY rowid").all(id,id))};
      }
      throw new Error('Unknown endpoint');
    }finally{db.close();}
  }
  private secrets(){
    const secrets=[this.config.apiKey,this.config.routerApiKey,this.config.workerApiKey,this.config.qq.accessToken,this.config.memoryApiKey??'',...this.memoryModel.secrets()];
    try{
      const current=loadConfig(this.config.root,{stateDir:this.config.stateDir});
      secrets.push(current.apiKey,current.routerApiKey,current.workerApiKey,current.qq.accessToken,current.memoryApiKey??'');
    }catch{ /* Keep the audit available while a local configuration edit is incomplete. */ }
    return secrets;
  }
  async start(){
    const assets=dirname(fileURLToPath(import.meta.url));
    this.server=createServer(async(req,res)=>{
      const origin=`http://${req.headers.host}`;
      res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
      res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data: blob:; frame-ancestors 'none'");
      if(!this.origins.has(origin)||(req.headers.origin&&!this.origins.has(req.headers.origin))){res.writeHead(403);res.end('Forbidden origin');return;}
      const url=new URL(req.url??'/',origin);
      if(url.pathname.startsWith('/api/')){
        if(url.pathname==='/api/config'&&req.method==='POST'){
          try{
            let value:unknown;
            {
              if(!String(req.headers['content-type']??'').startsWith('application/json')){res.writeHead(415);res.end();return;}
              let raw='';for await(const chunk of req){raw+=chunk.toString();if(Buffer.byteLength(raw)>64000)throw new Error('配置请求过大。');}
              value=savePrivateSettings(this.config,JSON.parse(raw));
            }
            res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(value));
          }catch(error){res.writeHead((error as {status?:number}).status??400,{'Content-Type':'application/json'});res.end(JSON.stringify({error:error instanceof Error?error.message:'私聊配置无效。'}));}return;
        }
        if(url.pathname==='/api/deliveries/resolve'){
          if(req.method!=='POST'){res.writeHead(405);res.end();return;}
          if(url.searchParams.get('source')&&url.searchParams.get('source')!=='main'){res.writeHead(403);res.end();return;}
          if(!String(req.headers['content-type']??'').startsWith('application/json')){res.writeHead(415);res.end();return;}
          let store:Store|undefined;
          try{
            let raw='';for await(const chunk of req){raw+=chunk.toString();if(Buffer.byteLength(raw)>16000)throw new Error('投递操作请求过大。');}
            const body=JSON.parse(raw);
            if(!body||Object.keys(body).some(k=>!['outboxId','decision','partIds','expectedResolutionVersion','key'].includes(k))||typeof body.outboxId!=='string'||!['received','abandon'].includes(body.decision)||!Number.isSafeInteger(body.expectedResolutionVersion)||body.expectedResolutionVersion<0||typeof body.key!=='string'||!body.key||body.key.length>200||body.partIds!==undefined&&(!Array.isArray(body.partIds)||body.partIds.length>5||body.partIds.some((p:unknown)=>typeof p!=='string')))throw new Error('投递操作字段无效。');
            store=new Store(join(this.config.stateDir,'state.sqlite'));const schedules=new ScheduledTaskService(store.db),deliveries=new DeliveryService(store,schedules,join(this.config.stateDir,'workspaces'));
            schedules.deliveryOutstanding=id=>deliveries.outstanding(id);
            const value=deliveries.resolve({kind:'admin',id:'local-admin'},body);
            res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(value));
          }catch(error){res.writeHead(409,{'Content-Type':'application/json'});res.end(JSON.stringify({error:error instanceof Error?error.message:'投递结案失败。'}));}finally{store?.close();}return;
        }
        if(this.schedules.handles(url.pathname)){
          if(!['GET','POST'].includes(req.method??'')){res.writeHead(405);res.end();return;}
          if(req.method==='POST'&&!String(req.headers['content-type']??'').startsWith('application/json')){res.writeHead(415);res.end();return;}
          try{
            let input:unknown;
            if(req.method==='POST'){let raw='';for await(const chunk of req){raw+=chunk.toString();if(Buffer.byteLength(raw)>64_000)throw new ScheduleError('REQUEST_TOO_LARGE','任务请求过大。',413);}input=JSON.parse(raw);}
            const result=this.schedules.handle(req.method!,url,input);
            res.writeHead(result.status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(redactAudit(result.value,this.secrets())));
          }catch(error){
            const known=error instanceof ScheduleError;
            res.writeHead(known?error.status:error instanceof SyntaxError?400:503,{'Content-Type':'application/json; charset=utf-8'});
            res.end(JSON.stringify({error:known?redactAudit(error.message,this.secrets()):error instanceof SyntaxError?'任务 JSON 无效。':'任务服务暂时不可用，请刷新后重试。',...(known?{code:error.code,details:redactAudit(error.details,this.secrets())}:{})}));
          }
          return;
        }
        if(url.pathname === '/api/business-config' || url.pathname.startsWith('/api/business-config/')) {
          try {
            const path = url.pathname.slice('/api/business-config'.length);
            let value: unknown;
            if(req.method === 'GET' && path === '') value = readBusinessSettings(this.config.root);
            else if(req.method === 'GET' && path === '/history') value = businessHistory(this.config.stateDir);
            else if(req.method === 'POST' && ['', '/rollback', '/preview'].includes(path)) {
              if(!String(req.headers['content-type'] ?? '').startsWith('application/json')) { res.writeHead(415); res.end(); return; }
              let raw = ''; for await(const chunk of req) { raw += chunk.toString(); if(Buffer.byteLength(raw) > 300000) throw new BusinessConfigError('业务配置请求过大。'); }
              const input = JSON.parse(raw);
              value = path === '/rollback' ? rollbackBusinessSettings(this.config.root, this.config.stateDir, input)
                : path === '/preview' ? previewBusinessSettings(this.config.root, input)
                : saveBusinessSettings(this.config.root, this.config.stateDir, input);
            } else { res.writeHead(405); res.end(); return; }
            res.writeHead(200, {'Content-Type':'application/json; charset=utf-8'});
            res.end(JSON.stringify(redactAudit(value, this.secrets())));
          } catch(error) {
            res.writeHead(error instanceof BusinessConfigError ? error.status : 400, {'Content-Type':'application/json; charset=utf-8'});
            res.end(JSON.stringify({error: error instanceof SyntaxError ? '业务配置 JSON 无效。' : redactAudit(error instanceof Error ? error.message : String(error), this.secrets())}));
          }
          return;
        }

        if(url.pathname==='/api/activation-config'){
          if(req.method!=='POST'){res.writeHead(405);res.end();return;}
          if(!String(req.headers['content-type']??'').startsWith('application/json')){res.writeHead(415);res.end();return;}
          try{
            let raw='';for await(const chunk of req){raw+=chunk.toString();if(Buffer.byteLength(raw)>16_000)throw new Error('唤起关键字请求过大。');}
            const config=saveActivationSettings(this.config.root,JSON.parse(raw));
            res.writeHead(200,{'Content-Type':'application/json; charset=utf-8'});
            res.end(JSON.stringify({saved:true,appliesTo:'bot-restart',config}));
          }catch(error){
            res.writeHead(400,{'Content-Type':'application/json; charset=utf-8'});
            res.end(JSON.stringify({error:error instanceof SyntaxError?'配置 JSON 无效，未保存。':redactAudit(error instanceof Error?error.message:String(error),this.secrets())}));
          }
          return;
        }
        if(url.pathname==='/api/openviking-model-config'||url.pathname==='/api/openviking-model-config/apply'){
          const apply=url.pathname.endsWith('/apply');
          if(req.method!=='POST'&&(req.method!=='GET'||apply)){res.writeHead(405);res.end();return;}
          if(req.method==='POST'&&!String(req.headers['content-type']??'').startsWith('application/json')){res.writeHead(415);res.end();return;}
          try{
            let result;
            if(req.method==='GET')result=await this.memoryModel.read();
            else{
              let raw='';for await(const chunk of req){raw+=chunk.toString();if(Buffer.byteLength(raw)>16_000)throw new OpenVikingModelError(400,'模型配置请求过大。');}
              const input=JSON.parse(raw);result=apply?await this.memoryModel.apply(input):await this.memoryModel.save(input);
            }
            // This is a white-listed settings view. Preserve the thinking setting, which audit redaction omits.
            const secrets=this.secrets();
            res.writeHead(200,{'Content-Type':'application/json; charset=utf-8'});
            res.end(JSON.stringify(result,(_key,value)=>typeof value==='string'?redactAudit(value,secrets):value));
          }catch(error){
            res.writeHead(error instanceof OpenVikingModelError?error.status:error instanceof SyntaxError?400:503,{'Content-Type':'application/json; charset=utf-8'});
            res.end(JSON.stringify({error:error instanceof OpenVikingModelError?error.message:error instanceof SyntaxError?'模型配置 JSON 无效。':'记忆模型配置操作失败，请刷新后重试。'}));
          }
          return;
        }
        if(req.method==='POST'&&url.pathname==='/api/model-config'){
          if(!String(req.headers['content-type']??'').startsWith('application/json')){res.writeHead(415);res.end();return;}
          try{
            let raw='';for await(const chunk of req){raw+=chunk.toString();if(Buffer.byteLength(raw)>16_000)throw new Error('Configuration request too large');}
            const updated=saveModelSettings(this.config.root,JSON.parse(raw));
            res.writeHead(200,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify({saved:true,appliesTo:'new-calls',config:updated}));
          }catch(e){res.writeHead(400,{'Content-Type':'application/json'});res.end(JSON.stringify({error:e instanceof SyntaxError?'Invalid JSON configuration':redactAudit(String(e),this.secrets())}));}return;
        }
        if(req.method!=='GET'){res.writeHead(405);res.end();return;}
        if(url.pathname==='/api/memory'||url.pathname.startsWith('/api/memory/')){
          try{
            const value=await this.memory.data(url);
            const body=JSON.stringify(redactAudit(value,this.secrets()));
            res.writeHead(200,{'Content-Type':'application/json; charset=utf-8'});res.end(body);
          }catch(e){
            const status=e instanceof AdminMemoryError?e.status:503;
            const message=e instanceof AdminMemoryError?e.message:'记忆服务暂时不可用，请稍后重试。';
            res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify({error:redactAudit(message,this.secrets())}));
          }
          return;
        }
        if(url.pathname.startsWith('/api/outbox/')){
          try{
            const {image,data,index}=await this.image(url);
            res.writeHead(200,{'Content-Type':image.mimeType,'Content-Length':data.length,
              'Content-Disposition':`inline; filename="reply-image-${index+1}.${image.mimeType.split('/')[1]}"`});res.end(data);
          }catch{res.writeHead(404,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'图片不存在或已不可用。'}));}
          return;
        }
        try{const value=this.data(url);res.writeHead(200,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(redactAudit(value,this.secrets())));}
        catch(e){res.writeHead(400,{'Content-Type':'application/json'});res.end(JSON.stringify({error:redactAudit(String(e),this.secrets())}));}return;
      }
      if(req.method!=='GET'){res.writeHead(405);res.end();return;}
      const files:Record<string,[string,string]>={'/':['index.html','text/html; charset=utf-8'],'/app.js':['app.js','text/javascript; charset=utf-8'],'/style.css':['style.css','text/css; charset=utf-8']};
      const file=files[url.pathname];if(!file){res.writeHead(404);res.end();return;}
      res.writeHead(200,{'Content-Type':file[1]});res.end(readFileSync(join(assets,file[0])));
    });
    await new Promise<void>((resolve,reject)=>{this.server!.once('error',reject);this.server!.listen(this.port,'127.0.0.1',()=>resolve());});
    const port=(this.server.address() as {port:number}).port;this.origins.add(`http://127.0.0.1:${port}`);this.origins.add(`http://localhost:${port}`);
    return `http://127.0.0.1:${port}`;
  }
  async close(){if(this.server)await new Promise<void>((resolve,reject)=>this.server!.close(e=>e?reject(e):resolve()));}
}
