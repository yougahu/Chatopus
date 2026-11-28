import {createHash} from 'node:crypto';
import {existsSync,readFileSync,writeFileSync,renameSync} from 'node:fs';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {privateChatSettings,qqStartupDigest} from '../private-chat.js';
import {scheduleServiceOnline} from './schedules.js';
import {loadConfig,type Config} from '../config.js';
const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
function disk(root:string){const path=join(root,'config.local.json'),text=existsSync(path)?readFileSync(path,'utf8'):'{}';return {path,text,value:JSON.parse(text),revision:hash(text)};}
export function readPrivateSettings(config:Config){
  let current:ReturnType<typeof disk>,settings,invalid:string|undefined;
  try{current=disk(config.root);settings=privateChatSettings(current.value.qq?.privateChat);}catch{
    invalid='private_config_invalid';const path=join(config.root,'config.local.json'),text=existsSync(path)?readFileSync(path,'utf8'):'';
    current={path,text,value:{},revision:hash(text)};settings=privateChatSettings(config.qq.privateChat);
  }
  const file=join(config.stateDir,'state.sqlite');
  let applied:unknown=null,error:unknown=null;
  if(existsSync(file)){const db=new DatabaseSync(file,{readOnly:true});try{
    const row=db.prepare("SELECT id,at,data FROM telemetry WHERE kind='private_config_applied' ORDER BY id DESC LIMIT 1").get();
    if(row)applied={at:row.at,...JSON.parse(String(row.data))};
    const failed=db.prepare("SELECT at,data FROM telemetry WHERE kind='private_config_error' AND id>? ORDER BY id DESC LIMIT 1").get(Number(row?.id??0));
    if(failed)error={at:failed.at,...JSON.parse(String(failed.data))};
  }finally{db.close();}}
  let attachmentStorage:unknown;
  try{const entries=JSON.parse(readFileSync(join(config.stateDir,'attachments/manifest.json'),'utf8'));attachmentStorage={bytes:entries.filter((e:any)=>e.state!=='expired').reduce((n:number,e:any)=>n+e.bytes,0),files:entries.filter((e:any)=>e.state==='available').length,expired:entries.filter((e:any)=>e.state==='expired').length,...config.attachments};}catch{}
  let restartRequired=false;
  if(applied&&!invalid){const prior=(applied as {startupDigest?:string}).startupDigest;try{restartRequired=!!prior&&prior!==qqStartupDigest(loadConfig(config.root).qq);}catch{}}
  return {settings,revision:current.revision,digest:hash(JSON.stringify(settings)),applied,error:invalid?{code:invalid}:error,attachmentStorage,restartRequired,running:scheduleServiceOnline(config),appliesTo:'running-service'};
}
export function savePrivateSettings(config:Config,input:unknown){
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['settings','revision'].includes(k)))throw new Error('私聊配置请求无效。');
  const body=input as {settings:unknown;revision:string},current=disk(config.root);
  if(body.revision!==current.revision)throw Object.assign(new Error('配置已变化，请刷新后重试。'),{status:409});
  const settings=privateChatSettings(body.settings),temporary=current.path+'.private-chat.tmp';
  writeFileSync(temporary,JSON.stringify({...current.value,qq:{...current.value.qq,privateChat:settings}},null,2)+'\n',{mode:0o600});renameSync(temporary,current.path);
  return {saved:true,...readPrivateSettings(config)};
}
