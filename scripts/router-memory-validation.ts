/** Isolated real-model validation. Defaults to a read-only plan; --execute is explicit. */
import {createHash,randomUUID} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,readdirSync,renameSync,writeFileSync} from 'node:fs';
import {basename,dirname,join,relative,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {roomMemoryValidationTurns,type MemoryValidationTurn} from '../fixtures/router-memory-validation.js';
import {sessionWatermark,traceSessionDelta,sumTraces} from './router-comparison-audit.js';
import type {GroupMessage,RouteAction,RouterRequest} from '../src/types.js';

const flags=new Map(process.argv.slice(2).map(arg=>{const at=arg.indexOf('=');return at<0?[arg,'true']:[arg.slice(0,at),arg.slice(at+1)];}));
if(!flags.get('--baseline')||flags.get('--baseline')==='true')throw new Error('Provide --baseline=<source-directory>');
const scriptRoot=resolve(fileURLToPath(new URL('..',import.meta.url)));
const root=resolve(flags.get('--project-root')??scriptRoot);
const execute=flags.has('--execute'),selected=(flags.get('--scenarios')??'incident,continuity').split(',');
if(selected.some(id=>!['incident','continuity'].includes(id)))throw new Error('Scenarios are incident,continuity');
const maxBackgroundCalls=Number(flags.get('--max-background-calls')??24);
if(!Number.isSafeInteger(maxBackgroundCalls)||maxBackgroundCalls<1)throw new Error('Invalid background call cap');
const backgroundWaitMs=Number(flags.get('--background-wait-ms')??600_000);
if(!Number.isSafeInteger(backgroundWaitMs)||backgroundWaitMs<1000)throw new Error('Invalid offline background wait');
const capacitySignals=new Set(['MEMORY_OUTPUT_TRUNCATED','MEMORY_INPUT_CAPACITY']);
const terminalValidationSignals=new Set(['MEMORY_NOTES_INVALID','MEMORY_SOURCE_INVALID','MEMORY_SOURCE_CHANGED','MEMORY_SUPERSEDES_INVALID',
 'MEMORY_BUDGET_INVALID','MEMORY_SUMMARY_FAILED','VALIDATION_CALL_LIMIT','AUTH','MISSING_CREDENTIAL','INVALID_CREDENTIAL','NO_ADAPTER']);
const arms={baseline:resolve(root,flags.get('--baseline')!),candidate:resolve(root,flags.get('--candidate')??'.')};
const output=resolve(root,flags.get('--output')??'.runtime/comparison/memory-'+new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomUUID().slice(0,8));
if(existsSync(output))throw new Error('Output exists; earlier validation evidence must remain immutable');
if(!flags.get('--incident-dir')||flags.get('--incident-dir')==='true')throw new Error('Provide --incident-dir=<captured-evidence-directory>');
const incidentRoot=resolve(root,flags.get('--incident-dir')!);
const evidence=JSON.parse(readFileSync(join(incidentRoot,'evidence-private.json'),'utf8'));
const originalRequest=evidence.request as RouterRequest;
const sourceLog=join(incidentRoot,'compaction-analysis/session-private.v4.jsonl');
const originalLog=readFileSync(sourceLog,'utf8'),events=originalLog.trimEnd().split('\n').map(line=>JSON.parse(line));
const targetId=originalRequest.messages[0].id;
// The incident first appears in its inbox insertion. Stop before that event,
// retaining the earlier settled timeout but never replaying the target twice.
const cutEvent=events.find(e=>e.type==='agent/inbox/spliced'&&e.data?.inserted?.some((m:any)=>m.content?.some((b:any)=>b.type==='text'&&b.text.includes(targetId))));
if(!cutEvent)throw new Error('Cannot find the incident request intake boundary in the fixed log copy');
const warmEvents=events.filter(e=>e.type==='session'||e.seq<cutEvent.seq),warmPrefix=warmEvents.map(e=>JSON.stringify(e)).join('\n')+'\n';
const header=events[0],sha=(v:string|Buffer)=>createHash('sha256').update(v).digest('hex');
function sourceHashes(source:string,directory=join(source,'src')):Record<string,string>{return Object.fromEntries(readdirSync(directory,{withFileTypes:true}).flatMap(entry=>{
 const file=join(directory,entry.name);return entry.isDirectory()?Object.entries(sourceHashes(source,file)):/\.(ts|js|py)$/.test(file)?[[relative(source,file),sha(readFileSync(file))]]:[];
}));}
const hashBefore=Object.fromEntries(Object.entries(arms).map(([arm,source])=>[arm,sourceHashes(source)]));
const continuity=roomMemoryValidationTurns();
const plan={stage:flags.get('--stage')??'final-validation',scenarios:selected,routeInputsPerArm:selected.reduce((n,id)=>n+(id==='incident'?1:continuity.length),0),maxBackgroundCalls,backgroundWaitMs,
 baseline:relative(root,arms.baseline),candidate:relative(root,arms.candidate),output,
 incident:{requestSha256:sha(JSON.stringify(originalRequest)),sourceLogSha256:sha(originalLog),clonePrefixSha256:sha(warmPrefix),exclusiveSeq:cutEvent.seq},
 fixtureSha256:sha(JSON.stringify(continuity)),
 notes:['Baseline restores the captured continuous-session prefix; both arms receive the exact incident request and the same captured source records.',
 'Candidate uses persistent Store memory and scoped recall. Background bootstrap work is measured separately and included in final usage.',
 'Continuity includes two authors, an uncalled neighbour, an explicit correction and quote, then Store/runtime restart before exact-value recall.',
 'No professional Worker runs, public delivery, production database writes or service restarts. Models use the currently configured Router route.',
 'One runtime.route attempt per input; the historical Coordinator outer retry is not silently replayed. Internal model/tool loops are fully counted.',
 'Model calls may exceed route inputs because of recall, repair, original baseline compaction and candidate background summaries.']};
plan.notes.push('Capacity adaptation signals are retained as retry evidence, not final failures. Product retry logic runs unchanged; only invalid notes/provenance, the offline call cap, or the offline wait deadline halts this experiment.');
if(!execute){console.log(JSON.stringify({mode:'prepared-no-model-calls',...plan},null,2));process.exit(0);}

const load=(source:string,file:string)=>import(pathToFileURL(join(source,'src',file)).href);
// All candidate support modules come from the same frozen source tree as its
// DshRuntime. The project root supplies configuration and read-only evidence.
const {loadConfig,agentSettingsRevision}=await load(arms.candidate,'config.ts'),base=loadConfig(root);
const {Store}=await load(arms.candidate,'store.ts');
const {RoomMemoryWorker}=await load(arms.candidate,'room-memory-worker.ts');
const {attachRoomMemory}=await load(arms.candidate,'router-context-builder.ts');
const secrets=[base.apiKey,base.routerApiKey,base.workerApiKey,base.qq.accessToken].filter(Boolean);
for(const secret of secrets)if(originalLog.includes(secret))throw new Error('Known credential found in captured evidence; refuse copying');
const safe=(error:unknown)=>secrets.reduce((s:string,key:string)=>s.replaceAll(key,'[redacted]'),String(error)).replace(/Bearer\s+[^\s"']+/gi,'Bearer [redacted]').slice(0,1600);
mkdirSync(output,{recursive:true,mode:0o700});
const report:any={status:'running',startedAt:new Date().toISOString(),plan,sourceHashesBefore:hashBefore,configRevisionBefore:agentSettingsRevision(root),
 model:{provider:base.router.provider,model:base.router.model,reasoningEffort:base.router.reasoningEffort,maxTokens:base.router.maxTokens},rows:[],arms:[]};
const reusePath=flags.get('--reuse-baseline-incident');
let reusedBaseline:any;
if(reusePath){
 const source=resolve(root,reusePath),prior=JSON.parse(readFileSync(source,'utf8'));
 const arm=prior.arms?.find((a:any)=>a.arm==='baseline'&&a.scenario==='incident');
 const rows=prior.rows?.filter((r:any)=>r.arm==='baseline'&&r.scenario==='incident');
 if(!arm?.trace||rows?.length!==1||prior.plan.incident.requestSha256!==plan.incident.requestSha256
  ||prior.plan.incident.clonePrefixSha256!==plan.incident.clonePrefixSha256
  ||JSON.stringify(prior.sourceHashesBefore?.baseline)!==JSON.stringify(hashBefore.baseline)
  ||prior.configRevisionBefore!==report.configRevisionBefore||JSON.stringify(prior.model)!==JSON.stringify(report.model)){
  throw new Error('Reusable baseline does not match this frozen source/config/request/prefix or lacks completed evidence');
 }
 reusedBaseline={source,sha256:sha(readFileSync(source)),arm,rows};
 report.reusedBaselineIncident={source,sha256:reusedBaseline.sha256,note:'Linked completed baseline evidence, not a new provider invocation. Count this attempt only once in cumulative experiment cost.'};
}
function save(){const temp=join(output,'result.tmp.json');writeFileSync(temp,JSON.stringify(report,null,2)+'\n',{mode:0o600});renameSync(temp,join(output,'result.json'));}
writeFileSync(join(output,'incident-request.private.json'),JSON.stringify(originalRequest,null,2)+'\n',{flag:'wx',mode:0o600});
writeFileSync(join(output,'continuity-fixture.json'),JSON.stringify(continuity,null,2)+'\n',{flag:'wx',mode:0o600});save();

function warmClone(stateDir:string){
 const file=join(stateDir,'dsh/sessions',basename(dirname(dirname(evidence.sessionLog))),header.id,'session.v4.jsonl');
 mkdirSync(dirname(file),{recursive:true,mode:0o700});writeFileSync(file,warmPrefix,{flag:'wx',mode:0o600});
 const logicalId=header.id.replace(/-g\d+-.+$/,''),match=header.id.match(/-g(\d+)-/);
 if(match){const path=join(stateDir,'dsh/session-generations',sha(logicalId)+'.json');mkdirSync(dirname(path),{recursive:true,mode:0o700});
  writeFileSync(path,JSON.stringify({version:1,logicalId,activeId:header.id,generation:Number(match[1]),createdAt:header.createdAt})+'\n',{flag:'wx',mode:0o600});}
}
function historyRequests():RouterRequest[]{
 const requests:RouterRequest[]=[];
 for(const event of warmEvents){
  const messages=event.type==='user/message'?[event.data]:event.type==='agent/inbox/spliced'?event.data.inserted??[]:[];
  for(const m of messages)for(const b of m.content??[]){if(b.type!=='text')continue;try{const p=JSON.parse(b.text);if(p.roomId===originalRequest.roomId&&p.event&&Array.isArray(p.messages)&&!p.messages.some((x:GroupMessage)=>x.id===targetId))requests.push(p);}catch{/* checkpoint prose */}}
 }
 return requests;
}
function seedRequests(store:any,requests:RouterRequest[]){
 const messages=new Map<string,GroupMessage>(),threads=new Map<string,any>(),replies=new Map<string,any>();
 for(const r of requests){
  for(const m of [...r.messages,...r.recentMessages,...Object.values(r.references??{}).flatMap(ref=>ref.message?[ref.message]:[])]){
   const prior=messages.get(m.id);if(!prior||m.text.length>prior.text.length)messages.set(m.id,m);
  }
  for(const t of r.threads)threads.set(t.id,t);
  for(const b of r.recentReplies??[])replies.set(b.messageId??JSON.stringify([b.sentAt,b.text]),b);
 }
 for(const m of [...messages.values()].sort((a,b)=>a.timestamp-b.timestamp)){store.ingest(m);store.messageStatus(m.id,'routed');}
 for(const t of threads.values())store.saveThread({...t,updatedAt:0,failures:0});
 for(const [id,b] of replies)store.enqueue({roomId:originalRequest.roomId,text:b.text,replyToMessageId:b.replyToMessageId},{id:'seed:'+id,status:'sent',platformMessageId:b.messageId,sentAt:b.sentAt});
 return{messages:messages.size,threads:threads.size,confirmedReplies:replies.size,
  truncatedMessagePreviews:[...messages.values()].filter(m=>(m as any).textTruncated).length,
  scope:'Only source records captured before the incident in this fixed log; this is not a copy of the full production database.'};
}
function grade(input:RouterRequest,actions:RouteAction[],turn?:MemoryValidationTurn){
 const failures:string[]=[];
 const wanted=turn?.expectedSources??input.messages.map(m=>({id:m.id,action:'open_thread' as const}));
 for(const e of wanted){const actual=actions.filter(a=>'sourceMessageIds'in a&&a.sourceMessageIds.includes(e.id));
  if(actual.length!==1||actual[0].action!==e.action)failures.push(e.id+': action/source coverage');
 }
 if(actions.some(a=>!('sourceMessageIds'in a)||a.sourceMessageIds.some(id=>!wanted.some(e=>e.id===id))))failures.push('unrequested action/source');
 const answer=actions.filter(a=>a.action==='reply_direct').map(a=>'text'in a?a.text:'').join('\n');
 for(const [label,expected] of Object.entries(turn?.expectedFields??{})){
  const match=answer.replace(/[*`]/g,'').match(new RegExp(label+'\\s*[=＝:：]\\s*([^；;，,\\n。]+)'));
  const value=match?.[1].trim().replace(/\s/g,'').replace(/^(?:现有|原有|当前|已有)(?:的)?/,'');
  if(value!==expected)failures.push(label+': expected '+expected+'; received '+(value??'missing'));
 }
 return{pass:failures.length===0,failures};
}

let backgroundCalls=0,haltReason:string|undefined;
for(let scenarioIndex=0;scenarioIndex<selected.length&&!haltReason;scenarioIndex++){
 const scenario=selected[scenarioIndex],order=scenarioIndex%2?['candidate','baseline']:['baseline','candidate'];
 for(const arm of order){
  if(haltReason)break;
  if(scenario==='incident'&&arm==='baseline'&&reusedBaseline){
   report.arms.push({...reusedBaseline.arm,reusedFrom:reusedBaseline.source});
   report.rows.push(...reusedBaseline.rows.map((row:any)=>({...row,reusedFrom:reusedBaseline.source})));
   save();console.log(JSON.stringify({arm,scenario,reusedFrom:reusedBaseline.source}));continue;
  }
  const stateDir=join(output,arm,scenario);mkdirSync(stateDir,{recursive:true,mode:0o700});
  const backgroundCallsBefore=backgroundCalls;
  const config={...structuredClone(base),root:stateDir,stateDir,qq:{...base.qq,enabled:false}};
  // Both arms get the captured local transcript. Only the baseline restores it.
  if(scenario==='incident')warmClone(stateDir);
  const db=join(stateDir,'context.sqlite');let store=new Store(db),runtime:any,memory:any;
  const metrics:any[]=[],backgroundEvents:any[]=[];let backgroundFinished=true;
  const initialWatermark=sessionWatermark(stateDir);
  const {DshRuntime}=await load(arms[arm as keyof typeof arms],'dsh-runtime.ts');
  const connect=async()=>{
   runtime=await DshRuntime.create(config,{onMetrics:(metric:any)=>metrics.push({at:Date.now(),...metric})});
   if(arm==='candidate')memory=new RoomMemoryWorker({store:store.roomMemory,concurrency:1,
    budget:(options:any,signal:AbortSignal)=>runtime.roomMemoryBudget(options,signal),
    summarize:(input:any,signal:AbortSignal)=>{
     if(backgroundCalls>=maxBackgroundCalls)throw Object.assign(new Error('Validation background call limit reached'),{code:'VALIDATION_CALL_LIMIT'});
     backgroundCalls++;return runtime.summarizeRoomMemory(input,signal);
    },
    onEvent:(event:any)=>{
     backgroundEvents.push({at:Date.now(),...event});save();
     console.log(JSON.stringify({arm,scenario,background:event.kind,targetSeq:event.targetSeq,coveredSeq:event.coveredSeq,...(event.code?{code:event.code}:{})}));
     if(event.kind==='failed'&&terminalValidationSignals.has(event.code)){
      haltReason='Background validation failed: '+event.code;
      // Capacity adaptation and transient provider retries belong to the real
      // product. Stop only invalid evidence/schema or the offline call cap.
      queueMicrotask(()=>{void memory.close().catch(()=>{});});
     }
    }});
  };
  const settle=async(label:string)=>{
   if(!memory)return{label,elapsedMs:0,complete:true};const start=Date.now();
   // Product backoff timers are deliberately unref'ed. An offline CLI must
   // remain alive while explicitly waiting; this handle never enters routing.
   const keepAlive=setInterval(()=>{},1000);
   try{await memory.whenIdle(AbortSignal.timeout(backgroundWaitMs));return{label,elapsedMs:Date.now()-start,complete:true};}
   catch(error){backgroundFinished=false;haltReason??='Offline background wait ended before completion';return{label,elapsedMs:Date.now()-start,complete:false,error:safe(error),status:memory.status()};}
   finally{clearInterval(keepAlive);}
  };
  const armResult:any={arm,scenario,stateDir:relative(output,stateDir),metrics,backgroundEvents,waits:[]};report.arms.push(armResult);save();
  try{
   if(scenario==='incident')armResult.seed=seedRequests(store,historyRequests());
   await connect();
   if(scenario==='incident'&&memory){
    memory.notify(originalRequest.roomId);armResult.waits.push(await settle('historical-memory-bootstrap'));save();
    if(haltReason)throw new Error(haltReason);
   }
   const turns=scenario==='incident'?[{id:'captured-incident',request:originalRequest}]:continuity;
   for(const turn of turns){
    if(haltReason)throw new Error(haltReason);
    const labeled='expectedSources'in turn?turn as MemoryValidationTurn:undefined;
    if(labeled?.restartBefore){
     armResult.waits.push(await settle('before-restart'));
     if(haltReason)throw new Error(haltReason);
     armResult.memoryBeforeRestart=arm==='candidate'?store.roomMemory.head(turn.request.roomId):undefined;
     if(memory)await memory.close();await runtime.close();store.close();store=new Store(db);await connect();
     armResult.memoryAfterRestart=arm==='candidate'?store.roomMemory.head(turn.request.roomId):undefined;
    }
    let input=structuredClone(turn.request);const metricsBefore=metrics.length,inputStarted=Date.now();
    // Preserve the actual current request. Candidate context is assembled by
    // the same memory/record builder as production, not a hand-made checkpoint.
    for(const m of input.messages)store.ingest(m);
    const reader=store.routerContextReader(input.roomId,input.messages[0]?.id,input.currentTime);
    const recallQueries:any[]=[];
    if(memory)input=attachRoomMemory(store,input,await runtime.routerContextBudget());
    const started=Date.now();let actions:RouteAction[]=[],error:string|undefined;
    try{actions=await runtime.route(input,async(q:any)=>{recallQueries.push(q);return reader(q);});}catch(e){error=safe(e);}
    const returned=Date.now(),checks=grade(input,actions,labeled);
    for(const m of input.messages)store.messageStatus(m.id,error?'failed':'routed');
    // Inert local delivery only; these records represent the harness's replies,
    // never a claim that QQ delivered a message.
    for(let n=0;n<actions.length;n++){const action=actions[n];if(action.action!=='reply_direct')continue;
     const origin=input.messages.find(m=>action.sourceMessageIds.includes(m.id));
     store.enqueue({roomId:input.roomId,text:action.text,replyToMessageId:origin?.messageId},{id:'local:'+turn.id+':'+n,status:'sent',platformMessageId:'local:'+turn.id+':'+n,sentAt:input.currentTime});
    }
    if(memory)memory.notify(input.roomId);
    const row={arm,scenario,turn:turn.id,elapsedMs:returned-inputStarted,routeCallMs:returned-started,contextSetupMs:started-inputStarted,startedAt:inputStarted,returnedAt:returned,actions,checks,pass:!error&&checks.pass,
     requestSha256:sha(JSON.stringify(input)),requestCharacters:JSON.stringify(input).length,workingMemory:input.workingMemory,
     recallQueries,metrics:metrics.slice(metricsBefore),...(error?{error}:{})};
    report.rows.push(row);save();console.log(JSON.stringify({arm,scenario,turn:turn.id,pass:row.pass,elapsedMs:row.elapsedMs,...(error?{error}:{})}));
   }
   armResult.waits.push(await settle('all-background-complete'));
   if(memory)armResult.finalMemory=store.roomMemory.head(scenario==='incident'?originalRequest.roomId:continuity[0].request.roomId);
  }catch(error){armResult.error=safe(error);backgroundFinished=false;}
  finally{
   try{if(memory)await memory.close();}finally{try{await runtime?.close();}finally{store.close();}}
   armResult.backgroundFinished=backgroundFinished;armResult.trace=traceSessionDelta(stateDir,initialWatermark);
   const backgroundIds=new Set<string>(metrics.filter(m=>m.role==='memory').map(m=>m.sessionId));
   for(const file of armResult.trace.sessionFiles)if(file.sessionId.startsWith('room-memory-'))backgroundIds.add(file.sessionId);
   const subset=(background:boolean)=>{
    const selectedFiles=new Set<string>(armResult.trace.sessionFiles.filter((file:any)=>backgroundIds.has(file.sessionId)===background).map((file:any)=>file.file));
    return{...armResult.trace,usage:armResult.trace.usage.filter((event:any)=>backgroundIds.has(event.sessionId)===background),
     tools:armResult.trace.tools.filter((event:any)=>selectedFiles.has(event.file)),summaries:armResult.trace.summaries.filter((event:any)=>selectedFiles.has(event.file)),
     sessionFiles:armResult.trace.sessionFiles.filter((file:any)=>selectedFiles.has(file.file))};
   };
   armResult.usage=sumTraces([armResult.trace]);armResult.foregroundUsage=sumTraces([subset(false)]);armResult.backgroundUsage=sumTraces([subset(true)]);
   armResult.backgroundModelElapsedMs=metrics.filter(m=>m.role==='memory').reduce((n,m)=>n+m.elapsedMs,0);
   armResult.backgroundModelRequests=backgroundCalls-backgroundCallsBefore;
   armResult.backgroundCapacityAdaptations=backgroundEvents.filter(event=>event.kind==='failed'&&capacitySignals.has(event.code)).length;
   armResult.backgroundOtherFailedAttempts=backgroundEvents.filter(event=>event.kind==='failed'&&!capacitySignals.has(event.code)).length;
   const starts=new Map<string,any>();armResult.backgroundBatchTimings=[];
   for(const event of backgroundEvents){
    if(event.kind==='started')starts.set(event.roomId,event);
    else if(['committed','failed','superseded'].includes(event.kind)){
     const start=starts.get(event.roomId);if(start){armResult.backgroundBatchTimings.push({outcome:event.kind,targetSeq:start.targetSeq,
      elapsedMs:event.at-start.at,...(event.code?{code:event.code}:{})});starts.delete(event.roomId);}
    }
   }
   armResult.providerUsageMayBeIncomplete=armResult.backgroundUsage.assistant.events<armResult.backgroundModelRequests||report.rows.some((row:any)=>row.arm===arm&&row.scenario===scenario&&row.error);
   armResult.accountingNote='Foreground and background partition the one final raw-event audit. Cached input is included. Failed requests without persisted provider usage cannot be priced; background model durations may overlap foreground latency and must not be added to response time.';
   save();
  }
 }
}
report.sourceHashesAfter=Object.fromEntries(Object.entries(arms).map(([arm,source])=>[arm,sourceHashes(source)]));
report.sourcesUnchanged=JSON.stringify(hashBefore)===JSON.stringify(report.sourceHashesAfter);
report.configRevisionAfter=agentSettingsRevision(root);report.configUnchanged=report.configRevisionBefore===report.configRevisionAfter;
report.status=haltReason?'halted':'completed';report.haltReason=haltReason;report.backgroundModelRequests=backgroundCalls;report.completedAt=new Date().toISOString();save();
console.log(JSON.stringify({output,sourcesUnchanged:report.sourcesUnchanged,configUnchanged:report.configUnchanged,rows:report.rows.map((r:any)=>({arm:r.arm,scenario:r.scenario,turn:r.turn,pass:r.pass,elapsedMs:r.elapsedMs})),usage:report.arms.map((a:any)=>({arm:a.arm,scenario:a.scenario,backgroundFinished:a.backgroundFinished,usage:a.usage}))}));
if(!report.sourcesUnchanged||!report.configUnchanged||report.rows.some((r:any)=>r.arm==='candidate'&&!r.pass)||report.arms.some((a:any)=>a.error||!a.backgroundFinished))process.exitCode=1;
