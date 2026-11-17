/** Paired current-policy Router comparison. Run only after candidate is ready; no QQ or domain calls. */
import {createHash,randomUUID} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,readdirSync,renameSync,writeFileSync} from 'node:fs';
import {join,resolve,relative,dirname,basename} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {snapshotComparisonScenarios as comparisonScenarios,resultFailures,type SnapshotTurn as ComparisonTurn} from '../fixtures/router-snapshot-comparison.js';
import type {ExpectedRoute} from '../fixtures/p1-comparison.js';
import {traceSessionDelta,sessionWatermark,sumTraces} from './router-comparison-audit.js';
import type {Config} from '../src/config.js';
import type {RouteAction,RuntimePort,RouterContextQuery} from '../src/types.js';
import type {RuntimeMetrics} from '../src/dsh-runtime.js';


const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const flags=new Map(process.argv.slice(2).map(arg=>{const i=arg.indexOf('=');return i<0?[arg,'true']:[arg.slice(0,i),arg.slice(i+1)];}));
if(!flags.get('--baseline')||flags.get('--baseline')==='true')throw new Error('Provide --baseline=<source-directory>');
const baseline=resolve(root,flags.get('--baseline')!);
const repeat=Number(flags.get('--repeat')??1),selected=flags.get('--scenarios')?.split(',');
if(!Number.isInteger(repeat)||repeat<1||repeat>5)throw new Error('--repeat must be 1..5');
const warm=flags.has('--warm-diagnostic');
if(warm&&(!flags.get('--evidence')||flags.get('--evidence')==='true'))throw new Error('Warm diagnostics require --evidence=<snapshot-directory>');
const evidenceRoot=resolve(root,flags.get('--evidence')??'.');
let scenarios=comparisonScenarios().filter(s=>!selected||selected.includes(s.id));
if(warm){
  const request=JSON.parse(readFileSync(join(evidenceRoot,'request.private.json'),'utf8'));
  scenarios=[{id:'production-warm-diagnostic',turns:[{id:'selected-request',request,tags:['production-warm-diagnostic'],
    expected:request.messages.map((m:{id:string})=>({messageId:m.id,actions:['open_thread'] as RouteAction['action'][]}))}]}];
}
if(!scenarios.length)throw new Error('No matching scenarios');
const runId='effect-'+new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomUUID().slice(0,8);
const output=resolve(root,flags.get('--output')??'.runtime/comparison/router/'+runId);
if(existsSync(output))throw new Error('Output already exists; use a new directory to preserve earlier evidence');
const sha=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
function hashes(source:string,folder=join(source,'src')):Record<string,string>{
  return Object.fromEntries(readdirSync(folder,{withFileTypes:true}).flatMap(entry=>{
    const file=join(folder,entry.name);return entry.isDirectory()?Object.entries(hashes(source,file)):
      /\.(ts|py|js)$/.test(file)?[[relative(source,file),sha(readFileSync(file))]]:[];
  }));
}
const arms={baseline,candidate:resolve(root,flags.get('--candidate')??'.')};
const sourceHashes=Object.fromEntries(Object.entries(arms).map(([arm,path])=>[arm,hashes(path)]));
const fixtureHash=sha(JSON.stringify(scenarios));
const load=(source:string,file:string)=>import(pathToFileURL(join(source,'src',file)).href);
const {loadConfig,agentSettingsRevision}=await load(root,'config.ts');
const {Store}=await load(root,'store.ts');
const base:Config=loadConfig(root);
const secretValues=[base.apiKey,base.routerApiKey,base.workerApiKey,base.qq.accessToken].filter(Boolean);
const safe=(error:unknown)=>secretValues.reduce((text,secret)=>text.replaceAll(secret,'[redacted]'),String(error)).replace(/Bearer\s+[^\s"']+/gi,'Bearer [redacted]').slice(0,2000);
interface Check {messageId:string;pass:boolean;expected:ExpectedRoute;actual:RouteAction[];failures:string[]}
interface Row {arm:string;scenario:string;repeat:number;turn:string;tags:string[];actions:RouteAction[];checks:Check[];pass:boolean;elapsedMs:number;metrics:RuntimeMetrics[];recallQueries:RouterContextQuery[];rawActions:RouteAction[];trace:ReturnType<typeof traceSessionDelta>;resultFailures:string[];error?:string}
const rows:Row[]=[];
const report:{[key:string]:any}={status:'prepared',runId,startedAt:new Date().toISOString(),baseline:relative(root,baseline),sourceHashesBefore:sourceHashes,
  fixtureHash,configRevisionBefore:agentSettingsRevision(root),model:{provider:base.router.provider,model:base.router.model,reasoningEffort:base.router.reasoningEffort,maxTokens:base.router.maxTokens},
  mode:warm?'production-warm-diagnostic':'synthetic-current-policy',
  ...(warm?{productionEvidence:JSON.parse(readFileSync(join(evidenceRoot,'evidence.json'),'utf8'))}:{}),
  configuredLimits:{routerTimeoutMs:base.routerTimeoutMs,routerContextChars:base.routerContextChars,recentMessageLimit:base.recentMessageLimit,threadCardLimit:base.threadCardLimit},
  comparison:{repeats:repeat,scenarios:scenarios.map(s=>({id:s.id,turns:s.turns.length})),paired:true,order:'Alternating baseline/candidate per scenario and repetition'},
  limitations:['Raw audit separates uncached input, cache reads/writes and compaction usage; runtime inputTokens alone is not total context input.','Synthetic labeled route tests, not all production traffic or a blinded answer-quality evaluation.',
    'Current explicit-activation policy is graded equally in both arms; original P1 fixtures are retained unchanged. Result events are graded by action and exact result identity.',
    'Recall-only capability cases intentionally omit earlier facts/tasks from the latest snapshot while preserving them in the same local database; report these separately from shared visible-context cases.',
    'Workers, external domain tools and QQ sending are not invoked by this harness.',
    'Sequential same-config calls can still differ because of provider load, stochastic output and prompt caches.',
    'Provider-reported successful-call token totals are not an invoice; failed-request usage may be absent.',
    'Store-memory recall uses immutable same-room history available equally to both arms; no native-session-only hidden information is required.',
    'Action failures are retained; the harness does not tune fixtures or retry failed cases until they pass.'],rows};
function percentile(values:number[],p:number){const sorted=[...values].sort((a,b)=>a-b);return sorted[Math.max(0,Math.ceil(sorted.length*p)-1)]??null;}
function summarize(){
  return Object.fromEntries(Object.keys(arms).map(arm=>{
    const entries=rows.filter(r=>r.arm===arm),checks=entries.flatMap(r=>r.checks),metrics=entries.flatMap(r=>r.metrics);
    const quiet=checks.filter(c=>c.expected.actions.length===1&&c.expected.actions[0]==='silence');
    const active=checks.filter(c=>!c.expected.actions.includes('silence'));
    const shared=entries.filter(r=>!r.tags.includes('capability-recall')),recall=entries.filter(r=>r.tags.includes('capability-recall'));
    return [arm,{sharedVisibleContext:{turns:shared.length,passed:shared.filter(r=>r.pass).length},recallCapability:{turns:recall.length,passed:recall.filter(r=>r.pass).length},turns:entries.length,passedTurns:entries.filter(r=>r.pass).length,messages:checks.length,passedMessages:checks.filter(c=>c.pass).length,
      falseActivations:quiet.filter(c=>c.actual.some(a=>a.action!=='silence')).length,quietMessages:quiet.length,
      missedActivations:active.filter(c=>c.actual.length===0||c.actual.every(a=>a.action==='silence')).length,activeMessages:active.length,
      runtimeErrors:entries.filter(r=>r.error).length,recallCalls:entries.reduce((n,r)=>n+r.recallQueries.length,0),completedRuntimeSends:metrics.length,formatRepairCalls:metrics.filter(m=>m.phase==='repair').length,
      actualUsage:sumTraces(entries.map(e=>e.trace)),
      inputTokens:metrics.reduce((n,m)=>n+m.inputTokens,0),outputTokens:metrics.reduce((n,m)=>n+m.outputTokens,0),
      compactionSummaries:metrics.reduce((n,m)=>n+(m.compaction?.summaries??0),0),
      compactionInputTokens:metrics.reduce((n,m)=>n+(m.compaction?.inputTokens??0),0),compactionOutputTokens:metrics.reduce((n,m)=>n+(m.compaction?.outputTokens??0),0),
      latencyMs:{p50:percentile(entries.map(r=>r.elapsedMs),.5),p95:percentile(entries.map(r=>r.elapsedMs),.95)},
      setupMs:{p50:percentile(metrics.flatMap(m=>m.setupMs===undefined?[]:[m.setupMs]),.5),p95:percentile(metrics.flatMap(m=>m.setupMs===undefined?[]:[m.setupMs]),.95)},
      queueMs:{p50:percentile(metrics.flatMap(m=>m.queueMs===undefined?[]:[m.queueMs]),.5),p95:percentile(metrics.flatMap(m=>m.queueMs===undefined?[]:[m.queueMs]),.95)},
      byTag:Object.fromEntries([...new Set(entries.flatMap(r=>r.tags))].map(tag=>{const group=entries.filter(r=>r.tags.includes(tag));return[tag,{turns:group.length,passed:group.filter(r=>r.pass).length}];}))}];
  }));
}
function save(){report.summary=summarize();const tmp=join(output,'result.tmp.json');writeFileSync(tmp,JSON.stringify(report,null,2)+'\n',{mode:0o600});renameSync(tmp,join(output,'result.json'));}
function seedWarm(stateDir:string){
  const raw=readFileSync(join(evidenceRoot,'warm-prefix.private.jsonl'),'utf8'),header=JSON.parse(raw.split('\n')[0]);
  const generation=JSON.parse(readFileSync(join(evidenceRoot,'generation.private.json'),'utf8'));
  const evidence=JSON.parse(readFileSync(join(evidenceRoot,'evidence.json'),'utf8'));
  if(sha(raw)!==evidence.source.clonePrefixSha256||header.id!==generation.activeId)throw new Error('Warm evidence integrity mismatch');
  // The backend locates the copied session by ID under its own private root.
  // Keep its original cwd metadata and directory name for faithful restoration.
  const sourceFolder=basename(dirname(dirname(evidence.source.file)));
  const file=join(stateDir,'dsh/sessions',sourceFolder,header.id,'session.v4.jsonl');
  mkdirSync(dirname(file),{recursive:true,mode:0o700});writeFileSync(file,raw,{flag:'wx',mode:0o600});
  const pointer=join(stateDir,'dsh/session-generations',sha(generation.logicalId)+'.json');
  mkdirSync(dirname(pointer),{recursive:true,mode:0o700});writeFileSync(pointer,JSON.stringify(generation)+'\n',{flag:'wx',mode:0o600});
}
function grade(turn:ComparisonTurn,actions:RouteAction[]):Check[]{
  const expectedSources=new Set(turn.request.messages.map(m=>m.id));
  const illegalSource=actions.some(a=>'sourceMessageIds'in a&&a.sourceMessageIds.some(id=>!expectedSources.has(id)));
  return turn.expected.map(expected=>{
    const actual=actions.filter(a=>'sourceMessageIds'in a&&a.sourceMessageIds.includes(expected.messageId));const failures:string[]=[];
    if(actual.length!==1||actual.some(a=>'sourceMessageIds'in a&&a.sourceMessageIds.filter(id=>id===expected.messageId).length!==1))failures.push('source coverage is not exactly once');
    if(illegalSource)failures.push('historical or unknown source ID');
    const a=actual[0];if(!a||!expected.actions.includes(a.action))failures.push('action class');
    if(expected.threadId&&(!a||!('threadId'in a)||a.threadId!==expected.threadId))failures.push('thread target');
    if(expected.kind&&(!a||a.action!=='append_thread'||a.kind!==expected.kind))failures.push('correction kind');
    if(expected.textContains&&(!a||!('text'in a)||!a.text.includes(expected.textContains)))failures.push('exact recalled fact');
    if(expected.contextMessageId&&(!a||!('contextMessageIds'in a)||!a.contextMessageIds?.includes(expected.contextMessageId)))failures.push('historical context handoff');
    return {messageId:expected.messageId,pass:failures.length===0,expected,actual,failures};
  });
}
if(flags.has('--dry-run')){console.log(JSON.stringify({baseline,output,mode:report.mode,fixtureHash,scenarios:report.comparison.scenarios,routeTurnsPerArm:scenarios.reduce((n,s)=>n+s.turns.length,0)*repeat,sourceFileCounts:Object.fromEntries(Object.entries(sourceHashes).map(([arm,hashes])=>[arm,Object.keys(hashes).length]))},null,2));process.exit(0);}
mkdirSync(output,{recursive:true,mode:0o700});writeFileSync(join(output,'fixtures.json'),JSON.stringify(scenarios,null,2)+'\n',{mode:0o600});report.status='running';save();
for(let repetition=0;repetition<repeat;repetition++)for(let index=0;index<scenarios.length;index++){
  const scenario=scenarios[index],order=(index+repetition)%2?['candidate','baseline']:['baseline','candidate'];
  for(const arm of order){
    const source=arms[arm as keyof typeof arms],{DshRuntime}=await load(source,'dsh-runtime.ts');
    const {enforceReferenceThreads}=await load(source,'protocol.ts');
    const stateDir=join(output,arm,'repeat-'+repetition,scenario.id);
    if(warm)seedWarm(stateDir);
    const config={...structuredClone(base),stateDir,qq:{...base.qq,enabled:false}};
    const store=new Store(join(stateDir,'context.sqlite'));
    let metrics:RuntimeMetrics[]=[];
    const runtime:RuntimePort=await DshRuntime.create(config,{onMetrics:(m:RuntimeMetrics)=>{metrics.push(m);}});
    try{for(const turn of scenario.turns){
      metrics=[];let actions:RouteAction[]=[],rawActions:RouteAction[]=[],error:string|undefined;const recallQueries:RouterContextQuery[]=[];
      const request=structuredClone(turn.request);
      for(const m of [...(turn.history?.messages??[]),...request.recentMessages,...Object.values(request.references??{}).flatMap(ref=>ref.message?[ref.message]:[])]){store.ingest(m);store.messageStatus(m.id,'routed');}
      for(const t of [...(turn.history?.threads??[]),...request.threads])store.saveThread({...t,updatedAt:request.currentTime??0,failures:0});
      for(const reply of request.recentReplies??[])store.enqueue({roomId:request.roomId,text:reply.text,replyToMessageId:reply.replyToMessageId},{id:request.roomId+':seed-reply:'+reply.messageId,status:'sent',platformMessageId:reply.messageId,sentAt:reply.sentAt});
      for(const m of request.messages)store.ingest(m);
      const lookup=store.routerContextReader(request.roomId,request.messages[0]?.id,request.currentTime);
      const reader=async(query:RouterContextQuery)=>{recallQueries.push(query);return lookup(query);};
      const watermark=sessionWatermark(stateDir),started=Date.now();
      try{rawActions=await runtime.route(request,reader);actions=enforceReferenceThreads(rawActions,request);}catch(e){error=safe(e);}
      const checks=grade(turn,actions),extraFailures=resultFailures(turn,actions),trace=traceSessionDelta(stateDir,watermark),row:Row={arm,scenario:scenario.id,repeat:repetition,turn:turn.id,tags:turn.tags,actions,checks,pass:!error&&checks.every(c=>c.pass)&&extraFailures.length===0,resultFailures:extraFailures,trace,elapsedMs:Date.now()-started,metrics:[...metrics],recallQueries,rawActions,...(error?{error}:{})};
      rows.push(row);for(const m of request.messages)store.messageStatus(m.id,'routed');save();console.log(JSON.stringify({arm,scenario:scenario.id,repeat:repetition,turn:turn.id,pass:row.pass,elapsedMs:row.elapsedMs,...(error?{error}:{})}));
    }}finally{try{await runtime.close();}finally{store.close();save();}}
  }
}
report.rawUsageAudit=Object.fromEntries(Object.keys(arms).map(arm=>[arm,sumTraces(rows.filter(row=>row.arm===arm).map(row=>row.trace))]));
report.sourceHashesAfter=Object.fromEntries(Object.entries(arms).map(([arm,path])=>[arm,hashes(path)]));
report.configRevisionAfter=agentSettingsRevision(root);report.configUnchanged=report.configRevisionBefore===report.configRevisionAfter;
report.sourcesUnchanged=JSON.stringify(report.sourceHashesBefore)===JSON.stringify(report.sourceHashesAfter);
report.status='completed';report.completedAt=new Date().toISOString();
report.pairedChanges=rows.filter(r=>r.arm==='candidate').map(candidate=>{const old=rows.find(r=>r.arm==='baseline'&&r.scenario===candidate.scenario&&r.repeat===candidate.repeat&&r.turn===candidate.turn)!;return{scenario:candidate.scenario,turn:candidate.turn,repeat:candidate.repeat,baselinePass:old.pass,candidatePass:candidate.pass,latencyDifferenceMs:candidate.elapsedMs-old.elapsedMs};});save();
console.log(JSON.stringify({output,summary:report.summary,sourcesUnchanged:report.sourcesUnchanged}));
if(!report.sourcesUnchanged||!report.configUnchanged||rows.some(r=>!r.pass))process.exitCode=1;
