import { readFileSync,existsSync,writeFileSync,renameSync,chmodSync,unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadConfig,safeConfig } from '../config.js';

function atomicWrite(file:string,text:string){const temp=file+'.'+randomUUID()+'.tmp';try{writeFileSync(temp,text,{mode:0o600});renameSync(temp,file);chmodSync(file,0o600);}finally{try{unlinkSync(temp);}catch{}}}
function object(v:unknown):Record<string,unknown>{if(!v||typeof v!=='object'||Array.isArray(v))throw new Error('Expected a configuration object');return v as Record<string,unknown>;}
export function saveModelSettings(root:string,value:unknown){
  const input=object(value);if(Object.keys(input).some(k=>!['router','worker'].includes(k))||!Object.keys(input).length)throw new Error('Only Router and Worker model settings can be changed');
  const configFile=join(root,'config.local.json'),envFile=join(root,'.env');
  const disk=existsSync(configFile)?JSON.parse(readFileSync(configFile,'utf8')):{};
  // Resolve credentials before changing references, including legacy/shared and custom provider keys.
  const current=loadConfig(root);
  let env=existsSync(envFile)?readFileSync(envFile,'utf8'):'';
  const envUpdates:Record<string,string>={};
  for(const role of ['router','worker'] as const){
    if(input[role]===undefined)continue;
    const settings=object(input[role]);
    if(Object.keys(settings).some(k=>!['model','baseUrl','api','reasoningEffort','apiKey'].includes(k)))throw new Error('Unsupported model setting');
    const prior=disk[role]??{};const next={...prior,provider:'boe-'+role,apiKeyEnv:role.toUpperCase()+'_API_KEY'};
    if(settings.model!==undefined){if(typeof settings.model!=='string'||!settings.model.trim()||settings.model.length>160||/[\r\n\0]/.test(settings.model))throw new Error('Invalid model ID');next.model=settings.model.trim();}
    if(settings.baseUrl!==undefined){
      if(typeof settings.baseUrl!=='string')throw new Error('Invalid API endpoint');const url=new URL(settings.baseUrl);
      if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)throw new Error('Use an API endpoint without embedded credentials or query parameters');
      if(url.protocol==='http:'&&!['localhost','127.0.0.1','[::1]'].includes(url.hostname))throw new Error('Remote API endpoints require HTTPS');
      next.baseUrl=url.href.replace(/\/$/,'');
    }
    if(settings.api!==undefined){if(!['openai-responses','openai-completions','anthropic-messages'].includes(String(settings.api)))throw new Error('Unsupported API protocol');next.api=settings.api;}
    if(settings.reasoningEffort!==undefined){if(!['off','low','medium','high','xhigh','max'].includes(String(settings.reasoningEffort)))throw new Error('Invalid reasoning effort');next.reasoningEffort=settings.reasoningEffort;}
    if(settings.apiKey!==undefined&&settings.apiKey!==''){
      if(typeof settings.apiKey!=='string'||settings.apiKey.length<6||settings.apiKey.length>4000||/[\r\n\0]/.test(settings.apiKey))throw new Error('Invalid API key');
      envUpdates[next.apiKeyEnv]=settings.apiKey;
    }else envUpdates[next.apiKeyEnv]=role==='router'?current.routerApiKey:current.workerApiKey;
    disk[role]=next;
  }
  for(const [name,key] of Object.entries(envUpdates)){
    const line=name+'='+JSON.stringify(key);const pattern=new RegExp('^'+name+'=.*$','m');env=pattern.test(env)?env.replace(pattern,()=>line):env.trimEnd()+'\n'+line+'\n';
  }
  // Secrets never enter JSON configuration or the HTTP response.
  atomicWrite(envFile,env);atomicWrite(configFile,JSON.stringify(disk,null,2)+'\n');
  // The operator's explicit local update supersedes an inherited variable for this process.
  for(const name of Object.keys(envUpdates))delete process.env[name];
  return safeConfig(loadConfig(root));
}
