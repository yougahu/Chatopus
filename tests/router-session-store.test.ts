import { afterEach, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { RouterSessionStore, routerTurnHash, type BeginRouterTurn, type RouterTurn } from '../src/router-session-store.js';

const databases=new Set<DatabaseSync>(),directories:string[]=[];
afterEach(()=>{for(const db of databases)db.close();databases.clear();for(const path of directories.splice(0))rmSync(path,{recursive:true,force:true});});
function fixture(path=':memory:'){
  const db=new DatabaseSync(path);databases.add(db);db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=1000;');
  return new RouterSessionStore(db);
}
function close(store:RouterSessionStore){store.db.close();databases.delete(store.db);}
function file(){const directory=mkdtempSync(join(tmpdir(),'boe-router-state-'));directories.push(directory);return join(directory,'test.db');}
function setup(store:RouterSessionStore,roomId='room'){return store.ensureSession({roomId,sessionId:`native-${roomId}-1`,configHash:'config-1'});}
function input(roomId='room',key='batch-1',ids=['m-1']):BeginRouterTurn {
  return {roomId,trigger:{kind:'messages',key},inputs:ids.map(id=>({kind:'message',id})),request:{messages:ids.map(id=>({id,text:'question'})),threads:[]}};
}
function begin(store:RouterSessionStore,roomId='room',key='batch-1',ids=['m-1']){setup(store,roomId);return store.beginTurn(input(roomId,key,ids));}
function commit(store:RouterSessionStore,turn:RouterTurn){return store.commitTurn({turnId:turn.id,generation:turn.generation,actions:[{action:'silence'}],receipt:{accepted:true},contextBoundary:store.latestEventSeq(turn.roomId)});}
it('separates provider health from the three business record tables and keeps input ownership separate from host facts',()=>{
  const store=fixture(),turn=begin(store);
  const source=store.events('room')[0];expect(source).toMatchObject({origin:'input',ownerTurnId:turn.id,payload:{kind:'input',input:{kind:'message',id:'m-1'}}});
  const result=commit(store,turn);
  expect(result.event).toMatchObject({origin:'host',payload:{kind:'turn_committed',turnId:turn.id,receipt:{accepted:true}}});
  expect(result.event.ownerTurnId).toBeUndefined();expect(store.session('room')?.contextBoundary).toBe(source.seq);
  expect(store.events('room',{afterSeq:source.seq})).toEqual([result.event]);
  expect(store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'router_%' ORDER BY name").all().map(row=>row.name)).toEqual(['router_events','router_provider_health','router_sessions','router_turns']);
});

it('deduplicates the exact trigger and sources without depending on native generation or prompt',()=>{
  const store=fixture(),turn=begin(store,'room','batch-1',['a','b']);
  expect(store.beginTurn({...input('room','batch-1',['a','b']),request:{fresh:true}})).toEqual(turn);
  expect(store.turnForInput('room',{kind:'message',id:'b'})?.id).toBe(turn.id);
  expect(store.events('room')).toHaveLength(2);expect(store.pendingTurns()).toEqual([turn]);
  expect(()=>store.beginTurn(input('room','batch-1',['b','a']))).toThrow('original batch');
  expect(()=>routerTurnHash(input('room','bad',['a','a']))).toThrow('Repeated input');
  commit(store,turn);
  expect(()=>store.beginTurn(input('room','different-batch',['a']))).toThrow('another turn');
  expect(store.pendingTurns()).toEqual([]);expect(store.events('room')).toHaveLength(3);
  expect(begin(store,'other','batch-1',['a']).id).not.toBe(turn.id);
});

it('does not allow a second pending batch to acquire the same room and permits an independent room',()=>{
  const store=fixture(),first=begin(store);
  expect(()=>store.beginTurn(input('room','batch-2',['m-2']))).toThrow('existing pending');
  const other=begin(store,'other');expect(other.roomId).toBe('other');
  expect(store.session('room')?.inflightTurnId).toBe(first.id);
});

it('allows fresh task/reference views on the same bound turn, preserving source identities and attempts',()=>{
  const store=fixture(),turn=begin(store);store.startAttempt({turnId:turn.id,generation:1});
  const updated=store.updateTurnRequest({turnId:turn.id,generation:1,inputs:turn.inputs,request:{messages:[{id:'m-1'}],threads:[{id:'newly-created-thread'}]}});
  expect(updated).toMatchObject({id:turn.id,inputHash:turn.inputHash,attempts:1,request:{threads:[{id:'newly-created-thread'}]}});
  expect(()=>store.updateTurnRequest({turnId:turn.id,generation:1,inputs:[{kind:'message',id:'different'}],request:{}})).toThrow('different source');
  commit(store,updated);
  expect(()=>store.updateTurnRequest({turnId:turn.id,generation:1,inputs:turn.inputs,request:{}})).toThrow('no longer pending');
});

it('commits callback-created business IDs, receipt and turn exactly once in one SQLite transaction',()=>{
  const store=fixture(),turn=begin(store);store.db.exec('CREATE TABLE business(id INTEGER PRIMARY KEY AUTOINCREMENT,value TEXT);');
  const apply=vi.fn(()=>{const row=store.db.prepare('INSERT INTO business(value) VALUES(?)').run('task');return {threadId:Number(row.lastInsertRowid)};});
  const result=store.commitTurn({turnId:turn.id,generation:1,actions:[{action:'open_thread'}]},apply);
  expect(result).toMatchObject({alreadyCommitted:false,receipt:{threadId:1},turn:{state:'committed',receipt:{threadId:1}}});
  expect(store.session('room')?.inflightTurnId).toBeUndefined();
  const retry=store.commitTurn({turnId:turn.id,generation:999,actions:['different']},apply);
  expect(retry.alreadyCommitted).toBe(true);expect(retry.receipt).toEqual({threadId:1});expect(apply).toHaveBeenCalledTimes(1);
  expect(store.db.prepare('SELECT COUNT(*) AS n FROM business').get()?.n).toBe(1);expect(store.events('room')).toHaveLength(2);
});

it('rolls back business effects and commit records when the callback or receipt write fails',()=>{
  const store=fixture(),turn=begin(store);store.db.exec('CREATE TABLE business(value TEXT);');
  const apply=()=>{store.db.prepare('INSERT INTO business VALUES(?)').run('task');return {threadId:'t-1'};};
  expect(()=>store.commitTurn({turnId:turn.id,generation:1,actions:[]},()=>{apply();throw new Error('crash before receipt');})).toThrow('crash before receipt');
  store.db.exec("CREATE TRIGGER break_receipt BEFORE INSERT ON router_events WHEN NEW.origin='host' BEGIN SELECT RAISE(ABORT,'receipt disk failure'); END;");
  expect(()=>store.commitTurn({turnId:turn.id,generation:1,actions:[]},apply)).toThrow('receipt disk failure');
  expect(store.db.prepare('SELECT COUNT(*) AS n FROM business').get()?.n).toBe(0);
  expect(store.turn(turn.id)?.state).toBe('pending');expect(store.session('room')?.inflightTurnId).toBe(turn.id);expect(store.events('room')).toHaveLength(1);
  store.db.exec('DROP TRIGGER break_receipt');expect(store.commitTurn({turnId:turn.id,generation:1,actions:[]},apply).receipt).toEqual({threadId:'t-1'});
});

it('composes with an existing transaction and rolls back begin, effects, cursor and receipt together',()=>{
  const store=fixture();setup(store);store.db.exec('CREATE TABLE business(value TEXT); BEGIN IMMEDIATE;');
  const turn=store.beginTurn(input());
  store.commitTurn({turnId:turn.id,generation:1,actions:[],contextBoundary:store.latestEventSeq('room')},()=>{store.db.exec("INSERT INTO business VALUES('task')");return {ok:true};});
  store.db.exec('ROLLBACK');
  expect(store.turn(turn.id)).toBeUndefined();expect(store.events('room')).toEqual([]);expect(store.session('room')).toMatchObject({contextBoundary:0});
  expect(store.session('room')?.inflightTurnId).toBeUndefined();expect(store.db.prepare('SELECT COUNT(*) AS n FROM business').get()?.n).toBe(0);
});

it('recovers durable pending batch and attempt count after actual database reopen without trusting old generation',()=>{
  const path=file();let store=fixture(path);const turn=begin(store,'room','original-batch',['a','b']);
  store.startAttempt({turnId:turn.id,generation:1});close(store);
  store=fixture(path);const uncertain=store.recoverUncertain();expect(uncertain).toHaveLength(1);expect(uncertain[0]).toMatchObject({generation:1,needsRebuild:true,inflightTurnId:turn.id});
  expect(store.pendingTurns('room')[0]).toMatchObject({id:turn.id,attempts:1,inputs:turn.inputs});
  const oldApply=vi.fn();expect(()=>store.commitTurn({turnId:turn.id,generation:1,actions:[]},oldApply)).toThrow('rebuilt');expect(oldApply).not.toHaveBeenCalled();
  const rebuilt=store.rebuildSession({roomId:'room',expectedGeneration:1,sessionId:'native-room-2',configHash:'config-1'});
  expect(rebuilt).toMatchObject({generation:2,needsRebuild:false});expect(rebuilt?.inflightTurnId).toBeUndefined();
  expect(store.rebuildSession({roomId:'room',expectedGeneration:1,sessionId:'native-stale',configHash:'config-1'})).toBeNull();
  expect(()=>store.beginTurn(input('room','rebatched',['a']))).toThrow('existing pending');
  const rebound=store.rebindTurn({turnId:turn.id,generation:2});expect(rebound).toMatchObject({generation:2,attempts:1,inputHash:turn.inputHash});
  expect(()=>store.commitTurn({turnId:turn.id,generation:1,actions:[]},oldApply)).toThrow('inactive generation');
  expect(store.startAttempt({turnId:turn.id,generation:2,maxAttempts:2}).attempts).toBe(2);
  expect(()=>store.startAttempt({turnId:turn.id,generation:2,maxAttempts:2})).toThrow('budget exhausted');
  commit(store,store.turn(turn.id)!);close(store);
  store=fixture(path);expect(store.recoverUncertain()).toEqual([]);expect(store.turn(turn.id)).toMatchObject({state:'committed',attempts:2,generation:2});
  expect(store.commitTurn({turnId:turn.id,generation:1,actions:['late']},oldApply).alreadyCommitted).toBe(true);expect(oldApply).not.toHaveBeenCalled();
});

it('preserves durable pending state when an outer commit was interrupted and rolled back on connection close',()=>{
  const path=file();let store=fixture(path);const turn=begin(store);store.db.exec('CREATE TABLE business(value TEXT); BEGIN IMMEDIATE;');
  store.commitTurn({turnId:turn.id,generation:1,actions:[]},()=>{store.db.exec("INSERT INTO business VALUES('task')");return {threadId:'t-1'};});
  close(store);store=fixture(path);
  expect(store.db.prepare('SELECT COUNT(*) AS n FROM business').get()?.n).toBe(0);expect(store.turn(turn.id)?.state).toBe('pending');expect(store.events('room')).toHaveLength(1);
  expect(store.recoverUncertain()[0].inflightTurnId).toBe(turn.id);
});

it('recovers after a separate process exits abruptly inside the business commit transaction',()=>{
  const path=file(),moduleUrl=new URL('../src/router-session-store.ts',import.meta.url).href;
  const script=`
    import { DatabaseSync } from 'node:sqlite';
    import { RouterSessionStore } from ${JSON.stringify(moduleUrl)};
    const db=new DatabaseSync(process.argv[1]);db.exec('PRAGMA journal_mode=WAL;');
    const store=new RouterSessionStore(db);
    store.ensureSession({roomId:'room',sessionId:'native-1',configHash:'config-1'});
    const turn=store.beginTurn({roomId:'room',trigger:{kind:'messages',key:'batch'},inputs:[{kind:'message',id:'original'}],request:{original:true}});
    store.startAttempt({turnId:turn.id,generation:1});
    db.exec('CREATE TABLE business(value TEXT); BEGIN IMMEDIATE;');
    store.commitTurn({turnId:turn.id,generation:1,actions:[]},()=>{db.exec("INSERT INTO business VALUES('task')");return {threadId:'uncommitted'};});
    process.exit(73);
  `;
  const child=spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',script,path],{encoding:'utf8',timeout:10_000});
  expect(child.status,child.stderr).toBe(73);
  const store=fixture(path),pending=store.pendingTurns('room');expect(pending).toHaveLength(1);expect(pending[0]).toMatchObject({attempts:1,state:'pending'});
  expect(store.db.prepare('SELECT COUNT(*) AS n FROM business').get()?.n).toBe(0);expect(store.events('room')).toHaveLength(1);
  expect(store.recoverUncertain()[0]).toMatchObject({inflightTurnId:pending[0].id,needsRebuild:true});
});

it('keeps failure attempts and input ownership, allowing only pending failures to rebind',()=>{
  const store=fixture(),turn=begin(store);store.startAttempt({turnId:turn.id,generation:1});
  store.failTurn({turnId:turn.id,generation:1,error:{code:'TIMEOUT'},terminal:false});
  expect(store.turn(turn.id)).toMatchObject({state:'pending',attempts:1,error:{code:'TIMEOUT'}});
  store.rebuildSession({roomId:'room',expectedGeneration:1,sessionId:'new-session',configHash:'config-1'});store.rebindTurn({turnId:turn.id,generation:2});
  store.failTurn({turnId:turn.id,generation:2,error:{code:'EXHAUSTED'}});
  expect(store.turnForInput('room',turn.inputs[0])).toMatchObject({state:'failed',attempts:1});
  store.rebuildSession({roomId:'room',expectedGeneration:2,sessionId:'third-session',configHash:'config-1'});
  expect(()=>store.rebindTurn({turnId:turn.id,generation:3})).toThrow('pending');
  expect(store.beginTurn(input()).state).toBe('failed');
});

it('retains the first validation cause when recovery ends at a different terminal error',()=>{
 const store=fixture(),turn=begin(store);store.startAttempt({turnId:turn.id,generation:1});
 store.failTurn({turnId:turn.id,generation:1,terminal:false,error:{code:'STRUCTURED_OUTPUT_INVALID',causeCode:'ROUTER_EVIDENCE_UNREAD',repair:{validationError:'Read the remaining evidence'}}});
 store.failTurn({turnId:turn.id,generation:1,error:{code:'ROUTER_REBUILD_LIMIT'}});
 expect(store.turn(turn.id)?.error).toMatchObject({code:'ROUTER_REBUILD_LIMIT',rootCode:'ROUTER_EVIDENCE_UNREAD',repair:{validationError:'Read the remaining evidence'},history:[
  {code:'STRUCTURED_OUTPUT_INVALID',causeCode:'ROUTER_EVIDENCE_UNREAD',stage:'attempt',attempt:1,generation:1},
  {code:'ROUTER_REBUILD_LIMIT',stage:'terminal',attempt:1,generation:1},
 ]});
});

it('bounds failure history while retaining the root cause across later failures',()=>{
 const store=fixture(),turn=begin(store);
 store.failTurn({turnId:turn.id,generation:1,terminal:false,error:{code:'ORIGINAL_FAILURE'}});
 for(let i=0;i<12;i++)store.failTurn({turnId:turn.id,generation:1,terminal:false,error:{code:'RECOVERY_FAILURE'}});
 const diagnostic=store.turn(turn.id)?.error as {rootCode:string;history:unknown[]};
 expect(diagnostic.rootCode).toBe('ORIGINAL_FAILURE');expect(diagnostic.history).toHaveLength(8);
});

it('deduplicates scoped host events and rejects content changes under an existing source',()=>{
  const store=fixture();setup(store);setup(store,'other');
  const payload={kind:'memory_changed' as const,memberId:'m',revision:7,commitId:'write-7'};
  const event=store.appendEvent({roomId:'room',sourceId:'write-7',payload});
  expect(store.appendEvent({roomId:'room',sourceId:'write-7',payload:{commitId:'write-7',revision:7,memberId:'m',kind:'memory_changed'}})).toEqual(event);
  expect(()=>store.appendEvent({roomId:'room',sourceId:'write-7',payload:{...payload,revision:8}})).toThrow('different content');
  expect(store.appendEvent({roomId:'other',sourceId:'write-7',payload}).seq).not.toBe(event.seq);
  expect(()=>store.appendEvent({roomId:'room',sourceId:'fake',payload:{kind:'turn_committed',turnId:'fake',receipt:{}}})).toThrow('commitTurn');
});

it('rejects cursors from other rooms and never implicitly represents a newly created receipt',()=>{
  const store=fixture(),a=begin(store);const foreign=begin(store,'other');const foreignSeq=store.latestEventSeq(foreign.roomId);
  expect(()=>store.commitTurn({turnId:a.id,generation:1,actions:[],contextBoundary:foreignSeq})).toThrow('outside the room');
  const committed=store.commitTurn({turnId:a.id,generation:1,actions:[]});expect(store.session('room')?.contextBoundary).toBe(0);
  expect(committed.event.seq).toBeGreaterThan(foreignSeq);
});

it('persists a pending proposal before external work without treating it as a committed action',()=>{
  const path=file();let store=fixture(path);const turn=begin(store);
  const actions={routes:[{action:'reply_direct'}],memoryIntents:[{commitId:'m-1:name',memberId:'owner',revision:1}]};
  store.saveTurnProposal({turnId:turn.id,generation:1,actions});close(store);store=fixture(path);
  expect(store.turn(turn.id)).toMatchObject({state:'pending',actions});expect(store.events('room')).toHaveLength(1);
  expect(store.recoverUncertain()).toHaveLength(1);
  expect(()=>store.saveTurnProposal({turnId:turn.id,generation:1,actions:[]})).toThrow('rebuilt');
});

it('does not publish business changes if a nested callback invalidates the generation state',()=>{
  const store=fixture(),turn=begin(store);store.db.exec('CREATE TABLE business(value TEXT);');
  expect(()=>store.commitTurn({turnId:turn.id,generation:1,actions:[]},()=>{
    store.db.exec("INSERT INTO business VALUES('task')");store.markNeedsRebuild('room','source_invalidated');return {threadId:'t-1'};
  })).toThrow('rebuilt');
  expect(store.db.prepare('SELECT COUNT(*) AS n FROM business').get()?.n).toBe(0);expect(store.turn(turn.id)?.state).toBe('pending');
  expect(store.session('room')).toMatchObject({needsRebuild:false,inflightTurnId:turn.id});
});

it('keeps initial result and later timer triggers distinct while deduplicating each trigger',()=>{
  const store=fixture();setup(store);
  const result=store.beginTurn({roomId:'room',trigger:{kind:'worker_result',key:'result-1'},inputs:[{kind:'result',id:'result-1'}],request:{resultId:'result-1'}});commit(store,result);
  const timerInput:BeginRouterTurn={roomId:'room',trigger:{kind:'timer',key:'result-1:defer-1'},inputs:[{kind:'timer',id:'result-1:defer-1'}],request:{resultId:'result-1'}};
  const timer=store.beginTurn(timerInput);expect(timer.id).not.toBe(result.id);expect(store.beginTurn(timerInput).id).toBe(timer.id);commit(store,timer);
  expect(store.turnForInput('room',{kind:'result',id:'result-1'})?.id).toBe(result.id);
});

it('migrates legacy checkpoint state once while preserving transactions, input ownership and attempts',()=>{
  const store=fixture(),turn=begin(store);store.startAttempt({turnId:turn.id,generation:1});
  store.db.exec("ALTER TABLE router_sessions RENAME COLUMN context_boundary TO represented_through; ALTER TABLE router_sessions ADD COLUMN checkpoint_ref TEXT; ALTER TABLE router_sessions ADD COLUMN candidate TEXT; ALTER TABLE router_sessions ADD COLUMN checkpoint_failure TEXT;");
  store.db.prepare('UPDATE router_sessions SET checkpoint_failure=?').run(JSON.stringify({attempts:46,retryAt:Date.now()+60_000,code:'ROUTER_CHECKPOINT_FAILED'}));
  const migrated=new RouterSessionStore(store.db);
  expect(migrated.session('room')).toMatchObject({needsRebuild:true,rebuildReason:'context_architecture_v2'});
  expect(migrated.turn(turn.id)).toMatchObject({state:'pending',attempts:1});expect(migrated.turnForInput('room',{kind:'message',id:'m-1'})?.id).toBe(turn.id);
  const columns=store.db.prepare('PRAGMA table_info(router_sessions)').all().map(row=>row.name);expect(columns).not.toContain('checkpoint_failure');expect(columns).toContain('context_boundary');
  const before=migrated.session('room');new RouterSessionStore(store.db);expect(migrated.session('room')).toEqual(before);
});
it('persists the total budget through reopen and refuses late commits atomically',()=>{
  const path=file();let store=fixture(path);const turn=begin(store),deadline=Date.now()+60_000;
  store.bindBudget(turn.id,deadline);store.consumeModelCall(turn.id,true);store.consumeRebuild(turn.id);close(store);store=fixture(path);
  expect(store.bindBudget(turn.id,deadline+100_000)).toMatchObject({deadlineAt:deadline,modelCalls:1,summaryCalls:1,rebuilds:1});
  expect(()=>store.consumeRebuild(turn.id)).toThrow('reconstruction budget');store.consumeModelCall(turn.id,true);
  expect(()=>store.consumeModelCall(turn.id,true)).toThrow('model-call budget');
  store.db.prepare('UPDATE router_turns SET deadline_at=? WHERE id=?').run(Date.now()-1,turn.id);
  const apply=vi.fn();expect(()=>store.commitTurn({turnId:turn.id,generation:1,actions:[]},apply)).toThrow('deadline');expect(apply).not.toHaveBeenCalled();
});
it('shares provider outages across rooms and permits only one recovery probe including after reopen',()=>{
  const path=file();let store=fixture(path);store.providerFailed('provider');close(store);store=fixture(path);
  expect(()=>store.admitProvider('provider','turn-a',1000)).toThrow('recovery');
  store.db.prepare('UPDATE router_provider_health SET retry_at=0').run();store.admitProvider('provider','turn-a',1000);
  expect(()=>store.admitProvider('provider','turn-b',1000)).toThrow('recovery');store.providerSucceeded('provider','turn-a',Date.now());
  expect(()=>store.admitProvider('provider','turn-b',1000)).not.toThrow();
});
