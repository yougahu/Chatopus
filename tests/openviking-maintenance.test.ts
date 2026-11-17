import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openVikingPrepareAfter, pauseOpenVikingPreparation } from '../src/memory/openviking-maintenance.js';

const directories:string[]=[];
afterEach(()=>{vi.useRealTimers();for(const directory of directories.splice(0))rmSync(directory,{recursive:true,force:true});});
function fixture(){
  vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-11-08T08:00:00Z'));
  const directory=mkdtempSync(join(tmpdir(),'ov-maintenance-'));directories.push(directory);
  return {directory,path:join(directory,'openviking-model-maintenance.json')};
}

describe('OpenViking preparation maintenance lease',()=>{
  it('publishes a private bounded lease and rejects a second owner until it is released',()=>{
    const {directory,path}=fixture();
    expect(openVikingPrepareAfter(directory)).toBe(0);
    const release=pauseOpenVikingPreparation(directory),deadline=Date.now()+120_000;
    expect(openVikingPrepareAfter(directory)).toBe(deadline);
    expect(statSync(path).mode&0o777).toBe(0o600);
    const original=readFileSync(path,'utf8');
    expect(()=>pauseOpenVikingPreparation(directory)).toThrow('being applied');
    expect(readFileSync(path,'utf8')).toBe(original);
    release();release();
    expect(openVikingPrepareAfter(directory)).toBe(0);expect(existsSync(path)).toBe(false);
  });

  it('recovers automatically after expiry and prevents the old owner from releasing its successor',()=>{
    const {directory,path}=fixture();
    const releaseOld=pauseOpenVikingPreparation(directory),old=readFileSync(path,'utf8'),start=Date.now();
    vi.setSystemTime(start+119_999);expect(openVikingPrepareAfter(directory)).toBe(start+120_000);
    vi.setSystemTime(start+120_000);expect(openVikingPrepareAfter(directory)).toBe(0);
    const releaseNew=pauseOpenVikingPreparation(directory),successor=readFileSync(path,'utf8');
    expect(successor).not.toBe(old);
    releaseOld();expect(readFileSync(path,'utf8')).toBe(successor);
    expect(openVikingPrepareAfter(directory)).toBe(Date.now()+120_000);
    releaseNew();expect(openVikingPrepareAfter(directory)).toBe(0);
  });

  it.each(['broken JSON','null','{}','{"until":"far-future"}'])('does not leave preparation paused by malformed state: %s',value=>{
    const {directory,path}=fixture();writeFileSync(path,value);
    expect(openVikingPrepareAfter(directory)).toBe(0);
    const release=pauseOpenVikingPreparation(directory);
    expect(openVikingPrepareAfter(directory)).toBe(Date.now()+120_000);release();
  });

  it('ignores unbounded future timestamps and replaces the stale lease',()=>{
    const {directory,path}=fixture();writeFileSync(path,JSON.stringify({id:'stale',until:Date.now()+120_001}));
    expect(openVikingPrepareAfter(directory)).toBe(0);
    const release=pauseOpenVikingPreparation(directory);
    expect(JSON.parse(readFileSync(path,'utf8')).id).not.toBe('stale');release();
  });
});
