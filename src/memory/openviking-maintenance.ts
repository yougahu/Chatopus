import { readFileSync,writeFileSync,unlinkSync,mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const filename='openviking-model-maintenance.json';
/** Short lease: a crashed admin cannot leave ingestion paused indefinitely. */
export function openVikingPrepareAfter(stateDir:string):number {
  try{
    const lease=JSON.parse(readFileSync(join(stateDir,filename),'utf8'));
    return Number.isSafeInteger(lease.until)&&lease.until>Date.now()&&lease.until<=Date.now()+120_000?lease.until:0;
  }catch{return 0;}
}
export function pauseOpenVikingPreparation(stateDir:string):()=>void {
  mkdirSync(stateDir,{recursive:true,mode:0o700});
  const path=join(stateDir,filename),id=randomUUID();
  if(openVikingPrepareAfter(stateDir))throw new Error('Memory configuration is being applied');
  try{unlinkSync(path);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  writeFileSync(path,JSON.stringify({id,until:Date.now()+120_000}),{flag:'wx',mode:0o600});
  return ()=>{try{if(JSON.parse(readFileSync(path,'utf8')).id===id)unlinkSync(path);}catch{/* Expired or already released. */}};
}
