import type { GroupMessage, RouteAction, RouterRequest, ThreadCard } from '../src/types.js';

export interface ExpectedRoute {
  messageId:string;
  actions:RouteAction['action'][];
  threadId?:string;
  kind?:'correction';
  textContains?:string;
  contextMessageId?:string;
}
export interface ComparisonTurn {id:string;request:RouterRequest;expected:ExpectedRoute[];tags:string[];history?:{messages?:GroupMessage[];threads?:ThreadCard[]}}
export interface ComparisonScenario {id:string;turns:ComparisonTurn[]}
const now=1_795_000_000_000;
const message=(roomId:string,id:string,text:string,extra:Partial<GroupMessage>={}):GroupMessage=>({
  id:`${roomId}:${id}`,platform:'replay',roomId,messageId:id,authorId:'A',authorName:'成员A',text,timestamp:now,mentions:[],attachments:[],isMentioned:false,isAdmin:false,...extra,
});
const thread=(roomId:string,id:string,extra:Partial<ThreadCard>={}):ThreadCard=>({id,roomId,subject:'Node 20 缓存与重复请求处理',ownerId:'A',sourceMessageId:'original',explicit:true,participants:['A'],status:'idle',revision:1,latestInputSeq:1,sessionId:'worker-'+id,epoch:1,summary:'已解释缓存对重复请求的处理方式。',...extra});
const addressed={isMentioned:true,mentions:['bot']};
function turn(roomId:string,id:string,text:string,expected:Omit<ExpectedRoute,'messageId'>,extras:Partial<RouterRequest>={},messageExtras:Partial<GroupMessage>={},tags:string[]=[]):ComparisonTurn{
  const m=message(roomId,id,text,messageExtras);
  return {id,tags,request:{roomId,currentTime:now,botUserId:'bot',event:'messages',messages:[m],recentMessages:[],threads:[],...extras},expected:[{messageId:m.id,...expected}]};
}

