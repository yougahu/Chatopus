/** Isolated backend integration probe. Never imports history or sends platform messages. */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../src/config.js';
import { SharedMemoryService } from '../src/memory/shared-memory.js';
import { bindMemberMemoryUpdates } from '../src/memory/member-updates.js';
import { memberMemoryUri, OPENVIKING_COMMIT, OpenVikingError } from '../src/memory/openviking-client.js';

const backendConfig=resolve(process.argv[2]??'.runtime/openviking-dev/ov.conf');
const backend=JSON.parse(readFileSync(backendConfig,'utf8'));
const runId=randomUUID(),folder=resolve('.runtime/verification/openviking',runId);
mkdirSync(folder,{recursive:true,mode:0o700});
const config=loadConfig();
config.memory={enabled:true,provider:'openviking',baseUrl:`http://127.0.0.1:${backend.server.port}`,namespace:'verification-'+runId,
  rootKeyEnv:'OPENVIKING_ROOT_API_KEY',timeoutMs:30_000,recallBytes:6000,ingestBatchSize:32};
config.memoryApiKey=backend.server.root_api_key;
const service=new SharedMemoryService(config);
const results:Array<{name:string;passed:boolean;elapsedMs:number;error?:string}>=[];
async function check(name:string,fn:()=>Promise<void>){
  const start=Date.now();
  try{await fn();results.push({name,passed:true,elapsedMs:Date.now()-start});}
  catch(error){results.push({name,passed:false,elapsedMs:Date.now()-start,error:error instanceof OpenVikingError?`${error.code}:${error.status}`:error instanceof Error?error.name:'Error'});throw error;}
}
function assert(value:unknown,message:string):asserts value{if(!value)throw new Error(message);}
function update(id:string,order:number,value:string|null){return bindMemberMemoryUpdates([{kind:'member',sourceMessageId:id,
  changes:[value===null?{key:'preferredName',op:'clear'}:{key:'preferredName',op:'set',value}]}],
  {actionSourceMessageIds:[id],messages:[{id,memberId:'fixture-alice',sourceOrder:order}]});}
try{
  let initial:Awaited<ReturnType<typeof service.prepareMemberWrites>>=[];
  await check('explicit-setting-readback',async()=>{
    initial=await service.prepareMemberWrites('fixture-room-a',update('fixture-1',1,'阿明'),'fixture-turn-1');
    assert(initial.length===1,'Expected one intent');
    const saved=await service.applyMemberWrite(initial[0]);assert(saved.fields.preferredName?.state==='set','Expected set');
    assert((await service.project('fixture-room-a',['fixture-alice']))[0].fields.preferredName?.state==='set','Projection missing');
  });
  await check('restart-and-cross-role-read',async()=>{
    const second=new SharedMemoryService(config);
    const current=await second.readMember('fixture-room-a','fixture-alice');
    assert(current?.document.commitId===initial[0].commitId,'Current state did not survive client restart');
    await second.applyMemberWrite(initial[0]);
    assert((await second.readMember('fixture-room-a','fixture-alice'))?.document.revision===1,'Duplicate intent changed revision');
  });
  await check('group-isolation',async()=>{
    assert(await service.readMember('fixture-room-b','fixture-alice')===null,'Profile crossed group');
  });
  await check('correction-and-stale-write-rejection',async()=>{
    const newer=await service.prepareMemberWrites('fixture-room-a',update('fixture-2',2,'老王'),'fixture-turn-2');
    await service.applyMemberWrite(newer[0]);
    let rejected=false;
    try{await service.client.writeMember(service.account('fixture-room-a'),'fixture-alice',initial[0].text,initial[0].sha256);}
    catch(error){rejected=error instanceof OpenVikingError&&error.status===409;}
    assert(rejected,'Backend did not reject stale hash');
    assert((await service.client.read(service.account('fixture-room-a'),memberMemoryUri('fixture-alice')))?.sha256===newer[0].sha256,'Stale write changed value');
  });
  await check('clear-and-old-source-does-not-revive',async()=>{
    const cleared=await service.prepareMemberWrites('fixture-room-a',update('fixture-3',3,null),'fixture-turn-3');
    await service.applyMemberWrite(cleared[0]);
    assert((await service.project('fixture-room-a',['fixture-alice']))[0].fields.preferredName?.state==='cleared','Clear not visible');
    assert((await service.prepareMemberWrites('fixture-room-a',update('fixture-1',1,'阿明'),'fixture-turn-old')).length===0,'Old source revived clear');
  });
}catch{process.exitCode=1;}
finally{
  const report={runId,backendCommit:OPENVIKING_COMMIT,scope:'isolated accounts; explicit member paths only',passed:results.every(r=>r.passed),results};
  writeFileSync(join(folder,'backend-smoke.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});
  console.log(JSON.stringify({report:join(folder,'backend-smoke.json'),passed:report.passed,checks:results.length}));
}
