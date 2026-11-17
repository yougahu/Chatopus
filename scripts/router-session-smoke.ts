import { mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { DshRuntime, routerSessionId, type RuntimeMetrics } from '../src/dsh-runtime.js';
import type { RouterRequest } from '../src/types.js';
import { Store } from '../src/store.js';

// Real configured Router API, synthetic input and isolated persistence only.
// No Coordinator, Worker, QQ adapter or publisher is created by this probe.
const base=loadConfig(),runId=randomUUID();
const stateDir=join(base.stateDir,'checks','router-session-'+runId);
mkdirSync(stateDir,{recursive:true,mode:0o700});
const config={...base,stateDir};
const store=new Store(join(stateDir,'context.sqlite'));
const roomId='session-smoke:'+runId,marker='松针37';
const metrics:RuntimeMetrics[]=[],turns:unknown[]=[],checks:Record<string,boolean>={};
const options={onMetrics:(value:RuntimeMetrics)=>metrics.push(value)};
let runtime=await DshRuntime.create(config,options);
const started=Date.now();
const output=join(stateDir,'result.json');
function save(status:string,error?:unknown){
  let detail=error===undefined?undefined:String(error);
  for(const key of [config.apiKey,config.routerApiKey,config.workerApiKey])if(key&&detail)detail=detail.replaceAll(key,'[redacted]');
  writeFileSync(output,JSON.stringify({status,time:new Date().toISOString(),elapsedMs:Date.now()-started,
    model:config.router.model,routerContextChars:config.routerContextChars,routerTimeoutMs:config.routerTimeoutMs,
    checks,metrics,turns,...(detail?{error:detail}:{})},null,2)+'\n',{mode:0o600});
}
async function route(id:string,text:string,room=roomId){
  const request:RouterRequest={roomId:room,currentTime:Date.now(),event:'messages',recentMessages:[],recentReplies:[],threads:[],messages:[{
    id:room+':'+id,roomId:room,platform:'replay',messageId:id,authorId:'synthetic-owner',authorName:'本地测试用户',
    text,timestamp:Date.now(),mentions:[],attachments:[],isMentioned:true,isAdmin:false,
  }]};
  store.ingest(request.messages[0]);
  const actions=await runtime.route(request,store.routerContextReader(room,request.messages[0].id,request.currentTime));
  store.messageStatus(request.messages[0].id,'routed');turns.push({id,room,actions});save('running');
  console.log(JSON.stringify({turn:id,actions:actions.map(action=>action.action),summaries:metrics.reduce((n,m)=>n+(m.compaction?.summaries??0),0)}));
  return actions;
}
try{
  await route('remember',`我给这次资料整理取的文字代号是“${marker}”。这是我自己的代号，请记住，后面我会问你；现在无需执行其他任务或查询资料。`);
  for(let i=0;i<8;i++){
    const records=Array.from({length:80},(_,j)=>`虚构记录${i}-${j}：这一行只用于补充历史文本，属于已经结束的记录，不要求执行任何任务。`).join('\n');
    await route('history-'+i,'补充一些无须回复的背景存档。之前的文字代号约定仍有效；以下均无待办事项。\n'+records);
  }
  checks.noCompaction=!metrics.some(metric=>(metric.compaction?.summaries??0)>0);
  await runtime.close();runtime=await DshRuntime.create(config,options);
  const remembered=await route('after-restart','我先前给这次资料整理取的文字代号是什么？只复述我给出的代号，不要执行分析任务事实。');
  checks.rememberedAfterRestart=remembered.some(action=>action.action==='reply_direct'&&action.text.includes(marker));
  const isolated=await route('other-room','我先前给这次资料整理取的文字代号是什么？只根据本群已经提供的信息回答。',roomId+':other');
  checks.roomIsolation=!JSON.stringify(isolated).includes(marker);
  const expected=routerSessionId(roomId);
  const initial=metrics.filter(metric=>metric.phase==='initial');
  checks.freshSessions=initial.filter(metric=>metric.sessionId.startsWith(expected+'-')).length>=3
    &&new Set(initial.map(metric=>metric.sessionId)).size===initial.length;
  const passed=Object.values(checks).every(Boolean);save(passed?'passed':'failed');
  console.log(JSON.stringify({status:passed?'passed':'failed',checks,report:output,elapsedMs:Date.now()-started}));
  if(!passed)process.exitCode=2;
}catch(error){save('failed',error);process.exitCode=1;console.log(JSON.stringify({status:'failed',report:output}));}
finally{try{await runtime.close();}finally{store.close();}}
