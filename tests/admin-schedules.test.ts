import {afterEach,describe,it,expect} from 'vitest';
import {existsSync,mkdtempSync,rmSync,mkdirSync,writeFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AdminServer} from '../src/admin/server.js';
import {loadConfig} from '../src/config.js';
import {Store} from '../src/store.js';
import {ScheduledTaskService} from '../src/scheduled-tasks/service.js';
import type {ScheduleActor} from '../src/scheduled-tasks/types.js';
import {DEFAULT_BUSINESS_SETTINGS} from '../src/business-config.js';
const cleanup:Array<()=>Promise<void>|void>=[];
afterEach(async()=>{for(const fn of cleanup.splice(0).reverse())await fn();});
async function setup(){
 const root=mkdtempSync(join(tmpdir(),'boe-admin-schedules-'));cleanup.push(()=>rmSync(root,{recursive:true,force:true}));
 const config=loadConfig(root,{stateDir:join(root,'state')});config.qq.selfId='bot';config.qq.allowedGroupIds=['room'];config.scheduledTasks={...config.scheduledTasks,enabled:true};mkdirSync(config.stateDir,{recursive:true});
 const store=new Store(join(config.stateDir,'state.sqlite'));cleanup.push(()=>store.close());const service=new ScheduledTaskService(store.db,{allowedRoomIds:['qq:bot:room']});
 const server=new AdminServer(config,0),url=await server.start();cleanup.push(()=>server.close());
 async function post(path:string,body:unknown){const response=await fetch(url+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});return {status:response.status,body:await response.json()};}
 return {root,config,store,service,url,post};
}
const draft=()=>({roomId:'qq:bot:room',title:'核对记录',content:'检查任务资料',executionKind:'worker',timezone:'Asia/Shanghai',scheduleSpec:{kind:'once',at:Date.now()+3600000}});
describe('scheduled task administration',()=>{
 it('creates, reads, edits and clears multiple recipients through the admin API',async()=>{
  const{url,post}=await setup();
  const created=await post('/api/schedules',{input:{...draft(),recipientIds:['member-A','member-B','member-A']},idempotencyKey:'recipients'});
  expect(created.status).toBe(201);const s=created.body.schedule;expect(s.recipientIds).toEqual(['member-A','member-B']);
  expect((await(await fetch(url+'/api/schedules/'+s.id)).json()).schedule.recipientIds).toEqual(s.recipientIds);
  const edited=await post(`/api/schedules/${s.id}/update`,{expectedVersion:s.version,patch:{title:'Updated'},idempotencyKey:'keep-recipients'});
  expect(edited.body.schedule.recipientIds).toEqual(s.recipientIds);
  const cleared=await post(`/api/schedules/${s.id}/update`,{expectedVersion:edited.body.schedule.version,patch:{recipientIds:[]},idempotencyKey:'clear-recipients'});
  expect(cleared.status).toBe(200);expect(cleared.body.schedule.recipientIds).toEqual([]);
  expect((await post('/api/schedules',{input:{...draft(),recipientIds:['']},idempotencyKey:'invalid-recipient'})).status).toBe(400);
 });
 it('initializes the full version-3 store when schedules are the first page opened on a clean install',async()=>{
  const root=mkdtempSync(join(tmpdir(),'boe-admin-schedules-clean-'));cleanup.push(()=>rmSync(root,{recursive:true,force:true}));
  const config=loadConfig(root),file=join(config.stateDir,'state.sqlite'),server=new AdminServer(config,0),url=await server.start();cleanup.push(()=>server.close());
  expect(existsSync(file)).toBe(false);
  const scheduleResponse=await fetch(url+'/api/schedules');expect(scheduleResponse.status).toBe(200);expect(await scheduleResponse.json()).toMatchObject({items:[],total:0,enabled:false,running:false});
  const overview=await fetch(url+'/api/overview');expect(overview.status).toBe(200);expect(await overview.json()).toMatchObject({messages:0,threads:[],outbox:[],running:false});
  const threads=await fetch(url+'/api/threads');expect(threads.status).toBe(200);expect(await threads.json()).toEqual([]);
  const db=new DatabaseSync(file,{readOnly:true});try{expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(3);}finally{db.close();}
 });
 it('refuses to modify a database whose primary schema is newer than version 3',async()=>{
  const root=mkdtempSync(join(tmpdir(),'boe-admin-schedules-newer-'));cleanup.push(()=>rmSync(root,{recursive:true,force:true}));
  const config=loadConfig(root),file=join(config.stateDir,'state.sqlite'),server=new AdminServer(config,0),url=await server.start();cleanup.push(()=>server.close());
  const db=new DatabaseSync(file);try{db.exec('PRAGMA user_version=4');}finally{db.close();}
  expect((await fetch(url+'/api/schedules')).status).toBe(503);
  const check=new DatabaseSync(file,{readOnly:true});try{expect(check.prepare('PRAGMA user_version').get()?.user_version).toBe(4);expect(check.prepare("SELECT name FROM sqlite_master WHERE name='schedules'").get()).toBeUndefined();}finally{check.close();}
 });
 it('creates only system tasks, exposes truthful offline state, and deduplicates retried requests',async()=>{
  const{post,url,service}=await setup();const input=draft();const a=await post('/api/schedules',{input,idempotencyKey:'create-one'});expect(a.status).toBe(201);expect(a.body.schedule).toMatchObject({authority:'system',ownerId:null,registeredBy:'admin',businessProfileId:'default'});expect(a.body.running).toBe(false);expect(a.body.message).toContain('等待');
  const b=await post('/api/schedules',{input,idempotencyKey:'create-one'});expect(b.body.schedule.id).toBe(a.body.schedule.id);const list=await(await fetch(url+'/api/schedules')).json();expect(list.items).toHaveLength(1);expect(list.allowedRoomIds).toEqual(['qq:bot:room']);expect(service.get({kind:'admin'},a.body.schedule.id).authority).toBe('system');
  const detail=await(await fetch(url+'/api/schedules/'+a.body.schedule.id)).json();expect(detail.audits).toEqual(expect.arrayContaining([expect.objectContaining({data:expect.objectContaining({event:'created',data:expect.objectContaining({id:a.body.schedule.id})})})]));
  const overview=await(await fetch(url+'/api/overview')).json();expect(overview.errors.some((row:any)=>row.kind==='scheduled_task')).toBe(false);
 });
 it('rejects identity overrides, foreign rooms, malformed requests, and cross-origin writes',async()=>{
  const{url,post}=await setup();expect((await post('/api/schedules',{input:{...draft(),authority:'user',ownerId:'another'},idempotencyKey:'spoof'})).status).toBe(400);
  expect((await post('/api/schedules',{input:{...draft(),roomId:'qq:bot:foreign'},idempotencyKey:'room'})).status).toBeGreaterThanOrEqual(400);
  expect((await fetch(url+'/api/schedules',{method:'POST',body:'{}'})).status).toBe(415);
  expect((await fetch(url+'/api/schedules',{method:'POST',headers:{Origin:'https://foreign.invalid','Content-Type':'application/json'},body:'{}'})).status).toBe(403);
  expect((await fetch(url+'/api/schedules',{method:'POST',headers:{'Content-Type':'application/json'},body:'{'})).status).toBe(400);
  expect((await fetch(url+'/api/schedules',{method:'DELETE'})).status).toBe(405);
 });
 it('binds new backend tasks to the latest saved room business profile',async()=>{
  const{root,post}=await setup();const business=structuredClone(DEFAULT_BUSINESS_SETTINGS);business.profiles.documents={...business.profiles.default,name:'资料助手'};business.roomProfiles['qq:bot:room']='documents';
  writeFileSync(join(root,'config.local.json'),JSON.stringify({business}));
  const result=await post('/api/schedules',{input:{...draft(),businessProfileId:'stale-client-profile'},idempotencyKey:'profile-refresh'});
  expect(result.status).toBe(201);expect(result.body.schedule.businessProfileId).toBe('documents');
 });
 it('persists exactly two configurable role groups with conflict detection and empty selection',async()=>{
  const{url,post}=await setup();const before=await(await fetch(url+'/api/schedule-permissions')).json();expect(before.allowedRoleGroups.sort()).toEqual(['group_admin','member']);
  const empty=await post('/api/schedule-permissions',{allowedRoleGroups:[],expectedVersion:before.version});expect(empty.status).toBe(200);expect(empty.body.allowedRoleGroups).toEqual([]);
  expect((await post('/api/schedule-permissions',{allowedRoleGroups:['member'],expectedVersion:before.version})).status).toBe(409);
  expect((await post('/api/schedule-permissions',{allowedRoleGroups:['owner'],expectedVersion:empty.body.version})).status).toBe(400);
  const selected=await post('/api/schedule-permissions',{allowedRoleGroups:['group_admin'],expectedVersion:empty.body.version});expect(selected.status).toBe(200);expect((await(await fetch(url+'/api/schedule-permissions')).json()).allowedRoleGroups).toEqual(['group_admin']);
 });
 it('keeps user ownership and authority while editing through the backend',async()=>{
  const{service,post}=await setup();const actor:ScheduleActor={kind:'user',memberId:'member-A',roomId:'qq:bot:room',roleGroup:'member',roleVerifiedAt:Date.now(),sourceMessageIds:['message-1'],registeredBy:'worker'};
  const task=service.create(actor,draft() as any,'worker-register');const changed=await post(`/api/schedules/${task.id}/update`,{expectedVersion:task.version,patch:{title:'新的说明'},idempotencyKey:'edit'});expect(changed.status).toBe(200);expect(changed.body.schedule).toMatchObject({ownerId:'member-A',authority:'user',registeredBy:'worker',title:'新的说明'});
  expect((await post(`/api/schedules/${task.id}/update`,{expectedVersion:task.version,patch:{title:'覆盖'},idempotencyKey:'stale'})).status).toBe(409);
 });
 it('uses the chosen timezone, allows short one-shot delay and refuses sub-hour repeats',async()=>{
  const{post}=await setup();const preview=await post('/api/schedules/preview',{scheduleSpec:{kind:'once',at:'2030-01-01T09:00'},timezone:'Asia/Shanghai'});expect(preview.status).toBe(200);expect(preview.body.times).toEqual([Date.UTC(2030,0,1,1)]);
  expect((await post('/api/schedules',{input:{...draft(),scheduleSpec:{kind:'once',at:Date.now()+60000}},idempotencyKey:'short-once'})).status).toBe(201);
  const interval={kind:'interval',anchorAt:Date.now()+3600000,intervalMs:59*60000};expect((await post('/api/schedules',{input:{...draft(),scheduleSpec:interval},idempotencyKey:'fast'})).status).toBe(400);
  expect((await post('/api/schedules/preview',{scheduleSpec:{kind:'cron',expression:'*/5 * * * *'},timezone:'Asia/Shanghai'})).status).toBe(400);
  const valid=await post('/api/schedules/preview',{scheduleSpec:{kind:'cron',expression:'0 9 * * 1-5'},timezone:'Asia/Shanghai'});expect(valid.status).toBe(200);expect(valid.body.times).toHaveLength(5);
 });
 it('never falls back from a historical data source to production management',async()=>{
  const{url,post,service}=await setup();const list=await(await fetch(url+'/api/schedules?source=ask-historical')).json();expect(list).toMatchObject({available:false,items:[]});expect((await post('/api/schedules?source=ask-historical',{input:draft(),idempotencyKey:'history'})).status).toBe(403);expect(service.list({kind:'admin'}).total).toBe(0);
 });
 it('manages pause/resume/cancel/archive and exposes command receipts and empty run history',async()=>{
  const{url,post}=await setup();let s=(await post('/api/schedules',{input:draft(),idempotencyKey:'flow'})).body.schedule;
  for(const [op,status] of [['pause','paused'],['resume','active'],['cancel','cancelled'],['archive','cancelled']]){
   const result=await post(`/api/schedules/${s.id}/commands`,{op,expectedVersion:s.version,idempotencyKey:op});expect(result.status).toBe(200);const receipt=await(await fetch(url+'/api/schedule-commands/'+result.body.command.id)).json();expect(receipt.command.status).toBe('applied');s=(await(await fetch(url+'/api/schedules/'+s.id)).json()).schedule;expect(s.status).toBe(status);
  }
  expect(s.archivedAt).toBeTruthy();const runs=await(await fetch(url+`/api/schedules/${s.id}/runs`)).json();expect(runs).toMatchObject({items:[],total:0});
 });
 it('enriches run history with actual delivery and retains successful compute vs unknown delivery',async()=>{
  const{service,store,url}=await setup();const s=service.create({kind:'admin'},draft() as any,'run-history');
  const now=Date.now(),run={id:'sr-test',scheduleId:s.id,scheduleVersion:s.version,generation:s.generation,triggerKey:'test',trigger:'manual',scheduledAt:now,createdAt:now,status:'succeeded',snapshot:s,outboxId:'schedule-output'};
  store.enqueue({roomId:s.roomId,text:'核对完成'},{id:'schedule-output',status:'unknown'});
  // Fixture uses the real persisted schema and a terminal calculation, independently of platform acceptance.
  const columns=store.db.prepare('PRAGMA table_info(schedule_runs)').all().map(x=>String(x.name));
  const values:Record<string,unknown>={id:run.id,schedule_id:s.id,status:run.status,created_at:now,trigger_key:'test',data:JSON.stringify(run)};
  store.db.prepare(`INSERT INTO schedule_runs(${columns.join(',')}) VALUES(${columns.map(()=>'?').join(',')})`).run(...columns.map(c=>values[c]??null) as any);
  const result=await(await fetch(url+`/api/schedules/${s.id}/runs`)).json();expect(result.items[0]).toMatchObject({status:'succeeded',outbox:[{status:'unknown',data:{message:{text:'核对完成'}}}]});
  const list=await(await fetch(url+'/api/schedules')).json();expect(list.items[0].lastRun).toMatchObject({id:run.id,status:'succeeded'});
 });
});
