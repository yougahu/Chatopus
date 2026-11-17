/** Read-only accounting from durable dsh events, independent of reduced runtime telemetry. */
import {createHash} from 'node:crypto';
import {existsSync,readFileSync,readdirSync,realpathSync} from 'node:fs';
import {join,relative} from 'node:path';

type Usage={inputTokens?:number;outputTokens?:number;cacheReadTokens?:number;cacheWriteTokens?:number;totalTokens?:number;reasoningTokens?:number};
export interface UsageTotals {
  events:number;uncachedInputTokens:number;cacheReadTokens:number;cacheWriteTokens:number;
  reconstructedContextInputTokens:number;outputTokens:number;providerTotalTokens:number;
  providerTotalPresent:number;providerTotalMissing:number;providerTotalMismatch:number;
}
const empty=():UsageTotals=>({events:0,uncachedInputTokens:0,cacheReadTokens:0,cacheWriteTokens:0,reconstructedContextInputTokens:0,outputTokens:0,providerTotalTokens:0,providerTotalPresent:0,providerTotalMissing:0,providerTotalMismatch:0});
function add(sum:UsageTotals,usage:Usage){
  const input=usage.inputTokens!,output=usage.outputTokens!,read=usage.cacheReadTokens??0,write=usage.cacheWriteTokens??0;
  sum.events++;sum.uncachedInputTokens+=input;sum.cacheReadTokens+=read;sum.cacheWriteTokens+=write;
  sum.reconstructedContextInputTokens+=input+read+write;sum.outputTokens+=output;
  if(usage.totalTokens===undefined)sum.providerTotalMissing++;
  else{sum.providerTotalPresent++;sum.providerTotalTokens+=usage.totalTokens;if(usage.totalTokens!==input+read+write+output)sum.providerTotalMismatch++;}
}
function logFiles(folder:string):string[]{return existsSync(folder)?readdirSync(folder,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?logFiles(join(folder,entry.name)):entry.name==='session.v4.jsonl'?[join(folder,entry.name)]:[]):[];}
export function auditDshUsage(directory:string){
  const assistant=empty(),compaction=empty(),combined=empty();
  const events:Array<{file:string;sessionId:string;seq:number;type:string;usage:Usage;reconstructedContextInputTokens:number;reconcilesProviderTotal:boolean|null}>=[];
  const files:Array<{file:string;sessionId:string;sha256:string;usageEvents:number;inheritedUsageExcluded:number;missingUsage:number;invalidUsage:number;invalidJsonLines:number}>=[];
  const seenFiles=new Set<string>(),seenEvents=new Set<string>();let duplicateEvents=0;
  for(const file of logFiles(directory).sort()){
    const real=realpathSync(file);if(seenFiles.has(real))continue;seenFiles.add(real);
    const raw=readFileSync(real),parsed:any[]=[];let invalidJsonLines=0;
    for(const line of raw.toString('utf8').split('\n')){if(!line.trim())continue;try{parsed.push(JSON.parse(line));}catch{invalidJsonLines++;}}
    const header=parsed.find(event=>event.type==='session'),sessionId=String(header?.id??'unknown');
    const inheritedCut=header?.isSeeded?parsed.find(event=>event.type==='session/end-seed'&&event.data?.inherited===true)?.seq:0;
    const detail={file:relative(directory,real),sessionId,sha256:createHash('sha256').update(raw).digest('hex'),usageEvents:0,inheritedUsageExcluded:0,missingUsage:0,invalidUsage:0,invalidJsonLines};
    for(const event of parsed){
      if(!['assistant/message','compaction/summary'].includes(event.type))continue;
      // Forked historical usage belongs to its original session, not the new call.
      if(header?.isSeeded&&(inheritedCut===undefined||event.seq<inheritedCut)){detail.inheritedUsageExcluded++;continue;}
      const identity=JSON.stringify([real,event.seq]);if(seenEvents.has(identity)){duplicateEvents++;continue;}seenEvents.add(identity);
      const usage=event.data?.usage as Usage|undefined;if(!usage){detail.missingUsage++;continue;}
      if(!Number.isSafeInteger(event.seq)||!Number.isFinite(usage.inputTokens)||!Number.isFinite(usage.outputTokens)
        ||Object.values(usage).some(value=>typeof value==='number'&&(!Number.isFinite(value)||value<0))){detail.invalidUsage++;continue;}
      const value={inputTokens:usage.inputTokens!,outputTokens:usage.outputTokens!,
        ...(usage.cacheReadTokens===undefined?{}:{cacheReadTokens:usage.cacheReadTokens}),...(usage.cacheWriteTokens===undefined?{}:{cacheWriteTokens:usage.cacheWriteTokens}),
        ...(usage.totalTokens===undefined?{}:{totalTokens:usage.totalTokens}),...(usage.reasoningTokens===undefined?{}:{reasoningTokens:usage.reasoningTokens})};
      add(event.type==='assistant/message'?assistant:compaction,value);add(combined,value);detail.usageEvents++;
      const input=value.inputTokens+(value.cacheReadTokens??0)+(value.cacheWriteTokens??0);
      events.push({file:detail.file,sessionId,seq:event.seq,type:event.type,usage:value,reconstructedContextInputTokens:input,
        reconcilesProviderTotal:value.totalTokens===undefined?null:value.totalTokens===input+value.outputTokens});
    }
    files.push(detail);
  }
  return {method:'Each unique persisted assistant/message or compaction/summary event is counted once. Embedded stream usage and runtime telemetry are not added. Fork-inherited events are excluded.',
    semantics:'Installed pi-ai maps inputTokens to uncached input; absent cacheReadTokens/cacheWriteTokens means zero. Context input is uncached + cache read + cache write; output includes reasoning where provider reports it. This is observed provider usage, not billing.',
    scope:'All selected state-directory sessions. Raw event provenance and log SHA-256 are included; missing or unpersisted failed-call usage cannot be recovered.',
    assistant,compaction,combined,duplicateEvents,files,events};
}
