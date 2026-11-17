/** Per-route durable-event accounting, excluding any copied history prefix. */
import {createHash} from 'node:crypto';
import {existsSync,readFileSync,readdirSync} from 'node:fs';
import {join,relative} from 'node:path';
type Event={type:string;seq?:number;time?:number;id?:string;data?:any};
const files=(p:string):string[]=>existsSync(p)?readdirSync(p,{withFileTypes:true}).flatMap(e=>e.isDirectory()?files(join(p,e.name)):e.name==='session.v4.jsonl'?[join(p,e.name)]:[]):[];
function events(file:string){return readFileSync(file,'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line) as Event);}
export function sessionWatermark(directory:string):Record<string,number>{return Object.fromEntries(files(directory).map(file=>[relative(directory,file),Math.max(-1,...events(file).map(e=>e.seq??-1))]));}
export function traceSessionDelta(directory:string,before:Record<string,number>){
 const usage:Array<{file:string;sessionId:string;seq:number;type:string;time:number;uncachedInputTokens:number;cacheReadTokens:number;cacheWriteTokens:number;contextInputTokens:number;outputTokens:number;providerTotalTokens:number|null;reconciles:boolean|null}>=[];
 const tools:Array<{file:string;seq:number;name:string;errorCode?:string}>=[];
 const summaries:Array<{file:string;seq:number;elapsedMs:number|null}>=[];
 const sessionFiles:Array<{file:string;sessionId:string;newEvents:number;excludedThroughSeq:number;sha256:string}>=[];
 const payloadCharacters:number[]=[];const specialEvents:Array<{file:string;seq:number;type:string}>=[];
 let missingUsage=0;
 for(const file of files(directory)){
  const all=events(file),rel=relative(directory,file),cut=before[rel]??-1,added=all.filter(e=>e.seq!==undefined&&e.seq>cut),sessionId=all[0].id??'unknown';
  if(!added.length)continue;
  sessionFiles.push({file:rel,sessionId,newEvents:added.length,excludedThroughSeq:cut,sha256:createHash('sha256').update(readFileSync(file)).digest('hex')});
  for(const e of added){
   if(['assistant/message','compaction/summary'].includes(e.type)){
    const u=e.data?.usage;if(!u){missingUsage++;continue;}
    const uncached=u.inputTokens??0,read=u.cacheReadTokens??0,write=u.cacheWriteTokens??0,output=u.outputTokens??0,total=u.totalTokens??null;
    usage.push({file:rel,sessionId,seq:e.seq!,type:e.type,time:e.time!,uncachedInputTokens:uncached,cacheReadTokens:read,cacheWriteTokens:write,contextInputTokens:uncached+read+write,outputTokens:output,providerTotalTokens:total,reconciles:total===null?null:total===uncached+read+write+output});
   }
   if(e.type==='compaction/summary'){
    const start=added.find(x=>x.type==='compaction/start'&&x.data?.compactionId===e.data.compactionId);
    summaries.push({file:rel,seq:e.seq!,elapsedMs:start?e.time!-start.time!:null});
   }
   if(e.type==='tool/call'){
    const result=added.find(x=>x.type==='tool/result'&&x.data?.message?.toolCallId===e.data.callId);
    tools.push({file:rel,seq:e.seq!,name:e.data.name,...(result?.data.error?{errorCode:result.data.error.code??result.data.error.name}:{})});
   }
   if(e.type==='user/message')for(const block of e.data?.content??[]){
    if(block.type!=='text')continue;try{const p=JSON.parse(block.text);if(p.event&&Array.isArray(p.messages))payloadCharacters.push(block.text.length);}catch{/* summary prose */}
   }
   if(/normaliz|action.*tool|tool.*action/i.test(e.type))specialEvents.push({file:rel,seq:e.seq!,type:e.type});
  }
 }
 return {method:'Only persisted events appended after the pre-route watermark; copied session history is excluded. Assistant and summary usage counted once, never also runtime metrics or embedded streams.',usage,tools,summaries,sessionFiles,payloadCharacters,specialEvents,missingUsage};
}
export function sumTraces(traces:ReturnType<typeof traceSessionDelta>[]){
 const usage=traces.flatMap(t=>t.usage),tools=traces.flatMap(t=>t.tools),summaries=traces.flatMap(t=>t.summaries);
 const sum=(es:typeof usage)=>({events:es.length,uncachedInputTokens:es.reduce((n,e)=>n+e.uncachedInputTokens,0),cacheReadTokens:es.reduce((n,e)=>n+e.cacheReadTokens,0),cacheWriteTokens:es.reduce((n,e)=>n+e.cacheWriteTokens,0),contextInputTokens:es.reduce((n,e)=>n+e.contextInputTokens,0),outputTokens:es.reduce((n,e)=>n+e.outputTokens,0),providerTotalTokens:es.reduce((n,e)=>n+(e.providerTotalTokens??0),0),missingProviderTotals:es.filter(e=>e.providerTotalTokens===null).length,providerTotalMismatches:es.filter(e=>e.reconciles===false).length});
 return {assistant:sum(usage.filter(e=>e.type==='assistant/message')),compaction:sum(usage.filter(e=>e.type==='compaction/summary')),combined:sum(usage),toolCalls:tools.length,toolErrors:tools.filter(t=>t.errorCode).length,unknownToolErrors:tools.filter(t=>t.errorCode==='UNKNOWN_TOOL').length,summaryElapsedMs:summaries.reduce((n,s)=>n+(s.elapsedMs??0),0),summaryDurationMissing:summaries.filter(s=>s.elapsedMs===null).length,missingUsage:traces.reduce((n,t)=>n+t.missingUsage,0),toolNames:Object.fromEntries([...new Set(tools.map(t=>t.name))].map(name=>[name,tools.filter(t=>t.name===name).length]))};
}
