export interface WorkerInputScheduling {settleMs:number;maxWaitMs:number}
export interface PendingWorkerInputs {firstPendingAt:number;lastPendingAt:number;throughInputSeq:number;readyAt:number}
export function workerInputScheduling(value:unknown):WorkerInputScheduling {
  if(value===undefined)return {settleMs:750,maxWaitMs:3000};
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid workerInputScheduling');
  const v=value as Record<string,unknown>;
  if(Object.keys(v).some(key=>!['settleMs','maxWaitMs'].includes(key)))throw new Error('Unknown workerInputScheduling option');
  const settleMs=v.settleMs??750,maxWaitMs=v.maxWaitMs??3000;
  if(!Number.isSafeInteger(settleMs)||!Number.isSafeInteger(maxWaitMs)||Number(settleMs)<0||Number(maxWaitMs)<Number(settleMs)||Number(maxWaitMs)>10000)
    throw new Error('Invalid worker input scheduling window');
  return {settleMs:Number(settleMs),maxWaitMs:Number(maxWaitMs)};
}
export function scheduleWorkerInputs(previous:PendingWorkerInputs|undefined,throughInputSeq:number,options:WorkerInputScheduling,now=Date.now()):PendingWorkerInputs {
  const firstPendingAt=previous?.firstPendingAt??now;
  return {firstPendingAt,lastPendingAt:now,throughInputSeq,readyAt:Math.min(now+options.settleMs,firstPendingAt+options.maxWaitMs)};
}
