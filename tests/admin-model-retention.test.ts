import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { saveModelSettings } from '../src/admin/model-config.js';
import { loadConfig } from '../src/config.js';

const roots:string[]=[];
afterEach(()=>{vi.unstubAllEnvs();for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function fixture(config:unknown,env:string){
  const root=mkdtempSync(join(tmpdir(),'boe-admin-retain-'));roots.push(root);
  writeFileSync(join(root,'config.local.json'),JSON.stringify(config));writeFileSync(join(root,'.env'),env,{mode:0o600});return root;
}
it('preserves the current shared legacy credential when both blank and omitted fields migrate roles',()=>{
  const root=fixture({router:{provider:'boe-openai',model:'legacy-router'},worker:{provider:'boe-openai',model:'legacy-worker'}},
    'OPENAI_API_KEY=synthetic-legacy-key\nROUTER_API_KEY=stale-unused-key\n');
  const response=saveModelSettings(root,{router:{model:'new-router',apiKey:''},worker:{model:'new-worker'}});
  const next=loadConfig(root),env=parseEnv(readFileSync(join(root,'.env'),'utf8'));
  expect(next.routerApiKey).toBe('synthetic-legacy-key');expect(next.workerApiKey).toBe('synthetic-legacy-key');
  expect(env.ROUTER_API_KEY).toBe('synthetic-legacy-key');expect(env.WORKER_API_KEY).toBe('synthetic-legacy-key');
  expect(env.OPENAI_API_KEY).toBe('synthetic-legacy-key');
  expect(next.router.apiKeyEnv).toBe('ROUTER_API_KEY');expect(next.worker.apiKeyEnv).toBe('WORKER_API_KEY');
  expect(JSON.stringify(response)).not.toContain('synthetic-legacy-key');
  expect(readFileSync(join(root,'config.local.json'),'utf8')).not.toContain('synthetic-legacy-key');
  expect(statSync(join(root,'.env')).mode&0o777).toBe(0o600);
});
it('preserves direct custom and provider-level environment credentials before switching to role references',()=>{
  vi.stubEnv('BOE_TEST_INHERITED_PROVIDER_KEY','synthetic-inherited-key');
  const root=fixture({router:{provider:'custom-router',model:'r',apiKeyEnv:'BOE_TEST_CUSTOM_ROUTER_KEY'},
    worker:{provider:'custom-worker',model:'w'},providers:{'custom-worker':{api:'openai-responses',apiKeyEnv:'BOE_TEST_INHERITED_PROVIDER_KEY'}}},
    'BOE_TEST_CUSTOM_ROUTER_KEY=synthetic-custom-key\n');
  const response=saveModelSettings(root,{router:{model:'r2'},worker:{model:'w2',apiKey:''}});
  const next=loadConfig(root);
  expect(next.routerApiKey).toBe('synthetic-custom-key');expect(next.workerApiKey).toBe('synthetic-inherited-key');
  expect(JSON.stringify(response)).not.toContain('synthetic-custom-key');expect(JSON.stringify(response)).not.toContain('synthetic-inherited-key');
});
it('prefers an explicit replacement and does not activate a stale role key when the old reference was empty',()=>{
  const root=fixture({router:{provider:'boe-openai',model:'r'},worker:{provider:'custom-worker',model:'w',apiKeyEnv:'BOE_TEST_EMPTY_KEY'}},
    'OPENAI_API_KEY=synthetic-old-key\nBOE_TEST_EMPTY_KEY=\nWORKER_API_KEY=stale-unrelated-key\n');
  saveModelSettings(root,{router:{apiKey:'synthetic-new-key'},worker:{apiKey:''}});
  const next=loadConfig(root);
  expect(next.routerApiKey).toBe('synthetic-new-key');expect(next.workerApiKey).toBe('');
});
