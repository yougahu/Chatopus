/** Offline preparation only. Model calls and target writes require explicit CLI --execute. */
import {createHash,randomUUID} from 'node:crypto';
import {backup,DatabaseSync} from 'node:sqlite';
import {chmodSync,existsSync,mkdirSync,mkdtempSync,readFileSync,realpathSync,renameSync,rmSync,writeFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {expandAssistantStream} from '@deepseek-ai/dsh-llm';
import {Store} from '../src/store.js';
import type {MemoryNote,MemoryVersion} from '../src/room-memory-store.js';
import {RoomMemoryWorker,type MemoryWorkerEvent} from '../src/room-memory-worker.js';
import {sessionWatermark,traceSessionDelta,sumTraces} from './router-comparison-audit.js';

export interface SourceIdentity {seq:number;roomId:string;kind:'message'|'reply';sourceId:string;digest:string}
export interface SourceManifest {
  format:'boe-memory-source-v1';origin:'sqlite-online-backup';createdAt:string;sourceDatabase:string;snapshotDatabase:string;
  rawDigest:string;rooms:Array<{roomId:string;cutoffSeq:number;sources:SourceIdentity[];base:MemoryVersion|null;epoch:number}>;
}
export interface MemoryPromotion {
  format:'boe-memory-promotion-v1';manifestSha256:string;roomId:string;
  sourceEpoch:number;selectedVersion:number;sources:SourceIdentity[];versions:MemoryVersion[];
}
const sha=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const failure=(code:string,message:string)=>Object.assign(new Error(message),{code});
const integer=(value:number)=>{if(!Number.isSafeInteger(value)||value<0)throw new Error('Expected a nonnegative integer');return value;};
const writePrivate=(path:string,value:unknown,exclusive=false)=>{mkdirSync(dirname(path),{recursive:true,mode:0o700});if(exclusive){writeFileSync(path,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});return;}
  const temp=path+'.'+randomUUID()+'.tmp';writeFileSync(temp,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});renameSync(temp,path);};
