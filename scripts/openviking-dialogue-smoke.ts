/** Real Router + OpenViking, synthetic dialogue only; no QQ publisher or professional tools. */
import { readFileSync,mkdirSync,writeFileSync } from 'node:fs';
import { resolve,join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../src/config.js';
import { DshRuntime,type RuntimeMetrics } from '../src/dsh-runtime.js';
import { Store } from '../src/store.js';
import { validateRouteActions } from '../src/protocol.js';
import { prepareMemberCommit,applyMemberCommit } from '../src/memory/member-commit.js';
import type { GroupMessage,RouteAction,RouterRequest } from '../src/types.js';

const backend=JSON.parse(readFileSync(resolve(process.argv[2]??'.runtime/openviking-dev/ov.conf'),'utf8'));
const runId=randomUUID(),folder=resolve('.runtime/verification/openviking-dialogue',runId);
mkdirSync(folder,{recursive:true,mode:0o700});
const config=loadConfig(undefined,{stateDir:folder});
config.memory={enabled:true,provider:'openviking',baseUrl:`http://127.0.0.1:${backend.server.port}`,namespace:'dialogue-'+runId,
  rootKeyEnv:'OPENVIKING_ROOT_API_KEY',timeoutMs:30_000,recallBytes:6000,ingestBatchSize:32};
config.memoryApiKey=backend.server.root_api_key;
const metrics:RuntimeMetrics[]=[],store=new Store(join(folder,'state.sqlite'));
const runtime=await DshRuntime.create(config,{onMetrics:value=>metrics.push(value)});
const memory=runtime.sharedMemory!;
const cases:Array<{name:string;text:string;member:string;room?:string;expectUpdate?:string|null;expectNoUpdate?:boolean;answerContains?:string}>= [
  {name:'explicit-name',text:'以后请叫我阿明。',member:'alice',expectUpdate:'阿明'},
  {name:'follow-up',text:'你以后应该怎么称呼我？',member:'alice',expectNoUpdate:true,answerContains:'阿明'},
  {name:'quoted-other',text:'小李说“以后请叫我老王”，我只是转述，不要修改我的称呼。',member:'alice',expectNoUpdate:true},
  {name:'temporary-detail',text:'这一次请简短回答：你是什么机器人？',member:'alice',expectNoUpdate:true},
  {name:'correction',text:'我的称呼改成阿强，以后不要再叫阿明。',member:'alice',expectUpdate:'阿强'},
  {name:'mixed-task',text:'以后叫我小白，顺便查一下文档里的项目交付日期。',member:'bob',expectUpdate:'小白'},
  {name:'clear',text:'取消我之前设置的称呼，清除这个长期偏好。',member:'alice',expectUpdate:null},
  {name:'cross-group',text:'你知道我设置过什么称呼吗？',member:'alice',room:'other',expectNoUpdate:true},
];
const results:Array<Record<string,unknown>>=[];
try{
  for(const [index,test] of cases.entries()){
    const roomId='fixture-'+(test.room??'main');
    const message:GroupMessage={id:'message-'+index,messageId:String(index),roomId,platform:'replay',authorId:test.member,authorName:test.member,
      text:'光头，'+test.text,timestamp:Date.now(),mentions:[config.qq.selfId],isMentioned:true,isAdmin:false,attachments:[]};
    store.ingest(message);
    const current=await memory.project(roomId,[test.member]);
    const request:RouterRequest={roomId,event:'messages',currentTime:Date.now(),botUserId:config.qq.selfId,messages:[message],
      recentMessages:store.recent(roomId,4,message.id),threads:[],memberMemory:current,memoryAvailable:true};
    const started=Date.now();
    try{
      const actions=await runtime.route(request,store.routerContextReader(roomId,message.id));
      validateRouteActions(actions,request);
      store.routerSessions.ensureSession({roomId,sessionId:'fixture-'+index,configHash:'smoke'});
      const turn=store.routerSessions.beginTurn({roomId,trigger:{kind:'messages',key:message.id},inputs:[{kind:'message',id:message.id}],request});
      const proposal=await prepareMemberCommit(store,memory,turn,request,actions);
      const receipts=await applyMemberCommit(memory,proposal);
      store.routerSessions.commitTurn({turnId:turn.id,generation:turn.generation,actions,receipt:receipts});
      const changes=actions.flatMap(action=>'memoryUpdates'in action?action.memoryUpdates?.flatMap(update=>update.changes)??[]:[]);
      const answer=actions.flatMap(action=>'text'in action?[action.text]:[]).join('\n');
      const saved=await memory.readMember(roomId,test.member);
      const field=saved?.document.fields.preferredName;
      const failures:string[]=[];
      if(test.expectNoUpdate&&changes.length)failures.push('unexpected-memory-update');
      if(test.expectUpdate===null&&field?.state!=='cleared')failures.push('clear-not-saved');
      if(typeof test.expectUpdate==='string'&&(field?.state!=='set'||field.value!==test.expectUpdate))failures.push('expected-name-not-saved');
      if(test.answerContains&&!answer.includes(test.answerContains))failures.push('followup-name-missing');
      if(test.name==='mixed-task'&&(actions.length!==1||!['open_thread','append_thread'].includes(actions[0].action)))failures.push('mixed-task-not-single-primary');
      if(test.name==='cross-group'&&(saved!==null||/阿明|阿强/.test(answer)))failures.push('cross-group-leak');
      results.push({name:test.name,passed:failures.length===0,failures,actions,memberMemory:saved?.document,elapsedMs:Date.now()-started});
    }catch(error){results.push({name:test.name,passed:false,error:error instanceof Error?{name:error.name,message:error.message.slice(0,300)}:{name:'Error'},elapsedMs:Date.now()-started});}
  }
}finally{
  await runtime.close();store.close();
  const passed=results.length===cases.length&&results.every(result=>result.passed);
  const file=join(folder,'dialogue-smoke.json');
  writeFileSync(file,JSON.stringify({runId,passed,model:config.router.model,scope:'synthetic isolated Router and memory; professional tasks intentionally not executed',results,metrics},null,2)+'\n',{mode:0o600});
  console.log(JSON.stringify({report:file,passed,cases:results.length}));if(!passed)process.exitCode=1;
}
