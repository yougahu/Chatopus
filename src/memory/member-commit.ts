import type { Store } from '../store.js';
import type { RouteAction, RouterRequest } from '../types.js';
import type { RouterTurn } from '../router-session-store.js';
import { bindMemberMemoryUpdates } from './member-updates.js';
import type { BoundMemberMemoryUpdate } from './types.js';
import { SharedMemoryService, type MemberWriteIntent } from './shared-memory.js';

export interface MemberCommitProposal { version:1;actions:RouteAction[];memoryIntents:MemberWriteIntent[] }
export interface MemberCommitReceipt { memberId:string;revision:number;commitId:string;sourceMessageIds:string[] }

/** Freeze the proposed actions and remote write intents in the existing Router turn before I/O.
 * A partial multi-member save is resumable; business actions and confirmations wait for all writes.
 * The OpenViking documents remain the sole current-value authority. */
export async function prepareMemberCommit(store:Store,memory:SharedMemoryService,turn:RouterTurn,request:RouterRequest,actions:RouteAction[]):Promise<MemberCommitProposal>{
  if(turn.roomId!==request.roomId||turn.state!=='pending')throw new Error('Member commit requires the current pending Router turn');
  if(turn.actions!==undefined){
    const saved=turn.actions as Partial<MemberCommitProposal>;
    if(saved.version!==1||!Array.isArray(saved.actions)||!Array.isArray(saved.memoryIntents))throw new Error('Invalid persisted Router proposal');
    return structuredClone(saved) as MemberCommitProposal;
  }
  const bound:BoundMemberMemoryUpdate[]=[];
  const sources=request.messages.map(message=>{
    const row=store.db.prepare('SELECT rowid,data FROM messages WHERE room=? AND id=?').get(request.roomId,message.id) as {rowid:number;data:string}|undefined;
    if(!row)throw new Error('Member source is not persisted');
    const original=JSON.parse(row.data);
    if(original.authorId!==message.authorId||original.text!==message.text)throw new Error('Member source differs from persisted original');
    return {id:message.id,memberId:message.authorId,sourceOrder:Number(row.rowid)};
  });
  for(const action of actions){
    if(!('memoryUpdates'in action)||!action.memoryUpdates?.length)continue;
    if(request.event!=='messages'||!request.memoryAvailable||!('sourceMessageIds'in action))throw new Error('Memory update outside an available user turn');
    bound.push(...bindMemberMemoryUpdates(action.memoryUpdates,{actionSourceMessageIds:action.sourceMessageIds,messages:sources}));
  }
  const memoryIntents=await memory.prepareMemberWrites(request.roomId,bound,turn.id);
  const proposal:MemberCommitProposal={version:1,actions:structuredClone(actions),memoryIntents};
  store.routerSessions.saveTurnProposal({turnId:turn.id,generation:turn.generation,actions:proposal});
  return proposal;
}

export async function applyMemberCommit(memory:SharedMemoryService,proposal:MemberCommitProposal,signal?:AbortSignal):Promise<MemberCommitReceipt[]>{
  const receipts:MemberCommitReceipt[]=[];
  for(const intent of proposal.memoryIntents){
    const saved=await memory.applyMemberWrite(intent,signal);
    const proposedSources=new Set(proposal.actions.flatMap(action=>'memoryUpdates'in action?action.memoryUpdates?.map(update=>update.sourceMessageId)??[]:[]));
    receipts.push({memberId:saved.memberId,revision:saved.revision,commitId:saved.commitId,
      sourceMessageIds:[...new Set(Object.values(saved.fields).filter(field=>proposedSources.has(field.sourceMessageId)).map(field=>field.sourceMessageId))]});
  }
  return receipts;
}

/** Enqueue an independent durable confirmation so cancelling a mixed task cannot erase a saved setting. */
export function enqueueMemberConfirmations(store:Store,request:RouterRequest,proposal:MemberCommitProposal,receipts:MemberCommitReceipt[]):void{
  for(const receipt of receipts){
    const sources=request.messages.filter(message=>receipt.sourceMessageIds.includes(message.id)&&message.authorId===receipt.memberId);
    const source=sources.at(-1);if(!source)throw new Error('Saved memory receipt has no current source');
    const primary=proposal.actions.find(action=>'sourceMessageIds'in action&&action.sourceMessageIds.includes(source.id));
    // Direct replies already acknowledge the saved setting after all writes have verified.
    if(primary?.action==='reply_direct'||primary?.action==='clarify')continue;
    store.enqueue({roomId:request.roomId,replyToMessageId:source.messageId,text:'你的长期资料已更新，后续回复会按最新设置处理。'},
      {id:'memory-confirm:'+receipt.commitId});
  }
}