const identity=(event:SourceIdentity):SourceIdentity=>({seq:event.seq,roomId:event.roomId,kind:event.kind,sourceId:event.sourceId,digest:event.digest});
const sameSource=(a:SourceIdentity,b:SourceIdentity)=>a.roomId===b.roomId&&a.kind===b.kind&&a.sourceId===b.sourceId&&a.digest===b.digest;
const tables=['messages','outbox','threads','runs','inputs','results','decisions','message_thread_bindings'];
/** Hash business rows only. SQLite sequence counters and memory tables are excluded. */
export function rawDataDigest(db:DatabaseSync):string {
  const hash=createHash('sha256');
  for(const table of tables){hash.update(table+'\n');if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)){hash.update('missing\n');continue;}
    for(const row of db.prepare(`SELECT rowid,* FROM ${table} ORDER BY rowid`).iterate())hash.update(JSON.stringify(row)).update('\n');}
  return hash.digest('hex');
}
function sourceRows(store:Store,roomId:string,throughSeq:number):SourceIdentity[]{
  store.roomMemory.sync(roomId);
  const rows=store.db.prepare('SELECT seq,room,kind,source_id,source_digest,valid FROM room_memory_events WHERE room=? AND seq<=? ORDER BY seq').all(roomId,throughSeq) as unknown as Array<{seq:number;room:string;kind:'message'|'reply';source_id:string;source_digest:string;valid:number}>;
  if(rows.some(row=>!row.valid))throw failure('SOURCE_UNAVAILABLE','A source in the selected prefix is no longer available');
  // Read every original through the store, which checks indexed digest against current body.
  return store.roomMemory.eventsBySeq(roomId,rows.map(row=>row.seq)).map(identity);
}
export async function onlineBackup(sourceDatabase:string,destination:string):Promise<void>{
  if(existsSync(destination))throw new Error('Backup destination already exists');
  mkdirSync(dirname(destination),{recursive:true,mode:0o700});
  const source=new DatabaseSync(sourceDatabase,{readOnly:true});
  try{await backup(source,destination);}finally{source.close();}
  chmodSync(destination,0o600);
}
export async function createSourceSnapshot(sourceDatabase:string,directory:string):Promise<SourceManifest>{
  if(existsSync(directory))throw new Error('Snapshot directory already exists');mkdirSync(directory,{recursive:true,mode:0o700});
  const snapshotDatabase=join(directory,'state.sqlite');await onlineBackup(sourceDatabase,snapshotDatabase);
  const store=new Store(snapshotDatabase);
  try{
    const manifest:SourceManifest={format:'boe-memory-source-v1',origin:'sqlite-online-backup',createdAt:new Date().toISOString(),sourceDatabase:realpathSync(sourceDatabase),snapshotDatabase:resolve(snapshotDatabase),rawDigest:rawDataDigest(store.db),
      rooms:store.roomMemory.rooms().map(roomId=>{const head=store.roomMemory.head(roomId),cutoffSeq=store.roomMemory.latestSeq(roomId);return{roomId,cutoffSeq,sources:sourceRows(store,roomId,cutoffSeq),base:head.version,epoch:head.epoch};})};
    writePrivate(join(directory,'source-manifest.json'),manifest,true);return manifest;
  }finally{store.close();}
}
function manifestRoom(manifest:SourceManifest,roomId:string){
  if(manifest.format!=='boe-memory-source-v1'||manifest.origin!=='sqlite-online-backup')throw failure('MANIFEST_INVALID','A real online-backup source manifest is required');
  const room=manifest.rooms.find(room=>room.roomId===roomId);if(!room)throw failure('MANIFEST_INVALID','Room is absent from the real source manifest');return room;
}
function remapNotes(notes:MemoryNote[],mapping:Map<number,number>):MemoryNote[]{return notes.map(note=>({...structuredClone(note),sourceSeqs:note.sourceSeqs.map(seq=>{const mapped=mapping.get(seq);if(mapped===undefined)throw failure('SOURCE_MISMATCH','Note refers outside the verified source prefix');return mapped;})}));}
function mappedCoverage(sources:SourceIdentity[],through:number,mapping:Map<number,number>):number{
  const last=sources.findLast(source=>source.seq<=through);return last?mapping.get(last.seq)!:0;
}
/** Export any explicit epoch/version, never assume the first numbered version is real history. */
export function exportMemory(store:Store,manifest:SourceManifest,roomId:string,epoch:number,version:number):MemoryPromotion{
  integer(epoch);integer(version);const authority=manifestRoom(manifest,roomId);
  if(store.roomMemory.currentEpoch(roomId)!==epoch)throw failure('SOURCE_CHANGED','The requested version belongs to an invalidated source epoch');
  const rows=store.db.prepare('SELECT * FROM room_memory_versions WHERE room=? AND epoch=? AND version>? AND version<=? ORDER BY version').all(roomId,epoch,authority.base?.version??0,version) as any[];
  const versions:MemoryVersion[]=rows.map(row=>({roomId,epoch,version:row.version,coveredSeq:row.covered_seq,notes:JSON.parse(row.notes),sourceDigest:row.source_digest,createdAt:row.created_at}));
  if(!versions.length||versions.at(-1)!.version!==version||versions.some((v,i)=>v.version!==(authority.base?.version??0)+i+1))throw failure('VERSION_MISSING','An uninterrupted explicit version chain is required');
  const sources=sourceRows(store,roomId,versions.at(-1)!.coveredSeq);
  if(!sources.length||sources.length>authority.sources.length||sources.some((source,i)=>!sameSource(source,authority.sources[i])))throw failure('SOURCE_MISMATCH','Candidate is not a complete prefix of the verified real source history');
  const mapping=new Map(sources.map((source,i)=>[source.seq,authority.sources[i].seq]));
  return {format:'boe-memory-promotion-v1',manifestSha256:sha(manifest),roomId,sourceEpoch:epoch,selectedVersion:version,sources:authority.sources.slice(0,sources.length).map(identity),
    versions:versions.map(v=>({...v,coveredSeq:mappedCoverage(sources,v.coveredSeq,mapping),notes:remapNotes(v.notes,mapping)}))};
}
export function validatePromotion(store:Store,manifest:SourceManifest,promotion:MemoryPromotion){
  if(promotion.format!=='boe-memory-promotion-v1'||promotion.manifestSha256!==sha(manifest))throw failure('MANIFEST_INVALID','Promotion does not match the reviewed source manifest');
  const authority=manifestRoom(manifest,promotion.roomId),n=promotion.sources.length;
  if(!n||n>authority.sources.length||promotion.sources.some((source,i)=>JSON.stringify(source)!==JSON.stringify(authority.sources[i])))throw failure('SOURCE_MISMATCH','Promotion source map is not the complete reviewed prefix');
  const target=sourceRows(store,promotion.roomId,store.roomMemory.latestSeq(promotion.roomId)).slice(0,n);
  if(target.length!==n||target.some((source,i)=>!sameSource(source,promotion.sources[i])))throw failure('SOURCE_MISMATCH','Target originals differ, are missing, or contain an unverified intervening source');
  const mapping=new Map(promotion.sources.map((source,i)=>[source.seq,target[i].seq]));
  const head=store.roomMemory.head(promotion.roomId),expected=authority.base;
  if(head.epoch!==authority.epoch||(head.version?.version??0)!==(expected?.version??0))throw failure('BASE_CHANGED','Target memory epoch or version changed after the snapshot');
  if(expected&&(!head.version||head.version.coveredSeq!==mappedCoverage(promotion.sources,expected.coveredSeq,mapping)||sha(head.version.notes)!==sha(remapNotes(expected.notes,mapping))))throw failure('BASE_CHANGED','Target checkpoint does not match the snapshot baseline');
  if(!promotion.versions.length||promotion.versions.at(-1)!.version!==promotion.selectedVersion||promotion.versions.some((v,i)=>v.version!==(expected?.version??0)+i+1))throw failure('VERSION_MISSING','Promotion version chain is incomplete');
  let previous=expected?.coveredSeq??0;
  for(const v of promotion.versions){if(v.roomId!==promotion.roomId||v.coveredSeq<previous||v.coveredSeq>promotion.sources.at(-1)!.seq)throw failure('VERSION_INVALID','Version coverage is not a continuous forward prefix');previous=v.coveredSeq;}
  if(previous!==promotion.sources.at(-1)!.seq)throw failure('VERSION_INVALID','Selected coverage does not match the complete source map');
  return {mapping,head,targetUntilSeq:target.at(-1)!.seq,sourceCount:n};
}
/** Caller opens the target only after explicit authorization; all publication is one transaction. */
export function promoteMemory(store:Store,manifest:SourceManifest,promotion:MemoryPromotion):MemoryVersion{
  return store.transaction(()=>{
    const before=rawDataDigest(store.db),plan=validatePromotion(store,manifest,promotion);let published=plan.head.version;
    for(const version of promotion.versions){
      const untilSeq=mappedCoverage(promotion.sources,version.coveredSeq,plan.mapping);
      const batch=store.roomMemory.batch(promotion.roomId,untilSeq,Number.MAX_SAFE_INTEGER);
      published=store.roomMemory.commit({roomId:promotion.roomId,epoch:plan.head.epoch,baseVersion:published?.version??0,untilSeq,sourceDigest:batch.sourceDigest,notes:remapNotes(version.notes,plan.mapping)});
      if(!published)throw failure('CAS_FAILED','Memory changed during publication');
    }
    if(rawDataDigest(store.db)!==before)throw failure('RAW_DATA_CHANGED','Publication changed business rows; transaction rolled back');
    return published!;
  });
}
/** One provider usage sample per settled attempt, including failed/cancelled attempts. */
export function auditPrewarmUsage(directory:string,before:Record<string,number>){
  const trace=traceSessionDelta(directory,before);
  // Rebuild assistant usage: the shared audit only considers top-level usage.
  trace.usage=trace.usage.filter(event=>event.type!=='assistant/message');
  let failedAttempts=0,failedAttemptsMissingUsage=0,failedAttemptsUnverifiedZeroUsage=0;
  const failedEvents=new Set<string>();
  const unknownUsage:Array<{file:string;seq:number;eventType:string;reason:'missing-usage'|'unverified-zero-usage';finishKind:string|null}>=[];
  const positive=(u:{inputTokens?:number;outputTokens?:number;cacheReadTokens?:number;cacheWriteTokens?:number;totalTokens?:number})=>
    [u.inputTokens,u.outputTokens,u.cacheReadTokens,u.cacheWriteTokens,u.totalTokens].some(n=>typeof n==='number'&&n>0);
  for(const file of trace.sessionFiles){
    const events=readFileSync(join(directory,file.file),'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
    for(const event of events){
      if(event.seq<=file.excludedThroughSeq||!['assistant/message','assistant/attempt'].includes(event.type))continue;
      const attempt=event.type==='assistant/attempt';
      if(!attempt&&!event.data.usage)trace.missingUsage--; // replace the shared audit's missing sample
      const stream=expandAssistantStream(event.data.stream??[]);
      const finish=stream.findLast(item=>item.chunk.type==='finish')?.chunk;
      const finishKind=finish?.type==='finish'?finish.reason.kind:null;
      const failed=attempt||event.data.interrupted===true||finishKind==='error'||finishKind==='aborted';
      if(failed){failedAttempts++;failedEvents.add(file.file+':'+event.seq);}
      const samples=stream.flatMap(item=>item.chunk.type==='usage'?[item.chunk.usage]:[]);
      if(event.data.usage)samples.push(event.data.usage);
      // pi-ai initializes usage to zeros and emits it even when its request or
      // stream fails before a provider usage event. Normalized dsh chunks do
      // not retain provenance sufficient to certify an all-zero failed sample.
      // Keep a known nonzero sample even if a later synthetic zero overwrites it.
      const u=failed?samples.findLast(positive):samples.at(-1);
      if(!u){
        const reason=failed&&samples.length?'unverified-zero-usage':'missing-usage';
        trace.missingUsage++;if(failed)failedAttemptsMissingUsage++;
        if(reason==='unverified-zero-usage')failedAttemptsUnverifiedZeroUsage++;
        unknownUsage.push({file:file.file,seq:event.seq,eventType:event.type,reason,finishKind});continue;
      }
      const uncached=u.inputTokens??0,read=u.cacheReadTokens??0,write=u.cacheWriteTokens??0,output=u.outputTokens??0,total=u.totalTokens??null;
      trace.usage.push({file:file.file,sessionId:file.sessionId,seq:event.seq,type:event.type,time:event.time,uncachedInputTokens:uncached,cacheReadTokens:read,cacheWriteTokens:write,contextInputTokens:uncached+read+write,outputTokens:output,providerTotalTokens:total,reconciles:total===null?null:total===uncached+read+write+output});
    }
  }
  trace.method='Each assistant/message, assistant/attempt and compaction/summary contributes at most one known usage sample. Failed/interrupted all-zero samples have no provider provenance in normalized dsh logs and remain unknown. The last nonzero failed sample is retained as known reported usage, never replaced by synthetic zero. All sums cover known samples only; no estimate is invented for missing usage or hard loss before durable settlement.';
  const totals=sumTraces([trace]);
  const knownFailedUsageMayBePartial=failedAttempts>failedAttemptsMissingUsage;
  const usage={...totals,totalsScope:'known-usage-only',knownFailedUsageMayBePartial,overallProviderTotalTokens:trace.missingUsage||totals.combined.missingProviderTotals||knownFailedUsageMayBePartial?null:totals.combined.providerTotalTokens,
    failedAttempts,failedAttemptsMissingUsage,failedAttemptsUnverifiedZeroUsage,unknownUsage,
    failed:sumTraces([{...trace,usage:trace.usage.filter(e=>failedEvents.has(e.file+':'+e.seq))}]).combined};
  return {trace,usage};
}
export async function prewarmSnapshot(directory:string,projectRoot:string,timeoutMs:number,execute=false){
  const manifest=JSON.parse(readFileSync(join(directory,'source-manifest.json'),'utf8')) as SourceManifest;
  if(!execute)return {mode:'prepared-no-model-calls',snapshotDatabase:manifest.snapshotDatabase,targets:manifest.rooms.map(r=>({roomId:r.roomId,cutoffSeq:r.cutoffSeq,sources:r.sources.length})),timeoutMs};
  integer(timeoutMs);if(timeoutMs<1||timeoutMs>2_147_483_647)throw new Error('Explicit timeout must fit a positive Node.js timer');
  if(resolve(manifest.snapshotDatabase)!==resolve(directory,'state.sqlite')||realpathSync(manifest.snapshotDatabase)===realpathSync(manifest.sourceDatabase))throw new Error('Prewarm must use the private backup, never the source database');
  const store=new Store(manifest.snapshotDatabase),runDir=join(directory,'prewarm-'+Date.now()+'-'+randomUUID().slice(0,8));mkdirSync(runDir,{mode:0o700});
  const report:any={status:'running',startedAt:new Date().toISOString(),targets:manifest.rooms.map(r=>({roomId:r.roomId,seq:r.cutoffSeq})),metrics:[],events:[],attempts:[]};
  const save=()=>writePrivate(join(runDir,'result.json'),report);let runtime:any,worker:RoomMemoryWorker|undefined;
  let usageDirectory:string|undefined,watermark:Record<string,number>={};
  try{
    if(rawDataDigest(store.db)!==manifest.rawDigest)throw failure('SOURCE_CHANGED','Private snapshot raw records changed since capture');
    for(const room of manifest.rooms)if(sha(sourceRows(store,room.roomId,room.cutoffSeq))!==sha(room.sources))throw failure('SOURCE_CHANGED','Snapshot sources changed');
    const {loadConfig}=await import('../src/config.js'),{DshRuntime}=await import('../src/dsh-runtime.js');
    const config=loadConfig(projectRoot);config.stateDir=join(runDir,'runtime');config.qq.enabled=false;
    runtime=await DshRuntime.create(config,{onMetrics:(metric:any)=>{report.metrics.push({at:Date.now(),...metric});save();}});
    worker=new RoomMemoryWorker({store:store.roomMemory,concurrency:config.concurrency,budget:(request,signal)=>runtime.roomMemoryBudget(request,signal),
      summarize:async(input,signal)=>{const attempt:any={startedAt:Date.now(),roomId:input.roomId,targetSeq:input.targetSeq,baseVersion:input.baseVersion,inputBytes:Buffer.byteLength(JSON.stringify(input)),inputBudgetBytes:input.inputBudgetBytes,outputTokens:input.outputTokens};report.attempts.push(attempt);save();
        try{const notes=await runtime.summarizeRoomMemory(input,signal);attempt.outcome='succeeded';return notes;}catch(error){attempt.outcome='failed';attempt.code=String((error as any)?.code??'UNKNOWN');throw error;}finally{attempt.elapsedMs=Date.now()-attempt.startedAt;save();}},
      onEvent:(event:MemoryWorkerEvent)=>{report.events.push({at:Date.now(),...event});save();}});
    usageDirectory=config.stateDir;watermark=sessionWatermark(config.stateDir);save();for(const room of manifest.rooms)worker.notify(room.roomId,room.cutoffSeq);
    // A referenced timer keeps the CLI alive while every room is in retry backoff.
    const abort=new AbortController(),timer=setTimeout(()=>abort.abort(failure('PREWARM_TIMEOUT','Prewarm deadline reached')),timeoutMs);
    const interrupted=()=>abort.abort(failure('PREWARM_INTERRUPTED','Prewarm was interrupted'));
    process.once('SIGINT',interrupted);process.once('SIGTERM',interrupted);
    try{await worker.whenIdle(abort.signal);report.status='completed';}
    catch(error){report.status='incomplete';report.errorCode=String((error as any)?.code??(error as any)?.name??'UNKNOWN');report.pending=worker.status();}
    finally{clearTimeout(timer);process.removeListener('SIGINT',interrupted);process.removeListener('SIGTERM',interrupted);}
  }catch(error){report.status='failed';report.errorCode=String((error as any)?.code??'UNKNOWN');throw error;}
  finally{
    try{await worker?.close();await runtime?.close();
      if(usageDirectory)Object.assign(report,auditPrewarmUsage(usageDirectory,watermark));
      report.moneyCost=null;report.moneyCostReason='No verified provider price supplied; uncached, cache and output token usage is reported without an invented currency estimate.';
      report.rawDataUnchanged=rawDataDigest(store.db)===manifest.rawDigest;
      report.heads=manifest.rooms.map(r=>({roomId:r.roomId,head:store.roomMemory.head(r.roomId)}));
      if(!report.rawDataUnchanged){report.status='failed';report.errorCode='RAW_DATA_CHANGED';throw failure('RAW_DATA_CHANGED','Snapshot business records changed during prewarm');}
    }finally{report.finishedAt=new Date().toISOString();save();store.close();}
  }
  return {runDir,status:report.status,usage:report.usage};
}
async function withPrivateCopy<T>(database:string,directory:string,fn:(store:Store)=>T|Promise<T>):Promise<T>{
  mkdirSync(directory,{recursive:true,mode:0o700});const scratch=mkdtempSync(join(directory,'.review-'));chmodSync(scratch,0o700);
  try{const copy=join(scratch,'state.sqlite');await onlineBackup(database,copy);const store=new Store(copy);try{return await fn(store);}finally{store.close();}}
  finally{rmSync(scratch,{recursive:true,force:true});}
}
async function main(args:string[]){
  const [command,...rest]=args,flags=new Map(rest.map(arg=>{const at=arg.indexOf('=');return at<0?[arg,'true']:[arg.slice(0,at),arg.slice(at+1)];}));
  const required=(name:string)=>{const value=flags.get('--'+name);if(!value||value==='true')throw new Error(`Missing --${name}=...`);return value;};
  const execute=flags.has('--execute');let result:unknown;
  if(command==='snapshot')result=await createSourceSnapshot(resolve(required('source-db')),resolve(required('output')));
  else if(command==='prewarm')result=await prewarmSnapshot(resolve(required('snapshot')),resolve(required('project-root')),Number(flags.get('--timeout-ms')??0),execute);
  else if(command==='export'){
    const manifest=JSON.parse(readFileSync(required('source-manifest'),'utf8')) as SourceManifest,output=resolve(required('output'));
    result=await withPrivateCopy(resolve(required('db')),dirname(output),store=>exportMemory(store,manifest,required('room'),Number(required('epoch')),Number(required('version'))));writePrivate(output,result,true);
  }else if(command==='promote'){
    const manifest=JSON.parse(readFileSync(required('source-manifest'),'utf8')) as SourceManifest,promotion=JSON.parse(readFileSync(required('artifact'),'utf8')) as MemoryPromotion,target=resolve(required('target-db'));
    const review=await withPrivateCopy(target,dirname(resolve(required('artifact'))),store=>{const plan=validatePromotion(store,manifest,promotion);return{roomId:promotion.roomId,sourceCount:plan.sourceCount,targetUntilSeq:plan.targetUntilSeq,baseVersion:plan.head.version?.version??0,epoch:plan.head.epoch};});
    if(!execute)result={mode:'validated-no-target-writes',...review};
    else{const store=new Store(target);try{const version=promoteMemory(store,manifest,promotion);result={mode:'promoted-memory-only',...review,publishedVersion:version.version,coveredSeq:version.coveredSeq};}finally{store.close();}}
  }else throw new Error('Commands: snapshot --source-db= --output=; prewarm --snapshot= --project-root= [--execute --timeout-ms=]; export --db= --source-manifest= --room= --epoch= --version= --output=; promote --source-manifest= --artifact= --target-db= [--execute]');
  // Source maps and notes are private files, not terminal output.
  console.log(JSON.stringify(command==='snapshot'?{mode:'snapshot-created',directory:resolve(required('output')),rooms:(result as SourceManifest).rooms.map(r=>({roomId:r.roomId,sources:r.sources.length,cutoffSeq:r.cutoffSeq}))}:command==='export'?{mode:'exported',path:resolve(required('output'))}:result,null,2));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)void main(process.argv.slice(2)).catch(error=>{console.error(JSON.stringify({status:'failed',code:String((error as any)?.code??'PREWARM_COMMAND_FAILED'),message:error instanceof Error?error.message:String(error)}));process.exitCode=1;});
