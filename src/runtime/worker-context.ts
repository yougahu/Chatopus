import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { GroupMessage, ThreadInput, ToolDefinition, WorkerReport, WorkerRequest } from '../types.js';

export const WORKER_CONTEXT_CHARS = 48_000;
export const WORKER_HISTORY_PAGE_CHARS = 8_000;
export interface WorkerRequirementSnapshot {
  throughInputSeq:number;
  revision:number;
  inputDigest:string;
  byAuthor:Array<{authorId:string;text:string;sourceSeqs:number[]}>;
}
type Part = 'message' | 'context_message' | 'context_reply' | 'resolved_request' | 'correction_target' | 'scheduled_instruction';
interface TextPart { seq:number; part:Part; index?:number; text:string; sourceRole:'user'|'bot'|'router'; authorId?:string; messageId?:string; replyToMessageId?:string }
export interface WorkerInputReadRange { seq:number; part:Part; index?:number; offset:number; totalCharacters:number }
export interface WorkerContextOptions { maxChars?:number; recentInputs?:number; persist?:boolean; previousSnapshot?:WorkerRequirementSnapshot }
export interface WorkerContext {
  inputs: unknown[];
  snapshot: Record<string, unknown>;
  /** Originals selected for image attachment and extension input preparation. */
  selectedInputs: ThreadInput[];
  tools: ToolDefinition[];
  unreadCurrentInputs(): WorkerInputReadRange[];
  /** Validate provenance/coverage and stamp model-authored requirements with host identity. */
  validateCandidateState(value:unknown): WorkerRequirementSnapshot;
  /** All original evidence newer than the validated requirement checkpoint must be consumed. */
  assertReady(report: Pick<WorkerReport,'status'>): void;
  close(): void;
}
function number(value:unknown,fallback:number,min:number,max:number):number {
  if(value===undefined)return fallback;
  if(!Number.isSafeInteger(value)||(value as number)<min||(value as number)>max)throw new Error('Invalid history bound');
  return value as number;
}
function textParts(input:ThreadInput):TextPart[] {
  return [
    {seq:input.seq,part:'message',text:input.message.text,sourceRole:'user',authorId:input.message.authorId,messageId:input.message.id,replyToMessageId:input.message.replyToMessageId},
    ...(input.contextMessages??[]).map((message,index)=>({seq:input.seq,part:'context_message' as const,index,text:message.text,sourceRole:'user' as const,authorId:message.authorId,messageId:message.id,replyToMessageId:message.replyToMessageId})),
    ...(input.contextReplies??[]).map((reply,index)=>({seq:input.seq,part:'context_reply' as const,index,text:reply.text,sourceRole:'bot' as const,messageId:reply.messageId,replyToMessageId:reply.replyToMessageId})),
    ...(input.routingContext?[{seq:input.seq,part:'resolved_request' as const,text:input.routingContext.resolvedRequest,sourceRole:'router' as const},
      ...(input.routingContext.correctionTarget?[{seq:input.seq,part:'correction_target' as const,text:input.routingContext.correctionTarget,sourceRole:'router' as const}]:[])]:[]),
  ];
}
const key=(part:Pick<TextPart,'seq'|'part'|'index'>)=>JSON.stringify([part.seq,part.part,part.index??0]);
// dsh refuses tool values with undefined properties rather than silently dropping them.
const json=<T>(value:T):T=>JSON.parse(JSON.stringify(value));
function clip(text:string,limit:number){return {text:text.slice(0,limit),...(text.length>limit?{textTruncated:true,totalCharacters:text.length}:{})};}
function projectMessage(message:GroupMessage,limit:number) {
  return {...message,...clip(message.text,limit),mentions:message.mentions.slice(0,12),
    attachments:message.attachments.map((attachment,attachmentIndex)=>({kind:attachment.kind,hasImage:true,attachmentIndex}))};
}
/** Stable host projection: preserve attribution, never expose attachment locators. */
export function projectWorkerInput(input:ThreadInput,limit=Number.MAX_SAFE_INTEGER) {
  return {...input,message:projectMessage(input.message,limit),
    ...(input.contextMessages?{contextMessages:input.contextMessages.map(message=>projectMessage(message,limit))}:{}),
    ...(input.contextReplies?{contextReplies:input.contextReplies.map(reply=>({...reply,...clip(reply.text,limit)}))}:{}),
    ...(input.routingContext?{routingContext:{...input.routingContext,
      resolvedRequest:input.routingContext.resolvedRequest.slice(0,limit),
      ...(input.routingContext.resolvedRequest.length>limit?{resolvedRequestTruncated:true}:{}),
      ...(input.routingContext.correctionTarget?{correctionTarget:input.routingContext.correctionTarget.slice(0,limit),
        ...(input.routingContext.correctionTarget.length>limit?{correctionTargetTruncated:true}:{})}:{})}}:{}),
  };
}
function record(input:ThreadInput) {
  return {seq:input.seq,revision:input.revision,kind:input.kind,messageId:input.message.id,authorId:input.message.authorId,
    authorName:input.message.authorName,preview:input.message.text.slice(0,160),totalCharacters:input.message.text.length,
    contextMessageCount:input.contextMessages?.length??0,
    contextMessages:(input.contextMessages??[]).slice(0,8).map((message,index)=>({index,authorId:message.authorId,messageId:message.id,totalCharacters:message.text.length})),
    contextReplyCount:input.contextReplies?.length??0,
    contextReplies:(input.contextReplies??[]).slice(0,8).map((reply,index)=>({index,messageId:reply.messageId,totalCharacters:reply.text.length})),
    ...(input.routingContext?{interpretation:input.routingContext.resolvedRequest.slice(0,400),interpretationTruncated:input.routingContext.resolvedRequest.length>400,
      routingMetadata:input.routingContext.routingMetadata,
      correctionTarget:input.routingContext.correctionTarget?.slice(0,300)}:{})};
}

