import { afterEach,expect,it,vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/store.js';
import { Coordinator } from '../src/coordinator.js';
import { MemoryPublisher } from '../src/platform/memory.js';
import { isSqliteBusy,retrySqliteBusy } from '../src/runtime/sqlite-busy.js';
import type { GroupMessage,RouterRequest,RuntimePort } from '../src/types.js';

const cleanup:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();vi.restoreAllMocks();});
function fixture(queueTimeout=3000){
  const root=mkdtempSync(join(tmpdir(),'boe-router-db-retry-')),path=join(root,'state.sqlite');
  const config=loadConfig(root,{stateDir:root,persistentRouter:true,routerBatchWindowMs:0,routerQueueTimeoutMs:queueTimeout,routerTurnTimeoutMs:3000});
  const store=new Store(path),blocker=new DatabaseSync(path);store.db.exec('PRAGMA busy_timeout=0');blocker.exec('PRAGMA busy_timeout=0');
  const publisher=new MemoryPublisher(),routes:RouterRequest[]=[];
  let onRoute=()=>{};
  const runtime:RuntimePort={route:async request=>{routes.push(request);onRoute();return [{action:'reply_direct',sourceMessageIds:request.messages.map(message=>message.id),text:'已处理'}];},runWorker:async()=>{throw new Error('Unexpected Worker');},steer:async()=>{},cancel:async()=>{},close:async()=>{}};
  const coordinator=new Coordinator(config,store,runtime,publisher);
  store.db.exec('PRAGMA busy_timeout=0');
  const unlock=()=>{try{blocker.exec('ROLLBACK');}catch{/* already released */}};
  cleanup.push(async()=>{unlock();await coordinator.close();blocker.close();store.close();rmSync(root,{recursive:true,force:true});});
  const message:GroupMessage={id:'room:current',roomId:'room',messageId:'current',authorId:'owner',authorName:'Owner',platform:'replay',text:'请回复',timestamp:Date.now(),mentions:[],attachments:[],isMentioned:true,isAdmin:false};
  return {store,blocker,coordinator,publisher,routes,message,unlock,setOnRoute:(fn:()=>void)=>{onRoute=fn;}};
}

it('recovers a real write lock before turn reservation without restart or duplicate inference',async()=>{
  const f=fixture(),transaction=f.store.transaction.bind(f.store);let count=0;
  vi.spyOn(f.store,'transaction').mockImplementation(fn=>{
    if(++count===2){f.blocker.exec('BEGIN IMMEDIATE');setTimeout(f.unlock,30);}
    return transaction(fn);
  });
  await f.coordinator.receive(f.message);
  expect(f.routes).toHaveLength(1);expect(f.store.pendingMessages()).toEqual([]);
  expect(f.store.routerSessions.turns('room')).toMatchObject([{state:'committed',attempts:1}]);
  expect(f.publisher.messages.map(row=>row.message.text)).toEqual(['已处理']);
});

it('retains model output while the provider success write is locked',async()=>{
  const f=fixture();f.setOnRoute(()=>{f.blocker.exec('BEGIN IMMEDIATE');setTimeout(f.unlock,30);});
  await f.coordinator.receive(f.message);
  expect(f.routes).toHaveLength(1);expect(f.store.decisions()).toHaveLength(1);
  expect(f.store.routerSessions.turns('room')).toMatchObject([{state:'committed',attempts:1,modelCalls:0}]);
  expect(f.publisher.messages.map(row=>row.message.text)).toEqual(['已处理']);
});

it('retains validated actions while the business commit write is locked',async()=>{
  const f=fixture(),transaction=f.store.transaction.bind(f.store);let ready=false;
  f.setOnRoute(()=>{ready=true;});
  vi.spyOn(f.store,'transaction').mockImplementation(fn=>{
    if(ready){ready=false;f.blocker.exec('BEGIN IMMEDIATE');setTimeout(f.unlock,30);}
    return transaction(fn);
  });
  await f.coordinator.receive(f.message);
  expect(f.routes).toHaveLength(1);expect(f.store.decisions()).toHaveLength(1);
  expect(f.store.pendingMessages()).toEqual([]);
  expect(f.publisher.messages.map(row=>row.message.text)).toEqual(['已处理']);
});

it('recovers intake and event registration atomically when the database starts locked',async()=>{
  const f=fixture();f.blocker.exec('BEGIN IMMEDIATE');setTimeout(f.unlock,30);
  await f.coordinator.receive(f.message);
  expect(f.routes).toHaveLength(1);expect(f.store.pendingMessages()).toEqual([]);
  expect(f.store.routerSessions.turns('room')).toMatchObject([{state:'committed',attempts:1}]);
  expect(f.publisher.messages).toHaveLength(1);
});

it('expires an input locked beyond its original queue deadline without calling the model',async()=>{
  const f=fixture(40),transaction=f.store.transaction.bind(f.store);let count=0;
  vi.spyOn(f.store,'transaction').mockImplementation(fn=>{
    if(++count===2){f.blocker.exec('BEGIN IMMEDIATE');setTimeout(f.unlock,100);}
    return transaction(fn);
  });
  await f.coordinator.receive(f.message);
  expect(f.routes).toEqual([]);expect(f.store.pendingMessages()).toEqual([]);
  expect(f.store.db.prepare('SELECT status FROM messages WHERE id=?').get(f.message.id)?.status).toBe('failed');
  expect(f.store.routerSessions.turns('room')).toMatchObject([{state:'failed',attempts:0}]);
  expect(f.publisher.messages).toHaveLength(1);expect(f.publisher.messages[0].dedupeKey).toBe('route-failed:'+f.message.id);
});

it('recognizes SQLite primary and extended lock codes without retrying unrelated errors',async()=>{
  expect(isSqliteBusy({code:'ERR_SQLITE_ERROR',errcode:517})).toBe(true);
  expect(isSqliteBusy({code:'SQLITE_LOCKED_SHAREDCACHE'})).toBe(true);
  expect(isSqliteBusy(new Error('database is locked'))).toBe(false);
  const work=vi.fn(()=>{throw new Error('constraint violation');});
  await expect(retrySqliteBusy(work,{deadlineAt:Date.now()+1000})).rejects.toThrow('constraint violation');expect(work).toHaveBeenCalledTimes(1);
});
