import {expect,it} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadConfig} from '../src/config.js';
import {scheduleWorkerInputs,workerInputScheduling} from '../src/worker-input-scheduling.js';
import {Store} from '../src/store.js';
import type {GroupMessage} from '../src/types.js';

it('validates startup scheduling and caps a burst at its first-input deadline',()=>{
  const options=workerInputScheduling(undefined);
  expect(options).toEqual({settleMs:750,maxWaitMs:3000});
  const root=mkdtempSync(join(tmpdir(),'input-window-'));
  try{expect(loadConfig(root,{workerInputScheduling:{settleMs:0,maxWaitMs:0}}).workerInputScheduling).toEqual({settleMs:0,maxWaitMs:0});}finally{rmSync(root,{recursive:true,force:true});}
  for(const value of [{settleMs:-1},{settleMs:3001},{maxWaitMs:10001},{settleMs:1.5},{other:1}])expect(()=>workerInputScheduling(value)).toThrow();
  let pending=scheduleWorkerInputs(undefined,2,options,1000);
  pending=scheduleWorkerInputs(pending,3,options,1600);expect(pending.readyAt).toBe(2350);
  pending=scheduleWorkerInputs(pending,4,options,3900);expect(pending.readyAt).toBe(4000);
});

it('recovers persisted pending inputs and the original superseded run binding',()=>{
  const store=new Store(':memory:');
  try{
    const message:GroupMessage={id:'room:1',messageId:'1',roomId:'room',platform:'replay',authorId:'owner',authorName:'owner',text:'prepare a document',timestamp:1,mentions:[],attachments:[],isAdmin:false,isMentioned:true};
    store.ingest(message);const thread=store.createThread(message,'document',true);
    thread.status='running';thread.activeRunId='old';thread.workerBudget={revision:1,remainingSteps:8,deadlineAt:99999};store.saveThread(thread);
    store.saveRun('old',thread.id,'running',{revision:1,epoch:1,throughInputSeq:1,startedAt:100});
    const correction={...message,id:'room:2',messageId:'2',text:'change the budget'};store.ingest(correction);store.append(thread,correction,'correction');
    thread.pendingInputs=scheduleWorkerInputs(undefined,2,{settleMs:750,maxWaitMs:3000},1000);store.saveThread(thread);
    store.recovery();const recovered=store.thread(thread.id)!;
    expect(recovered).toMatchObject({status:'queued',revision:2,pendingInputs:{readyAt:1750,throughInputSeq:2},workerBudget:{remainingSteps:8}});
    const row=store.db.prepare('SELECT status,data FROM runs WHERE id=?').get('old')!;
    expect(row.status).toBe('superseded');expect(JSON.parse(String(row.data))).toMatchObject({revision:1,throughInputSeq:1,supersededByRevision:2});
    expect(recovered.lastFailure).toBeUndefined();
  }finally{store.close();}
});
