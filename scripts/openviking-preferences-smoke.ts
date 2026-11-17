/** Real presentation refresh over an accepted Worker answer; no professional tools or publisher. */
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {loadConfig} from '../src/config.js';
import {DshRuntime,type RuntimeMetrics} from '../src/dsh-runtime.js';
import {bindMemberMemoryUpdates} from '../src/memory/member-updates.js';
import type {MemberMemoryChange} from '../src/memory/types.js';
if(!process.argv[2]||!process.argv[3])throw new Error('Usage: openviking-preferences-smoke.ts <accepted-worker-artifact.json> <backend-config.json>');
const runId=randomUUID(),folder=resolve('.runtime/verification/openviking-preferences',runId);
mkdirSync(folder,{recursive:true,mode:0o700});
const backend=JSON.parse(readFileSync(resolve(process.argv[3]),'utf8'));
const source=resolve(process.argv[2]);
const worker=JSON.parse(readFileSync(source,'utf8'));
if(worker.status!=='passed')throw new Error('Requires an accepted Worker artifact');
const config=loadConfig(undefined,{stateDir:folder});
config.memory={enabled:true,provider:'openviking',baseUrl:`http://127.0.0.1:${backend.server.port}`,namespace:'preferences-'+runId,rootKeyEnv:'UNUSED',timeoutMs:30000,recallBytes:6000,ingestBatchSize:32};
config.memoryApiKey=backend.server.root_api_key;
const metrics:RuntimeMetrics[]=[],runtime=await DshRuntime.create(config,{onMetrics:metric=>metrics.push(metric)}),memory=runtime.sharedMemory!;
const results:unknown[]=[];let success=false;
async function save(order:number,changes:MemberMemoryChange[]){
  const id='setting-'+order,updates=bindMemberMemoryUpdates([{kind:'member',sourceMessageId:id,changes}],{actionSourceMessageIds:[id],messages:[{id,memberId:'alice',sourceOrder:order}]});
  for(const intent of await memory.prepareMemberWrites('room',updates,id))await memory.applyMemberWrite(intent);
  return memory.project('room',['alice']);
}
try{
  let previous=await save(1,[{key:'preferredName',op:'set',value:'阿明'}]),text=worker.report.shortAnswer;
  for(const [index,change]of ([{key:'preferredName',op:'set',value:'阿强'},{key:'preferredName',op:'clear'}] as MemberMemoryChange[]).entries()){
    const current=await save(index+2,[change]),started=Date.now();
    const output=await runtime.refreshReplyPreferences({roomId:'room',text,memberMemory:current,previousMemberMemory:previous,replyToMemberId:'alice',sourceText:'使用我保存的称呼，核对表格中的两个数值，给出准确数字和来源。'});
    if(output.includes('阿明')||(change.op==='clear'&&output.includes('阿强'))||(change.op==='set'&&!output.includes('阿强')))throw new Error('Latest name not applied');
    results.push({case:change.op,passed:true,elapsedMs:Date.now()-started,input:text,output});text=output;previous=current;
  }
  success=true;
}catch(error){results.push({passed:false,error:error instanceof Error?error.message:'Error'});process.exitCode=1;}
finally{
  await runtime.close();const path=join(folder,'preferences-smoke.json');
  writeFileSync(path,JSON.stringify({runId,passed:success,source,scope:'real backend and model; existing accepted domain answer; no domain rerun; no platform sends',results,metrics},null,2)+'\n',{mode:0o600});
  console.log(JSON.stringify({passed:success,path}));
}
