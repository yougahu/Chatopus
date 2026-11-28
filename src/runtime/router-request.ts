import {isPrivateRoom} from '../conversation.js';
import type { RouterRequest } from '../types.js';

export function routerClock(timestamp:number,timeZone:string):NonNullable<RouterRequest['currentTimeContext']> {
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23',weekday:'long',timeZoneName:'longOffset'}).formatToParts(timestamp);
  const part=(type:Intl.DateTimeFormatPartTypes)=>parts.find(part=>part.type===type)!.value;
  const date=`${part('year')}-${part('month')}-${part('day')}`,time=`${part('hour')}:${part('minute')}:${part('second')}`;
  const utcOffset=part('timeZoneName').replace('GMT','')||'+00:00';
  return {date,time,weekday:part('weekday'),timeZone,utcOffset,iso8601:`${date}T${time}${utcOffset}`};
}

/** Recomputed from the current snapshot, never inherited from model history. */
export function routerOutputContract(request:RouterRequest):NonNullable<RouterRequest['outputContract']> {
  if(request.event!=='messages')return {format:'json_array',allowedActions:['publish_result','defer_result'],resultId:request.result?.id,sourceMessageIds:[],scheduleSourceGroups:[]};
  const groups=new Map<string,string[]>();
  for(const message of request.messages)groups.set(message.authorId,[...(groups.get(message.authorId)??[]),message.id]);
  return {format:'json_array',allowedActions:[...(isPrivateRoom(request.roomId)?['resolve_delivery','resend_delivery']:[]),'silence','reply_direct','clarify','open_thread','append_thread','request_status','request_handoff','request_cancel','manage_schedule'],
    sourceMessageIds:request.messages.map(message=>message.id),scheduleSourceGroups:[...groups].map(([authorId,sourceMessageIds])=>({authorId,sourceMessageIds}))};
}
