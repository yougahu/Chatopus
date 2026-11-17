import { describe,it,expect } from 'vitest';
import { mkdtempSync,rmSync,writeFileSync,existsSync } from 'node:fs';
import { tmpdir,hostname } from 'node:os';
import { join } from 'node:path';
import { acquireInstanceLock } from '../src/instance-lock.js';
import { evaluateReplay } from '../src/replay.js';
import { loadConfig } from '../src/config.js';
import type { RuntimePort } from '../src/types.js';
describe('operational invariants',()=>{
 it('refuses a second coordinator while preserving its live owner lock',()=>{
  const dir=mkdtempSync(join(tmpdir(),'boe-lock-'));const file=join(dir,'instance.lock');
  try{const release=acquireInstanceLock(file);expect(()=>acquireInstanceLock(file)).toThrow('already owns');expect(existsSync(file)).toBe(true);release();expect(existsSync(file)).toBe(false);}finally{rmSync(dir,{recursive:true,force:true});}
 });
 it('refuses foreign-host or corrupt locks rather than recovering live work',()=>{
  const dir=mkdtempSync(join(tmpdir(),'boe-lock-'));const file=join(dir,'instance.lock');
  try{writeFileSync(file,JSON.stringify({pid:process.pid,host:'different-'+hostname()}));expect(()=>acquireInstanceLock(file)).toThrow('different host');writeFileSync(file,'broken');expect(()=>acquireInstanceLock(file)).toThrow('unreadable');}finally{rmSync(dir,{recursive:true,force:true});}
 });
 it('does not report an empty replay as a passed validation',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'boe-replay-'));let calls=0;
  try{const config=loadConfig(dir);const runtime={route:async()=>{calls++;return[];}} as unknown as RuntimePort;
   await expect(evaluateReplay(config,runtime,{split:'typo'})).rejects.toThrow('split');
   await expect(evaluateReplay(config,runtime,{limit:0})).rejects.toThrow('limit');
   await expect(evaluateReplay(config,runtime,{concurrency:0})).rejects.toThrow('concurrency');expect(calls).toBe(0);
  }finally{rmSync(dir,{recursive:true,force:true});}
 });
});
