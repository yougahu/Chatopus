import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { GroupMessage, RouteAction, RuntimePort, ThreadCard } from './types.js';
import type { Config } from './config.js';
import { ROUTER_PROMPT } from './protocol.js';
export interface Scenario { id:string; title:string; tags:string[]; split:string; messages:GroupMessage[]; expected:{messageId:string;actions:string[];threadFrom?:string;forbiddenText?:string[];requiredText?:string[]}[] }
export interface ReplayOptions { fixturePath?:string; split?:string; limit?:number; concurrency?:number; output?:string; onProgress?:(done:number,total:number)=>void }
export async function evaluateReplay(config:Config,runtime:RuntimePort,options:ReplayOptions={}){
  if(options.split&&!['development','holdout'].includes(options.split))throw new Error('Replay split must be development or holdout');
  if(options.limit!==undefined&&(!Number.isInteger(options.limit)||options.limit<1))throw new Error('Replay limit must be a positive integer');
  if(options.concurrency!==undefined&&(!Number.isInteger(options.concurrency)||options.concurrency<1||options.concurrency>8))throw new Error('Replay concurrency must be 1..8');
  const fixture=JSON.parse(readFileSync(resolve(config.root,options.fixturePath??'fixtures/group-replay.json'),'utf8'));
  const scenarios:Scenario[]=fixture.scenarios.filter((s:Scenario)=>!options.split||s.split===options.split).slice(0,options.limit??Infinity);
  if(!scenarios.length)throw new Error('No replay scenarios selected');
  // Router history now persists by room. Each evaluation/scenario is an
  // independent conversation, while turns within that scenario share history.
  const runId=randomUUID();
  const rows:{scenario:string;split:string;messageId:string;expected:string[];actions:RouteAction[];pass:boolean;elapsedMs:number;error?:string}[]=[];
  let done=0,next=0;
  const target=options.output??join(config.stateDir,'verification',`router-${options.split??'all'}.json`);
  mkdirSync(join(config.stateDir,'verification'),{recursive:true});
  const snapshot=()=>{
    const times=rows.map(x=>x.elapsedMs).sort((a,b)=>a-b);
    const percentile=(p:number)=>times[Math.max(0,Math.ceil(times.length*p)-1)]??0;
    const professional=rows.filter(x=>x.expected.every(a=>['open_thread','append_thread','clarify'].includes(a)));
    const report={time:new Date().toISOString(),runId,sessionIsolation:'per-run-scenario-room',model:config.router,endpoint:config.baseUrl,promptSha256:createHash('sha256').update(ROUTER_PROMPT).digest('hex'),configurationHash:runtime.routerConfigurationHash?.(''),fixturePath:options.fixturePath??'fixtures/group-replay.json',
      completedScenarios:done,totalScenarios:scenarios.length,messages:rows.length,passed:rows.filter(x=>x.pass).length,
      professionalCases:professional.length,professionalHandled:professional.filter(x=>x.actions.some(a=>['open_thread','append_thread','clarify'].includes(a.action))).length,
      latency:{p50:percentile(.5),p95:percentile(.95)},rows};
    writeFileSync(target,JSON.stringify(report,null,2)+'\n');return report;
  };
  async function runScenario(s:Scenario,index:number){
    const threads:ThreadCard[]=[];const sourceThreads=new Map<string,string>();const recent:GroupMessage[]=[];
    const roomId=(original:string)=>`replay:${runId}:${index}:${createHash('sha256').update(original).digest('hex')}`;
    // Keep opaque fixture message IDs and quote targets unchanged for scoring.
    for(const source of s.messages){
      const message={...source,roomId:roomId(source.roomId)};
      const expected=s.expected.find(x=>x.messageId===message.id)!;const started=Date.now();let actions:RouteAction[]=[];let error:string|undefined;
      try{actions=await runtime.route({roomId:message.roomId,event:'messages',messages:[message],recentMessages:recent.filter(m=>m.roomId===message.roomId).slice(-config.recentMessageLimit),threads:threads.filter(t=>t.roomId===message.roomId)});}
      catch(e){error=String(e).replaceAll(config.apiKey||'\0','[redacted]').slice(0,600);}
      const valid=actions.length===1&&'sourceMessageIds'in actions[0]&&actions[0].sourceMessageIds.length===1&&actions[0].sourceMessageIds[0]===message.id;
      const action=actions[0];
      const output=JSON.stringify(actions);
      let pass=valid&&expected.actions.includes(action.action)
        &&(expected.forbiddenText??[]).every(text=>!output.includes(text))
        &&(expected.requiredText??[]).every(text=>output.includes(text));
      if(pass&&expected.threadFrom&&action&&'threadId'in action)pass=action.threadId===sourceThreads.get(expected.threadFrom);
      rows.push({scenario:s.id,split:s.split,messageId:message.id,expected:expected.actions,actions,pass,elapsedMs:Date.now()-started,...(error?{error}:{})});
      if(valid&&action.action==='open_thread'){
        const id=`thread-${s.id}-${threads.length+1}`;sourceThreads.set(message.id,id);
        threads.push({id,roomId:message.roomId,subject:action.subject,ownerId:message.authorId,sourceMessageId:message.messageId,explicit:message.isMentioned,participants:[message.authorId],status:'running',revision:1,latestInputSeq:1,sessionId:'replay-'+id,epoch:1,summary:''});
      }else if(valid&&'threadId'in action){
        const thread=threads.find(x=>x.id===action.threadId);
        if(thread&&action.action==='append_thread'){thread.latestInputSeq++;thread.revision++;thread.summary=message.text.slice(0,300);if(!thread.participants.includes(message.authorId))thread.participants.push(message.authorId);}
        if(thread&&action.action==='request_cancel'&&(message.authorId===thread.ownerId||message.isAdmin))thread.status='cancelled';
      }
      recent.push(message);
    }
    done++;snapshot();options.onProgress?.(done,scenarios.length);
  }
  await Promise.all(Array.from({length:Math.min(options.concurrency??3,scenarios.length)},async()=>{for(;;){const i=next++;if(i>=scenarios.length)return;await runScenario(scenarios[i],i);}}));
  return snapshot();
}
