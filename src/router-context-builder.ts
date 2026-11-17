import type { Config } from './config.js';
import type { Store } from './store.js';
import { roomMemoryAtomic } from './room-memory-store.js';
import type { BotReply,GroupMessage,RouterRequest } from './types.js';
import { routerOutputContract } from './runtime/router-request.js';

const scopeError=()=>Object.assign(new Error('Router original outside captured room/intake scope'),{code:'INVALID_ROUTER_CONTEXT'});
const replyKey=(reply:BotReply)=>reply.messageId?`id:${reply.messageId}`:JSON.stringify(['unidentified',reply.sentAt,reply.replyToMessageId,reply.text]);

/** Called while the coordinator owns the room, with no model work in the transaction. */
export function attachRoomMemory(store:Store,request:RouterRequest,inputBudgetBytes:number):RouterRequest {
  return roomMemoryAtomic(store.db,()=>{
  if(request.messages.some(message=>message.roomId!==request.roomId))throw scopeError();
  const snapshot=store.roomMemory.capture(request.roomId,{
    ...(request.event==='messages'&&request.messages.length?{beforeMessageId:request.messages[0].id}:{}),
    // The remainder stays available to notes, authoritative current input and tool reads.
    eventBudgetBytes:Math.max(1,Math.floor(inputBudgetBytes/4)),
  });
  const sources=new Set(request.messages.map(m=>m.id));
  const references=Object.entries(request.references??{}).filter(([id])=>sources.has(id));
  const lookedUp=store.roomMemory.sourceEvents(request.roomId,{
    messageIds:[...request.messages.map(m=>m.id),...request.recentMessages.map(m=>m.id),...references.flatMap(([,ref])=>ref.message?[ref.message.id]:[])],
    replyIds:[...(request.recentReplies??[]).flatMap(r=>r.messageId?[r.messageId]:[]),...references.flatMap(([,ref])=>ref.reply?.messageId?[ref.reply.messageId]:[])],
    throughSeq:Number.MAX_SAFE_INTEGER,
  });
  const historical=lookedUp.filter(event=>event.seq<=snapshot.cutoffSeq);
  const byMessage=new Map(lookedUp.flatMap(event=>event.message?[[event.message.id,event] as const]:[]));
  const quoted=[] as typeof historical;
  const checkedReferences=request.references?Object.fromEntries(references.map(([id,ref])=>{
    const boundary=byMessage.get(id)?.seq;if(boundary===undefined)throw scopeError();
    const original=ref.message?byMessage.get(ref.message.id):undefined;
    const reply=ref.reply?.messageId?lookedUp.find(event=>event.reply?.messageId===ref.reply!.messageId&&event.seq<boundary):undefined;
    if(ref.message&&(!original||original.seq>=boundary||ref.message.roomId!==request.roomId))throw scopeError();
    if(ref.reply&&!reply)throw scopeError();
    if(original)quoted.push(original);if(reply)quoted.push(reply);
    return [id,{...ref,...(original?{message:original.message!}:{}),...(reply?{reply:reply.reply!}:{})}];
  })):undefined;
  const messages=new Map<string,GroupMessage>(),replies=new Map<string,BotReply>();
  // Intake order, not user-supplied timestamps, controls which old entries are
  // removed first under pressure. Unprocessed corrections stay at the tail.
  const events=[...new Map([...historical,...snapshot.events,...quoted].map(event=>[event.seq,event])).values()].sort((a,b)=>a.seq-b.seq);
  for(const event of events){
    if(event.message&&!sources.has(event.message.id))messages.set(event.message.id,event.message);
    if(event.reply)replies.set(replyKey(event.reply),event.reply);
  }
  const sourceEvents=new Map(store.roomMemory.eventsBySeq(request.roomId,[...new Set((snapshot.version?.notes??[]).flatMap(n=>n.sourceSeqs))]).map(e=>[e.seq,e]));
  const notes=(snapshot.version?.notes??[]).map(note=>({...note,sources:note.sourceSeqs.flatMap(seq=>{
    const event=sourceEvents.get(seq);
    if(!event||seq>snapshot.cutoffSeq)return [];
    const id=event.message?.id??event.reply?.messageId;
    return id?[{seq,kind:event.kind,id,authorId:event.authorId}]:[];
  })}));
  return {...request,references:checkedReferences,recentMessages:[...messages.values()],recentReplies:[...replies.values()],
    workingMemory:{epoch:snapshot.epoch,version:snapshot.version?.version??0,coveredSeq:snapshot.version?.coveredSeq??0,
      cutoffSeq:snapshot.cutoffSeq,notes,...(snapshot.gap?{gap:snapshot.gap}:{})}};
  });
}

