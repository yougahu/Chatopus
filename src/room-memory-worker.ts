import { setImmediate as defer, clearImmediate } from 'node:timers';
import type { MemoryEvent, MemoryNote, RoomMemoryStore } from './room-memory-store.js';
import { modelRetriesExhausted } from './runtime/model-retry.js';

export interface MemorySummaryEvent {
  seq:number;roomId:string;kind:'message'|'reply';sourceId:string;authorId:string|null;
  text:string;threadId?:string;digest:string;
  messageId?:string;authorName?:string;replyToMessageId?:string;mentions?:string[];hasImage?:boolean;
  /** UTF-16 offsets into the original text; only the final fragment covers its event. */
  textOffset?:number;totalTextLength?:number;finalPart?:boolean;
}
export interface MemorySummaryInput {
  roomId:string;epoch:number;baseVersion:number;coveredSeq:number;targetSeq:number;
  previousNotes:MemoryNote[];events:MemorySummaryEvent[];outputTokens:number;inputBudgetBytes:number;
  repairHint?:{code:string;reason:string};
  partialMemory?:boolean;inactiveNotesCount?:number;
}
export interface MemoryBudget {
  /** Capacity for the complete serialized MemorySummaryInput, including its metadata. */
  inputBudgetBytes:number;outputTokens:number;maxOutputTokens:number;
}
export type MemoryBudgetReason='initial'|'output_truncated'|'input_capacity';
export interface MemoryBudgetRequest {roomId:string;previousNotes:MemoryNote[];outputTokens?:number;reason:MemoryBudgetReason}
export interface MemoryWorkerEvent {
  kind:'started'|'committed'|'superseded'|'failed';roomId:string;targetSeq:number;
  coveredSeq?:number;version?:number;code?:string;attempt?:number;retryAt?:number;
}
export interface RoomMemoryWorkerOptions {
  store:RoomMemoryStore;
  concurrency:number;
  budget:(request:MemoryBudgetRequest,signal:AbortSignal)=>MemoryBudget|Promise<MemoryBudget>;
  summarize:(input:MemorySummaryInput,signal:AbortSignal)=>Promise<MemoryNote[]>;
  onEvent?:(event:MemoryWorkerEvent)=>void;
  /** Failure backoff only. New arrivals never restart or bypass this timer. */
  retryDelayMs?:(attempt:number,code:string)=>number;
}
interface RoomState {
  targetSeq:number;queued:boolean;running:boolean;attempt:number;retryAt?:number;timer?:ReturnType<typeof setTimeout>;
  outputTokens?:number;eventBudgetBytes?:number;reason:MemoryBudgetReason;lastError?:string;
  noteBudgetBytes?:number;noteBudgetOutputTokens?:number;
  fragmentSeq?:number;
  repairHint?:MemorySummaryInput['repairHint'];
  modelFailedThrough?:number;
}
interface Running {abort:AbortController;promise:Promise<void>}
interface IdleWaiter {resolve:()=>void;reject:(error:unknown)=>void;signal?:AbortSignal;abort?:()=>void}
const bytes=(value:unknown)=>Buffer.byteLength(JSON.stringify(value));
const failure=(code:string,message:string)=>Object.assign(new Error(message),{code});
interface MemorySourceIssue {
  noteId:string;noteIndex:number;noteIdTruncated?:boolean;
  reason:'sourceNotVisible'|'authorMismatch'|'noteAuthorChanged'|'missingAuthorSource';
  sourceSeq?:number;sourceIndex?:number;expectedAuthorId?:string|null;actualAuthorId?:string|null;
  expectedAuthorIdTruncated?:boolean;actualAuthorIdTruncated?:boolean;
}
/** Only host-created metadata enters repair hints; arbitrary error data never does. */
class MemorySourceError extends Error {
  readonly code='MEMORY_SOURCE_INVALID';
  constructor(readonly diagnostics:{issues:MemorySourceIssue[];totalIssues:number;omittedIssues:number}){
    super('Memory sources failed visibility or author validation');
  }
}
const codeOf=(error:unknown)=>{
  const code=(error as {code?:unknown})?.code;
  return typeof code==='string'&&/^[A-Z][A-Z0-9_]{0,79}$/.test(code)?code:'MEMORY_SUMMARY_FAILED';
};
const project=(event:MemoryEvent):MemorySummaryEvent=>({seq:event.seq,roomId:event.roomId,kind:event.kind,
  sourceId:event.sourceId,authorId:event.authorId,text:event.text,digest:event.digest,
  ...(event.threadId?{threadId:event.threadId}:{}),
  ...(event.message?{messageId:event.message.messageId,authorName:event.message.authorName,
    ...(event.message.replyToMessageId?{replyToMessageId:event.message.replyToMessageId}:{}),
    ...(event.message.mentions.length?{mentions:[...event.message.mentions]}:{}),
    ...(event.message.attachments.length?{hasImage:true}:{})}:{}),
  ...(event.reply?{...(event.reply.messageId?{messageId:event.reply.messageId}:{}),
    ...(event.reply.replyToMessageId?{replyToMessageId:event.reply.replyToMessageId}:{})}:{})});
