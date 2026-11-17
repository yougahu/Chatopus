import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { Coordinator } from '../src/coordinator.js';
import { Store } from '../src/store.js';
import { OneBotAdapter } from '../src/platform/onebot.js';
import { loadConfig } from '../src/config.js';
import type { RouteAction, RouterRequest, RuntimePort, WorkerReport } from '../src/types.js';

const cleanup:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
async function until(check:()=>boolean){for(let attempt=0;attempt<100;attempt++){if(check())return;await new Promise(resolve=>setTimeout(resolve,5));}throw new Error('Lifecycle condition timed out');}
class Runtime implements RuntimePort {
  routes:RouterRequest[]=[];closed=false;private reject?: (error:Error)=>void;
  constructor(readonly blockRouter=false){}
  async route(request:RouterRequest):Promise<RouteAction[]>{
    this.routes.push(request);
    if(this.blockRouter)return new Promise((_resolve,reject)=>this.reject=reject);
    return [{action:'silence',sourceMessageIds:request.messages.map(message=>message.id)}];
  }
  async runWorker():Promise<WorkerReport>{throw new Error('Unexpected Worker during lifecycle test');}
  async steer(){}async cancel(){}
  async close(){this.closed=true;this.reject?.(new Error('Cancelled Router during shutdown'));}
}
async function directory(){const root=await mkdtemp(join(tmpdir(),'boe2-p1-lifecycle-'));cleanup.push(()=>rm(root,{recursive:true,force:true}));return root;}
async function start(root:string,runtime=new Runtime()){
  const config=loadConfig(root,{apiKey:'',stateDir:join(root,'state'),routerBatchWindowMs:0});
  const file=join(root,'state.sqlite'),store=new Store(file);let coordinator:Coordinator;
  const adapter=new OneBotAdapter({selfId:'900',allowedGroupIds:['100'],accessToken:'local-lifecycle',port:0,actionTimeoutMs:25,
    onMessage:message=>coordinator.receive(message)});
  coordinator=new Coordinator(config,store,runtime,adapter);
  let stopped=false;
  const close=async()=>{
    if(stopped)return;stopped=true;
    adapter.stopIntake();
    try{await coordinator.close();}finally{try{await adapter.close();}finally{store.close();}}
  };
  cleanup.push(close);await adapter.start();await coordinator.start();return {file,store,runtime,adapter,coordinator,close};
}
async function connect(adapter:OneBotAdapter){
  const socket=new WebSocket(`ws://127.0.0.1:${adapter.port}/onebot/v11/ws`,{headers:{Authorization:'Bearer local-lifecycle','X-Self-ID':'900'}});
  await once(socket,'open');return socket;
}
const event=(id:number)=>({post_type:'message',message_type:'group',self_id:900,user_id:901,group_id:100,message_id:id,time:1_700_000_000,
  sender:{nickname:'Test player',role:'member'},message:[{type:'at',data:{qq:'900'}},{type:'text',data:{text:'请解释缓存机制'}}]});

describe('local OneBot/Coordinator/SQLite lifecycle',()=>{
  it('retains offline outbox across a fresh service and sends once after reconnect without replaying unknown delivery',async()=>{
    const root=await directory(),first=await start(root),socket=await connect(first.adapter);
    const firstPackets:unknown[]=[];socket.on('message',raw=>firstPackets.push(JSON.parse(raw.toString())));
    first.store.enqueue({roomId:'qq:900:100',text:'platform receipt will time out'},{id:'uncertain'});
    await first.coordinator.tick();
    expect(first.store.outbox().find(row=>row.id==='uncertain')).toMatchObject({status:'unknown',attempts:1,reason:'timeout'});
    expect(firstPackets).toHaveLength(1);socket.close();await once(socket,'close');await until(()=>!first.adapter.connected);
    first.store.enqueue({roomId:'qq:900:100',text:'durable offline answer'},{id:'offline'});
    for(let attempt=0;attempt<4;attempt++){
      const row=first.store.outbox().find(row=>row.id==='offline')!;row.dueAt=0;first.store.saveOutbox(row);await first.coordinator.tick();
      expect(first.store.outbox().find(row=>row.id==='offline')).toMatchObject({status:'pending',attempts:0,reason:'not_connected'});
    }
    // A second interrupted send exercises startup's sending -> unknown recovery.
    first.store.enqueue({roomId:'qq:900:100',text:'interrupted after send registration'},{id:'interrupted',status:'sending',attempts:1});
    await first.close();
    const restored=await start(root);
    expect(restored.store.outbox().find(row=>row.id==='offline')).toMatchObject({status:'pending',attempts:0});
    expect(restored.store.outbox().filter(row=>row.status==='unknown').map(row=>row.id).sort()).toEqual(['interrupted','uncertain']);
    const reconnected=await connect(restored.adapter),packets:any[]=[];
    reconnected.on('message',raw=>{const packet=JSON.parse(raw.toString());packets.push(packet);reconnected.send(JSON.stringify({echo:packet.echo,status:'ok',retcode:0,data:{message_id:999}}));});
    const pending=restored.store.outbox().find(row=>row.id==='offline')!;pending.dueAt=0;restored.store.saveOutbox(pending);
    await restored.coordinator.tick();await restored.coordinator.tick();
    expect(packets).toHaveLength(1);expect(packets[0].params.message).toEqual([{type:'text',data:{text:'durable offline answer'}}]);
    expect(restored.store.outbox().find(row=>row.id==='offline')).toMatchObject({status:'sent',attempts:1,platformMessageId:'999'});
    expect(restored.store.outbox().filter(row=>row.status==='unknown')).toHaveLength(2);
  });
  it('stops intake before cancelling a blocked Router and durably recovers both active and buffered messages',async()=>{
    const root=await directory(),runtime=new Runtime(true),first=await start(root,runtime),socket=await connect(first.adapter);
    socket.send(JSON.stringify(event(11)));await until(()=>runtime.routes.length===1);
    socket.send(JSON.stringify(event(12)));await until(()=>Boolean(first.store.message('qq:900:100:12')));
    let timer:ReturnType<typeof setTimeout>|undefined;
    try{
      await Promise.race([first.close(),new Promise<never>((_resolve,reject)=>timer=setTimeout(()=>reject(new Error('Shutdown waited for Router before cancellation')),1000))]);
    }finally{if(timer)clearTimeout(timer);}
    expect(runtime.closed).toBe(true);
    const reopened=new Store(first.file);
    try{
      expect(reopened.pendingMessages().map(message=>message.id).sort()).toEqual(['qq:900:100:11','qq:900:100:12']);
      expect(reopened.outbox()).toHaveLength(0);
    }finally{reopened.close();}
    const restored=await start(root);
    expect(restored.runtime.routes.flatMap(request=>request.messages.map(message=>message.id)).sort()).toEqual(['qq:900:100:11','qq:900:100:12']);
    expect(restored.store.pendingMessages()).toHaveLength(0);
    expect(restored.store.db.prepare('SELECT status FROM messages ORDER BY id').all().map(row=>row.status)).toEqual(['routed','routed']);
  });
});