/** A schedule has host provenance rather than a fabricated chat author/message. */
async function prepareScheduledWorkerContext(request:WorkerRequest,options:WorkerContextOptions,maxChars:number):Promise<WorkerContext> {
  const source=structuredClone(request.scheduledInput!),task=request.thread.scheduledTask;
  if(!task||source.kind!=='scheduled'||source.scheduleId!==task.scheduleId||source.scheduleRunId!==task.scheduleRunId
    ||source.authority!==task.authority||source.roomId!==request.thread.roomId||!source.instructions.trim()
    ||(source.authority==='system'?source.ownerId!==null:!source.ownerId||source.ownerId!==request.thread.ownerId)
    ||request.inputs.length||options.previousSnapshot||request.thread.latestInputSeq!==1)
    throw new Error('Invalid scheduled Worker source binding');
  const binding={threadId:request.thread.id,runId:request.runId,revision:request.thread.revision,throughInputSeq:1,
    inputDigest:createHash('sha256').update(JSON.stringify(source)).digest('hex')};
  const {instructions,...metadata}=source;
  const entry={seq:1,revision:request.thread.revision,...metadata,sourceRole:'host',instructions};
  let inline=instructions.length;
  const snapshot:Record<string,unknown>={version:1,...binding,mode:'scheduled',totalInputs:1,
    authorization:{kind:source.authority,ownerId:source.ownerId,sourceRefs:source.sourceRefs},
    instruction:'这是宿主登记的定时执行输入，不是本轮群聊发言。按instructions完成本次工作；禁止自行扩大授权或递归登记计划，不提交按群成员归属的requirementState。若instructions截短，使用worker_input_history scan/read读取余下部分后才能报告ready。',
    history:{tool:'worker_input_history',firstSeq:1,lastSeq:1,pageCharacters:WORKER_HISTORY_PAGE_CHARS},
  };
  if(JSON.stringify({inputs:[entry],snapshot}).length>maxChars)inline=Math.min(2000,instructions.length);
  const inputs=[{...entry,instructions:instructions.slice(0,inline),...(inline<instructions.length?{instructionsTruncated:true,totalCharacters:instructions.length}:{})}];
  const readRanges:Array<[number,number]>=[[0,inline]];
  function unreadCurrentInputs():WorkerInputReadRange[]{
    let end=0;for(const [start,stop]of [...readRanges].sort((a,b)=>a[0]-b[0])){if(start>end)break;end=Math.max(end,stop);}
    return end<instructions.length?[{seq:1,part:'scheduled_instruction',offset:end,totalCharacters:instructions.length}]:[];
  }
  Object.assign(snapshot,{requiredReads:unreadCurrentInputs(),requiredReadParts:unreadCurrentInputs().length,inlineSeqs:[1],scanAfterSeq:0});
  if(JSON.stringify({inputs,snapshot}).length>maxChars)throw Object.assign(new Error('Scheduled input metadata exceeds context capacity'),{code:'WORKER_CONTEXT_METADATA_OVERSIZED'});
  let closed=false;
  const tool:ToolDefinition={name:'worker_input_history',description:'Read this exact scheduled run’s immutable host instructions. Use read or scan with offset and continue nextOffset/nextCursor until complete. This source is not a chat message and has no fabricated author.',
    inputSchema:{type:'object',properties:{operation:{type:'string',enum:['read','scan']},seq:{type:'integer',enum:[1]},part:{type:'string',enum:['scheduled_instruction']},offset:{type:'integer',minimum:0},limit:{type:'integer',minimum:1,maximum:8000},afterSeq:{type:'integer',enum:[0]}},required:['operation'],additionalProperties:false},
    async execute(value,signal){
      request.signal?.throwIfAborted();signal?.throwIfAborted();if(closed)throw new Error('Worker history is closed');
      if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Expected scheduled history arguments');
      const args=value as Record<string,unknown>;
      if(Object.keys(args).some(k=>!['operation','seq','part','offset','limit','afterSeq'].includes(k))
        ||!['read','scan'].includes(String(args.operation))||args.seq!==undefined&&args.seq!==1
        ||args.part!==undefined&&args.part!=='scheduled_instruction'||args.afterSeq!==undefined&&args.afterSeq!==0)throw new Error('Invalid scheduled history scope');
      const offset=number(args.offset,0,0,instructions.length),limit=number(args.limit,WORKER_HISTORY_PAGE_CHARS,1,WORKER_HISTORY_PAGE_CHARS);
      const end=Math.min(instructions.length,offset+limit);readRanges.push([offset,end]);
      const row={...binding,seq:1,part:'scheduled_instruction',sourceRole:'host',...metadata,text:instructions.slice(offset,end),offset,totalCharacters:instructions.length};
      return args.operation==='read'?{...row,nextOffset:end<instructions.length?end:null}:{...binding,records:[row],nextCursor:end<instructions.length?{seq:1,part:'scheduled_instruction',offset:end}:null};
    }};
  if(options.persist!==false){
    const directory=join(request.workspace,'.worker-inputs');await mkdir(directory,{recursive:true,mode:0o700});
    const file=join(directory,createHash('sha256').update(request.runId).digest('hex')+'.json'),contents=JSON.stringify({inputs,snapshot});
    try{await writeFile(file,contents,{mode:0o600,flag:'wx'});}catch(error){
      if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;
      if(await readFile(file,'utf8')!==contents)throw new Error('Run already has a different scheduled input snapshot');
    }
  }
  return {inputs,snapshot,selectedInputs:[],tools:[tool],unreadCurrentInputs,
    assertReady(report){if(report.status==='ready'&&unreadCurrentInputs().length)throw Object.assign(new Error('Scheduled instructions remain unread'),{code:'WORKER_CONTEXT_UNREAD'});},
    validateCandidateState(){throw new Error('Scheduled inputs do not create user-author requirement checkpoints');},close(){closed=true;}};
}