function selectNotes(notes:MemoryNote[],events:MemorySummaryEvent[],inputBudgetBytes:number,fits:(selected:MemoryNote[])=>boolean){
  if(fits(notes))return {selected:notes,inactive:[] as MemoryNote[]};
  const authors=new Set(events.map(event=>event.authorId));
  const words=new Set(events.flatMap(event=>event.text.slice(0,inputBudgetBytes).toLowerCase().split(/[\s，。！？、；：,.!?;:]+/u).filter(word=>word.length>=2)));
  const references=events.flatMap(event=>event.replyToMessageId?[event.replyToMessageId]:[]);
  const ranked=notes.map((note,index)=>({note,index,author:authors.has(note.authorId)?1:0,
    reference:references.some(id=>note.id.includes(id)||note.text.includes(id))?1:0,
    related:[...words].some(word=>note.text.toLowerCase().includes(word))?1:0,
    latest:note.sourceSeqs.reduce((latest,seq)=>Math.max(latest,seq),0)})).sort((a,b)=>b.reference-a.reference||b.author-a.author||b.related-a.related||b.latest-a.latest||a.index-b.index);
  let selected:MemoryNote[]=[];
  for(const {note}of ranked){const next=[...selected,note];if(fits(next))selected=next;}
  const selectedIds=new Set(selected.map(note=>note.id));return {selected,inactive:notes.filter(note=>!selectedIds.has(note.id))};
}

/** A background owner of contiguous room-memory checkpoints; never await notify in routing. */
export class RoomMemoryWorker {
  private readonly rooms=new Map<string,RoomState>();
  private readonly queue:string[]=[];
  private readonly active=new Map<string,Running>();
  private readonly waiters=new Set<IdleWaiter>();
  private scheduled?:ReturnType<typeof setImmediate>;
  private closed=false;
  private closing?:Promise<void>;
  constructor(private readonly options:RoomMemoryWorkerOptions){
    if(!Number.isSafeInteger(options.concurrency)||options.concurrency<1)throw new Error('Memory concurrency must be positive');
  }

  notify(roomId:string,targetSeq?:number):void {
    if(this.closed)return;
    const latest=this.options.store.latestSeq(roomId);targetSeq??=latest;
    if(!Number.isSafeInteger(targetSeq)||targetSeq<0)throw new Error('Invalid room memory target');
    targetSeq=Math.min(targetSeq,latest);
    let state=this.rooms.get(roomId);
    if(!state){state={targetSeq,queued:false,running:false,attempt:0,reason:'initial'};this.rooms.set(roomId,state);}
    else state.targetSeq=Math.max(state.targetSeq,targetSeq);
    this.enqueue(roomId,state);
  }

