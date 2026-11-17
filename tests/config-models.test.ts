import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentSettingsRevision, loadConfig, reloadAgentConfig, safeConfig } from '../src/config.js';
import { DEFAULT_BUSINESS_SETTINGS } from '../src/business-config.js';
import { roleProviderProfile } from '../src/runtime/pool.js';

const directories:string[]=[];
it('validates configured call names and permits mention-only operation',()=>{
  const root=directory();
  expect(loadConfig(root).botCallNames).toContain('机器人');
  disk(root,{botCallNames:[]});expect(loadConfig(root).botCallNames).toEqual([]);
  disk(root,{botCallNames:['小助手']});expect(loadConfig(root).botCallNames).toEqual(['小助手']);
  for(const value of ['Chris',[''],['  '],[' Chris'],[1],Array(33).fill('Chris')]){
    disk(root,{botCallNames:value});expect(()=>loadConfig(root)).toThrow('botCallNames');
  }
});
afterEach(()=>{for(const directory of directories.splice(0))rmSync(directory,{recursive:true,force:true});});
function directory(){const root=mkdtempSync(join(tmpdir(),'boe-config-'));directories.push(root);return root;}
function disk(root:string,value:unknown){writeFileSync(join(root,'config.local.json'),JSON.stringify(value));}

it('does not load obsolete global or room persona settings',()=>{
  const root=directory();
  disk(root,{personaFile:'obsolete-global.md',roomPersonaFiles:{room:'obsolete-room.md'}});
  const initial=loadConfig(root), reloaded=reloadAgentConfig(initial).config;
  for(const config of [initial,reloaded]){
    expect(config).not.toHaveProperty('personaFile');expect(config).not.toHaveProperty('roomPersonaFiles');
    expect(config.business?.profiles.default.personaFile).toBeUndefined();
  }
});

it('uses separate credentials by default and exposes only configured booleans',()=>{
  const root=directory();
  writeFileSync(join(root,'.env'),'ROUTER_API_KEY=router-private-value\nWORKER_API_KEY=worker-private-value\nOPENAI_API_KEY=legacy-private-value\n');
  const config=loadConfig(root);
  expect(config.router.provider).toBe('boe-router');expect(config.worker.provider).toBe('boe-worker');
  expect(config.routerApiKey).toBe('router-private-value');expect(config.workerApiKey).toBe('worker-private-value');
  expect(roleProviderProfile(config,'router').apiKeyEnv).toBe('ROUTER_API_KEY');
  expect(roleProviderProfile(config,'worker').apiKeyEnv).toBe('WORKER_API_KEY');
  const safe=JSON.stringify(safeConfig(config));expect(safe).not.toContain('private-value');
  expect(safeConfig(config)).toMatchObject({routerApiKeyConfigured:true,workerApiKeyConfigured:true});
});

it('keeps OPENAI_API_KEY fallback confined to legacy boe-openai roles',()=>{
  const root=directory();
  writeFileSync(join(root,'.env'),'OPENAI_API_KEY=legacy-only\nROUTER_API_KEY=\nWORKER_API_KEY=\n');
  disk(root,{router:{provider:'boe-openai',model:'old-gpt'},worker:{provider:'boe-worker',model:'new-gpt'}});
  const config=loadConfig(root);
  expect(config.routerApiKey).toBe('legacy-only');expect(config.workerApiKey).toBe('');
  expect(roleProviderProfile(config,'router').apiKeyEnv).toBe('OPENAI_API_KEY');
});

it('resolves explicit provider references without publishing .env secrets to process.env',()=>{
  const root=directory(),routerEnv='BOE_CONFIG_TEST_ROUTER_'+process.pid,workerEnv='BOE_CONFIG_TEST_WORKER_'+process.pid;
  writeFileSync(join(root,'.env'),`${routerEnv}=role-value\n${workerEnv}=profile-value\n`);
  disk(root,{router:{provider:'custom',model:'deepseek-chat',api:'openai-completions',baseUrl:'https://example.invalid/v1',apiKeyEnv:routerEnv,reasoningEffort:'off'},
    worker:{provider:'configured',model:'worker-gpt'},providers:{configured:{api:'openai-responses',apiKeyEnv:workerEnv,models:[{id:'worker-gpt',input:['text']}]}}});
  const config=loadConfig(root);
  expect(config.routerApiKey).toBe('role-value');expect(config.workerApiKey).toBe('profile-value');
  expect(process.env[routerEnv]).toBeUndefined();expect(process.env[workerEnv]).toBeUndefined();
  expect(roleProviderProfile(config,'router')).toMatchObject({api:'openai-completions',models:[{id:'deepseek-chat',input:['text'],reasoningEfforts:false}]});
});

