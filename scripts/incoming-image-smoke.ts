/** Real model checks with an isolated dsh store. Never connects to or sends messages to QQ. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadConfig } from '../src/config.js';
import { DshRuntime, type IncomingImageContext } from '../src/dsh-runtime.js';
import { resolveOneBotImage } from '../src/platform/media.js';
import type { GroupMessage, RouterRequest, WorkerRequest } from '../src/types.js';

if(!process.argv[2]||process.argv[2].startsWith('--'))throw new Error('Usage: incoming-image-smoke.ts <audit-directory>');
const audit=resolve(process.argv[2]);
const base=loadConfig(),stateDir=join(base.stateDir,'verification','incoming-images-'+randomUUID());
mkdirSync(stateDir,{recursive:true,mode:0o700});
const config={...base,stateDir},checks:unknown[]=[],metrics:unknown[]=[],diagnostics:unknown[]=[];
let runtime:DshRuntime|undefined;
const save=()=>writeFileSync(join(stateDir,'result.json'),JSON.stringify({time:new Date().toISOString(),checks,metrics,diagnostics},null,2),{mode:0o600});
try{
 const cases=JSON.parse(readFileSync(join(audit,'router-image-replay-cases.private.json'),'utf8'));
 for(let start=0;start<cases.length;start+=2)await Promise.all(cases.slice(start,start+2).map(async(c:any,index:number)=>{
  const request:RouterRequest={...c.originalRouterInput,
   messages:c.originalRouterInput.messages.map((m:GroupMessage)=>c.snapshotMessagesById[m.id]??m),
   recentMessages:c.originalRouterInput.recentMessages.map((m:GroupMessage)=>c.snapshotMessagesById[m.id]??m)};
  const began=Date.now();let actions:Awaited<ReturnType<DshRuntime['route']>>|undefined,error:unknown,attempts=0;
  // Isolate unrelated snapshots from the same production room. A retry stays
  // within this case; original room IDs and persona selection remain intact.
  const caseRuntime=await DshRuntime.create({...config,stateDir:join(stateDir,'router-cases',`case-${start+index}`)},{onMetrics:m=>metrics.push(m)});
  try{
  for(;attempts<2;attempts++)try{actions=await caseRuntime.route(request);break;}catch(e){error=e;}
  if(!actions){checks.push({caseId:c.caseId,pass:false,elapsedMs:Date.now()-began,attempts,error:String(error)});save();console.log(JSON.stringify({caseId:c.caseId,pass:false,error:'router_unavailable'}));return;}
  const used=actions.flatMap(a=>'sourceMessageIds'in a?a.sourceMessageIds:[]);
  const validSources=used.length===request.messages.length&&new Set(used).size===used.length&&used.every(id=>request.messages.some(m=>m.id===id));
  const validContext=actions.every(action=>{
   if(action.action!=='open_thread'&&action.action!=='append_thread')return true;
   const sources=request.messages.filter(m=>action.sourceMessageIds.includes(m.id));
   return (action.contextMessageIds??[]).every(id=>request.recentMessages.some(m=>m.id===id&&m.roomId===request.roomId&&sources.some(s=>s.authorId===m.authorId||s.replyToMessageId===m.messageId)))
    &&(action.action!=='append_thread'||request.threads.some(t=>t.id===action.threadId&&t.roomId===request.roomId));
  });
  const dispatched=actions.filter(a=>a.action==='open_thread'||a.action==='append_thread');
  const associated=new Set<string>();
  for(const action of dispatched){
   for(const id of action.contextMessageIds??[])associated.add(id);
   for(const message of request.messages.filter(m=>action.sourceMessageIds.includes(m.id))){
    if(message.attachments.length)associated.add(message.id);
    const quoted=request.recentMessages.find(m=>m.messageId===message.replyToMessageId&&m.roomId===message.roomId);
    if(quoted?.attachments.length)associated.add(quoted.id);
   }
  }
  const pass=validSources&&validContext&&(!c.expected.requiresWorkerImageAccess||c.expected.relevantImageMessageIds.every((id:string)=>associated.has(id)));
  checks.push({caseId:c.caseId,pass,elapsedMs:Date.now()-began,attempts:attempts+1,actions,expectedImageIds:c.expected.relevantImageMessageIds,associatedImageIds:[...associated]});save();
  console.log(JSON.stringify({caseId:c.caseId,pass,actions:actions.map(a=>a.action)}));
  }finally{await caseRuntime.close();}
 }));
 if(process.argv.includes('--router-only')){
  assert.ok(checks.every((c:any)=>c.pass),'One or more Router checks failed');
  console.log(JSON.stringify({status:'passed',report:join(stateDir,'result.json'),checks:checks.length}));
  process.exitCode=0;
 }else{
 const png=readFileSync(join(base.root,'fixtures/validation-document.png'));
 let bridgeCalls=0;
 const resolver=(offline:boolean)=>(attachment:any,context:IncomingImageContext)=>resolveOneBotImage({call:async()=>{
  bridgeCalls++;if(offline)throw new Error('bridge deliberately unavailable');return {base64:png.toString('base64')};
 }},attachment,{cacheDir:join(stateDir,'incoming-images'),cacheKey:JSON.stringify([context.roomId,context.messageId,context.attachmentIndex]),onDiagnostic:d=>diagnostics.push({...context,...d})});
 const message:GroupMessage={id:'synthetic-document',platform:'replay',roomId:'image-verification',messageId:'1',authorId:'test',authorName:'测试',text:'只读图：请写出图中总页数、已完成页数、待审阅页数三个数值。不要查外部资料，也不要推算其他数值。',timestamp:Date.now(),mentions:[],attachments:[{kind:'image',file:'synthetic-document.png'}],isMentioned:true,isAdmin:false};
 const request:WorkerRequest={thread:{id:'image-test',roomId:message.roomId,subject:'图片读数',ownerId:'test',sourceMessageId:'1',explicit:true,participants:['test'],status:'running',revision:1,latestInputSeq:1,sessionId:'image-test',epoch:1,summary:''},runId:'first',workspace:join(stateDir,'workspaces/first'),inputs:[{seq:1,revision:1,message,kind:'question'}]};
 for(const offline of [false,true]){
  runtime=await DshRuntime.create(config,{resolveImage:resolver(offline),onMetrics:m=>metrics.push(m),onImage:d=>diagnostics.push(d)});
  if(offline){
   request.runId='after-restart';request.workspace=join(stateDir,'workspaces/after-restart');request.thread={...request.thread,revision:2,latestInputSeq:2,epoch:2};
   request.inputs.push({seq:2,revision:2,kind:'supplement',message:{...message,id:'followup',messageId:'2',attachments:[],replyToMessageId:'1',text:'再核对我引用的这张图，写出总页数、已完成页数、待审阅页数三个数值即可。'},contextMessages:[message]});
  }
  const result=await runtime.runWorker(request);
  const pass=result.status==='ready'&&['73','38','27'].every(n=>result.shortAnswer.includes(n));
  checks.push({caseId:offline?'worker-restarted-offline-cache':'worker-first-download',pass,result});save();
  console.log(JSON.stringify({caseId:offline?'worker-restarted-offline-cache':'worker-first-download',pass}));
  await runtime.close();
 }
 assert.equal(bridgeCalls,1,'Restart must load cached bytes without another bridge call');
 assert.ok(diagnostics.some((d:any)=>d.stage==='cache'&&d.status==='hit'));
 assert.ok(checks.every((c:any)=>c.pass),'One or more real-model checks failed');
 console.log(JSON.stringify({status:'passed',report:join(stateDir,'result.json'),checks:checks.length,bridgeCalls}));
 }
}finally{save();await runtime?.close();}