  private enqueue(roomId:string,state:RoomState):void {
    if(this.closed||state.running||state.queued||state.timer)return;
    if(state.modelFailedThrough!==undefined&&state.targetSeq<=state.modelFailedThrough)return;
    if(state.targetSeq<=(this.options.store.head(roomId).version?.coveredSeq??0)){this.settleIdle();return;}
    state.queued=true;this.queue.push(roomId);
    if(!this.scheduled)this.scheduled=defer(()=>{this.scheduled=undefined;this.pump();});
  }

  private pump():void {
    if(this.closed)return;
    while(this.active.size<this.options.concurrency&&this.queue.length){
      const roomId=this.queue.shift()!,state=this.rooms.get(roomId)!;state.queued=false;
      if(state.running||state.timer)continue;
      if(state.targetSeq<=(this.options.store.head(roomId).version?.coveredSeq??0))continue;
      // A running batch owns a fixed target. New arrivals only raise state.targetSeq.
      const targetSeq=state.targetSeq,abort=new AbortController();state.running=true;
      const promise=this.runBatch(roomId,targetSeq,state,abort.signal).catch(error=>{
        if(!this.closed&&!abort.signal.aborted)this.retry(roomId,state,error);
      }).finally(()=>{
        state.running=false;this.active.delete(roomId);
        if(!this.closed){this.enqueue(roomId,state);this.pump();}
        this.settleIdle();
      });
      this.active.set(roomId,{abort,promise});
    }
    this.settleIdle();
  }

  private emit(event:MemoryWorkerEvent):void {try{this.options.onEvent?.(event);}catch{/* diagnostics are observers */}}

