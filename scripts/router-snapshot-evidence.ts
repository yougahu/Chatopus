/** Read-only production evidence extraction. No model/network/QQ calls. */
import {createHash,randomUUID} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {join,relative,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {loadConfig} from '../src/config.js';

const {values}=parseArgs({options:{'message-id':{type:'string'},'session-id':{type:'string'},'user-seq':{type:'string'},'state-dir':{type:'string'},output:{type:'string'}}});
const messageId=values['message-id'];
if(!messageId?.trim())throw new Error('Pass --message-id=<full source message ID>; optionally select --session-id and --user-seq for repeated requests.');
const userSeq=values['user-seq']===undefined?undefined:Number(values['user-seq']);
if(userSeq!==undefined&&(!Number.isSafeInteger(userSeq)||userSeq<1))throw new Error('--user-seq must be a positive integer');
const root=resolve(fileURLToPath(new URL('..',import.meta.url))),config=loadConfig(root);
const stateDir=resolve(root,values['state-dir']??config.stateDir);
const output=resolve(root,values.output??join(stateDir,'router-snapshot-evidence',randomUUID()));
if(existsSync(output))throw new Error('Evidence already exists; preserve original extraction');
const sha=(s:string|Buffer)=>createHash('sha256').update(s).digest('hex');
const files=(p:string):string[]=>readdirSync(p,{withFileTypes:true}).flatMap(e=>e.isDirectory()?files(join(p,e.name)):e.name==='session.v4.jsonl'?[join(p,e.name)]:[]);
const matches:Array<{file:string;raw:string;events:any[];request:any;event:any;start:any;cut:number}>=[];
for(const file of files(join(stateDir,'dsh/sessions')).filter(p=>p.includes('router-room'))){
 const raw=readFileSync(file,'utf8');
 const events=raw.trimEnd().split('\n').map(line=>JSON.parse(line));
 if(values['session-id']&&events[0]?.id!==values['session-id'])continue;
 for(const event of events){
  if(event.type!=='user/message'||(userSeq!==undefined&&event.seq!==userSeq))continue;
  for(const b of event.data.content??[]){
   if(b.type!=='text'||!b.text.startsWith('{'))continue;
   let request;try{request=JSON.parse(b.text);}catch{continue;}
   if(!request.messages?.some((m:any)=>m.id===messageId))continue;
   const start=events.filter(e=>e.type==='turn/start'&&e.seq<event.seq).at(-1);
   if(!start)continue;
   // Exclude the new request's queued inbox event as well as its turn. Retain
   // the settled previous turn and lifecycle markers, with original IDs intact.
   const priorEnd=events.filter(e=>e.type==='turn/end'&&e.seq<start.seq).at(-1);
   if(!priorEnd)throw new Error('Selected request has no settled previous turn to clone');
   let cut=priorEnd.seq+1;
   while(events.find(e=>e.seq===cut)?.type==='session/end-seed')cut++;
   matches.push({file,raw,events,request,event,start,cut});
  }
 }
}
if(!matches.length)throw new Error('Target production request not found');
if(matches.length!==1)throw new Error('Multiple requests matched; specify --session-id and --user-seq to select one without guessing');
const {file,raw,events,request,event,start,cut}=matches[0];
for(const secret of [config.apiKey,config.routerApiKey,config.workerApiKey,config.qq.accessToken].filter(Boolean))if(raw.includes(secret))throw new Error('Credential value found in source log; do not copy');
const end=events.find(e=>e.type==='turn/end'&&e.seq>start.seq);
if(!end)throw new Error('Selected request has no completed turn');
const turnEvents=events.filter(e=>e.seq>=start.seq&&e.seq<=end.seq);
const prefix=events.filter(e=>e.type==='session'||e.seq<cut).map(e=>JSON.stringify(e)).join('\n')+'\n';
const header=events[0],logicalId=header.id.replace(/-g\d+-.+$/,''),pointer=join(stateDir,'dsh/session-generations',sha(logicalId)+'.json');
const generation=JSON.parse(readFileSync(pointer,'utf8'));
if(generation.activeId!==header.id)throw new Error('Production generation changed; select the archived generation record explicitly');
const usageEvents=turnEvents.filter(e=>['assistant/message','compaction/summary'].includes(e.type)).map(e=>({seq:e.seq,type:e.type,time:e.time,usage:e.data.usage}));
const total={uncachedInputTokens:0,cacheReadTokens:0,cacheWriteTokens:0,contextInputTokens:0,outputTokens:0,providerTotalTokens:0};
for(const e of usageEvents){const u=e.usage;total.uncachedInputTokens+=u.inputTokens??0;total.cacheReadTokens+=u.cacheReadTokens??0;total.cacheWriteTokens+=u.cacheWriteTokens??0;total.outputTokens+=u.outputTokens??0;total.providerTotalTokens+=u.totalTokens??0;}
total.contextInputTokens=total.uncachedInputTokens+total.cacheReadTokens+total.cacheWriteTokens;
const summaries=turnEvents.filter(e=>e.type==='compaction/summary').map(e=>({seq:e.seq,elapsedMs:e.time-turnEvents.find(s=>s.type==='compaction/start'&&s.data.compactionId===e.data.compactionId).time,usage:e.data.usage,summaryCharacters:e.data.summary.length}));
const calls=turnEvents.filter(e=>e.type==='tool/call').map(e=>({seq:e.seq,name:e.data.name,time:e.time,error:turnEvents.find(x=>x.type==='tool/result'&&x.data.message?.toolCallId===e.data.callId)?.data.error}));
const finalAssistant=turnEvents.filter(e=>e.type==='assistant/message').at(-1),unknown=turnEvents.find(e=>e.type==='tool/result'&&e.data.error?.code==='UNKNOWN_TOOL');
const evidence={extractedAt:new Date().toISOString(),source:{file:relative(root,file),sha256:sha(raw),sessionId:header.id,targetUserSeq:event.seq,turn:start.data.turn,clonePrefixExclusiveSeq:cut,clonePrefixSha256:sha(prefix)},
 question:request.messages.find((message:any)=>message.id===messageId).text,
 request:{characters:JSON.stringify(request).length,currentTime:request.currentTime,event:request.event,messages:request.messages.length,recentMessages:request.recentMessages.length,recentReplies:request.recentReplies?.length,threads:request.threads.length},
 latency:{requestToTurnEndMs:end.time-request.currentTime,routerTurnMs:end.time-start.time,summaryMs:summaries.reduce((n,s)=>n+s.elapsedMs,0),unknownToolToFinalAssistantMs:unknown?finalAssistant.time-unknown.time:0},
 summaries,toolCalls:calls,actualAssistantCalls:usageEvents.filter(e=>e.type==='assistant/message').length,usageEvents,total,
 notes:['Times are persisted dsh event boundaries, not network tracing; platform acknowledgement time is not inferred from turn/end.',
 'The private request contains the existing bounded history. The private clone ends before target request enqueue, so it cannot replay the target twice.',
 'Private files retain original IDs and historical content for faithful isolated replay. No provider credentials occur in the copied source. Never publish these files or use them as shared synthetic fixtures.',
 'Warm diagnostic accounting must exclude all cloned events before new user calls.']};
mkdirSync(output,{recursive:true,mode:0o700});
for(const [name,value] of Object.entries({'request.private.json':JSON.stringify(request,null,2)+'\n','warm-prefix.private.jsonl':prefix,'generation.private.json':JSON.stringify(generation,null,2)+'\n','evidence.json':JSON.stringify(evidence,null,2)+'\n'}))writeFileSync(join(output,name),value,{flag:'wx',mode:0o600});
console.log(JSON.stringify({output,evidence},null,2));