/** A bounded model view of an immutable, host-owned run snapshot. Full originals
 * remain in SQLite; the tool never reads another task or subsequently steered input. */
export async function prepareWorkerContext(request:WorkerRequest,options:WorkerContextOptions={}):Promise<WorkerContext> {
  request.signal?.throwIfAborted();
  const maxChars=number(options.maxChars,WORKER_CONTEXT_CHARS,8_000,160_000);
  if(request.scheduledInput)return prepareScheduledWorkerContext(request,options,maxChars);
  if(request.thread.scheduledTask)throw new Error('Scheduled execution is missing its authoritative input');
  const recentInputs=number(options.recentInputs,6,1,12);
  const originals=structuredClone(request.inputs).sort((a,b)=>a.seq-b.seq);
  const bySeq=new Map<number,ThreadInput>();
  for(const input of originals){
    if(!Number.isSafeInteger(input.seq)||input.seq<1||bySeq.has(input.seq))throw new Error('Invalid or duplicate Worker input sequence');
    if(input.message.roomId!==request.thread.roomId||(input.contextMessages??[]).some(message=>message.roomId!==request.thread.roomId))throw new Error('Worker history crosses room scope');
    bySeq.set(input.seq,input);
  }
  const latest=originals.at(-1);
  const digest=createHash('sha256');
  let checkpointDigest:string|undefined;
  for(const input of originals){
    digest.update(JSON.stringify(projectWorkerInput(input))).update('\n');
    if(input.seq===options.previousSnapshot?.throughInputSeq)checkpointDigest=digest.copy().digest('hex');
  }
  const previousSnapshot=options.previousSnapshot?structuredClone(options.previousSnapshot):undefined;
  if(previousSnapshot){
    const covered=bySeq.get(previousSnapshot.throughInputSeq);
    const priorAuthors=new Map<string,number>();
    for(const input of originals)if(input.seq<=previousSnapshot.throughInputSeq)priorAuthors.set(input.message.authorId,input.seq);
    const seen=new Set<string>();
    if(!covered||covered.revision!==previousSnapshot.revision||checkpointDigest!==previousSnapshot.inputDigest
      ||JSON.stringify(previousSnapshot).length>16_000||!Array.isArray(previousSnapshot.byAuthor)
      ||previousSnapshot.byAuthor.length<1||previousSnapshot.byAuthor.length>32||previousSnapshot.byAuthor.some(author=>{
        if(!author||typeof author.authorId!=='string'||seen.has(author.authorId)||!priorAuthors.has(author.authorId)||typeof author.text!=='string'||!author.text.trim()
          ||!Array.isArray(author.sourceSeqs)||author.sourceSeqs.length<1||author.sourceSeqs.length>128
          ||!author.sourceSeqs.includes(priorAuthors.get(author.authorId)!)
          ||author.sourceSeqs.some(seq=>!Number.isSafeInteger(seq)||seq>previousSnapshot.throughInputSeq||bySeq.get(seq)?.message.authorId!==author.authorId))return true;
        seen.add(author.authorId);return false;
      })||[...priorAuthors.keys()].some(author=>!seen.has(author)))throw new Error('Invalid Worker requirement checkpoint');
  }
  const uncovered=originals.filter(input=>input.seq>(previousSnapshot?.throughInputSeq??0));
  const binding={threadId:request.thread.id,runId:request.runId,revision:request.thread.revision,
    throughInputSeq:latest?.seq??0,inputDigest:digest.digest('hex')};
  const latestByAuthor=new Map<string,ThreadInput>();
  for(const input of originals)latestByAuthor.set(input.message.authorId,input);
  const authorInputs=[...latestByAuthor.values()].sort((a,b)=>b.seq-a.seq).slice(0,8);
  const base={version:1,...binding,totalInputs:originals.length,
    ...(previousSnapshot?{previousSnapshot}:{}),
    currentInterpretations:authorInputs.map(input=>({authorId:input.message.authorId,seq:input.seq,messageId:input.message.id,kind:input.kind,
      ...clip(input.routingContext?.resolvedRequest??input.message.text,800),
      ...(input.routingContext?{routingMetadata:input.routingContext.routingMetadata,
        correctionTarget:input.routingContext.correctionTarget?.slice(0,400),source:'router_interpretation'}:{source:'original_preview'})})),
    omittedAuthors:Math.max(0,latestByAuthor.size-authorInputs.length),
    history:{tool:'worker_input_history',firstSeq:originals[0]?.seq??0,lastSeq:latest?.seq??0,pageCharacters:WORKER_HISTORY_PAGE_CHARS},
    instruction:'previousSnapshot 是已消费原文后的需求检查点，保留其未被新原文明示更正或撤销的条件。currentInterpretations 只是路由解释，不是完整需求账本。各作者条件独立，缺省旧输入不表示撤销。requiredReads/requiredReadParts 指明检查点之后尚未完整提供的原文；必须用 worker_input_history scan/read 消费后才可标 ready 或提交新的完整检查点。scan 支持 nextCursor 顺序读取。旧原文也可 list/search/read 核对，不要让用户重复提供已存信息。',
  };
  const initial=previousSnapshot?uncovered:originals;
  let inputs:ReturnType<typeof projectWorkerInput>[]=initial.map(input=>projectWorkerInput(input));
  let selectedInputs=initial;
  let snapshot:Record<string,unknown>={...base,mode:previousSnapshot?'incremental':'complete',inlineSeqs:initial.map(input=>input.seq),omittedInputs:originals.length-initial.length,requiredReads:[],requiredReadParts:0};
  const reads:WorkerInputReadRange[]=[];
  const ranges=new Map<string,Array<[number,number]>>();
  if(JSON.stringify({inputs,snapshot}).length>maxChars){
    inputs=[];selectedInputs=[];
    // Prefer current deltas, then each current author's original request. Keep
    // the most recent input even if its own text needs pagination.
    const candidates=[...uncovered.slice(-recentInputs).reverse(),
      ...authorInputs.flatMap(last=>uncovered.find(input=>input.message.authorId===last.message.authorId)??[]),uncovered[0]].filter(Boolean);
    const seen=new Set<number>();
    const textLimit=Math.max(300,Math.min(2_000,Math.floor((maxChars-JSON.stringify(base).length)/16)));
    for(const original of candidates){
      if(seen.has(original.seq))continue;seen.add(original.seq);
      const projected=projectWorkerInput(original,textLimit);
      const proposal=[...inputs,projected].sort((a,b)=>a.seq-b.seq);
      const proposedSnapshot={...base,mode:'bounded',inlineSeqs:proposal.map(input=>input.seq),omittedInputs:originals.length-proposal.length,requiredReads:[]};
      if(JSON.stringify({inputs:proposal,snapshot:proposedSnapshot}).length>maxChars-2_000)continue;
      inputs=proposal;selectedInputs.push(original);
    }
    if(latest&&!selectedInputs.includes(latest))throw Object.assign(new Error('Worker current input metadata exceeds bounded snapshot capacity'),{code:'WORKER_CONTEXT_METADATA_OVERSIZED'});
    selectedInputs.sort((a,b)=>a.seq-b.seq);
    for(const original of uncovered)for(const part of textParts(original)){
      const end=selectedInputs.includes(original)?Math.min(textLimit,part.text.length):0;ranges.set(key(part),[[0,end]]);
      if(end<part.text.length)reads.push({seq:part.seq,part:part.part,...(part.index===undefined?{}:{index:part.index}),offset:end,totalCharacters:part.text.length});
    }
    snapshot={...base,mode:'bounded',inlineSeqs:inputs.map(input=>input.seq),omittedInputs:originals.length-inputs.length,
      requiredReads:reads.slice(0,8),requiredReadParts:reads.length,scanAfterSeq:previousSnapshot?.throughInputSeq??0};
  }
  if(JSON.stringify({inputs,snapshot}).length>maxChars)throw Object.assign(new Error('Worker snapshot metadata exceeds size limit'),{code:'WORKER_CONTEXT_METADATA_OVERSIZED'});
  let closed=false;
  const tool:ToolDefinition={name:'worker_input_history',
    description:'Read this run’s attributed original task inputs. scan reads successive text parts within 32k serialized characters; start with afterSeq=snapshot.scanAfterSeq and continue by spreading nextCursor into the next scan call until null. read pages one part at UTF-16 offset (default message, max8000). list/search find metadata by afterSeq, optional authorId and literal query. All checkpoint-uncovered evidence must be consumed before ready. No other thread/run or future inputs are accessible.',
    inputSchema:{type:'object',properties:{operation:{type:'string',enum:['list','search','read','scan']},seq:{type:'integer',minimum:1},part:{type:'string',enum:['message','context_message','context_reply','resolved_request','correction_target']},index:{type:'integer',minimum:0},offset:{type:'integer',minimum:0},limit:{type:'integer',minimum:1},afterSeq:{type:'integer',minimum:0},authorId:{type:'string'},query:{type:'string'}},required:['operation'],additionalProperties:false},
    async execute(value,signal){
      request.signal?.throwIfAborted();signal?.throwIfAborted();if(closed)throw new Error('Worker history is closed');
      if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Expected history arguments');
      const args=value as Record<string,unknown>;
      if(Object.keys(args).some(k=>!['operation','seq','part','index','offset','limit','afterSeq','authorId','query'].includes(k)))throw new Error('Unsupported history argument');
      if(args.operation==='scan'){
        const afterSeq=number(args.afterSeq,0,0,Number.MAX_SAFE_INTEGER);
        const seq=number(args.seq,originals.find(input=>input.seq>afterSeq)?.seq??0,1,Number.MAX_SAFE_INTEGER);
        if(!seq)return json({...binding,records:[],nextCursor:null});
        if(!bySeq.has(seq))throw new Error('Input is outside this run snapshot');
        const parts=originals.filter(input=>input.seq>=seq).flatMap(textParts);
        const startPart=args.part??'message',startIndex=number(args.index,0,0,1000);
        const start=parts.findIndex(part=>part.seq===seq&&part.part===startPart&&(part.index??0)===startIndex);
        if(start<0)throw new Error('History text part not found');
        let offset=number(args.offset,0,0,parts[start].text.length),nextCursor:Record<string,unknown>|null=null;
        const records:unknown[]=[];
        for(let n=start;n<parts.length;n++){
          const part=parts[n],input=bySeq.get(part.seq)!;
          const entry={seq:part.seq,revision:input.revision,kind:input.kind,part:part.part,index:part.index,
            inputAuthorId:input.message.authorId,sourceRole:part.sourceRole,authorId:part.authorId,messageId:part.messageId,
            replyToMessageId:part.replyToMessageId,offset,totalCharacters:part.text.length,text:''};
          const room=30_000-JSON.stringify(records).length-JSON.stringify(entry).length;
          if(room<100){nextCursor={seq:part.seq,part:part.part,index:part.index,offset};break;}
          let length=Math.min(part.text.length-offset,room),lo=0,hi=length;
          // Account for JSON escaping before committing read coverage.
          while(lo<hi){const mid=Math.ceil((lo+hi)/2);if(JSON.stringify(part.text.slice(offset,offset+mid)).length<=room)lo=mid;else hi=mid-1;}
          length=lo;const end=offset+length;
          records.push({...entry,text:part.text.slice(offset,end)});
          ranges.set(key(part),[...(ranges.get(key(part))??[]),[offset,end]]);
          if(end<part.text.length){nextCursor={seq:part.seq,part:part.part,index:part.index,offset:end};break;}
          offset=0;
        }
        return json({...binding,records,nextCursor});
      }
      if(args.operation==='read'){
        const seq=number(args.seq,0,1,Number.MAX_SAFE_INTEGER),input=bySeq.get(seq);if(!input)throw new Error('Input is outside this run snapshot');
        const partName=args.part??'message';
        if(typeof partName!=='string'||!['message','context_message','context_reply','resolved_request','correction_target'].includes(partName))throw new Error('Unknown history text part');
        const index=number(args.index,0,0,1000),part=textParts(input).find(part=>part.part===partName&&(part.index??0)===index);if(!part)throw new Error('History text part not found');
        const offset=number(args.offset,0,0,part.text.length),limit=number(args.limit,WORKER_HISTORY_PAGE_CHARS,1,WORKER_HISTORY_PAGE_CHARS),end=Math.min(offset+limit,part.text.length);
        ranges.set(key(part),[...(ranges.get(key(part))??[]),[offset,end]]);
        return json({...binding,seq,kind:input.kind,part:part.part,index:part.index,inputAuthorId:input.message.authorId,
          sourceRole:part.sourceRole,authorId:part.authorId,messageId:part.messageId,replyToMessageId:part.replyToMessageId,
          text:part.text.slice(offset,end),offset,nextOffset:end<part.text.length?end:null,totalCharacters:part.text.length});
      }
      if(args.operation!=='list'&&args.operation!=='search')throw new Error('Unknown history operation');
      if(args.authorId!==undefined&&typeof args.authorId!=='string')throw new Error('Invalid authorId');
      const afterSeq=number(args.afterSeq,0,0,Number.MAX_SAFE_INTEGER),limit=number(args.limit,8,1,12);
      const query=args.operation==='search'?args.query:undefined;
      if(args.operation==='search'&&(typeof query!=='string'||!query.trim()||query.length>200))throw new Error('Search requires 1–200 characters');
      const matches:unknown[]=[];let nextAfterSeq:number|null=null;
      for(const input of originals){
        if(input.seq<=afterSeq||(args.authorId!==undefined&&input.message.authorId!==args.authorId))continue;
        let match:unknown;
        if(typeof query==='string'){
          const found=textParts(input).map(part=>({part,at:part.text.toLocaleLowerCase().indexOf(query.toLocaleLowerCase())})).find(found=>found.at>=0);
          if(!found)continue;
          const offset=Math.max(0,found.at-80);
          match={...record(input),match:{part:found.part.part,index:found.part.index,sourceRole:found.part.sourceRole,authorId:found.part.authorId,offset,text:found.part.text.slice(offset,offset+300)}};
        }else match=record(input);
        if(matches.length===limit||JSON.stringify(matches).length+JSON.stringify(match).length>12_000){
          if(!matches.length)throw new Error('Input metadata exceeds history page limit; read its text by sequence');
          nextAfterSeq=(matches.at(-1) as {seq:number}).seq;break;
        }
        matches.push(match);
      }
      return json({...binding,records:matches,nextAfterSeq,totalInputs:originals.length});
    },
  };
  if(options.persist!==false){
    request.signal?.throwIfAborted();
    const directory=join(request.workspace,'.worker-input-snapshots');
    await mkdir(directory,{recursive:true,mode:0o700});
    const file=join(directory,createHash('sha256').update(request.runId).digest('hex')+'.json'),contents=JSON.stringify({inputs,snapshot});
    try{await writeFile(file,contents,{mode:0o600,flag:'wx'});}
    catch(error){
      if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;
      if(await readFile(file,'utf8')!==contents)throw new Error('Run already has a different Worker input snapshot');
    }
  }
  function unreadCurrentInputs(){
      return reads.flatMap(part=>{
        let end=0;
        for(const [start,stop]of [...(ranges.get(key(part))??[])].sort((a,b)=>a[0]-b[0])){if(start>end)break;end=Math.max(end,stop);}
        return end<part.totalCharacters?[{...part,offset:end}]:[];
      });
  }
  return {inputs,snapshot,selectedInputs,tools:[tool],unreadCurrentInputs,
    assertReady(report){
      if(report.status!=='ready')return;
      const unread=unreadCurrentInputs();
      if(unread.length)throw Object.assign(new Error('Task input remains unread; use worker_input_history scan/read before reporting ready'),{code:'WORKER_CONTEXT_UNREAD',requiredReads:unread.slice(0,8),requiredReadParts:unread.length});
    },
    validateCandidateState(value){
      if(unreadCurrentInputs().length)throw new Error('Cannot checkpoint unread Worker input');
      if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Expected requirement state');
      const authors=(value as {byAuthor?:unknown}).byAuthor;
      if(!Array.isArray(authors)||authors.length<1||authors.length>32)throw new Error('Requirement state needs 1–32 authors');
      const seen=new Set<string>();
      for(const author of authors){
        if(!author||typeof author!=='object'||typeof author.authorId!=='string'||seen.has(author.authorId)||!latestByAuthor.has(author.authorId)
          ||typeof author.text!=='string'||!author.text.trim()||!Array.isArray(author.sourceSeqs)||author.sourceSeqs.length<1||author.sourceSeqs.length>128
          ||author.sourceSeqs.some((seq:unknown)=>!Number.isSafeInteger(seq)||bySeq.get(seq as number)?.message.authorId!==author.authorId)
          ||!author.sourceSeqs.includes(latestByAuthor.get(author.authorId)!.seq))throw new Error('Invalid requirement author or source provenance');
        seen.add(author.authorId);
      }
      if([...latestByAuthor.keys()].some(author=>!seen.has(author)))throw new Error('Requirement state omitted an author');
      const checkpoint:WorkerRequirementSnapshot={throughInputSeq:latest?.seq??0,revision:latest?.revision??0,inputDigest:binding.inputDigest,
        byAuthor:authors.map(author=>({authorId:author.authorId,text:author.text,sourceSeqs:[...new Set<number>(author.sourceSeqs)]}))};
      if(JSON.stringify(checkpoint).length>16_000)throw new Error('Requirement checkpoint exceeds 16k characters');
      return checkpoint;
    },close(){closed=true;},
  };
}
