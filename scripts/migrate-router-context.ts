import { backup, DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, chmodSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { acquireInstanceLock } from '../src/instance-lock.js';
import { RouterSessionStore } from '../src/router-session-store.js';

// Explicit state directory only. Uses the serving process's exclusive lock; no live migration.
const directory=process.argv[2];
if(!directory)throw new Error('Usage: npx tsx scripts/migrate-router-context.ts /absolute/state/directory');
const root=resolve(directory);
if(!existsSync(join(root,'state.sqlite')))throw new Error('State database does not exist; verify the explicit state directory');
const release=acquireInstanceLock(join(root,'instance.lock'));
let db:DatabaseSync|undefined;
try{
  db=new DatabaseSync(join(root,'state.sqlite'));db.exec('PRAGMA busy_timeout=5000');
  const destination=join(root,'backups','router-context-v2-'+Date.now()+'-'+randomUUID());mkdirSync(destination,{recursive:true,mode:0o700});
  const snapshot=join(destination,'state.sqlite');await backup(db,snapshot);chmodSync(snapshot,0o600);
  const tables=['messages','threads','inputs','results','outbox','router_turns','router_events'];
  const counts=()=>Object.fromEntries(tables.map(table=>[table,Number(db!.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n)]));
  const before=counts();new RouterSessionStore(db);const after=counts();
  const integrityCheck=db.prepare('PRAGMA integrity_check').get()?.integrity_check;
  if(JSON.stringify(before)!==JSON.stringify(after)||integrityCheck!=='ok')throw new Error('Migration invariant failed; keep service stopped and inspect backup');
  const report={version:2,completedAt:new Date().toISOString(),backup:snapshot,before,after,integrityCheck,
    sessions:db.prepare('SELECT room,generation,needs_rebuild,rebuild_reason FROM router_sessions').all(),
    pendingTurns:db.prepare("SELECT id,room,attempts,deadline_at FROM router_turns WHERE state='pending'").all()};
  writeFileSync(join(destination,'migration.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});
  console.log(JSON.stringify({status:'migrated',backup:snapshot,report:join(destination,'migration.json')}));
}finally{db?.close();release();}
