/** Race read-only host work against its durable turn deadline. Late results are ignored. */
export async function withinRouterDeadline<T>(deadlineAt:number,work:()=>Promise<T>):Promise<T>{
  const remaining=deadlineAt-Date.now();
  if(remaining<=0)throw Object.assign(new Error('Router total deadline expired'),{code:'ROUTER_DEADLINE'});
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{return await Promise.race([work(),new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(Object.assign(new Error('Router total deadline expired'),{code:'ROUTER_DEADLINE'})),remaining);})]);}
  finally{if(timer)clearTimeout(timer);}
}

/** Stop waiting even when an adapter ignores cancellation. The caller must fence
 * late results; a timed-out native generation must never be resumed. */
export async function untilRouterAbort<T>(signal:AbortSignal,work:()=>Promise<T>):Promise<T>{
  const expired=()=>Object.assign(new Error('Router total deadline expired'),{code:'ROUTER_DEADLINE'});
  if(signal.aborted)throw expired();
  let abort!:()=>void;
  const stopped=new Promise<never>((_resolve,reject)=>{abort=()=>reject(expired());signal.addEventListener('abort',abort,{once:true});});
  try{return await Promise.race([work(),stopped]);}
  finally{signal.removeEventListener('abort',abort);}
}
