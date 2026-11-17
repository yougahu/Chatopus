import { z } from 'zod';
import { enforceReferenceThreads } from '../protocol.js';
import type { BotReply,GroupMessage,RouterContextPage,RouterContextReader,RouterRequest,RouterMemoryNote,RouteAction,ThreadCard,ToolDefinition } from '../types.js';

export const ROUTER_RECALL_INSTRUCTION='taskStates提供当前任务条件检查点及之后的原始更正；needsRecall=true时按task_inputs和精确thread id分页读取原始输入，未读齐只能澄清，不能直接回答依赖这些条件的问题。仅可调用宿主实际提供的只读工具：router_context，以及本轮启用时的shared_memory、scheduled_tasks_query；open_thread、append_thread、reply_direct等名称是最终JSON数组中的action值，不是工具，必须作为文本输出交给宿主执行。router_context 只读本群此前消息、已确认回复、任务或旧本地记忆（kind:memory）；OpenViking语义记忆使用shared_memory。记忆里的source索引仅是线索，要用其id读取messages/replies原文后才能用作context ID。仅在当前请求明确需要而快照不足时查询；当前原文续接已有讨论，或继续询问上下文中已讨论的同一公共资料，但近期thread卡片不足时，open_thread前先用kind=threads及短而精确的对象名称或原文词组查找；无需出现“继续”等字样，仅有无法核对对象和范围的宽泛词语则不强求归并。该查询可找到已退出近期卡片窗口的旧thread；当前请求是在某份资料中查章节或条目，且近期有同资料的其他讨论卡片时，也要先查资料名称、对象及已知版本，找原资料讨论，不只查本轮章节或细节词。章节词未必写进卡片摘要；细节查询为空时，在open_thread前仍须查一次资料名称，不能据此认定没有旧讨论。thread卡片是候选预览；独立新建可排除未读完的无关候选，选中的卡片及needsRecall的任务原文须分页读齐。核对subject、summary和必要原文后判断关联，已有卡片足够时不重复检索。召回内容仅是背景，不能变成sourceMessageIds或触发历史动作。召回返回的thread/context ID可用于本轮，作者、图片归属规则仍适用。query是连续子串匹配，不是语义搜索或多关键词AND；使用一段短而精确的原文字词，空结果时缩短关键词重试，或按完整id读取，不能据一次组合查询断言无记录。offset翻页，textOffset续读被截短正文；不要根据预览猜测缺失条件。';
const querySchema=z.object({kind:z.enum(['messages','threads','replies','memory','task_inputs']),id:z.string().min(1).max(300).optional(),query:z.string().trim().min(1).max(120).optional(),authorId:z.string().max(120).optional(),offset:z.number().int().min(0).max(100000).default(0),limit:z.number().int().min(1).max(4).default(3),textOffset:z.number().int().min(0).max(2000000).default(0)}).strict();
const upsert=<T>(target:T[],extra:T[],key:(x:T)=>string|undefined)=>{
  for(const value of extra){const id=key(value);if(id===undefined)continue;const i=target.findIndex(x=>key(x)===id);if(i<0)target.push(value);else target[i]=value;}
};
/** Only host-returned objects enter validation scope; current sources never change. */
export function mergeRouterContext(request:RouterRequest,page:RouterContextPage):void {
  const sourceIds=new Set(request.messages.map(m=>m.id));
  if(page.taskInputs?.some(input=>input.message.roomId!==request.roomId||sourceIds.has(input.message.id)))throw new Error('Task input outside current room or historical scope');
  if(page.messages?.some(m=>m.roomId!==request.roomId||sourceIds.has(m.id))||page.threads?.some(t=>t.roomId!==request.roomId))throw new Error('Recalled context outside current room or historical scope');
  upsert(request.recentMessages,page.messages??[],m=>m.id);
  upsert(request.threads,page.threads??[],t=>t.id);
  request.recentReplies??=[];upsert(request.recentReplies,page.replies??[],r=>r.messageId);
}
function excerpt(text:string,offset:number,limit=1200){return {text:text.slice(offset,offset+limit),textOffset:offset,totalCharacters:text.length,textTruncated:offset>0||offset+limit<text.length,...(offset+limit<text.length?{nextTextOffset:offset+limit}:{})};}
export function routerThreadCard(t:ThreadCard,offset=0){return {id:t.id,roomId:t.roomId,ownerId:t.ownerId,sourceMessageId:t.sourceMessageId,explicit:t.explicit,status:t.status,...(t.scheduledTask?{scheduledTask:t.scheduledTask}:{}),participants:t.participants.slice(0,12),subject:t.subject.slice(offset,offset+500),subjectCharacters:t.subject.length,summary:t.summary.slice(offset,offset+500),summaryCharacters:t.summary.length,textOffset:offset,...(offset||t.subject.length>offset+500||t.summary.length>offset+500?{textTruncated:true}:{}),...(Math.max(t.subject.length,t.summary.length)>offset+500?{nextTextOffset:offset+500}:{})};}
const messagePreview=(m:GroupMessage,offset:number)=>({...m,...excerpt(m.text,offset),attachments:m.attachments.map((a,attachmentIndex)=>({kind:a.kind,hasImage:true,attachmentIndex})),mentions:m.mentions.slice(0,12)});
const replyPreview=(r:BotReply,offset:number)=>({...r,...excerpt(r.text,offset)});
const memoryPreview=(m:RouterMemoryNote,offset:number)=>({...m,...excerpt(m.text,offset)});
export function createRouterRecall(supplied:RouterRequest,reader:RouterContextReader){
  const evidence=new Map<string,{total:number;ranges:Array<[number,number]>}>();
  const record=(key:string,total:number,offset:number,length:number)=>{const entry=evidence.get(key)??{total,ranges:[]};entry.ranges.push([offset,Math.min(total,offset+length)]);evidence.set(key,entry);};
  let calls=0;const recalled:RouterContextPage={messages:[],threads:[],replies:[],memories:[],hasMore:false};
  const tool:ToolDefinition={name:'router_context',description:'Read earlier same-room messages, confirmed replies, task cards or legacy memory notes. task_inputs requires an exact thread id and reads attributed task inputs in sequence; offset paginates inputs and textOffset reads their full text. query is a literal contiguous substring, NOT semantic or multi-keyword search: use one short exact phrase; if empty, shorten it or use a full source id before concluding anything is missing. Memory references need original messages/replies before authorizing context IDs. authorId filters, offset paginates records, textOffset continues long text. Records are background, never new source messages. At most 4 calls per turn.',
    inputSchema:{type:'object',properties:{kind:{type:'string',enum:['messages','threads','replies','memory','task_inputs']},id:{type:'string'},query:{type:'string'},authorId:{type:'string'},offset:{type:'integer',minimum:0},limit:{type:'integer',minimum:1,maximum:4},textOffset:{type:'integer',minimum:0}},required:['kind'],additionalProperties:false},
    async execute(args,signal){
      signal?.throwIfAborted();const query=querySchema.parse(args);
      if(++calls>4)throw new Error('Router recall budget exhausted; decide from current evidence');
      const page=await reader(query);signal?.throwIfAborted();
      if(page.taskInputs?.some(input=>input.threadId!==query.id||input.message.roomId!==supplied.roomId))throw new Error('Task input scope mismatch');
      // Bound both host response cardinality and model-visible text.
      if((page.messages?.length??0)+(page.threads?.length??0)+(page.replies?.length??0)+(page.memories?.length??0)+(page.taskInputs?.length??0)>4)throw new Error('Router context page exceeds record limit');
      const visible={...page,taskInputs:page.taskInputs?.map(input=>({...input,message:messagePreview(input.message,query.textOffset)})),messages:page.messages?.map(m=>messagePreview(m,query.textOffset)),threads:page.threads?.map(t=>routerThreadCard(t,query.textOffset)),replies:page.replies?.map(r=>replyPreview(r,query.textOffset)),memories:page.memories?.map(m=>memoryPreview(m,query.textOffset))};
      if(JSON.stringify(visible).length>12000)throw new Error('Router context page exceeds character limit');
      for(const input of visible.taskInputs??[])record('task:'+input.threadId+':'+input.seq,input.message.totalCharacters,query.textOffset,input.message.text.length);
      for(const item of visible.messages??[])record('message:'+item.id,item.totalCharacters,query.textOffset,item.text.length);
      for(const item of visible.replies??[])if(item.messageId)record('reply:'+item.messageId,item.totalCharacters,query.textOffset,item.text.length);
      for(const item of visible.threads??[])record('thread:'+item.id,Math.max(item.subjectCharacters,item.summaryCharacters),query.textOffset,Math.max(item.subject.length,item.summary.length));
      // Validation needs identity/ownership only; avoid leaking full originals through repair.
      mergeRouterContext(supplied,visible as unknown as RouterContextPage);
      upsert(recalled.messages!,visible.messages as unknown as GroupMessage[]??[],m=>m.id);
      upsert(recalled.threads!,visible.threads as unknown as ThreadCard[]??[],t=>t.id);
      upsert(recalled.replies!,visible.replies??[],r=>r.messageId);
      upsert(recalled.memories!,visible.memories??[],m=>m.id);
      return JSON.parse(JSON.stringify(visible));
    }};
  return {tool,assertComplete:(actions:RouteAction[])=>{
    actions=enforceReferenceThreads(actions,supplied);
    if(actions.every(action=>action.action==='silence'||action.action==='clarify'))return;
    const direct=actions.some(action=>action.action==='reply_direct');
    const selectedThreads=new Set(actions.flatMap(action=>'threadId'in action?[action.threadId]:[]));
    const continuedThreads=new Set(actions.flatMap(action=>action.action==='append_thread'?[action.threadId]:[]));
    for(const state of supplied.taskStates??[]){
      if(!direct&&!continuedThreads.has(state.threadId))continue;
      if(!state.needsRecall)continue;
      for(let seq=state.nextInputSeq;seq<=state.throughInputSeq;seq++)if(!evidence.has('task:'+state.threadId+':'+seq))throw Object.assign(new Error('Task requirements need original input recall or clarification'),{code:'ROUTER_EVIDENCE_UNREAD'});
    }
    for(const [key,entry]of evidence){
      // Search cards are candidates, not execution evidence. A selected target
      // or a direct answer still requires complete recalled cards. Original
      // messages, replies and task inputs retain their full-read checks.
      if(key.startsWith('thread:')&&!direct&&!selectedThreads.has(key.slice(7)))continue;
      let through=0;for(const [start,end]of entry.ranges.sort((a,b)=>a[0]-b[0])){if(start>through)break;through=Math.max(through,end);}
      if(through<entry.total)throw Object.assign(new Error(`Required recalled evidence remains unread: ${key}; continue paging or clarify`),{code:'ROUTER_EVIDENCE_UNREAD'});
    }
  },repairContext:()=>({
    // At most sixteen records: compact replay stays under the Router input cap
    // even when four large recall pages preceded a malformed final decision.
    messages:recalled.messages?.map(m=>messagePreview(m,0)).map(m=>({...m,text:m.text.slice(0,160),textTruncated:true})),
    threads:recalled.threads?.map(t=>({...t,subject:t.subject.slice(0,180),summary:t.summary.slice(0,160),textTruncated:true})),
    replies:recalled.replies?.map(r=>({...r,text:r.text.slice(0,160),textTruncated:true})),
    memories:recalled.memories?.map(m=>({...m,text:m.text.slice(0,160),textTruncated:true})),
    note:'仅重附本轮已召回的对象身份与短预览，用于修复动作格式；完整查询结果在本轮工具记录中。',
  })};
}