it('reloads only model credentials provider and persona settings while retaining operational limits',()=>{
  const root=directory();mkdirSync(join(root,'personas'));writeFileSync(join(root,'personas/default.md'),'old');
  writeFileSync(join(root,'.env'),'ROUTER_API_KEY=initial-router\nWORKER_API_KEY=initial-worker\n');
  const initial=loadConfig(root,{stateDir:join(root,'fixed-state'),workerTimeoutMs:90000});const previous=agentSettingsRevision(root);
  const business=structuredClone(DEFAULT_BUSINESS_SETTINGS);business.profiles.default.personaFile='personas/new.md';
  disk(root,{router:{provider:'boe-router',model:'changed-router',baseUrl:'https://new.invalid/v1'},worker:{provider:'boe-worker',model:'changed-worker'},
    business,stateDir:'ignore-new-state',workerTimeoutMs:1,routerContextChars:1,concurrency:0,plugins:[{module:'never-import'}]});
  writeFileSync(join(root,'.env'),'ROUTER_API_KEY=changed-router-key\nWORKER_API_KEY=changed-worker-key\n');
  const {config,revision}=reloadAgentConfig(initial);
  expect(revision).not.toBe(previous);expect(config.router.model).toBe('changed-router');expect(config.workerApiKey).toBe('changed-worker-key');
  expect(config.business?.profiles.default.personaFile).toBe('personas/new.md');
  expect(config.stateDir).toBe(initial.stateDir);expect(config.workerTimeoutMs).toBe(90000);expect(config.concurrency).toBe(initial.concurrency);
  expect(config.routerContextChars).toBe(48_000);
  expect(config.skills).toEqual(initial.skills);expect(config.plugins).toEqual(initial.plugins);
  expect(readFileSync(join(root,'.env'),'utf8')).toContain('changed-router-key');
});

it('loads and validates the Router history character budget',()=>{
  const root=directory();disk(root,{routerContextChars:64_000});
  expect(loadConfig(root).routerContextChars).toBe(64_000);
  for(const value of [0,-1,1.5,'48000']){
    disk(root,{routerContextChars:value});
    expect(()=>loadConfig(root)).toThrow('routerContextChars');
  }
});

it('reloads the independent summary budget and rejects invalid settings',()=>{
  const root=directory(),initial=loadConfig(root);
  expect(initial.routerCompaction).toEqual({maxTokens:16384,thresholdRatio:0.8,headroomTokens:65536,retainRatio:0.16});
  const supplied=loadConfig(root,{routerCompaction:{maxTokens:3072,thresholdTokens:96000,contextTokens:128000}});
  expect(reloadAgentConfig(supplied).config.routerCompaction).toEqual(supplied.routerCompaction);
  disk(root,{routerCompaction:{maxTokens:3072}});
  expect(loadConfig(root).routerCompaction).toMatchObject({maxTokens:3072,thresholdRatio:0.8,headroomTokens:65536,retainRatio:0.16});
  expect(reloadAgentConfig(initial).config.routerCompaction).toMatchObject({maxTokens:3072});
  expect(reloadAgentConfig(initial).config.router).toEqual(initial.router);
  disk(root,{});
  expect(reloadAgentConfig(initial).config.routerCompaction).toEqual(initial.routerCompaction);
  disk(root,{routerCompaction:{thresholdTokens:96000,contextTokens:128000}});
  expect(reloadAgentConfig(initial).config.routerCompaction).toMatchObject({thresholdTokens:96000,contextTokens:128000});
  for(const value of [null,[],false,{maxTokens:0},{maxTokens:-1},{maxTokens:1.5},{maxTokens:'4096'},{maxTokens:null},{maxTokens:16385},{unknown:1},
    {thresholdTokens:64000,contextTokens:64000},{thresholdTokens:8000},{contextTokens:0},{contextTokens:1048577},{thresholdTokens:'48000'},{thresholdRatio:0},{thresholdRatio:1},{retainRatio:0.8},{headroomTokens:-1},{headroomTokens:null},{retainRatio:'0.16'}]){
    disk(root,{routerCompaction:value});
    expect(()=>loadConfig(root)).toThrow(/routerCompaction/);
    expect(()=>reloadAgentConfig(initial)).toThrow(/routerCompaction/);
  }
});

it('defaults idle thread retention to six hours and validates overrides',()=>{
  const root=directory();
  expect(loadConfig(root).threadIdleTtlMs).toBe(21_600_000);
  disk(root,{threadIdleTtlMs:1_800_000});expect(loadConfig(root).threadIdleTtlMs).toBe(1_800_000);
  for(const value of [0,-1,1.5,'21600000']){
    disk(root,{threadIdleTtlMs:value});expect(()=>loadConfig(root)).toThrow('threadIdleTtlMs');
  }
});

it('defaults memory extraction to a bounded five-minute batch window and validates overrides',()=>{
  const root=directory();
  expect(loadConfig(root).memory?.ingestBatchWindowMs).toBe(300_000);
  for(const value of [0,120_000,3_600_000]){
    disk(root,{memory:{ingestBatchWindowMs:value}});
    expect(loadConfig(root).memory?.ingestBatchWindowMs).toBe(value);
  }
  for(const value of [-1,1.5,'300000',null,3_600_001]){
    disk(root,{memory:{ingestBatchWindowMs:value}});
    expect(()=>loadConfig(root)).toThrow('ingestBatchWindowMs');
  }
});
