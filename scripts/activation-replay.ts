/** Isolated real-Router evaluation; never creates Workers or publishes to a chat. */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadConfig } from '../src/config.js';
import { DshRuntime } from '../src/dsh-runtime.js';
import { ROUTER_PROMPT, validateRouteActions } from '../src/protocol.js';
import { describeAddressing } from '../src/router-context.js';
import type { RouteAction, RouterRequest } from '../src/types.js';

if(!process.argv[2]||process.argv[2].startsWith('--'))throw new Error('Usage: activation-replay.ts <audit-directory>');
const audit=resolve(process.argv[2]);
const label=process.argv[3]??'candidate';
if(!/^[a-z0-9-]+$/.test(label))throw new Error('Invalid evaluation label');
interface Case {id:string;source:'production'|'synthetic';request:RouterRequest;expected:{messageId:string;allowedActions:string[]}[];expectedThreadId?:string;requiredContextMessageIds?:string[];requiresAcknowledgement?:boolean}
const real=JSON.parse(readFileSync(join(audit,'router-activation-replay-cases.private.json'),'utf8'));
const synthetic=JSON.parse(readFileSync(join(audit,'synthetic-cases.json'),'utf8')).cases;
const cases:Case[]=[...real.map((c:any)=>({id:c.caseId,source:'production',request:c.routerRequest,expected:c.expectedActions})),
 ...synthetic.map((c:any)=>({id:c.id,source:'synthetic',request:c.request,expected:c.request.messages.map((m:any)=>({messageId:m.id,allowedActions:c.expectedActions})),expectedThreadId:c.expectedThreadId,requiredContextMessageIds:c.requiredContextMessageIds,requiresAcknowledgement:c.requiresAcknowledgement}))];
const config=loadConfig(),dir=join(audit,label+'-'+Date.now());mkdirSync(dir,{recursive:true,mode:0o700});
const reportFile=join(dir,'result.json'),metrics:unknown[]=[],rows:any[]=[];
// The baseline retains its historical inputs verbatim. Later evaluations add
// only addressing facts derivable from that exact snapshot, never future chat.
if(label!=='baseline')for(const c of cases){
 const r=c.request,botUserId=r.roomId.startsWith('qq:')?r.roomId.split(':')[1]:'bot';
 const members=Object.fromEntries(r.messages.map((message,index)=>[message.id,
  [...r.recentMessages,...r.messages.slice(0,index)].find(m=>m.roomId===r.roomId&&m.messageId===message.replyToMessageId)]));
 const replies=(r.recentReplies??[]).filter(reply=>reply.messageId).map(reply=>({roomId:r.roomId,messageId:reply.messageId!,
  threadId:r.threads.find(thread=>thread.roomId===r.roomId&&thread.sourceMessageId===reply.replyToMessageId)?.id}));
 r.currentTime??=Math.max(...r.messages.map(m=>m.timestamp),...(r.recentReplies??[]).map(reply=>reply.sentAt));
 r.botUserId=botUserId;r.addressing=describeAddressing(r.messages,botUserId,members,replies);
}
const hash=createHash('sha256').update(ROUTER_PROMPT).digest('hex');
writeFileSync(join(dir,'router-prompt.txt'),ROUTER_PROMPT,{mode:0o600});
const quiet=(c:Case)=>c.expected.every(e=>e.allowedActions.length===1&&e.allowedActions[0]==='silence');
function valid(actions:RouteAction[],r:RouterRequest){
 // Share the host rules: cross-author text may explain group context; only
 // images require the source author or an explicit quote of that message.
 try{validateRouteActions(actions,r);return true;}catch{return false;}
}
function save(){
 const negatives=rows.filter(r=>r.expectedSilence),positives=rows.filter(r=>!r.expectedSilence);
 const report={time:new Date().toISOString(),label,router:config.router,promptSha256:hash,addressingFromOriginalSnapshot:label!=='baseline',total:cases.length,completed:rows.length,
  passed:rows.filter(r=>r.pass).length,falseActivations:negatives.filter(r=>r.actions.some((a:RouteAction)=>a.action!=='silence')).length,
  silenceCases:negatives.length,positiveCases:positives.length,positivePassed:positives.filter(r=>r.pass).length,rows,metrics};
 writeFileSync(reportFile,JSON.stringify(report,null,2)+'\n',{mode:0o600});return report;
}
console.log(JSON.stringify({event:'started',label,cases:cases.length,promptSha256:hash,report:reportFile}));
let next=0;
try{
 await Promise.all(Array.from({length:3},async()=>{for(;;){const index=next++;if(index>=cases.length)return;
  const c=cases[index],start=Date.now();let actions:RouteAction[]=[],error:string|undefined,attempts=0,scopeValid=false;
  // These are independent historical snapshots, often from the same real QQ
  // room. Preserve their room/persona facts without inheriting another case.
  const runtime=await DshRuntime.create({...config,stateDir:join(dir,'runtime',`case-${index}`)},{onMetrics:m=>metrics.push(m)});
  try{
  for(;attempts<2;attempts++)try{actions=await runtime.route(c.request);scopeValid=valid(actions,c.request);if(!scopeValid)throw new Error('Invalid action scope or message coverage');error=undefined;break;}
  catch(e){error=String(e).replace(/https?:\/\/\S+/g,'[url]').replace(/sk-[A-Za-z0-9_-]+/g,'[key]').slice(0,400);}
  const decisions=c.expected.map(e=>({messageId:e.messageId,allowed:e.allowedActions,action:actions.find(a=>'sourceMessageIds'in a&&a.sourceMessageIds.includes(e.messageId))?.action}));
  const pass=!error&&scopeValid&&decisions.every(e=>e.action&&e.allowed.includes(e.action))
   &&(!c.expectedThreadId||actions.some(a=>'threadId'in a&&a.threadId===c.expectedThreadId))
   &&(!c.requiredContextMessageIds||c.requiredContextMessageIds.every(id=>actions.some(a=>(a.action==='open_thread'||a.action==='append_thread')&&a.contextMessageIds?.includes(id))))
   &&(!c.requiresAcknowledgement||actions.some(a=>(a.action==='open_thread'||a.action==='append_thread')&&a.acknowledgement?.trim()));
  rows.push({id:c.id,source:c.source,expectedSilence:quiet(c),pass,decisions,actions,attempts:Math.min(attempts+1,2),elapsedMs:Date.now()-start,...(error?{error}:{})});save();
  console.log(JSON.stringify({id:c.id,pass,expectedSilence:quiet(c),actions:actions.map(a=>a.action),...(error?{error}:{})}));
  }finally{await runtime.close();}
 }}));
 const report=save();console.log(JSON.stringify({event:'complete',passed:report.passed,total:report.total,falseActivations:report.falseActivations,positivePassed:report.positivePassed,positiveCases:report.positiveCases,report:reportFile}));
 if(report.passed!==report.total)process.exitCode=2;
}finally{save();}
