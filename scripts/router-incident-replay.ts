import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/store.js';
import { Coordinator } from '../src/coordinator.js';
import { MemoryPublisher } from '../src/platform/memory.js';
import { loadConfig } from '../src/config.js';
import type { GroupMessage, RouterRequest, RuntimePort, RouteAction, WorkerRequest, WorkerReport } from '../src/types.js';

// Deterministic replay of the audited corpus, no model or external messages.
if(!process.argv[2]||process.argv[2].startsWith('--'))throw new Error('Usage: router-incident-replay.ts <audit-directory>');
const audit=resolve(process.argv[2]);
const affected=JSON.parse(readFileSync(join(audit,'affected-messages.json'),'utf8')) as Array<{id:string;action:string;explicitMention:boolean}>;
const source=new DatabaseSync(join(audit,'snapshot.sqlite'),{readOnly:true});
const root=resolve('.runtime/checks/incident-replay-v2-'+randomUUID());mkdirSync(root,{recursive:true,mode:0o700});
const store=new Store(join(root,'state.sqlite')),publisher=new MemoryPublisher();
const base=loadConfig(process.cwd());
const config={...base,stateDir:root,persistentRouter:true,routerBatchWindowMs:0,memory:{...base.memory!,enabled:false}};
const first=JSON.parse(String(source.prepare('SELECT data FROM messages WHERE id=?').get(affected[0].id)!.data)) as GroupMessage;
const prior=source.prepare('SELECT data FROM messages WHERE room=? AND rowid<(SELECT rowid FROM messages WHERE id=?) ORDER BY rowid DESC LIMIT 16').all(first.roomId,first.id).reverse().map(row=>JSON.parse(String(row.data)) as GroupMessage);
for(const original of prior){store.ingest(original);store.messageStatus(original.id,'routed');}
const origin=prior.filter(m=>m.authorId===first.authorId).at(-1)??first;
const thread=store.createThread(origin,'事故回放：同一价格追问任务',true);thread.status='needs_input';store.saveThread(thread);
const expected=new Map(affected.map(row=>[row.id,row]));let calls=0,injected=false,maxBytes=0;
const runtime:RuntimePort={
 async route(request:RouterRequest):Promise<RouteAction[]>{
   calls++;maxBytes=Math.max(maxBytes,Buffer.byteLength(JSON.stringify(request)));
   if(!injected){injected=true;throw Object.assign(new Error('Injected repeatable summary truncation'),{code:'ROUTER_COMPACTION_TRUNCATED'});}
   if(request.result)return [{action:'publish_result',resultId:request.result.id}];
   return request.messages.map(m=>expected.get(m.id)?.action==='silence'?{action:'silence',sourceMessageIds:[m.id]}:expected.get(m.id)?.action==='append_thread'?{action:'append_thread',sourceMessageIds:[m.id],threadId:thread.id,acknowledgement:'回放确认'}:{action:'reply_direct',sourceMessageIds:[m.id],text:'回放回复'});
 },
 async routerContextBudget(){return 16_000;},routerConfigurationHash(){return 'incident-replay-v2';},
 async runWorker(request:WorkerRequest):Promise<WorkerReport>{return {threadId:request.thread.id,runId:request.runId,coveredInputSeq:request.inputs.at(-1)!.seq,basedOnRevision:request.thread.revision,status:'needs_input',shortAnswer:'本地回放保留任务',assumptions:[],evidenceRefs:[],openQuestions:['本地回放']};},
 async steer(){},async cancel(){},async close(){},
};
const coordinator=new Coordinator(config,store,runtime,publisher),started=Date.now();
try{
 for(const item of affected){const original=JSON.parse(String(source.prepare('SELECT data FROM messages WHERE id=?').get(item.id)!.data)) as GroupMessage;await coordinator.receive(original);}
 await coordinator.drain(5000);
 const statuses=affected.map(item=>store.db.prepare('SELECT status FROM messages WHERE id=?').get(item.id)?.status);
 const turns=store.routerSessions.turns(first.roomId),decisions=store.decisions().flatMap(row=>row.actions);
 const checks={all252Routed:affected.length===252&&statuses.every(s=>s==='routed'),fourExplicitRequests:affected.filter(item=>item.explicitMention).length===4&&decisions.filter(a=>a.action!=='silence'&&'sourceMessageIds'in a).flatMap(a=>'sourceMessageIds'in a?a.sourceMessageIds:[]).length===4&&turns.every(t=>t.state==='committed'),oneRecovery:turns.reduce((n,t)=>n+t.rebuilds,0)===1,
  twoAppendsSameTask:decisions.filter(a=>a.action==='append_thread').length===2&&store.threads(first.roomId).length===1,
  chatterSilent:decisions.filter(a=>a.action==='silence').flatMap(a=>a.sourceMessageIds).length===248,noPending:store.routerSessions.pendingTurns().length===0,boundedContext:maxBytes<=16_000,
  uniqueSends:new Set(publisher.messages.map(m=>m.dedupeKey)).size===publisher.messages.length};
 const status=Object.values(checks).every(Boolean)?'passed':'failed',report=join(root,'replay.json');
 writeFileSync(report,JSON.stringify({status,checks,elapsedMs:Date.now()-started,calls,maxBytes,turns:turns.map(t=>({id:t.id,state:t.state,attempts:t.attempts,rebuilds:t.rebuilds})),sends:publisher.messages.length},null,2)+'\n',{mode:0o600});
 console.log(JSON.stringify({status,checks,report}));if(status==='failed')process.exitCode=2;
}finally{await coordinator.close();store.close();source.close();}
