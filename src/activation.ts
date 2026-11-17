import type { GroupMessage, RouteAction } from './types.js';

/** A name is only a candidate: the Router must still distinguish calling from discussing the bot. */
export function hasWakeCandidate(message:GroupMessage,names:readonly string[]):boolean {
  if(message.isMentioned)return true;
  return names.some(name=>{
    const escaped=name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    // Do not wake on Chris inside Christmas, a URL, or another identifier.
    const before=/^[a-z0-9]/i.test(name)?'(?<![a-z0-9_/:.])':'';
    const after=/[a-z0-9]$/i.test(name)?'(?![a-z0-9_/.])':'';
    return new RegExp(before+escaped+after,'iu').test(message.text);
  });
}

/** Fail closed for messages with neither an actual @ nor a configured name, including mixed batches. */
export function enforceExplicitActivation(actions:RouteAction[],messages:readonly GroupMessage[],names:readonly string[]):RouteAction[] {
  const allowed=new Set(messages.filter(m=>hasWakeCandidate(m,names)).map(m=>m.id));
  return actions.flatMap((action):RouteAction[]=>{
    if(!('sourceMessageIds'in action)||action.action==='silence')return [action];
    const accepted=action.sourceMessageIds.filter(id=>allowed.has(id));
    const rejected=action.sourceMessageIds.filter(id=>!allowed.has(id));
    const scoped={...action,sourceMessageIds:accepted,...(action.memoryUpdates?{memoryUpdates:action.memoryUpdates.filter(update=>accepted.includes(update.sourceMessageId))}:{})};
    if(scoped.memoryUpdates?.length===0)delete scoped.memoryUpdates;
    return [...(accepted.length?[scoped]:[]),
      ...(rejected.length?[{action:'silence' as const,sourceMessageIds:rejected,reason:'本条未明确@或呼唤机器人'}]:[])];
  });
}

export function silentMessages(messages:readonly GroupMessage[]):RouteAction[] {
  return [{action:'silence',sourceMessageIds:messages.map(m=>m.id),reason:'本批消息均未明确@或呼唤机器人'}];
}