  private async runBatch(roomId:string,targetSeq:number,state:RoomState,signal:AbortSignal):Promise<void>{
    const initial=this.options.store.head(roomId);
    const budget=await this.options.budget({roomId,previousNotes:initial.version?.notes??[],outputTokens:state.outputTokens,reason:state.reason},signal);
    signal.throwIfAborted();
    for(const value of [budget.inputBudgetBytes,budget.outputTokens,budget.maxOutputTokens]){
      if(!Number.isSafeInteger(value)||value<1)throw failure('MEMORY_BUDGET_INVALID','Memory capacity must be positive and explicit');
    }
    if(budget.outputTokens>budget.maxOutputTokens)throw failure('MEMORY_BUDGET_INVALID','Output reserve exceeds model capacity');
    if(state.noteBudgetOutputTokens!==budget.outputTokens){state.noteBudgetBytes=undefined;state.noteBudgetOutputTokens=undefined;}
    const notesFitOutput=(notes:MemoryNote[])=>!notes.length||state.noteBudgetBytes===undefined||bytes(notes)<=state.noteBudgetBytes;
    const current=this.options.store.head(roomId);
    if(current.epoch!==initial.epoch||current.version?.version!==initial.version?.version)return;
    const base=current.version,allNotes=base?.notes??[];
    let selectedNotes=allNotes,inactiveNotes:MemoryNote[]=[];
    const shellFor=(notes:MemoryNote[],events:MemorySummaryEvent[]=[],inactive=0):MemorySummaryInput=>({roomId,epoch:current.epoch,baseVersion:base?.version??0,coveredSeq:base?.coveredSeq??0,
      targetSeq,previousNotes:notes,events,outputTokens:budget.outputTokens,inputBudgetBytes:budget.inputBudgetBytes,
      ...(state.repairHint?{repairHint:state.repairHint}:{}),...(inactive?{partialMemory:true,inactiveNotesCount:inactive}:{})});
    const preview=this.options.store.events(roomId,{afterSeq:base?.coveredSeq??0,throughSeq:targetSeq,inputBudgetBytes:budget.inputBudgetBytes});
    const first=preview[0]?project(preview[0]):undefined;
    const minimal=first?[{...first,text:first.text.slice(0,(first.text.codePointAt(0)??0)>0xFFFF?2:1),textOffset:0,totalTextLength:first.text.length,finalPart:false}]:[];
    if(allNotes.length&&(!notesFitOutput(allNotes)||bytes(shellFor(allNotes,minimal))>budget.inputBudgetBytes)){
      // The durable ledger can outgrow a model window. Activate complete notes
      // only when necessary; unseen notes remain immutable host-owned facts.
      // Prefer leaving a whole current event available when it fits alone.
      // A huge original still uses the exact fragment path below.
      const selectionEvent=first&&bytes(shellFor([],[first],allNotes.length))<=budget.inputBudgetBytes?[first]:minimal;
      const selected=selectNotes(allNotes,preview.map(project),budget.inputBudgetBytes,notes=>notesFitOutput(notes)&&bytes(shellFor(notes,selectionEvent,allNotes.length-notes.length))<=budget.inputBudgetBytes);
      selectedNotes=selected.selected;inactiveNotes=selected.inactive;
    }
    const shell=shellFor(selectedNotes,[],inactiveNotes.length);
    const available=budget.inputBudgetBytes-bytes(shell);
    if(available<=0)throw failure('MEMORY_INPUT_CAPACITY','Existing memory leaves no room for a new source');
    const eventBudget=Math.min(available,state.eventBudgetBytes??available);
    if(eventBudget<1)throw failure('MEMORY_INPUT_CAPACITY','Source metadata cannot fit the model capacity');
    let batch=this.options.store.batch(roomId,targetSeq,eventBudget);
    if(batch.epoch!==current.epoch||batch.baseVersion!==(base?.version??0))return;
    if(!batch.events.length){
      // Deleted/invalidated source rows still occupy sequence numbers. Advance
      // their verified empty prefix without inventing a model interpretation.
      const committed=this.options.store.commit({roomId,epoch:batch.epoch,baseVersion:batch.baseVersion,untilSeq:batch.untilSeq,sourceDigest:batch.sourceDigest,notes:allNotes});
      if(committed){state.attempt=0;state.lastError=undefined;this.emit({kind:'committed',roomId,targetSeq:batch.untilSeq,coveredSeq:committed.coveredSeq,version:committed.version});}
      return;
    }
    this.emit({kind:'started',roomId,targetSeq:batch.untilSeq,coveredSeq:base?.coveredSeq??0});
    const input=(notes:MemoryNote[],events:MemorySummaryEvent[],inactiveCount=inactiveNotes.length):MemorySummaryInput=>({
      roomId,epoch:batch.epoch,baseVersion:batch.baseVersion,coveredSeq:base?.coveredSeq??0,targetSeq:batch.untilSeq,
      previousNotes:notes,events,outputTokens:budget.outputTokens,inputBudgetBytes:budget.inputBudgetBytes,
      ...(state.repairHint?{repairHint:state.repairHint}:{}),
      ...(inactiveCount?{partialMemory:true,inactiveNotesCount:inactiveCount}:{}),
    });
    let events=batch.events.map(project);
    // Store byte bounds may count richer source metadata. Final JSON is the
    // authority; shorten only at complete event boundaries, never drop a gap.
    while(events.length>1&&bytes(input(selectedNotes,events))>budget.inputBudgetBytes)events.pop();
    if(events.length!==batch.events.length){
      batch=this.options.store.batch(roomId,events.at(-1)!.seq,eventBudget);
      events=batch.events.map(project);
    }
    const baseIds=new Set(selectedNotes.map(note=>note.id)),inactiveIds=new Set(inactiveNotes.map(note=>note.id));
    const lineage=new Map(selectedNotes.map(note=>[note.id,new Set([note.id])]));
    const summarize=async(notes:MemoryNote[],part:MemorySummaryEvent[],inactiveDrafts:MemoryNote[]=[])=>{
      signal.throwIfAborted();
      const request=input(notes,part,inactiveNotes.length+inactiveDrafts.length);
      if(bytes(request)>budget.inputBudgetBytes)throw failure('MEMORY_INPUT_CAPACITY','Prepared memory input exceeds verified model capacity');
      try{
        const result=await this.options.summarize(request,signal);signal.throwIfAborted();
        const visibleSources=new Set([...notes.flatMap(note=>note.sourceSeqs),...part.map(event=>event.seq)]);
        const validated=this.validateNotes(roomId,batch.untilSeq,result,notes,visibleSources);
        const unseenIds=new Set([...inactiveIds,...inactiveDrafts.map(note=>note.id)]);
        if(validated.some(note=>unseenIds.has(note.id)||(note.supersedes??[]).some(id=>unseenIds.has(id))))throw failure('MEMORY_SOURCE_INVALID','Inactive memory notes cannot be overwritten or superseded');
        for(const note of validated){
          const replaced=new Set(lineage.get(note.id)??[]);
          for(const id of note.supersedes??[])for(const ancestor of lineage.get(id)??[])replaced.add(ancestor);
          lineage.set(note.id,replaced);
        }
        return validated;
      }catch(error){
        if(codeOf(error)==='MEMORY_OUTPUT_TRUNCATED'){
          if(budget.outputTokens<budget.maxOutputTokens)state.outputTokens=Math.min(budget.maxOutputTokens,Math.max(budget.outputTokens+1,budget.outputTokens*2));
          // Reduce the source span that actually overflowed, not the model's
          // potentially much larger unused input capacity.
          else if(part.length===1&&notes.length){
            // A full old ledger can exceed the output capacity even when it
            // fits the input. Keep its inactive facts in the host and retry a
            // smaller active portion only after observing that real ceiling.
            state.noteBudgetBytes=Math.floor(Math.min(state.noteBudgetBytes??Infinity,bytes(notes))/2);state.noteBudgetOutputTokens=budget.outputTokens;
          }else{state.eventBudgetBytes=Math.floor(Math.min(eventBudget,bytes(part))/2);state.fragmentSeq=part.length===1?part[0].seq:undefined;}
          state.reason='output_truncated';
        }
        throw error;
      }
    };
    let notes:MemoryNote[];
    if(bytes(input(selectedNotes,events))<=budget.inputBudgetBytes&&!events.some(event=>event.seq===state.fragmentSeq)){
      notes=await summarize(selectedNotes,events);
    }else{
      // An individual source can exceed a real context window. Read it in
      // contiguous text fragments; partial drafts never advance durable coverage.
      const event=events[0];
      batch=this.options.store.batch(roomId,event.seq,eventBudget);
      if(batch.events.length!==1||batch.events[0].seq!==event.seq)throw failure('MEMORY_SOURCE_CHANGED','Source prefix changed while planning fragments');
      notes=selectedNotes;let offset=0;
      do{
        const part=(end:number):MemorySummaryEvent=>({...event,text:event.text.slice(offset,end),textOffset:offset,totalTextLength:event.text.length,finalPart:end===event.text.length});
        const nextCharacterEnd=Math.min(event.text.length,offset+((event.text.codePointAt(offset)??0)>0xFFFF?2:1));
        const fullDraft=notes;
        const activeFits=(selected:MemoryNote[],end:number)=>notesFitOutput(selected)&&bytes(input(selected,[part(end)],inactiveNotes.length+fullDraft.length-selected.length))<=budget.inputBudgetBytes;
        // Intermediate drafts may grow across a huge source. Freeze complete
        // inactive drafts in the host, just like durable notes, without covering
        // any part of the original until every fragment has been processed.
        const preferredEnd=activeFits([],event.text.length)?event.text.length:nextCharacterEnd;
        const selected=activeFits(fullDraft,nextCharacterEnd)?{selected:fullDraft,inactive:[] as MemoryNote[]}
          :selectNotes(fullDraft,[part(preferredEnd)],budget.inputBudgetBytes,active=>activeFits(active,preferredEnd));
        const activeNotes=selected.selected,inactiveDrafts=selected.inactive;
        // Adaptive source spans cannot be smaller than their own metadata and
        // one complete character; the full real input capacity still applies.
        const fragmentBudget=state.eventBudgetBytes===undefined?undefined:Math.max(state.eventBudgetBytes,bytes([part(nextCharacterEnd)]));
        const fragmentFits=(end:number)=>bytes(input(activeNotes,[part(end)],inactiveNotes.length+inactiveDrafts.length))<=budget.inputBudgetBytes
          &&(fragmentBudget===undefined||bytes([part(end)])<=fragmentBudget);
        let low=offset,high=event.text.length;
        while(low<high){const middle=Math.ceil((low+high)/2);if(fragmentFits(middle))low=middle;else high=middle-1;}
        // Avoid splitting a UTF-16 surrogate pair in the preserved original text.
        if(low>offset&&low<event.text.length&&/[\uD800-\uDBFF]/.test(event.text[low-1])&&/[\uDC00-\uDFFF]/.test(event.text[low]))low--;
        if(low===offset&&event.text.length>offset||!fragmentFits(low))throw failure('MEMORY_INPUT_CAPACITY','A source fragment and its draft cannot fit model capacity');
        notes=[...inactiveDrafts,...await summarize(activeNotes,[part(low)],inactiveDrafts)];offset=low;
      }while(offset<event.text.length);
    }
    signal.throwIfAborted();
    // Collapse intermediate fragment replacements back to the durable base.
    // Draft-only note IDs never become unverifiable supersedes references.
    const finalIds=new Set(notes.map(note=>note.id));
    notes=notes.map(note=>{
      const supersedes=[...(lineage.get(note.id)??[])].filter(id=>baseIds.has(id)&&id!==note.id&&!finalIds.has(id));
      const {supersedes:_,...fields}=note;
      return {...fields,...(supersedes.length?{supersedes}:{})};
    });
    const committed=this.options.store.commit({roomId,epoch:batch.epoch,baseVersion:batch.baseVersion,untilSeq:batch.untilSeq,sourceDigest:batch.sourceDigest,notes:[...inactiveNotes,...notes]});
    if(!committed){this.emit({kind:'superseded',roomId,targetSeq:batch.untilSeq});return;}
    state.attempt=0;state.retryAt=undefined;state.lastError=undefined;state.reason='initial';state.eventBudgetBytes=undefined;state.fragmentSeq=undefined;state.repairHint=undefined;
    this.emit({kind:'committed',roomId,targetSeq:batch.untilSeq,coveredSeq:committed.coveredSeq,version:committed.version});
  }