/** Fixed synthetic messages. No personal group transcript enters model comparisons. */
export function comparisonScenarios():ComparisonScenario[]{
  const scenarios:ComparisonScenario[]=[];
  let room='comparison:participation';
  const talk=[message(room,'chat1','你刚才说你在看发布会？',{authorId:'B'}),message(room,'chat2','对啊，跟C一起看着呢',{authorId:'C'})];
  scenarios.push({id:'participation',turns:[
    turn(room,'mechanic-help','缓存过期会清除已有连接吗？',{actions:['open_thread']},{},{},['unmentioned-help']),
    turn(room,'casual-time','这次发布会什么时候开啊',{actions:['silence']},{recentMessages:talk},{authorId:'B'},['member-chatter']),
    turn(room,'human-help','B帮我看一下这个配置行吗',{actions:['silence']},{addressing:{[room+':human-help']:{mentionsOthers:['B']}}},{mentions:['B']},['addressed-to-member']),
    turn(room,'explicit-delegate','帮我整理一下发布会的新版本改动',{actions:['open_thread']},{recentMessages:talk},{},['explicit-unmentioned-delegation']),
    turn(room,'complaint','这个机器人今天怎么老插嘴',{actions:['silence']},{},{authorId:'C'},['third-person-complaint']),
  ]});
  room='comparison:corrections';const t=thread(room,'task-correction',{subject:'Node 20 服务部署方案',summary:'误把成员A的Node 20 问题解释为 Node 22，等待纠正。'});
  const original=message(room,'original','帮我分析Node 20 服务部署步骤',addressed);
  const wrong={messageId:'wrong',replyToMessageId:'original',text:'你要的是Node 22 服务部署，但工具不支持Node 22。',sentAt:now-100};
  scenarios.push({id:'corrections',turns:[
    turn(room,'correct','我问的是Node 20 服务部署，不是 Node 22，请按原问题继续。',{actions:['append_thread'],threadId:t.id,kind:'correction'},{threads:[t],recentMessages:[original],recentReplies:[wrong]},addressed,['version-correction']),
    turn(room,'question-mark','？',{actions:['append_thread'],threadId:t.id,kind:'correction'},
      {threads:[t],recentMessages:[original,message(room,'clarifying','我说的是Node 20 服务部署，不是 Node 22',addressed)],recentReplies:[wrong]},
      {replyToMessageId:'wrong'},['short-correction']),
    turn(room,'thanks','谢谢，明白了',{actions:['silence']},{threads:[t],recentReplies:[{...wrong,messageId:'corrected',text:'已经按Node 20 服务部署整理。'}]}, {replyToMessageId:'corrected'},['quoted-thanks']),
  ]});
  room='comparison:calculation';const ct=thread(room,'task-calculation',{subject:'成员A的文档审核通过率和期望成本',status:'needs_input',summary:'继续计算文档审核通过率，等待成员A补充文档页数和预算。'});
  const calculationOriginal=message(room,'original','帮我算文档审核通过率和期望成本',addressed);
  const calculationContext={threads:[ct],recentMessages:[calculationOriginal],recentReplies:[{messageId:'calculation-ask',replyToMessageId:'original',text:'请补充文档页数和预算，我会继续按刚才的目标计算。',sentAt:now-100}]};
  scenarios.push({id:'calculation',turns:[
    turn(room,'item-level','文档页数85，继续按刚才的目标算',{actions:['append_thread'],threadId:ct.id},calculationContext,{replyToMessageId:'calculation-ask'},['calculation-supplement']),
    turn(room,'budget','预算改为20元，重新计算',{actions:['append_thread'],threadId:ct.id},calculationContext,addressed,['calculation-correction']),
    turn(room,'no-calculation','先不算成本了，只解释缓存的过期机制。',{actions:['open_thread','append_thread']},calculationContext,addressed,['calculation-withdrawal']),
    turn(room,'other-author','我想问缓存的过期机制，不是计算成本',{actions:['open_thread','append_thread']},calculationContext,{...addressed,authorId:'B',authorName:'成员B'},['cross-author']),
  ]});
  room='comparison:control';const active=thread(room,'task-control',{status:'running',summary:'正在核对文档参数。'});
  const control={threads:[active],recentMessages:[message(room,'original','帮我分析这件文档',addressed)]};
  scenarios.push({id:'control',turns:[
    turn(room,'status','我刚才让你分析的文档现在查到哪了？',{actions:['request_status'],threadId:active.id},control,addressed,['status']),
    turn(room,'cancel','不用继续查我刚才那件文档了，停止这个任务',{actions:['request_cancel'],threadId:active.id},control,addressed,['cancellation']),
    turn(room,'cancelled-thanks','谢谢不用了',{actions:['silence']},{threads:[{...active,status:'cancelled'}]}, {},['cancelled-task']),
  ]});
  room='comparison:images';const image=message(room,'old-image','这是我的文档截图',{attachments:[{kind:'image',file:'synthetic-image.png'}]});
  const imageTask=thread(room,'task-image',{subject:'成员A的文档图',summary:'已收到成员A的文档截图。'});
  scenarios.push({id:'images',turns:[
    turn(room,'old-image-question','这张图里的参数适合我的方案吗？',{actions:['open_thread','append_thread']},
      {recentMessages:[image],threads:[imageTask],references:{[room+':old-image-question']:{status:'resolved',threadId:imageTask.id,message:image,chain:['old-image']}}},
      {...addressed,replyToMessageId:'old-image'},['old-image-quote']),
    turn(room,'unmentioned-image','',{actions:['silence']},{},{attachments:[{kind:'image',file:'synthetic-image.png'}]},['unmentioned-image']),
    turn(room,'addressed-image','',{actions:['open_thread']},{},{...addressed,attachments:[{kind:'image',file:'synthetic-image.png'}]},['addressed-image']),
  ]});
  room='comparison:mixed';const request=turn(room,'request','帮我查缓存是否减少重复请求',{actions:['open_thread']},{},addressed,['mixed-batch']);
  const chatter=message(room,'chatter','哈哈这次外观好闪',{authorId:'B'});
  request.request.messages.push(chatter);request.expected.push({messageId:chatter.id,actions:['silence']});
  scenarios.push({id:'mixed-batch',turns:[request]});
  room='comparison:long-memory';
  const memory:ComparisonTurn[]=[turn(room,'remember','帮我记住一个测试代号：蓝松石731。只是记住这个代号，不需要额外查询资料。',{actions:['reply_direct']},{},addressed,['memory-anchor'])];
  const filler='B：这本小说的情节我昨天看了一遍，C：人物关系和电影不太一样。';
  for(let index=0;index<10;index++)memory.push(turn(room,'filler-'+index,filler.repeat(95),{actions:['silence']},{recentMessages:[message(room,'background','群友B和C在彼此讨论小说，不是在向机器人提问。',{authorId:'B'})]}, {authorId:index%2?'B':'C'},['long-history-chatter']));
  memory.push(turn(room,'recall','我一开始让你记住的测试代号是什么？只回答代号。',{actions:['reply_direct'],textContains:'蓝松石731'},{},addressed,['long-history-recall']));
  scenarios.push({id:'long-memory',turns:memory});
  room='comparison:recall-original';
  const oldFact=turn(room,'recall-hidden','我之前让你记住的测试代号是什么？请查询本群记录，只回答代号。',{actions:['reply_direct'],textContains:'银杏982'},{},addressed,['capability-recall','original-fact-recall']);
  oldFact.history={messages:[message(room,'hidden-fact','帮我记住这个测试代号：银杏982。',addressed)]};
  scenarios.push({id:'recall-original',turns:[oldFact]});
  room='comparison:recall-task';const hiddenTask=thread(room,'task-hidden-budget',{subject:'成员A的30元工作站升级方案',status:'needs_input',summary:'成员A要求30元以内的工作站升级建议，正在等成员A补充CPU 利用率。'});
  const oldTask=turn(room,'recall-hidden-task','继续我之前30元工作站升级那个任务，我的CPU 利用率是35%，别另开任务。',{actions:['append_thread'],threadId:hiddenTask.id},{},addressed,['capability-recall','old-task-recall']);
  oldTask.history={messages:[message(room,'hidden-original','请按30元预算分析我的工作站升级路线',addressed)],threads:[hiddenTask]};
  scenarios.push({id:'recall-task',turns:[oldTask]});
  return scenarios;
}
