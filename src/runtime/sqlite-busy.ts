import { setTimeout as delay } from 'node:timers/promises';

/** node:sqlite exposes primary/extended SQLite codes as errcode, often with ERR_SQLITE_ERROR. */
export function isSqliteBusy(error:unknown):boolean {
  if(!error||typeof error!=='object')return false;
  const value=error as {code?:unknown;errcode?:unknown};
  return typeof value.errcode==='number'&&[5,6].includes(value.errcode&255)
    ||typeof value.code==='string'&&/^(?:SQLITE_BUSY|SQLITE_LOCKED)(?:_|$)/.test(value.code);
}

/** Retry database work only, within its original deadline; the caller owns rollback. */
export async function retrySqliteBusy<T>(work:()=>T|Promise<T>,options:{deadlineAt:number;stopped?:()=>boolean}):Promise<T> {
  const delays=[100,250,500,1000];
  for(let attempt=0;;attempt++){
    try{return await work();}
    catch(error){
      const remaining=options.deadlineAt-Date.now();
      if(!isSqliteBusy(error)||options.stopped?.()||remaining<=0)throw error;
      await delay(Math.min(delays[Math.min(attempt,delays.length-1)],remaining));
    }
  }
}
