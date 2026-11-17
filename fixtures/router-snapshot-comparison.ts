import {comparisonScenarios,type ComparisonScenario,type ComparisonTurn} from './p1-comparison.js';
import type {RouteAction,RouterRequest} from '../src/types.js';

export interface SnapshotTurn extends ComparisonTurn {expectedResult?:{action:'publish_result'|'defer_result';resultId:string}}
export interface SnapshotScenario extends Omit<ComparisonScenario,'turns'> {turns:SnapshotTurn[]}
const now=1_795_000_000_000;
const addressed={isMentioned:true,mentions:['bot']};

/** This suite labels the current explicit-activation policy. The original P1
 * fixtures retain their original activation labels; changed examples receive a new fixture hash. */
export function snapshotComparisonScenarios():SnapshotScenario[]{
 const scenarios:SnapshotScenario[]=structuredClone(comparisonScenarios());
 const find=(id:string)=>scenarios.flatMap(s=>s.turns).find(t=>t.id===id)!;
 for(const id of ['mechanic-help','explicit-delegate','question-mark','item-level']){
  const t=find(id);t.expected=t.expected.map(e=>({messageId:e.messageId,actions:['silence']}));t.tags.push('explicit-activation-negative');
 }
 const duplicate=(original:string,id:string,text?:string,activated=true):SnapshotTurn=>{
  const t=structuredClone(find(original)),m=t.request.messages[0],old=m.id;
  t.id=id;m.id=m.roomId+':'+id;m.messageId=id;if(text!==undefined)m.text=text;
  Object.assign(m,activated?addressed:{isMentioned:false,mentions:[]});
  if(t.request.addressing?.[old]){t.request.addressing[m.id]=t.request.addressing[old];delete t.request.addressing[old];}
  if(t.request.references?.[old]){t.request.references[m.id]=t.request.references[old];delete t.request.references[old];}
  t.expected=t.expected.map(e=>({...e,messageId:m.id}));return t;
 };
 const positives:SnapshotTurn[]=[
  duplicate('mechanic-help','mentioned-mechanic'),
  duplicate('question-mark','mentioned-short-correction'),
  duplicate('item-level','mentioned-calculation-supplement'),
  duplicate('mechanic-help','named-mechanic','助手，缓存过期会清除已有连接吗？',false),
  duplicate('mechanic-help','suffix-named-mechanic','缓存过期会清除已有连接吗，助手？',false),
 ];
 positives[0].expected[0]={messageId:positives[0].request.messages[0].id,actions:['open_thread']};
 positives[1].expected[0]={messageId:positives[1].request.messages[0].id,actions:['append_thread'],threadId:'task-correction',kind:'correction'};
 positives[2].expected[0]={messageId:positives[2].request.messages[0].id,actions:['append_thread'],threadId:'task-calculation'};
 for(const t of positives.slice(3))t.expected[0]={messageId:t.request.messages[0].id,actions:['open_thread']};
 for(const t of positives)t.tags=['explicit-activation-positive',...t.tags.filter(tag=>tag!=='explicit-activation-negative')];
 scenarios.push({id:'activation-positives',turns:positives});
 const negatives=[
  duplicate('cancel','unmentioned-cancel',undefined,false),
  duplicate('old-image-question','unmentioned-quoted-image',undefined,false),
  duplicate('correct','unmentioned-substantive-correction',undefined,false),
  duplicate('mechanic-help','third-person-name','助手都知道缓存会在过期后失效吧',false),
  duplicate('mechanic-help','quoted-name','B刚说“助手，帮我查一下键盘”，我觉得他又在逗机器人',false),
 ];
 for(const t of negatives){t.expected=t.expected.map(e=>({messageId:e.messageId,actions:['silence']}));t.tags=['explicit-activation-negative'];}
 scenarios.push({id:'activation-negatives',turns:negatives});
 // Persisted Store history, not native memory alone, must support the last turn.
 const memory=scenarios.find(s=>s.id==='long-memory')!;
 memory.turns=memory.turns.filter(t=>!t.id.startsWith('filler-')||['filler-0','filler-1'].includes(t.id));
 memory.id='store-memory';
 const image=find('old-image-question');image.expected[0].actions=['append_thread'];image.expected[0].threadId='task-image';
 // A completed Worker result is a host event, independent of message activation.
 const resultTurns:SnapshotTurn[]=[];
 for(const event of ['worker_result','timer'] as const){
  const roomId='snapshot:result-'+event,id='result-'+event,threadId='task-'+event;
  const request:RouterRequest={roomId,event,currentTime:now,messages:[],recentMessages:[],threads:[],result:{id,threadId,explicit:true,
   report:{threadId,runId:'run-'+event,coveredInputSeq:1,basedOnRevision:1,status:'ready',shortAnswer:'已完成用户明确要求的缓存机制核对。',assumptions:[],evidenceRefs:[],openQuestions:[]}}};
  resultTurns.push({id,tags:['result-delivery',event],request,expected:[],expectedResult:{action:'publish_result',resultId:id}});
 }
 scenarios.push({id:'result-delivery',turns:resultTurns});
 return scenarios;
}

export function resultFailures(turn:SnapshotTurn,actions:RouteAction[]):string[]{
 if(turn.expectedResult){const e=turn.expectedResult;return actions.length===1&&actions[0].action===e.action&&'resultId'in actions[0]&&actions[0].resultId===e.resultId?[]:['result action or identity'];}
 return actions.some(a=>!('sourceMessageIds'in a))?['unexpected result action in message turn']:[];
}