  private validateNotes(roomId:string,untilSeq:number,value:unknown,previous:MemoryNote[],visibleSources:Set<number>):MemoryNote[]{
    if(!Array.isArray(value))throw failure('MEMORY_NOTES_INVALID','Memory notes must be an array');
    const ids=new Set<string>(),known=new Map(previous.map(note=>[note.id,note])),replaced=new Set<string>();
    for(const note of value){
      if(!note||typeof note!=='object'||typeof note.id!=='string'||!note.id.trim()||ids.has(note.id)
        ||(note.authorId!==null&&(typeof note.authorId!=='string'||!note.authorId))||typeof note.text!=='string'||!note.text.trim()
        ||!Array.isArray(note.sourceSeqs)||!note.sourceSeqs.length||new Set(note.sourceSeqs).size!==note.sourceSeqs.length
        ||note.supersedes!==undefined&&(!Array.isArray(note.supersedes)||note.supersedes.some((id:unknown)=>typeof id!=='string'||!id)))
        throw failure('MEMORY_NOTES_INVALID','Invalid memory note shape or identity');
      ids.add(note.id);
    }
    const issues:MemorySourceIssue[]=[];let totalIssues=0;
    const issue=(note:MemoryNote,noteIndex:number,details:Omit<MemorySourceIssue,'noteId'|'noteIndex'|'noteIdTruncated'>)=>{
      totalIssues++;
      // This bounds diagnostic metadata only, never notes, sources or coverage.
      if(issues.length<32){
        const entry:MemorySourceIssue={noteId:note.id.slice(0,256),noteIndex,...(note.id.length>256?{noteIdTruncated:true}:{}),...details};
        for(const field of ['expectedAuthorId','actualAuthorId'] as const)if(typeof entry[field]==='string'&&entry[field]!.length>256){entry[field]=entry[field]!.slice(0,256);entry[field==='expectedAuthorId'?'expectedAuthorIdTruncated':'actualAuthorIdTruncated']=true;}
        issues.push(entry);
      }
    };
    const visible=(seq:unknown):seq is number=>Number.isSafeInteger(seq)&&Number(seq)>0&&Number(seq)<=untilSeq&&visibleSources.has(Number(seq));
    const requested=[...new Set<number>(value.flatMap(note=>note.sourceSeqs).filter(visible))];
    // Never look up an unprovided ID, even to make an error more descriptive.
    const sources=new Map(this.options.store.eventsBySeq(roomId,requested).map(event=>[event.seq,event]));
    for(const [noteIndex,note]of value.entries()){
      const prior=known.get(note.id);
      if(prior&&prior.authorId!==note.authorId)issue(note,noteIndex,{reason:'noteAuthorChanged',expectedAuthorId:prior.authorId,actualAuthorId:note.authorId});
      let ownedMessage=false,sourceIssue=false;
      for(const [sourceIndex,seq]of note.sourceSeqs.entries()){
        const source=visible(seq)?sources.get(seq):undefined;
        if(!source||source.roomId!==roomId){
          issue(note,noteIndex,{reason:'sourceNotVisible',sourceIndex,...(typeof seq==='number'&&Number.isFinite(seq)?{sourceSeq:seq}:{})});sourceIssue=true;continue;
        }
        if(source.kind==='message'&&source.authorId!==note.authorId){
          issue(note,noteIndex,{reason:'authorMismatch',sourceSeq:seq,expectedAuthorId:note.authorId,actualAuthorId:source.authorId});sourceIssue=true;
        }
        if(source.kind==='message'&&source.authorId===note.authorId)ownedMessage=true;
      }
      if(note.authorId!==null&&!ownedMessage&&!sourceIssue)issue(note,noteIndex,{reason:'missingAuthorSource',expectedAuthorId:note.authorId});
    }
    if(totalIssues)throw new MemorySourceError({issues,totalIssues,omittedIssues:totalIssues-issues.length});
    for(const note of value){
      for(const id of note.supersedes??[]){
        const old=known.get(id);
        // A retained note can carry its already validated historical lineage.
        if(!old&&known.get(note.id)?.supersedes?.includes(id))continue;
        if(id===note.id||!old||old.authorId!==note.authorId||replaced.has(id))throw failure('MEMORY_SUPERSEDES_INVALID','Memory replacement must name a known note by the same author');
        replaced.add(id);
      }
    }
    for(const id of replaced)if(ids.has(id))throw failure('MEMORY_SUPERSEDES_INVALID','A superseded note cannot remain current');
    for(const id of known.keys())if(!ids.has(id)&&!replaced.has(id))throw failure('MEMORY_NOTES_INVALID','A prior note needs an explicit successor');
    return value.map(note=>({id:note.id,authorId:note.authorId,text:note.text,sourceSeqs:[...note.sourceSeqs],
      ...(note.supersedes?.length?{supersedes:[...note.supersedes]}:{})}));
  }

