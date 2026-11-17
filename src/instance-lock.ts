import { openSync, readFileSync, writeFileSync, closeSync, unlinkSync } from 'node:fs';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
/** Prevent a second coordinator from recovering the first one's live runs. */
export function acquireInstanceLock(file:string):()=>void {
  const nonce=randomUUID();
  for(let attempt=0;attempt<2;attempt++){
    try{
      const fd=openSync(file,'wx',0o600);
      try{writeFileSync(fd,JSON.stringify({pid:process.pid,host:hostname(),nonce}));}finally{closeSync(fd);}
      return ()=>{try{if(JSON.parse(readFileSync(file,'utf8')).nonce===nonce)unlinkSync(file);}catch{}};
    }catch(error){
      if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;
      let owner;try{owner=JSON.parse(readFileSync(file,'utf8'));}catch{throw new Error('Instance lock is unreadable; inspect it before starting another process');}
      if(owner.host!==hostname())throw new Error('State directory belongs to a different host; complete migration before starting');
      let alive=true;
      try{process.kill(owner.pid,0);}catch(e){if((e as NodeJS.ErrnoException).code==='ESRCH')alive=false;}
      if(alive)throw new Error('A Chatopus process already owns this state directory');
      unlinkSync(file);
    }
  }
  throw new Error('Could not acquire process lock');
}
