import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../src/config.js';
import { NativeAgentRuntime, type NativeResult } from '../src/runtime/native.js';
import { NativeRuntimePool } from '../src/runtime/pool.js';
import { ROUTER_COMPACTION_POLICY } from '../src/runtime/router-compaction.js';
import { roleProviderProfile } from '../src/runtime/pool.js';

// Real provider, synthetic attributed messages, isolated sessions. No tools or publisher.
const base=loadConfig(),id=randomUUID(),root=join(base.stateDir,'checks','context-v2-'+id);
mkdirSync(root,{recursive:true,mode:0o700});
const keyEnv='BOE2_CONTEXT_CHECK_'+id.replaceAll('-','');process.env[keyEnv]=base.routerApiKey;
const profile={...roleProviderProfile(base,'router'),apiKeyEnv:keyEnv};
const config={...base,stateDir:root},pool=new NativeRuntimePool(root);
const lease=await pool.acquire('router',config);const info=await lease.native.modelContext(lease.model);await lease.release();await pool.close();
const window=info.context?.contextWindow;if(!window)throw new Error('Configured model has no declared context window');
// Lower only the trigger/retained tail to exercise three cycles with modest synthetic volume.
const threshold=Math.min(6500,Math.floor(window/3)),maxTokens=Math.min(16_384,info.defaultMaxTokens??16_384,Math.floor(window/4));
const runtimeOptions={root:join(root,'dsh'),providers:{probe:profile},compactionRole:'router' as const,
  compaction:{...ROUTER_COMPACTION_POLICY,thresholdRatio:threshold/window,retainTokens:512,headroomTokens:Math.min(8192,Math.floor(window/8)),maxTokens,summarizationProvider:'probe',summarizationModel:base.router.model}};
let runtime=await NativeAgentRuntime.create(runtimeOptions),agent:Awaited<ReturnType<typeof runtime.start>>|undefined;
const results:NativeResult[]=[],calls:unknown[]=[],checks:Record<string,boolean>={},started=Date.now();let physicalCalls=0;
const report=join(root,'validation.json');
const system='这是隔离的群聊Router验证。收到背景存档只回复“收到”。不执行任务。当前用户更正覆盖旧条件，作者之间不可混淆。被问到代号和预算时，仅依据已给事实回答；不要使用工具。';
const agentOptions={id:'validation-'+id,model:{provider:'probe',model:base.router.model,maxTokens:2048,...(base.router.reasoningEffort?{reasoningEffort:base.router.reasoningEffort}:{})},cwd:root,systemPrompt:system,maxSteps:1,timeoutMs:120_000,maxContextTokens:Math.min(64_000,window),maxContextBytes:256_000,rotation:{maxBytes:100_000}};
function save(status:string,error?:unknown){let detail=error?String(error):undefined;for(const secret of [base.routerApiKey,base.workerApiKey,base.memoryApiKey])if(secret&&detail)detail=detail.replaceAll(secret,'[redacted]');writeFileSync(report,JSON.stringify({status,model:base.router.model,elapsedMs:Date.now()-started,policy:runtimeOptions.compaction,checks,calls,results,...(detail?{error:detail}:{})},null,2)+'\n',{mode:0o600});}
async function send(text:string,resume:boolean){
  const signal=AbortSignal.timeout(120_000);
  agent=await runtime.start({...agentOptions,resume,signal,execution:{signal,consumeModelCall:()=>{if(++physicalCalls>36)throw new Error('Validation total model-call limit');},onModelCall:event=>calls.push(event)}});
  try{const result=await agent.send(text);results.push(result);save('running');console.log(JSON.stringify({turn:results.length,summaries:results.reduce((n,r)=>n+(r.compaction?.summaries??0),0)}));return result.text;}
  finally{await agent.dispose();agent=undefined;}
}
try{
  await send('群room-test，用户A：我的代号是松针37，预算十元；用户B：我的代号是潮汐92，预算三元。这些只是验证事实，先回复收到。',false);
  let cycles=0;
  for(let turn=0;turn<12&&cycles<3;turn++){
    const records=Array.from({length:100},(_,index)=>`归档记录 ${turn}-${index}，作者 observer-${index%4}：本条是已完成的背景讨论，没有任务、条件更新或回复请求，主题编号 ${turn*100+index}。`).join('\n');
    await send('群room-test，宿主：以下历史资料只供观察。用户A和B的约定继续有效。\n'+records,true);
    cycles=results.reduce((n,r)=>n+(r.compaction?.summaries??0),0);
  }
  checks.threeCompactions=cycles>=3;
  await send('群room-test，用户A：更正，我的预算改成五元，代号不变。用户B未更改。回复收到。',true);
  await runtime.close();runtime=await NativeAgentRuntime.create(runtimeOptions);
  const answer=await send('群room-test，宿主：请复述用户A和用户B各自的代号与最新预算。不得混淆归属，直接列出。',true);
  checks.attributionAndCorrection=answer.includes('松针37')&&answer.includes('潮汐92')&&/(五|5)\s*元/.test(answer)&&/(三|3)\s*元/.test(answer)&&!/(十|10)\s*元/.test(answer);
  checks.restart=true;checks.noFailedCalls=calls.every(call=>!(call as {code?:string}).code);
  const passed=Object.values(checks).every(Boolean);save(passed?'passed':'failed');console.log(JSON.stringify({status:passed?'passed':'failed',checks,report}));if(!passed)process.exitCode=2;
}catch(error){save('failed',error);process.exitCode=1;console.log(JSON.stringify({status:'failed',report}));}
finally{await agent?.dispose();await runtime.close();delete process.env[keyEnv];}
