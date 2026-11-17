import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import type { Config } from '../config.js';
import { pauseOpenVikingPreparation } from '../memory/openviking-maintenance.js';

export class OpenVikingModelError extends Error {
  constructor(readonly status:number,message:string){super(message);this.name='OpenVikingModelError';}
}
type RecordValue=Record<string,any>;
type Thinking='default'|'disabled'|'enabled';
export interface OpenVikingModelView {
  available:boolean;reason?:string;model?:string;baseUrl?:string;thinking?:Thinking;apiKeyConfigured?:boolean;
  revision?:string;restartRequired?:boolean;restartSupported?:boolean;restarting?:boolean;
}
interface Snapshot {file:RecordValue;content:RecordValue;view:OpenVikingModelView}
interface Options {fetch?:typeof fetch;pollMs?:number;applyTimeoutMs?:number}
const filePath='/api/v1/admin/configuration?source=file';
const environmentReference=/\$|%[^%]+%|\\u002[45]/i;
function object(value:unknown):RecordValue {
  if(!value||typeof value!=='object'||Array.isArray(value))throw new OpenVikingModelError(400,'模型配置格式无效。');
  return value as RecordValue;
}
function revision(value:unknown):string {
  if(typeof value!=='string'||! /^[a-f0-9]{64}$/.test(value))throw new OpenVikingModelError(400,'配置版本无效，请刷新后重试。');
  return value;
}
function endpoint(value:unknown):string {
  if(typeof value!=='string'||value.length>2000)throw new OpenVikingModelError(400,'API 地址无效。');
  let url:URL;try{url=new URL(value.trim());}catch{throw new OpenVikingModelError(400,'API 地址无效。');}
  if(!['https:','http:'].includes(url.protocol)||url.username||url.password||url.search||url.hash
    ||(url.protocol==='http:'&&!['localhost','127.0.0.1','[::1]'].includes(url.hostname)))
    throw new OpenVikingModelError(400,'请使用 HTTPS API 基础地址，不包含凭据或查询参数；本地服务可以使用 HTTP。');
  return url.href.replace(/\/$/,'');
}

