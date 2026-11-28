import {isPrivateRoom,qqId} from './conversation.js';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, safeConfig } from './config.js';
import { DshRuntime } from './dsh-runtime.js';
import { Store } from './store.js';
import { Coordinator } from './coordinator.js';
import { OneBotAdapter } from './platform/onebot.js';
import { resolveOneBotImage } from './platform/media.js';
import { sourceImage } from './runtime/incoming-images.js';
import { MemoryPublisher } from './platform/memory.js';
import { evaluateReplay } from './replay.js';
import { loadExtensions } from './capabilities.js';
import { hostSdk } from './tools/index.js';
import type { GroupMessage } from './types.js';
import { acquireInstanceLock } from './instance-lock.js';
import { AdminServer } from './admin/server.js';
import { probeExecutable } from './diagnostics.js';
const config=loadConfig();
const command=process.argv[2]??'help';
const arg=(name:string)=>{const i=process.argv.indexOf(name);return i>=0?process.argv[i+1]:undefined;};
function redact(error:unknown){let text=String(error);for(const key of [config.apiKey,config.routerApiKey,config.workerApiKey])if(key)text=text.replaceAll(key,'[redacted]');return text.replace(/\b(?:sk-|Bearer\s+)[A-Za-z0-9_.-]+/gi,'[redacted]');}
async function main(){
  if(command==='admin'){
    const admin=new AdminServer(config,Number(arg('--port')??8092));
    const url=await admin.start();console.log(`Chatopus admin: ${url}`);
    process.once('SIGINT',()=>void admin.close());process.once('SIGTERM',()=>void admin.close());return;
  }
  if(command==='doctor'){
    const skillIds=new Set(Object.values(config.business?.profiles??{}).flatMap(p=>p.skillIds));
    const skills=config.skills.filter(s=>skillIds.has(s.id)).map(s=>({id:s.id,available:existsSync(join(s.path,'SKILL.md'))}));
    const extensionIds=new Set(Object.values(config.business?.profiles??{}).flatMap(p=>p.extensionIds));
    const specs=config.extensions.filter(e=>extensionIds.has(e.id)&&e.enabled!==false);
    const extensions=[];
    for(const spec of specs){
      try{const [module]=await loadExtensions({...config,extensions:[spec]});const checks=await module.diagnose?.(spec.options??{},hostSdk)??[];
        extensions.push({id:spec.id,available:checks.every(c=>c.available),checks});}
      catch{extensions.push({id:spec.id,available:false,error:'EXTENSION_UNAVAILABLE'});}
    }
    const browser=config.browser?await probeExecutable(config.browser.command):undefined;
    const qq={enabled:config.qq.enabled,configured:!config.qq.enabled||!!qqId(config.qq.selfId)&&!!config.qq.accessToken,groups:config.qq.allowedGroupIds.length,privatePeers:config.qq.privateChat?.enabled?config.qq.privateChat.allowedUserIds.length:0,privateFiles:config.qq.privateFiles?{implementation:config.qq.privateFiles.implementation,version:config.qq.privateFiles.version,verification:'runtime-version-check-and-operator-integration-required'}:'not-configured',zeroTargetsAllowed:true};
    const checks={skills,extensions,browser,qq,nodeVersion:process.version,routerApiConfigured:!!config.routerApiKey,workerApiConfigured:!!config.workerApiKey};
    console.log(JSON.stringify({config:safeConfig(config),checks},null,2));
    if(!qq.configured||skills.some(s=>!s.available)||extensions.some(e=>!e.available)||browser?.available===false)process.exitCode=1;
    return;
  }
  if(command==='replay'){
    const runtime=await DshRuntime.create(config);
    try{const report=await evaluateReplay(config,runtime,{fixturePath:arg('--fixture'),split:arg('--split'),limit:arg('--limit')?Number(arg('--limit')):undefined,
      concurrency:Number(arg('--concurrency')??3),onProgress:(done,total)=>console.log(`Replay ${done}/${total}`)});
      const {rows,...summary}=report;console.log(JSON.stringify({...summary,failures:rows.filter(x=>!x.pass)},null,2));
      if(report.passed!==report.messages)process.exitCode=2;
    }finally{await runtime.close();}return;
  }
  if(command==='ask'){
    const text=process.argv.slice(3).join(' ').trim();if(!text)throw new Error('Usage: npm run dev -- ask <question>');
    const testConfig={...config,stateDir:join(config.stateDir,'ask',String(Date.now()))};
    const store=new Store(join(testConfig.stateDir,'state.sqlite'));const publisher=new MemoryPublisher();
    const runtime=await DshRuntime.create(testConfig,{onMetrics:m=>store.telemetry('model',{...m,eventId:m.measurementId}),onModelCall:m=>store.telemetry('model_call',{...m,eventId:m.callId}),onToolAudit:event=>store.telemetry('domain_tool',event)});
    const coordinator=new Coordinator(testConfig,store,runtime,publisher);
    try{await coordinator.start();
      const message:GroupMessage={id:'cli:1',roomId:'cli',platform:'replay',messageId:'1',authorId:'local',authorName:'本地用户',text,timestamp:Date.now(),mentions:['bot'],attachments:[],isMentioned:true,isAdmin:true};
      await coordinator.receive(message);await coordinator.drain(config.workerTimeoutMs*2+config.routerTimeoutMs*4);
      for(const x of publisher.messages)console.log(x.message.text);
      if(store.threads().some(x=>x.status==='failed'))process.exitCode=2;
    }finally{await coordinator.close();store.close();}return;
  }
  if(command==='serve'){
    if(!config.qq.enabled)throw new Error('QQ adapter is disabled. Configure qq.enabled, selfId, allowed targets and ONEBOT_ACCESS_TOKEN first.');
    const release=acquireInstanceLock(join(config.stateDir,'instance.lock'));
    process.once('exit',release);
    const store=new Store(join(config.stateDir,'state.sqlite'));
    let coordinator:Coordinator|undefined;let runtime:DshRuntime|undefined;
    const adapter=new OneBotAdapter({...config.qq,host:'127.0.0.1',outputRoot:join(config.stateDir,'workspaces'),
      onMessage:m=>coordinator!.receive(m),onError:(code,id)=>store.telemetry('platform',{code,id})});
    let closing=false;
    const close=async()=>{
      if(closing)return;closing=true;
      adapter.stopIntake();
      try{if(coordinator)await coordinator.close();else await runtime?.close();}
      finally{try{await adapter.close();}finally{store.close();release();}}
    };
    try{
      runtime=await DshRuntime.create(config,{
        resolveImage:(_marker,context,signal)=>{
          const a=sourceImage(store.message(context.messageId),context);
          const privateRoom=isPrivateRoom(context.roomId);
          const resolve=(inputSignal?:AbortSignal)=>resolveOneBotImage(adapter,a,{signal:inputSignal,cacheRoot:config.qq.imageCacheRoot,
            cacheDir:privateRoom?undefined:join(config.stateDir,'incoming-images'),cacheKey:JSON.stringify([context.roomId,context.messageId,context.attachmentIndex]),
            onDiagnostic:event=>store.telemetry('image_receive',{...context,...event})});
          return privateRoom?coordinator!.attachments.image(context.roomId,context.messageId,context.attachmentIndex,resolve,signal):resolve(signal);
        },onImage:event=>store.telemetry('image_input',event),onMetrics:m=>store.telemetry('model',{...m,eventId:m.measurementId}),onModelCall:m=>store.telemetry('model_call',{...m,eventId:m.callId}),onToolAudit:event=>store.telemetry('domain_tool',event)});
      coordinator=new Coordinator(config,store,runtime,adapter,true);
      await coordinator.start(false);await adapter.start();
    }catch(error){await close();throw error;}
    console.log(`Chatopus listening on 127.0.0.1:${config.qq.port}; ${config.qq.allowedGroupIds.length} allowed group(s).`);
    process.once('SIGINT',()=>void close());process.once('SIGTERM',()=>void close());return;
  }
  if(command==='inspect'){
    const store=new Store(join(config.stateDir,'state.sqlite'));
    try{console.log(JSON.stringify({threads:store.threads().map(t=>({id:t.id,room:t.roomId,status:t.status,revision:t.revision})),outbox:store.outbox().map(x=>({id:x.id,status:x.status,attempts:x.attempts}))},null,2));}finally{store.close();}return;
  }
  console.log('Chatopus: doctor | ask <question> | replay [--fixture FILE] [--limit N] [--concurrency N] | serve | admin [--port 8092] | inspect');
}
main().catch(error=>{console.error(redact(error));process.exitCode=1;});
