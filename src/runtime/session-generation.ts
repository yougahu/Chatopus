import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Session, SessionId, type SessionEvent, type SessionSeq } from '@deepseek-ai/dsh-session';
import type { Message } from '@deepseek-ai/dsh-llm';

export const DEFAULT_SESSION_MAX_BYTES=4_000_000;
export interface SessionRotation { maxBytes?:number }
export interface SessionGeneration {
  version:1;logicalId:string;activeId:string;generation:number;
  previousId?:string;createdAt:number;surfaceHash?:string;
}
const owned=new Set<string>();
/** Covers preparation and the full live lifecycle, including model-host reloads. */
export function claimLogicalSession(root:string,id:string):()=>void {
  const key=JSON.stringify([resolve(root),id]);
  if(owned.has(key))throw Object.assign(new Error('Logical session is already active'),{code:'AGENT_EXISTS'});
  owned.add(key);return()=>owned.delete(key);
}
export function generationFile(root:string,id:string):string {
  return join(resolve(root),'session-generations',createHash('sha256').update(id).digest('hex')+'.json');
}
export async function readGeneration(root:string,id:string):Promise<SessionGeneration> {
  let value:SessionGeneration;
  try{value=JSON.parse(await readFile(generationFile(root,id),'utf8'));}
  catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return {version:1,logicalId:id,activeId:id,generation:0,createdAt:0};throw error;}
  const prefix=id.slice(0,120)+'-g'+value.generation+'-';
  if(value.version!==1||value.logicalId!==id||!Number.isSafeInteger(value.generation)||value.generation<1
    ||!value.activeId?.startsWith(prefix)||!/^[a-zA-Z0-9_-]{1,180}$/.test(value.activeId))throw new Error('Invalid session generation pointer');
  return value;
}
export function nextGeneration(previous:SessionGeneration,messages:readonly Message[]):SessionGeneration {
  return {version:1,logicalId:previous.logicalId,activeId:previous.logicalId.slice(0,120)+'-g'+(previous.generation+1)+'-'+randomUUID(),
    generation:previous.generation+1,previousId:previous.activeId,createdAt:Date.now(),
    surfaceHash:createHash('sha256').update(JSON.stringify(messages)).digest('hex')};
}
/** Commit only after the new dsh session has been flushed. Rename is the commit point. */
export async function writeGeneration(root:string,value:SessionGeneration):Promise<void> {
  const file=generationFile(root,value.logicalId),directory=join(resolve(root),'session-generations');
  await mkdir(directory,{recursive:true,mode:0o700});
  const history=join(directory,'history');await mkdir(history,{recursive:true,mode:0o700});
  const record=await open(join(history,value.activeId+'.json'),'wx',0o600);
  try{await record.writeFile(JSON.stringify(value)+'\n');await record.sync();}finally{await record.close();}
  const temporary=file+'.'+randomUUID()+'.tmp';
  try{
    const fd=await open(temporary,'wx',0o600);
    try{await fd.writeFile(JSON.stringify(value)+'\n');await fd.sync();}finally{await fd.close();}
    await rename(temporary,file);
    const dir=await open(directory,'r');try{await dir.sync();}finally{await dir.close();}
  }finally{await unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;});}
}

/** Pending work must be repaired/resumed by dsh, never treated as historical context. */
export function hasUnsettledWork(events:readonly SessionEvent[]):boolean {
  let openTurn=false,openStep=false;
  const pending:{[key:string]:unknown[]}={'next-turn':[],'next-step':[]};
  for(const event of events){
    if(event.type==='turn/start')openTurn=true;
    if(event.type==='turn/end')openTurn=false;
    if(event.type==='step/start')openStep=true;
    if(event.type==='step/end')openStep=false;
    if(event.type==='agent/inbox/spliced'){
      const splice=event.data;
      const queue=pending[splice.target];
      if(!queue||splice.start<0||splice.start>queue.length||splice.start+(splice.removedCount??0)>queue.length)throw new Error('Invalid inbox while rotating session');
      queue.splice(splice.start,splice.removedCount??0,...splice.inserted);
    }
  }
  return openTurn||openStep||Object.values(pending).some(queue=>queue.length>0);
}

/** Re-encode the current dsh surface, not the raw log. No summarization or text truncation. */
export function surfaceSeed(source:Session,id:string):readonly SessionEvent[] {
  const seed=Session.create(SessionId(id)),events=source.snapshotEvents();
  seed.append('turn/start',{turn:1});seed.append('step/start',{turn:1,step:1});
  const copiedHeaders=new Map<SessionSeq,SessionSeq>();
  const header=(seq:SessionSeq):SessionSeq=>{
    const copied=copiedHeaders.get(seq);if(copied!==undefined)return copied;
    const original=events[seq];if(original?.type!=='request/header')throw new Error('Missing tool declaration during rotation');
    const next=seed.append('request/header',original.data).seq;copiedHeaders.set(seq,next);return next;
  };
  const firstHeader=events.find(event=>event.type==='request/header');if(firstHeader)header(firstHeader.seq);
  for(const seq of source.surface.nodes){
    const event=events[seq],message=source.deriveEventMessage(event);if(!message)continue;
    switch(message.role){
      case 'system':seed.append('system/message',{turn:1,step:1,message},{surfaceOp:'append'});break;
      case 'user':seed.append('user/message',message,{surfaceOp:'append'});break;
      case 'assistant':seed.append('assistant/message',{turn:1,step:1,message,stream:[]},{surfaceOp:'append'});break;
      case 'tool':seed.append('tool/result',{turn:1,step:1,message},{surfaceOp:'append'});break;
      case 'developer':{
        if(event.type!=='developer/message')throw new Error('Unexpected developer projection');
        const headerSeq=event.data.headerSeq===undefined?undefined:header(event.data.headerSeq);
        seed.append('developer/message',{turn:1,step:1,message,...(headerSeq===undefined?{}:{headerSeq})},{surfaceOp:'append'});break;
      }
    }
  }
  const latestHeader=events.findLast(event=>event.type==='request/header');if(latestHeader)header(latestHeader.seq);
  seed.append('step/end',{turn:1,step:1});seed.append('turn/end',{turn:1,reason:{kind:'completed'}});
  if(JSON.stringify(seed.deriveMessages())!==JSON.stringify(source.deriveMessages()))throw new Error('Session rotation changed model-visible history');
  return seed.snapshotEvents();
}
