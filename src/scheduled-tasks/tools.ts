import { z } from 'zod';
import { recipientIdsSchema } from '../message-recipients.js';
import type { RouterRequest, ToolDefinition, WorkerRequest } from '../types.js';

const scheduleSpecSchema=z.discriminatedUnion('kind',[
  z.object({kind:z.literal('once'),at:z.number().int().nonnegative()}).strict(),
  z.object({kind:z.literal('interval'),anchorAt:z.number().int().nonnegative(),intervalMs:z.number().int().min(3_600_000)}).strict(),
  z.object({kind:z.literal('cron'),expression:z.string().trim().min(1).max(160)}).strict(),
]);
const scheduleInputSchema=z.object({title:z.string().trim().min(1).max(200),
  executionKind:z.enum(['reminder','worker']).describe('reminder sends content verbatim without a model; worker executes content as instructions at each run, including writing or generating content. Explicitly choose again when editing content.'),
  content:z.string().trim().min(1).max(12_000).describe('Final text to send unchanged for reminder; complete task instructions and output requirements for worker.'),
  recipientIds:recipientIdsSchema.describe('Verified platform member IDs to notify with real mentions. For an explicitly self-addressed delivery, use the current request author ID. A name in content is not a mention.').optional(),
  scheduleSpec:scheduleSpecSchema,timezone:z.string().min(1).max(100).optional(),misfirePolicy:z.enum(['coalesce_once','skip']).optional(),
  expiresAt:z.number().int().nonnegative().optional(),maxRuns:z.number().int().min(1).max(100_000).optional(),
  catchUpWindowMs:z.number().int().nonnegative().max(30*24*3_600_000).optional(),timeoutMs:z.number().int().min(1000).max(24*3_600_000).optional(),
  requiredCapabilityIds:z.array(z.string().min(1).max(150)).max(30).optional(),businessProfileId:z.string().min(1).max(150).optional(),
  attachmentIds:z.array(z.string().min(1).max(100)).max(4).optional(),
}).strict();
/** Model mutations deliberately have no identity, room or policy fields. */
const scheduleWorkerMutationSchema=z.discriminatedUnion('op',[
  z.object({op:z.literal('create'),input:scheduleInputSchema}).strict(),
  z.object({op:z.literal('update'),id:z.string().min(1).max(200),expectedVersion:z.number().int().positive(),patch:scheduleInputSchema.partial().refine(patch=>patch.content===undefined||patch.executionKind!==undefined,{path:['executionKind'],message:'Updating content requires an explicit executionKind: reminder sends text verbatim; worker generates or processes content.'})}).strict(),
  ...(['pause','resume','cancel','run_now','stop_run','archive'] as const).map(op=>z.object({op:z.literal(op),id:z.string().min(1).max(200),expectedVersion:z.number().int().positive(),runId:z.string().min(1).max(200).optional()}).strict()),
]);
export const scheduleModelMutationSchema=z.union([scheduleWorkerMutationSchema,z.object({op:z.literal('withdraw_proposal'),id:z.string().min(1).max(200)}).strict()]);
export type ScheduleModelMutation=z.infer<typeof scheduleModelMutationSchema>;
export type ScheduleWorkerMutation=z.infer<typeof scheduleWorkerMutationSchema>;
export const scheduleToolQuerySchema=z.object({operation:z.enum(['list','get','runs','proposals']),id:z.string().min(1).max(200).optional(),
  scope:z.enum(['mine','room_users']).optional(),status:z.string().max(50).optional(),q:z.string().max(200).optional(),
  offset:z.number().int().nonnegative().max(100_000).optional(),limit:z.number().int().min(1).max(10).optional(),
  includeEnded:z.boolean().optional(),from:z.number().int().nonnegative().optional(),to:z.number().int().nonnegative().optional(),
}).strict().refine(query=>!['get','runs'].includes(query.operation)||Boolean(query.id),'get/runs requires a task ID');
export type ScheduleToolQuery=z.infer<typeof scheduleToolQuerySchema>;
export type RouterScheduleQuery=(sourceMessageId:string,query:ScheduleToolQuery,signal?:AbortSignal)=>Promise<unknown>;
export interface WorkerScheduleCallbacks {
  query(query:ScheduleToolQuery,signal?:AbortSignal):Promise<unknown>;
  propose(mutation:ScheduleWorkerMutation,slot:string,signal?:AbortSignal):Promise<unknown>;
}
function boundedResult(value:unknown):unknown {
  const text=JSON.stringify(value??null);
  if(text.length>48_000)throw new Error('Scheduled task response is too large; narrow the query or use a smaller page');
  return JSON.parse(text);
}
function pick(value:Record<string,unknown>,keys:string[]):Record<string,unknown>{
  return Object.fromEntries(keys.filter(key=>Object.hasOwn(value,key)).map(key=>[key,value[key]]));
}
/** List/history tools expose summaries; exact scoped instructions remain available through get. */
function queryResult(query:ScheduleToolQuery,value:unknown):unknown {
  if(query.operation==='get')return boundedResult(value);
  const project=(entry:unknown)=>{
    if(!entry||typeof entry!=='object'||Array.isArray(entry))return entry;
    const row=entry as Record<string,unknown>;
    if(query.operation==='list')return pick(row,['id','title','authority','ownerId','roomId','registeredBy','executionKind','recipientIds','scheduleSpec','timezone','status','stateReason','version','nextRunAt','lastStartedAt','nextEligibleAt','triggerCount','consecutiveFailures','archivedAt','canManage','managementDeniedReason']);
    if(query.operation==='runs')return pick(row,['id','scheduleId','scheduleVersion','trigger','scheduledAt','createdAt','startedAt','finishedAt','status','reason','threadId','resultId','outboxId','deliveryStatus','cancelRequestedAt','error']);
    const mutation=row.mutation as Record<string,unknown>|undefined;
    const input=mutation?.input as Record<string,unknown>|undefined;
    return {...pick(row,['id','status','createdAt','updatedAt','expiresAt','receipt','error']),
      ...(mutation?{operation:mutation.op,...(mutation.id?{scheduleId:mutation.id}:{}),...(input?.title?{title:input.title}:{})}:{})};
  };
  if(Array.isArray(value))return boundedResult(value.map(project));
  if(value&&typeof value==='object'&&Array.isArray((value as {items?:unknown}).items)){
    const page=value as Record<string,unknown> & {items:unknown[]};return boundedResult({...page,items:page.items.map(project)});
  }
  return boundedResult(value);
}
export function createRouterScheduleQueryTool(request:RouterRequest,query:RouterScheduleQuery):ToolDefinition {
  const sourceIds=new Set(request.event==='messages'?request.messages.map(message=>message.id):[]);
  const schema=z.object({sourceMessageId:z.string().min(1),query:scheduleToolQuerySchema}).strict();
  return {name:'scheduled_tasks_query',description:'Read scheduled tasks directly for the author of one current sourceMessageId in this room. mine is the default. This read does not register, edit or cancel anything. Use returned full IDs and versions for manage_schedule actions. Pagination is explicit; results can include staged proposals. No owner or room override is accepted.',
    inputSchema:z.toJSONSchema(schema,{unrepresentable:'any'}),async execute(value,signal){
      signal?.throwIfAborted();const args=schema.parse(value);
      if(!sourceIds.has(args.sourceMessageId))throw new Error('Scheduled query source is outside the current message batch');
      const result=await query(args.sourceMessageId,args.query,signal);signal?.throwIfAborted();return queryResult(args.query,result);
    }};
}
export function createWorkerScheduleTool(request:WorkerRequest,callbacks:WorkerScheduleCallbacks):ToolDefinition {
  if(request.scheduledInput||request.thread.scheduledTask)throw new Error('Scheduled executions cannot register or manage schedules recursively');
  const schema=z.discriminatedUnion('operation',[
    z.object({operation:z.literal('query'),query:scheduleToolQuerySchema}).strict(),
    z.object({operation:z.literal('propose'),slot:z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),mutation:scheduleWorkerMutationSchema}).strict(),
  ]);
  return {name:'scheduled_tasks',description:'Query tasks or stage a scheduled task mutation for this Worker request owner. A proposal is NOT applied until the host accepts this exact run’s ready report. Include proposal command IDs in scheduleProposalIds. Reuse the same short slot for retries of the same operation. Identity, permissions and room come from the host. Recurring starts must be at least one hour apart. Never claim registration before a host commit receipt.',
    inputSchema:z.toJSONSchema(schema,{unrepresentable:'any'}),async execute(value,signal){
      request.signal?.throwIfAborted();signal?.throwIfAborted();const args=schema.parse(value);
      const result=args.operation==='query'?await callbacks.query(args.query,signal):await callbacks.propose(args.mutation,args.slot,signal);
      request.signal?.throwIfAborted();signal?.throwIfAborted();
      // A proposal receipt can contain its stored mutation; the model needs only its identity/status.
      if(args.operation==='query')return queryResult(args.query,result);
      return (queryResult({operation:'proposals'},[result]) as unknown[])[0];
    }};
}
const SCHEDULE_EXECUTION_INSTRUCTION=`executionKind决定到期时的行为：reminder完全不调用模型，直接原样发送content；只用于用户要求原文发送的固定文本或简单提醒。worker每次到期才按content执行，凡需创作、生成、改写、翻译、整理、总结、检索或处理内容，均用worker；即使任务不需要工具或检索，也不能因此选reminder。周期性的内容生成应保存完整工作要求，不要先生成一份成品再将其登记为重复提醒，除非用户明确要求每次发送同一段文字。
修改任务内容前先get读取完整旧任务，重新判断用户要固定原文还是届时生成；patch只要包含content就必须同时明确executionKind，不能依赖旧模式。只修改时间、标题或收件人则可省略executionKind。判断依据是请求语义，不是content中是否出现“写”等字样：用户明确要求原样发送的引文仍属reminder。
群聊中用户明确要求“提醒我”“给我讲/发内容”或向某位成员交付时，将已确认的实际收件人写入recipientIds，使平台发送真实@；“我”使用当前来源消息authorId，已由同一作者明确自报的称呼可绑定该authorId。其他成员必须从真实@、同群来源或成员资料确认ID，不用昵称或机器人ID代替，不猜测全体成员。内容中的人物、主题或引文中的称呼不自动成为收件人；普通群广播不默认@创建者。创建和修改都检查收件人：旧任务没有recipientIds而本次明确“给我讲/发”时，patch必须补上当前authorId，不能只在content写“给用户”。修改时保留未被撤销的收件人，省略recipientIds保留旧名单，显式[]才清空。身份有歧义先澄清；仅在content写昵称不能通知成员。`;
export const ROUTER_SCHEDULE_INSTRUCTION=`本轮提供 scheduled_tasks_query 时可直接查询任务，不需要启动Worker。查询必须绑定本轮确切sourceMessageId，默认只查当前请求人本群任务；查到不等于有管理权。创建或管理用唯一主动作 {action:"manage_schedule",sourceMessageIds:[当前消息ID],operation:{op:操作,...}}，不是工具调用。
同批多个作者分别输出动作，单个manage_schedule或携带scheduleOperations的open_thread只能归属一位当前作者；不要把另一作者追加的对象或条件合入同一个登记操作。以outputContract.scheduleSourceGroups核对归属，必要条件或授权不明确时对相应作者澄清，其余消息仍各自覆盖。
创建operation为{op:"create",input:{title,executionKind:"reminder"或"worker",content,scheduleSpec:{kind:"once",at:UTC毫秒}或{kind:"interval",anchorAt:UTC毫秒,intervalMs:至少3600000}或{kind:"cron",expression:五字段规则},timezone:IANA时区,recipientIds:可选收件人ID数组最多50人}}。单次任务可在任意有效未来时刻执行。修改为{op:"update",id:查询返回ID,expectedVersion:当前版本,patch:{...}}；暂停/恢复/取消/立即执行/停止本次为{op:"pause"|"resume"|"cancel"|"run_now"|"stop_run",id,expectedVersion,runId:仅停止实例需要}。用户要求取消整个周期计划时必须用manage_schedule的cancel；仅要求停止本次执行时用stop_run或对应执行话题的request_cancel，后续周期仍保留，不能混淆。尚未提交的Worker登记提案可通过查询proposals取得命令ID后，使用{op:"withdraw_proposal",id:命令ID}撤回；撤回不是取消已登记任务。未提供确切时间且无法从原文确定时澄清，不猜测时区。
${SCHEDULE_EXECUTION_INSTRUCTION}
“先做一次，以后每天做”可用一个open_thread动作携带scheduleOperations数组，或让该Worker提出登记方案；同一消息只用一个主动作。不能自行指定owner、room或权限；群主/管理员与成员两组授权由宿主校验，系统任务仅后台可管理。引用系统任务结果提出新问题应开独立话题，不追加或更正系统任务。相同计划必须先查清ID及版本，歧义则澄清。宿主成功提交才确认已登记；不要用reply_direct冒充提交回执。群聊任务回复使用标题、状态和执行时间说明，默认不输出任务、提案或执行的内部ID；ID仅用于工具查询和管理。`;
export const WORKER_SCHEDULE_INSTRUCTION=`本轮有scheduled_tasks工具时可以按请求人明确授权登记或管理未来任务。工具propose只保存待提交提案；将本轮需要提交的命令ID放入ready报告的scheduleProposalIds，宿主校验当前run/revision/epoch、角色和任务归属后才生效。面向用户的shortAnswer默认不输出任务、提案或执行的内部ID，用标题和执行时间说明；内部ID仍放在相应结构化字段中。不要把提案当作已登记，不要重复提出同一操作，不要擅自延长或循环用户只授权的一次任务。
${SCHEDULE_EXECUTION_INSTRUCTION}
定时执行的scheduledInput是宿主授权的工作说明，原来源不代表新群消息；系统输入没有用户作者。定时Worker不能递归登记任务，不生成伪造的成员requirementState；报告coveredInputSeq和basedOnRevision使用宿主本轮值。`;