  private retry(roomId:string,state:RoomState,error:unknown):void{
    const code=codeOf(error);state.attempt++;state.lastError=code;
    if(modelRetriesExhausted(error)){
      state.modelFailedThrough=state.targetSeq;
      this.emit({kind:'failed',roomId,targetSeq:state.targetSeq,code,attempt:state.attempt});
      return;
    }
    if(code==='MEMORY_INPUT_CAPACITY')state.reason='input_capacity';
    const hints:Record<string,string>={
      MEMORY_OUTPUT_INVALID:'上一轮输出不符合记忆JSON结构。仅返回完整合法notes，不输出解释文字；保留已有条件及其来源。',
      MEMORY_NOTES_INVALID:'上一轮note结构或旧note继承不合法。保留旧note，或用同作者新note的supersedes明确替代；id必须唯一且正文和来源非空。',
      MEMORY_SOURCE_INVALID:'上一轮来源校验失败。sourceSeqs只能使用previousNotes已有来源及本次events中可见seq；必须匹配作者，不能引用未提供的旧消息。',
      MEMORY_SUPERSEDES_INVALID:'上一轮替代关系不合法。supersedes只能指向同作者既有note；被替代note不能同时保留，不能省略无明确继承者的旧note。',
    };
    if(hints[code])state.repairHint={code,reason:hints[code]+(error instanceof MemorySourceError?' 校验定位（仅元数据；authorMismatch的expectedAuthorId是note作者、actualAuthorId是已提供原文作者；noteAuthorChanged的expectedAuthorId是原条目作者；不要通过删除有效事实规避校验）：'+JSON.stringify(error.diagnostics):'')};
    const proposed=this.options.retryDelayMs?.(state.attempt,code)??Math.min(60_000,1000*2**Math.min(state.attempt-1,6));
    const delay=Number.isFinite(proposed)&&proposed>=0?proposed:60_000;
    state.retryAt=Date.now()+delay;
    this.emit({kind:'failed',roomId,targetSeq:state.targetSeq,code,attempt:state.attempt,retryAt:state.retryAt});
    state.timer=setTimeout(()=>{state.timer=undefined;state.retryAt=undefined;this.enqueue(roomId,state);},delay);
    state.timer.unref?.();
  }

