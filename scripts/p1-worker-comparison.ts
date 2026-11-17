/** Execute after P1 readiness: paired real Worker task-understanding probes, no domain side effects. */
import {createHash,randomUUID} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,readdirSync,renameSync,writeFileSync} from 'node:fs';
import {join,resolve,relative} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import type {Config} from '../src/config.js';
import type {GroupMessage,RuntimePort,ThreadInput,WorkerReport,WorkerRequest} from '../src/types.js';
import type {RuntimeMetrics} from '../src/dsh-runtime.js';
import {auditDshUsage} from './p1-usage-audit.js';

const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const flags=new Map(process.argv.slice(2).map(arg=>{const i=arg.indexOf('=');return i<0?[arg,'true']:[arg.slice(0,i),arg.slice(i+1)];}));
if(!flags.get('--baseline')||flags.get('--baseline')==='true')throw new Error('Provide --baseline=<source-directory>');
const baseline=resolve(root,flags.get('--baseline')!);
const output=resolve(root,flags.get('--output')??'.runtime/comparison/tasks/worker-'+new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomUUID().slice(0,8));
if(existsSync(output))throw new Error('Choose a new output directory');
const load=(source:string,file:string)=>import(pathToFileURL(join(source,'src',file)).href);
const {loadConfig,agentSettingsRevision}=await load(root,'config.ts');
const base:Config=loadConfig(root),arms={baseline,candidate:resolve(root,flags.get('--candidate')??'.')};
const hash=(text:string|Buffer)=>createHash('sha256').update(text).digest('hex');
function sourceHashes(source:string,folder=join(source,'src')):Record<string,string>{return Object.fromEntries(readdirSync(folder,{withFileTypes:true}).flatMap(entry=>{const file=join(folder,entry.name);return entry.isDirectory()?Object.entries(sourceHashes(source,file)):/\.(ts|py|js)$/.test(file)?[[relative(source,file),hash(readFileSync(file))]]:[];}));}
const safe=(error:unknown)=>[base.apiKey,base.routerApiKey,base.workerApiKey,base.qq.accessToken].filter(Boolean).reduce((text,secret)=>text.replaceAll(secret,'[redacted]'),String(error)).replace(/Bearer\s+[^\s"']+/gi,'Bearer [redacted]').slice(0,1800);
const probeInstruction='这是隔离的任务理解测试，不是领域分析请求。只提取本轮存储的用户要求，不回答专业领域问题，不索取材料，不做预算计算，不调用外部工具。唯一可用工具若存在，是宿主提供的原文历史读取，必须按其覆盖规则读取。正常输出 Worker 报告 JSON，status=ready 仅表示完成需求核对，shortAnswer 为单行键值：A预算=<当前值>元；B预算=<当前值>元；A保留=<物品>；A设备=<当前对象或未指定>；B保留=<物品>。根据原文填写，未知写未指定。证据写进 evidenceRefs，格式 authorId:seq；不要把历史已撤销值当当前值。若主协议提供 requirementState，则如实保存所有作者仍有效的约束及其来源，不能省略最新输入来源。';
interface Scenario {id:string;oversized:boolean;inputs:ThreadInput[];expected:{aBudget:string;bBudget:string;aKeep:string;aDevice:string;bKeep:string};second?:{text:string;expected:{aBudget:string;bBudget:string;aKeep:string;aDevice:string;bKeep:string}}}
function input(room:string,seq:number,text:string,author='A',kind:ThreadInput['kind']='supplement'):ThreadInput{
 const message:GroupMessage={id:room+':'+seq,messageId:String(seq),roomId:room,platform:'replay',authorId:author,authorName:author,text,timestamp:1_795_000_000_000+seq,isMentioned:true,isAdmin:false,mentions:['bot'],attachments:[]};
 return{seq,revision:seq,kind,message,routingContext:{resolvedRequest:text.length<700?text:'历史对话记录，保留原文归属核对；没有新增要求。',routingMetadata:{'test-calculation':{required:false}},sourceMessageIds:[message.id]}};
}
function makeScenario(id:string,variant:0|1,oversized=false):Scenario{
 const room='worker-comparison:'+id,inputs:ThreadInput[]=[];
 const filler='这是已归档的测试对话记录，仅用于长历史读取；本段没有新增预算、文档或交付要求，已有有效要求不变。';
 const count=oversized?72:44,repeat=oversized?48:22;
 for(let seq=1;seq<=count;seq++){
  let text=filler.repeat(repeat),author='A',kind:ThreadInput['kind']='supplement';
  if(seq===1){text=variant===0?'我的预算是10元，保留现有键盘，不要更换键盘。':'我的预算是12元，保留现有显示器，原计划使用笔记本电脑。';kind='question';}
  if(seq===13){text=variant===0?'我是成员B，我自己的预算是100元，请保留我的路由器，我的条件不能覆盖A。':'我是成员B，我的预算80元，请保留鼠标。不要把我的物品或预算写到A名下。';author='B';kind='question';}
  if(seq===26){text=variant===0?'更正一下，我的预算从10元改为5元，其余没有改。':'更正：我不要笔记本电脑了，改为台式机，预算和保留设备要求都不变。';kind='correction';}
  if(seq===count)text='现在核对各作者的当前预算、保留设备和电脑类型。此前没有被更正的条件继续保留，只输出所需键值，不执行分析任务。';
  inputs.push(input(room,seq,text,author,kind));
 }
 const expected=variant===0?{aBudget:'5',bBudget:'100',aKeep:'键盘',aDevice:'未指定',bKeep:'路由器'}:{aBudget:'12',bBudget:'80',aKeep:'显示器',aDevice:'台式机',bKeep:'鼠标'};
 return{id,oversized,inputs,expected,...(!oversized?{second:{text:variant===0?'我的预算现在改为7元，键盘仍保留；B的条件不变。再次核对各作者当前条件。':'我的预算改为7元，显示器仍保留，设备按上次更正后的对象；B的条件不变。再次核对当前条件。',expected:{...expected,aBudget:'7'}}}:{})};
}
const scenarios=[makeScenario('budget-authorship',0),makeScenario('device-correction',1),...(flags.has('--oversized')?[makeScenario('oversized-legacy',0,true)]:[])].filter(s=>!flags.has('--scenarios')||flags.get('--scenarios')!.split(',').includes(s.id));
if(!scenarios.length)throw new Error('No matching scenarios');
for(const s of scenarios){const n=JSON.stringify(s.inputs).length;if(s.oversized?n<=160_000:n>=160_000||n<=48_000)throw new Error('Fixture size outside intended band: '+s.id+' '+n);}
const rows:any[]=[];
const record:any={status:'prepared',startedAt:new Date().toISOString(),baseline:relative(root,baseline),configRevisionBefore:agentSettingsRevision(root),model:{provider:base.worker.provider,model:base.worker.model,reasoningEffort:base.worker.reasoningEffort,maxTokens:base.worker.maxTokens},
 sourceHashesBefore:Object.fromEntries(Object.entries(arms).map(([arm,source])=>[arm,sourceHashes(source)])),fixtureHash:hash(JSON.stringify(scenarios)),domainPromptHash:hash(probeInstruction),fixtures:scenarios.map(s=>({id:s.id,originalSerializedChars:JSON.stringify(s.inputs).length,inputCount:s.inputs.length,runs:s.second?2:1,oversized:s.oversized})),
 gradingVersion:'field-value-v2-prefix-normalization',
 limits:['Raw audit separates uncached input, cache reads/writes and compaction usage; runtime inputTokens alone is not total context input.','Real configured Worker model; inert domain with no professional tools or external actions. Tests task understanding rather than subject-matter answer accuracy.','Checkpoint is supplied to candidate phase2 only when phase1 host actually produced one; no fabricated checkpoint.','Both arms resume their own session through two runs. Alternating order by scenario reduces but does not remove cache/network bias.','oversized-legacy is a separate capability test; baseline is expected to reject before a model call.','Token totals use successful-call provider metrics and can omit failed-request usage; not billing.','All inputs are synthetic. Same thread identifiers in independent state roots cannot cross-read other arm history.'],rows};
function summarize(){return Object.fromEntries(Object.keys(arms).map(arm=>{const rs=rows.filter(r=>r.arm===arm),ms=rs.flatMap(r=>r.metrics);return[arm,{shared:rs.filter(r=>!r.oversized).map(r=>({scenario:r.scenario,phase:r.phase,pass:r.pass,elapsedMs:r.elapsedMs,inputTokens:r.metrics.reduce((n:number,m:RuntimeMetrics)=>n+m.inputTokens,0),outputTokens:r.metrics.reduce((n:number,m:RuntimeMetrics)=>n+m.outputTokens,0),historyCalls:r.trace.historyCalls.length,payloadChars:r.trace.workerPayloadChars,checkpointProduced:r.checkpointProduced})),capability:rs.filter(r=>r.oversized).map(r=>({pass:r.pass,actualOutcome:r.actualOutcome,expectedRejection:r.expectedRejection,error:r.error})),successfulModelMetrics:ms.length,inputTokens:ms.reduce((n:number,m:RuntimeMetrics)=>n+m.inputTokens,0),outputTokens:ms.reduce((n:number,m:RuntimeMetrics)=>n+m.outputTokens,0),formatOrCoverageRepairCalls:ms.filter((m:RuntimeMetrics)=>m.phase==='repair').length}];}));}
function save(){record.summary=summarize();const tmp=join(output,'result.tmp.json');writeFileSync(tmp,JSON.stringify(record,null,2)+'\n',{mode:0o600});renameSync(tmp,join(output,'result.json'));}
function files(folder:string):string[]{return existsSync(folder)?readdirSync(folder,{withFileTypes:true}).flatMap(e=>e.isDirectory()?files(join(folder,e.name)):e.name==='session.v4.jsonl'?[join(folder,e.name)]:[]):[];}
function trace(state:string,runId:string){
 const workerPayloadChars:number[]=[],historyCalls:unknown[]=[];let inRun=false;
 for(const file of files(join(state,'dsh/sessions')))for(const line of readFileSync(file,'utf8').split('\n')){
  let event;try{event=JSON.parse(line);}catch{continue;}
  if(event.type==='user/message')for(const block of (event.data.message??event.data).content??[]){if(block.type!=='text')continue;let payload;try{payload=JSON.parse(block.text);}catch{continue;}
   if(payload.runId&&Array.isArray(payload.inputs)){inRun=payload.runId===runId;if(inRun)workerPayloadChars.push(block.text.length);}}
  if(inRun&&event.type==='tool/call'&&event.data.name==='worker_input_history')historyCalls.push(event.data.arguments);
 }
 return {workerPayloadChars,historyCalls};
}
function grade(report:WorkerReport|undefined,expected:Scenario['expected']){
 const text=(report?.shortAnswer??'').replace(/\s/g,'');
 const value=(label:string)=>text.match(new RegExp('(?:^|[；;,，。])'+label+'[=:：]([^；;,，。]+)'))?.[1];
 // Compare complete field values, allowing only harmless item-description prefixes.
 // This applies equally to both arms; raw reports remain unchanged in evidence.
 const item=(label:string)=>value(label)?.replace(/^(?:(?:现有|原有|当前|我的|本人的|已有)(?:的)?)+/,'');
 const fields={aBudget:value('A预算')?.toUpperCase()===expected.aBudget+'元',bBudget:value('B预算')?.toUpperCase()===expected.bBudget+'元',
  aKeep:item('A保留')===expected.aKeep,aDevice:item('A设备')===expected.aDevice,bKeep:item('B保留')===expected.bKeep};
 return {statusReady:report?.status==='ready',...fields};
}
if(flags.has('--dry-run')){console.log(JSON.stringify({output,fixtures:record.fixtures,expectedModelStarts:scenarios.reduce((n,s)=>n+(s.second?4:2),0)},null,2));process.exit(0);}
mkdirSync(output,{recursive:true,mode:0o700});writeFileSync(join(output,'fixtures.json'),JSON.stringify(scenarios,null,2)+'\n',{mode:0o600});record.status='running';save();
for(const [index,scenario]of scenarios.entries())for(const arm of index%2?['candidate','baseline']:['baseline','candidate']){
 const source=arms[arm as keyof typeof arms],{DshRuntime}=await load(source,'dsh-runtime.ts');
 const stateDir=join(output,arm,scenario.id),config={...structuredClone(base),stateDir,qq:{...base.qq,enabled:false}};
 let metrics:RuntimeMetrics[]=[];
 const runtime:RuntimePort=await DshRuntime.create(config,{onMetrics:(m:RuntimeMetrics)=>metrics.push(m),capabilityFactory:async()=>({tools:[],systemContext:probeInstruction,finalizeAnswer:async(answer:string)=>answer,close:async()=>{}})});
 let previous:WorkerReport['requirementSnapshot'];const inputs=structuredClone(scenario.inputs);
 try{for(let phase=1;phase<=(scenario.second?2:1);phase++){
  if(phase===2)inputs.push(input(inputs[0].message.roomId,inputs.length+1,scenario.second!.text,'A','correction'));
  const runId='r-phase-'+phase,workspace=join(stateDir,'workspaces',scenario.id,runId);
  mkdirSync(workspace,{recursive:true,mode:0o700});metrics=[];
  const request:WorkerRequest={thread:{id:'t-'+scenario.id,roomId:inputs[0].message.roomId,subject:'隔离需求核对测试',ownerId:'A',sourceMessageId:'1',explicit:true,participants:['A','B'],status:'running',revision:inputs.length,latestInputSeq:inputs.length,sessionId:'worker-'+scenario.id,epoch:phase,summary:''},runId,inputs:structuredClone(inputs),workspace,
    ...(arm==='candidate'&&previous?{previousRequirementSnapshot:previous}:{})};
  const started=Date.now();let report:WorkerReport|undefined,error:string|undefined;
  try{report=await runtime.runWorker(request);}catch(e){error=safe(e);}
  const checks=grade(report,phase===1?scenario.expected:scenario.second!.expected),expectedRejection=scenario.oversized&&arm==='baseline';
  const row={arm,scenario:scenario.id,oversized:scenario.oversized,phase,elapsedMs:Date.now()-started,originalSerializedChars:JSON.stringify(inputs).length,previousCheckpointSupplied:Boolean(request.previousRequirementSnapshot),checkpointProduced:Boolean(report?.requirementSnapshot),report,checks,error,metrics:[...metrics],trace:trace(stateDir,runId),expectedRejection,
    actualOutcome:error?'runtime_rejection':report?.status??'no_report',pass:expectedRejection?Boolean(error?.includes('Worker input exceeds size limit')):!error&&Object.values(checks).every(Boolean)};
  rows.push(row);previous=report?.requirementSnapshot;save();console.log(JSON.stringify({arm,scenario:scenario.id,phase,pass:row.pass,checks,elapsedMs:row.elapsedMs,checkpointProduced:row.checkpointProduced,...(error?{error}:{})}));
 }}finally{await runtime.close();save();}
}
record.rawUsageAudit=Object.fromEntries(Object.keys(arms).map(arm=>[arm,auditDshUsage(join(output,arm))]));
record.sourceHashesAfter=Object.fromEntries(Object.entries(arms).map(([arm,source])=>[arm,sourceHashes(source)]));record.sourcesUnchanged=JSON.stringify(record.sourceHashesBefore)===JSON.stringify(record.sourceHashesAfter);
record.configRevisionAfter=agentSettingsRevision(root);record.configUnchanged=record.configRevisionBefore===record.configRevisionAfter;record.status='completed';record.completedAt=new Date().toISOString();save();
console.log(JSON.stringify({output,summary:record.summary,sourcesUnchanged:record.sourcesUnchanged}));if(!record.sourcesUnchanged||!record.configUnchanged||rows.some(r=>!r.pass))process.exitCode=1;
