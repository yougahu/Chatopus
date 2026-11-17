import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

/** Consume discovery output incrementally; rg --max-count only limits each file. */
export function boundedRipgrep(args:string[],options:{limit:number;signal?:AbortSignal;filter?:(line:string)=>string|undefined;maxBytes?:number;timeoutMs?:number}):Promise<{lines:string[];truncated:boolean}> {
  options.signal?.throwIfAborted();
  return new Promise((resolve,reject)=>{
    const child=spawn('rg',args,{stdio:['ignore','pipe','pipe'],signal:options.signal});
    const decoder=new StringDecoder('utf8'),lines:string[]=[];
    const maxBytes=options.maxBytes??256_000;
    let pending='',stderr='',bytes=0,truncated=false,timedOut=false,failure:Error|undefined,killTimer:ReturnType<typeof setTimeout>|undefined;
    const stop=()=>{if(child.exitCode!==null||child.signalCode!==null)return;child.kill('SIGTERM');killTimer??=setTimeout(()=>child.kill('SIGKILL'),250);killTimer.unref();};
    const timeout=setTimeout(()=>{timedOut=true;stop();},options.timeoutMs??10_000);timeout.unref();
    const consume=(line:string)=>{
      if(truncated)return;
      const selected=options.filter?options.filter(line):line;
      if(selected===undefined||!selected)return;
      const size=Buffer.byteLength(selected,'utf8');
      if(lines.length>=options.limit||bytes+size>maxBytes){truncated=true;stop();return;}
      lines.push(selected);bytes+=size;
    };
    child.stdout.on('data',(chunk:Buffer)=>{
      if(truncated||timedOut)return;
      pending+=decoder.write(chunk);
      let end:number;
      while((end=pending.indexOf('\n'))>=0){consume(pending.slice(0,end).replace(/\r$/,''));pending=pending.slice(end+1);if(truncated){pending='';return;}}
      if(Buffer.byteLength(pending,'utf8')>maxBytes){truncated=true;pending='';stop();}
    });
    child.stderr.on('data',(chunk:Buffer)=>{stderr=(stderr+chunk.toString('utf8')).slice(-2000);});
    child.on('error',error=>{failure=error;});
    child.on('close',code=>{
      clearTimeout(timeout);if(killTimer)clearTimeout(killTimer);
      if(options.signal?.aborted){reject(options.signal.reason??new Error('Search cancelled'));return;}
      if(failure){reject(failure);return;}
      if(timedOut){reject(new Error('Search timed out'));return;}
      if(!truncated){pending+=decoder.end();if(pending)consume(pending);}
      if(truncated||code===0||code===1){resolve({lines,truncated});return;}
      reject(new Error(`Search failed (exit ${code}): ${stderr.trim()}`));
    });
  });
}