const message=(m:GroupMessage)=>({...m,attachments:m.attachments.map((a,attachmentIndex)=>({kind:a.kind,hasImage:true,attachmentIndex}))});
const bytes=(value:unknown)=>Buffer.byteLength(JSON.stringify(value));
function searchTerms(text:string):Set<string>{
  const terms=new Set<string>();
  for(const word of text.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}_-]+/gu)??[]){
    if(/\p{Script=Han}/u.test(word)){const characters=[...word];for(let i=0;i<characters.length-1;i++)terms.add(characters[i]+characters[i+1]);if(characters.length===1)terms.add(word);}
    else terms.add(word);
  }
  return terms;
}
function prioritizeNotes(request:RouterRequest,notes:NonNullable<RouterRequest['workingMemory']>['notes']){
  const terms=searchTerms(request.messages.map(m=>m.text).join('\n')),authors=new Set(request.messages.map(m=>m.authorId));
  return notes.map((note,index)=>({note,index,relevance:[...searchTerms(`${note.id} ${note.text}`)].reduce((total,term)=>total+Number(terms.has(term)),0),author:Number(note.authorId!==null&&authors.has(note.authorId)),latest:note.sourceSeqs.reduce((latest,seq)=>Math.max(latest,seq),0)}))
    .sort((a,b)=>b.relevance-a.relevance||b.author-a.author||b.latest-a.latest||a.index-b.index).map(item=>item.note);
}
/** One canonical copy of each original. Only optional historical entries can be omitted. */
export function buildRouterPayload(request:RouterRequest,config:Pick<Config,'recentMessageLimit'|'threadCardLimit'>,
  recallAvailable=false,inputBudgetBytes=Number.MAX_SAFE_INTEGER):string {
  if(!Number.isSafeInteger(inputBudgetBytes)||inputBudgetBytes<1)throw new Error('Invalid Router input budget');
  if([...request.messages,...request.recentMessages].some(m=>m.roomId!==request.roomId)||request.threads.some(t=>t.roomId!==request.roomId))throw scopeError();
  const current=new Map<string,GroupMessage>();
  for(const original of request.messages){
    if(current.has(original.id)&&JSON.stringify(current.get(original.id))!==JSON.stringify(original))throw Object.assign(new Error('Conflicting current message identity'),{code:'INVALID_ROUTER_CONTEXT'});
    current.set(original.id,original);
  }
  const currentIds=new Set(current.keys());
  const recent=new Map(request.recentMessages.filter(m=>!currentIds.has(m.id)).map(m=>[m.id,message(m)]));
  const replies=new Map((request.recentReplies??[]).map(r=>[replyKey(r),r]));
  const pinnedMessages=new Set<string>(),pinnedReplies=new Set<string>();
  const references=request.references?Object.fromEntries(Object.entries(request.references).filter(([id])=>currentIds.has(id)).map(([id,ref])=>{
    const {message:original,reply,...facts}=ref;
    if(original&&original.roomId!==request.roomId)throw scopeError();
    if(original&&!currentIds.has(original.id)){recent.set(original.id,message(original));pinnedMessages.add(original.id);}
    if(reply?.messageId){replies.set(replyKey(reply),reply);pinnedReplies.add(replyKey(reply));}
    // A receipt without a platform identity cannot authorize a reply ID; keep
    // an explicit quoted body verbatim and omit its optional duplicate.
    if(reply&&!reply.messageId)replies.delete(replyKey(reply));
    return [id,{...facts,...(original?{messageRef:original.id,...(request.routing?{message:message(original)}:{})}:{}),...(reply?.messageId?{replyRef:reply.messageId,...(request.routing?{reply}:{})}:reply?{reply}:{})}];
  })):undefined;
  if(!Number.isSafeInteger(config.threadCardLimit)||config.threadCardLimit<0)throw new Error('Invalid Router thread card limit');
  const pinnedThreads=new Set(Object.values(references??{}).flatMap(ref=>ref.status==='resolved'&&ref.threadId?[ref.threadId]:[]));
  if(request.result)pinnedThreads.add(request.result.threadId);
  const uniqueThreads=[...new Map(request.threads.map(thread=>[thread.id,thread])).values()];
  const pinnedCards=uniqueThreads.filter(thread=>pinnedThreads.has(thread.id));
  const authors=new Set(request.messages.map(m=>m.authorId));
  const others=uniqueThreads.filter(thread=>!pinnedThreads.has(thread.id)).sort((a,b)=>Number(authors.has(b.ownerId))-Number(authors.has(a.ownerId)));
  const threads=[...pinnedCards,...others].slice(0,Math.max(config.threadCardLimit,pinnedCards.length));
  const payload={...request,outputContract:routerOutputContract(request),...(request.routing?{routing:structuredClone(request.routing)}:{}),messages:[...current.values()].map(message),recentMessages:[...recent.values()],recentReplies:[...replies.values()],references,
    threads:threads.map(t=>({id:t.id,roomId:t.roomId,ownerId:t.ownerId,sourceMessageId:t.sourceMessageId,explicit:t.explicit,status:t.status,participants:t.participants,
      revision:t.revision,epoch:t.epoch,latestInputSeq:t.latestInputSeq,
      ...(t.scheduledTask?{scheduledTask:t.scheduledTask}:{}),
      subject:recallAvailable?t.subject.slice(0,180):t.subject,
      summary:recallAvailable?t.summary.slice(0,160):t.summary,lastFailure:t.lastFailure,
      ...(recallAvailable&&(t.subject.length>180||t.summary.length>160)?{textTruncated:true,subjectCharacters:t.subject.length,summaryCharacters:t.summary.length}:{})})),
    taskStates:request.taskStates?.filter(state=>threads.some(thread=>thread.id===state.threadId)).map(state=>({...state,updates:state.updates.map(input=>({...input,message:message(input.message)}))})),
    result:request.result?{...request.result,report:{...request.result.report,details:undefined,attachments:undefined,fileAttachments:undefined,requirementState:undefined,requirementSnapshot:undefined,hostMemberMemory:undefined}}:undefined,
  };
  // A snapshot describes exactly what was supplied, without claiming prefix coverage.
  const measure=()=>{
    if(payload.routing)payload.routing.context={...payload.routing.context,
      messageIds:[...new Set([...payload.messages,...payload.recentMessages].map(m=>m.id))],
      replyIds:payload.recentReplies.flatMap(r=>r.messageId?[r.messageId]:[]),threadIds:payload.threads.map(t=>t.id)};
    return bytes(payload);
  };
  let limitedHistory=false;
  for(let index=0;payload.recentMessages.length>Math.max(config.recentMessageLimit,pinnedMessages.size)&&index<payload.recentMessages.length;){
    if(pinnedMessages.has(payload.recentMessages[index].id)){index++;continue;}
    payload.recentMessages.splice(index,1);limitedHistory=true;
  }
  if(limitedHistory)payload.workingMemory={epoch:0,version:0,coveredSeq:0,cutoffSeq:0,notes:[],...payload.workingMemory,omittedContext:true};
  let omitted=limitedHistory;
  let size=measure();
  // Recent originals can contain a correction not incorporated into old notes.
  // Preserve that direct evidence first, then fit whole, relevant notes into
  // the actual remainder. Omitted notes remain readable through memory recall.
  const selectableNotes=size>inputBudgetBytes&&payload.workingMemory?.notes.length
    ?prioritizeNotes(request,payload.workingMemory.notes):undefined;
  if(selectableNotes){
    payload.workingMemory={...payload.workingMemory!,notes:[],omittedNotes:true,availableNotes:Math.max(payload.workingMemory!.availableNotes??0,selectableNotes.length)};
    size=measure();
  }
  // Find the smallest removable prefix in logarithmic measurements. Serializing
  // the entire payload for every old entry makes large histories quadratic.
  const trimHistory=<T>(items:T[],pinned:(item:T)=>boolean,assign:(kept:T[])=>void)=>{
    const removable=items.filter(item=>!pinned(item)).length;
    if(!removable)return false;
    const drop=(count:number)=>{let skipped=0;return items.filter(item=>pinned(item)||++skipped>count);};
    let low=1,high=removable;
    while(low<high){const middle=Math.floor((low+high)/2);assign(drop(middle));
      if(measure()<=inputBudgetBytes)high=middle;else low=middle+1;}
    assign(drop(low));size=measure();return true;
  };
  // Capacity pressure never silently clips a current question or explicit quote.
  while(size>inputBudgetBytes){
    if(!omitted){payload.workingMemory={epoch:0,version:0,coveredSeq:0,cutoffSeq:0,notes:[],...payload.workingMemory,omittedContext:true};omitted=true;size=measure();}
    if(trimHistory(payload.recentMessages,m=>pinnedMessages.has(m.id),kept=>{payload.recentMessages=kept;}))continue;
    if(trimHistory(payload.recentReplies,r=>pinnedReplies.has(replyKey(r)),kept=>{payload.recentReplies=kept;}))continue;
    const taskState=payload.taskStates?.find(state=>state.snapshot||state.updates.length);
    if(taskState){taskState.snapshot=undefined;taskState.updates=[];taskState.needsRecall=true;taskState.nextInputSeq=1;size=measure();continue;}
    const threadIndex=payload.threads.findLastIndex(t=>!pinnedThreads.has(t.id));
    if(threadIndex>=0){const removed=payload.threads.splice(threadIndex,1)[0];payload.taskStates=payload.taskStates?.filter(state=>state.threadId!==removed.id);size=measure();continue;}
    const fact=payload.routing?.hostEvents.shift();
    if(fact){size=measure();continue;}
    break;
  }
  if(size>inputBudgetBytes)throw Object.assign(new Error('Current Router input cannot fit the model context; split the current batch'),{code:'ROUTER_PAYLOAD_OVERSIZED'});
  if(selectableNotes)for(const note of selectableNotes){
    const cost=bytes(note)+(payload.workingMemory!.notes.length?1:0);
    if(size+cost>inputBudgetBytes)continue;
    payload.workingMemory!.notes.push(note);size+=cost;
  }
  return JSON.stringify(payload);
}
