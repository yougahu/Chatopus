import { openSync, closeSync, fstatSync, readSync } from 'node:fs';

/** Bounded audit view; the append-only source is never modified. */
export function readSessionTail(file:string,maxBytes=2_000_000):{events:any[];bytes:number;truncated:boolean;skipped:number} {
  const fd=openSync(file,'r');
  try{
    const bytes=fstatSync(fd).size,start=Math.max(0,bytes-maxBytes);
    const buffer=Buffer.alloc(Math.min(bytes,maxBytes));
    let read=0;
    while(read<buffer.length){const n=readSync(fd,buffer,read,buffer.length-read,start+read);if(!n)break;read+=n;}
    // Discard an incomplete first UTF-8/JSON record, including oversized lines.
    let from=0;
    if(start>0){const previous=Buffer.alloc(1);readSync(fd,previous,0,1,start-1);if(previous[0]!==10)from=buffer.indexOf(10)+1||read;}
    let skipped=0;const events:any[]=[];
    for(const line of buffer.subarray(from,read).toString('utf8').split('\n')){
      if(!line.trim())continue;
      try{events.push(JSON.parse(line));}catch{skipped++;} // Writer may have an incomplete last record.
    }
    return {events,bytes,truncated:start>0,skipped};
  }finally{closeSync(fd);}
}