  status(){
    const pendingRooms=[...this.rooms].flatMap(([roomId,state])=>{
      const coveredSeq=this.options.store.head(roomId).version?.coveredSeq??0;
      return state.targetSeq>coveredSeq?[{roomId,targetSeq:state.targetSeq,coveredSeq,running:state.running,queued:state.queued,retryAt:state.retryAt,lastError:state.lastError}]:[];
    });
    return {closed:this.closed,running:this.active.size,queued:this.queue.length,backoff:pendingRooms.filter(room=>room.retryAt!==undefined).length,pendingRooms};
  }
  whenIdle(signal?:AbortSignal):Promise<void>{
    if(signal?.aborted)return Promise.reject(signal.reason);
    if(this.closed)return Promise.reject(failure('MEMORY_CLOSED','Memory worker is closed'));
    if(this.blockedByModel())return Promise.reject(failure('MODEL_RETRIES_EXHAUSTED','Room memory model retries exhausted'));
    if(!this.active.size&&!this.queue.length&&!this.status().pendingRooms.length)return Promise.resolve();
    return new Promise((resolve,reject)=>{
      const waiter:IdleWaiter={resolve,reject,signal};
      waiter.abort=()=>{this.waiters.delete(waiter);reject(signal?.reason);};
      signal?.addEventListener('abort',waiter.abort,{once:true});this.waiters.add(waiter);
    });
  }
  private settleIdle():void {
    const blocked=this.blockedByModel();
    if(this.active.size||this.queue.length||!this.closed&&!blocked&&this.status().pendingRooms.length)return;
    for(const waiter of this.waiters){waiter.signal?.removeEventListener('abort',waiter.abort!);
      if(this.closed)waiter.reject(failure('MEMORY_CLOSED','Memory worker closed before reaching idle'));
      else if(blocked)waiter.reject(failure('MODEL_RETRIES_EXHAUSTED','Room memory model retries exhausted'));
      else waiter.resolve();}
    this.waiters.clear();
  }
  private blockedByModel():boolean {
    return !this.active.size&&!this.queue.length&&[...this.rooms].some(([roomId,state])=>
      state.modelFailedThrough!==undefined&&state.targetSeq<=state.modelFailedThrough
      &&state.targetSeq>(this.options.store.head(roomId).version?.coveredSeq??0));
  }
  close():Promise<void>{
    if(this.closing)return this.closing;
    this.closed=true;if(this.scheduled)clearImmediate(this.scheduled);this.scheduled=undefined;this.queue.length=0;
    for(const state of this.rooms.values()){if(state.timer)clearTimeout(state.timer);state.timer=undefined;state.queued=false;}
    for(const active of this.active.values())active.abort.abort(failure('MEMORY_CLOSED','Memory worker is closing'));
    this.closing=Promise.allSettled([...this.active.values()].map(active=>active.promise)).then(()=>{this.settleIdle();});
    return this.closing;
  }
}
