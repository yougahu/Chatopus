import { expect, it, vi } from 'vitest';
import { Store } from '../src/store.js';
import type { GroupMessage, ThreadStatus } from '../src/types.js';

it('expires inactive cards at the idle boundary while preserving work, history and renewed topics',()=>{
  const store=new Store(':memory:'),clock=vi.spyOn(Date,'now');
  const now=100_000_000,ttl=21_600_000;
  function seed(id:string,status:ThreadStatus,at:number,roomId='room'){
    clock.mockReturnValue(at);
    const message:GroupMessage={id:`${roomId}:${id}`,messageId:id,roomId,platform:'replay',authorId:'player',authorName:'成员',text:id,timestamp:at,mentions:[],attachments:[],isMentioned:true,isAdmin:false};
    store.ingest(message);const thread=store.createThread(message,id,true);
    thread.status=status;store.saveThread(thread);return thread;
  }
  try{
    const expired=['idle','needs_input','failed','cancelled'].map((status,i)=>seed(`expired-${i}`,status as ThreadStatus,now-ttl));
    const fresh=seed('fresh','idle',now-ttl+1);
    const queued=seed('queued','queued',now-ttl-1000),running=seed('running','running',now-ttl-2000);
    seed('foreign','idle',now,'other-room');clock.mockReturnValue(now);
    expect(store.routingThreads('room',20,ttl).map(t=>t.id)).toEqual([fresh.id,queued.id,running.id]);
    expect(store.routingThreads('room',1,ttl).map(t=>t.id)).toEqual([fresh.id]);
    expect(store.routingThreads('room',20,ttl,now+1).map(t=>t.id)).toEqual([queued.id,running.id]);
    expect(store.threads('room')).toHaveLength(7);
    expect(store.inputs(expired[0].id)).toHaveLength(1);
    expect(store.thread(expired[0].id)?.status).toBe('idle');
    store.saveThread(expired[0]);
    expect(store.routingThreads('room',1,ttl).map(t=>t.id)).toEqual([expired[0].id]);
  }finally{clock.mockRestore();store.close();}
});