/** ROOT configuration responses contain every credential. Only the explicit model view may leave this class. */
export class AdminOpenVikingModel {
  private changing=false;
  private readonly credentials=new Set<string>();
  constructor(private readonly config:Config,private readonly options:Options={}){}
  secrets():string[]{return [...this.credentials];}
  private remember(value:unknown){
    if(!value||typeof value!=='object')return;
    for(const [key,child] of Object.entries(value)){
      if(/(?:api_?key|token|password|secret)$/i.test(key)&&typeof child==='string'&&child)this.credentials.add(child);
      else if(child&&typeof child==='object')this.remember(child);
    }
  }
  private async request(path:string,method='GET',body?:unknown,timeoutMs?:number):Promise<any>{
    const memory=this.config.memory;
    if(!memory?.enabled||!this.config.memoryApiKey)throw new OpenVikingModelError(503,'尚未启用 OpenViking，或未配置管理凭据。');
    try{
      const response=await (this.options.fetch??fetch)(memory.baseUrl.replace(/\/$/,'')+path,{
        method,redirect:'error',signal:AbortSignal.timeout(timeoutMs??Math.min(memory.timeoutMs,15_000)),
        headers:{'X-API-Key':this.config.memoryApiKey,'Content-Type':'application/json'},
        ...(body===undefined?{}:{body:JSON.stringify(body)}),
      });
      // Never include upstream error bodies: they can contain model credentials or the full startup file.
      if(!response.ok){
        await response.body?.cancel();
        throw new OpenVikingModelError(response.status===401||response.status===403?503:response.status===409?409:400,
          response.status===401||response.status===403?'记忆服务管理凭据不可用。':'记忆服务未接受配置操作，请刷新后检查配置。');
      }
      if(path==='/ready'){await response.body?.cancel();return true;}
      const reader=response.body?.getReader();if(!reader)throw new Error('Missing response');
      const chunks:Uint8Array[]=[];let bytes=0;
      for(;;){const {value,done}=await reader.read();if(done)break;bytes+=value.byteLength;
        if(bytes>1_000_000){await reader.cancel();throw new Error('Oversized response');}chunks.push(value);}
      const data=JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if(data.status!=='ok')throw new Error('Unexpected response');
      return data.result;
    }catch(error){
      if(error instanceof OpenVikingModelError)throw error;
      throw new OpenVikingModelError(503,'记忆服务暂时不可用，或未能确认操作结果，请刷新后重试。');
    }
  }
  private async snapshot():Promise<Snapshot>{
    const file=object(await this.request(filePath));
    let content:RecordValue;try{content=object(JSON.parse(file.content));}catch{throw new OpenVikingModelError(503,'无法读取记忆服务的模型配置。');}
    this.remember(content);
    const vlm=object(content.vlm),rev=revision(file.revision);
    let reason:string|undefined;
    if(file.form_readonly||!file.writable)reason='当前记忆配置为只读或使用环境变量引用，暂不能通过此表单修改。';
    else if((vlm.provider??vlm.backend)!=='openai'||(vlm.credentials?.length??0)>0||Object.keys(vlm.providers??{}).length>0||vlm.backup)
      reason='此表单支持单个 OpenAI 兼容模型；当前服务使用其他提供商或多凭据配置。';
    else if(file.overrides?.cluster?.includes('vlm'))reason='记忆模型存在运行时覆盖配置，请先移除覆盖再修改默认模型。';
    const thinking=vlm.extra_request_body?.thinking?.type;
    const view:OpenVikingModelView={available:!reason,...(reason?{reason}:{}),
      model:typeof vlm.model==='string'?vlm.model:'',baseUrl:typeof vlm.api_base==='string'?vlm.api_base:'',
      thinking:thinking==='disabled'||thinking==='enabled'?thinking:'default',apiKeyConfigured:typeof vlm.api_key==='string'&&!!vlm.api_key,
      revision:rev,restartRequired:!!file.restart_required,restartSupported:!!file.restart?.supported,restarting:!!file.restart?.restarting};
    return {file,content,view};
  }
  async read():Promise<OpenVikingModelView>{
    try{return (await this.snapshot()).view;}
    catch(error){return {available:false,reason:error instanceof OpenVikingModelError?error.message:'无法读取记忆模型配置。'};}
  }
  private async exclusive<T>(operation:()=>Promise<T>):Promise<T>{
    if(this.changing)throw new OpenVikingModelError(409,'已有模型配置正在保存或应用，请稍后重试。');
    this.changing=true;try{return await operation();}finally{this.changing=false;}
  }
  private editable(snapshot:Snapshot,expected:string){
    if(snapshot.file.revision!==expected)throw new OpenVikingModelError(409,'配置已发生变化，请刷新后重新保存。');
    if(!snapshot.view.available)throw new OpenVikingModelError(400,snapshot.view.reason!);
    if(snapshot.view.restarting)throw new OpenVikingModelError(409,'记忆服务正在重启，请稍后重试。');
  }
  async save(value:unknown){
    return this.exclusive(async()=>{
      const input=object(value);
      if(Object.keys(input).some(key=>!['model','baseUrl','thinking','apiKey','revision'].includes(key)))throw new OpenVikingModelError(400,'包含不支持的模型设置。');
      if(['model','baseUrl','apiKey'].some(key=>typeof input[key]==='string'&&environmentReference.test(input[key])))
        throw new OpenVikingModelError(400,'模型设置请填写实际值，不支持环境变量引用。');
      const expected=revision(input.revision);
      if(typeof input.model!=='string'||!input.model.trim()||input.model.length>160||/[\x00-\x1f\x7f]/.test(input.model))throw new OpenVikingModelError(400,'模型名称无效。');
      const baseUrl=endpoint(input.baseUrl);
      if(!['default','disabled','enabled'].includes(input.thinking))throw new OpenVikingModelError(400,'思考模式无效。');
      if(input.apiKey!==undefined&&(typeof input.apiKey!=='string'||(input.apiKey!==''&&(input.apiKey.length<6||input.apiKey.length>4000||/[\x00-\x1f\x7f]/.test(input.apiKey)))))
        throw new OpenVikingModelError(400,'API Key 格式无效。');
      const current=await this.snapshot();this.editable(current,expected);
      const content=structuredClone(current.content),vlm=content.vlm;
      vlm.model=input.model.trim();vlm.api_base=baseUrl;
      if(input.apiKey){vlm.api_key=input.apiKey;this.credentials.add(input.apiKey);}
      if(!vlm.api_key)throw new OpenVikingModelError(400,'请配置记忆提炼模型的 API Key。');
      const extra={...(vlm.extra_request_body??{})};
      if(input.thinking==='default')delete extra.thinking;else extra.thinking={type:input.thinking};
      if(Object.keys(extra).length)vlm.extra_request_body=extra;else delete vlm.extra_request_body;
      let saved=current;
      if(JSON.stringify(content)!==JSON.stringify(current.content)){
        const result=object(await this.request(filePath,'PATCH',{revision:expected,content:JSON.stringify(content,null,2)+'\n'}));
        const next=revision(result.revision);
        // Read back the saved revision before requesting restart; unknown outcomes never claim success.
        saved=await this.snapshot();
        if(saved.file.revision!==next)throw new OpenVikingModelError(409,'保存后配置再次变化，请刷新后确认。');
      }
      const result=await this.applySnapshot(saved);
      return {saved:true,...result};
    });
  }
  async apply(value:unknown){
    return this.exclusive(async()=>{
      const input=object(value);
      if(Object.keys(input).some(key=>key!=='revision'))throw new OpenVikingModelError(400,'应用请求格式无效。');
      const current=await this.snapshot();this.editable(current,revision(input.revision));
      return this.applySnapshot(current);
    });
  }
  private hostBusy():boolean {
    const path=join(this.config.stateDir,'state.sqlite');if(!existsSync(path))return false;
    const db=new DatabaseSync(path,{readOnly:true});
    try{
      if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='openviking_ingestion'").get())return false;
      return !!db.prepare('SELECT 1 FROM openviking_ingestion WHERE batch IS NOT NULL AND blocked=0 LIMIT 1').get();
    }finally{db.close();}
  }
  private async busy():Promise<boolean>{
    if(this.hostBusy())return true;
    const results=await Promise.all(['pending','running','cancelling'].map(status=>this.request('/api/v1/tasks?'+new URLSearchParams({status,limit:'1',include_internal:'true',pagination:'cursor'}))));
    for(const result of results){const items=Array.isArray(result)?result:result?.items;if(!Array.isArray(items))throw new OpenVikingModelError(503,'无法确认记忆任务状态，暂未重启服务。');if(items.length)return true;}
    return this.hostBusy();
  }
  private async applySnapshot(current:Snapshot){
    if(!current.view.restartRequired)return {applied:true,config:current.view,message:'记忆模型配置已生效。'};
    let release:()=>void;
    try{release=pauseOpenVikingPreparation(this.config.stateDir);}
    catch{return {applied:false,config:current.view,message:'配置已保存，已有配置正在应用；请稍后刷新确认。'};}
    try{return await this.restart(current);}finally{release();}
  }
  private async restart(current:Snapshot){
    const pending=(message:string,config=current.view)=>({applied:false,config,message});
    if(!current.view.restartRequired)return {applied:true,config:current.view,message:'记忆模型配置已生效。'};
    if(!current.view.restartSupported)return pending('配置已保存；当前记忆服务不支持远程重启，需要重启 OpenViking 后生效。');
    try{
      if(await this.busy())return pending('配置已保存，记忆任务仍在处理中；空闲后点击“重新应用”生效。');
    }catch{return pending('配置已保存，但暂时无法确认记忆任务状态；稍后点击“重新应用”。');}
    const oldInstance=current.file.restart?.instance_id,expected=current.file.revision;
    if(typeof oldInstance!=='string'||!oldInstance)return pending('配置已保存，但无法确认记忆服务实例；请刷新后重新应用。');
    try{await this.request('/api/v1/admin/restart','POST',{revision:expected});}
    catch{return pending('配置已保存，但未能确认重启请求；请稍后刷新检查，再尝试应用。');}
    const deadline=Date.now()+(this.options.applyTimeoutMs??30_000);
    do{
      await delay(this.options.pollMs??500);
      try{
        const next=await this.snapshot();
        if(typeof next.file.restart?.instance_id!=='string'||!next.file.restart.instance_id||next.file.restart.instance_id===oldInstance)continue;
        if(next.file.restart?.rolled_back||next.file.revision!==expected)return pending('记忆服务未采用本次配置，可能已回滚；请检查当前设置后重试。',next.view);
        if(next.view.restartRequired||next.view.restarting)continue;
        await this.request('/ready','GET',undefined,2000);
        return {applied:true,config:next.view,message:'记忆模型配置已生效，记忆服务已恢复。'};
      }catch{/* Restart can briefly close the listener. Keep a bounded verification window. */}
    }while(Date.now()<deadline);
    return pending('配置已保存，记忆服务仍在重启或暂时不可用；请稍后刷新确认。');
  }
}
