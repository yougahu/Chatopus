import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { parseEnv } from 'node:util';
import { createHash } from 'node:crypto';
import type { ModelSelection } from './types.js';
import type { PiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai';
import { validateCapabilities, type SkillSpec, type ExtensionSpec } from './capabilities.js';
import { validateBusinessSettings, DEFAULT_BUSINESS_SETTINGS, type BusinessSettings } from './business-config.js';
import { validateMemoryFieldDefinitions, CORE_MEMORY_FIELDS, type MemoryFieldDefinition } from './memory/types.js';
import { validateBrowserConfig, type BrowserConfig } from './tools/public-browser.js';
import type { ScheduleOptions } from './scheduled-tasks/types.js';
import { validateAgentPlugins, type AgentPluginSpec } from './runtime/plugins.js';

export interface SharedMemoryConfig {
  fields?:MemoryFieldDefinition[];
  enabled:boolean;
  provider:'openviking';
  baseUrl:string;
  namespace:string;
  rootKeyEnv:string;
  timeoutMs:number;
  recallBytes:number;
  /** New ingestion starts at enablement; historical samples are imported explicitly. */
  ingestBatchSize:number;
  /** Maximum coalescing wait from the oldest accepted source; 0 disables waiting. */
  ingestBatchWindowMs?:number;
}

export interface Config {
  scheduledTasks?:Omit<ScheduleOptions,'now'|'allowedRoomIds'> & {enabled:boolean;scanIntervalMs?:number;concurrency?:number};
  root: string;
  stateDir: string;
  router: ModelSelection;
  worker: ModelSelection;
  baseUrl: string;
  apiKey: string;
  routerApiKey: string;
  workerApiKey: string;
  providers?:Record<string,PiAiProviderProfile>;
  botCallNames:string[];
  plugins?:AgentPluginSpec[];
  memory?:SharedMemoryConfig;
  memoryApiKey?:string;
  concurrency: number;
  workerTimeoutMs: number;
  routerTimeoutMs: number;
  routerTurnTimeoutMs?:number;
  routerQueueTimeoutMs?:number;
  routerContextChars: number;
  routerSessionMaxBytes:number;
  persistentRouter?:boolean;
  maxWorkerSteps: number;
  recentMessageLimit: number;
  threadCardLimit: number;
  threadIdleTtlMs: number;
  routerBatchWindowMs: number;
  routerBatchSize: number;
  business?: BusinessSettings;
  skills: SkillSpec[];
  extensions: ExtensionSpec[];
  python: string;
  browser?: BrowserConfig;
  qq: { enabled: boolean; selfId: string; accessToken: string; allowedGroupIds: string[]; host: string; port: number; imageCacheRoot?:string };
}
export function validateBusinessReferences(config:Pick<Config,'business'|'skills'|'extensions'|'memory'>):void {
  for(const profile of Object.values(config.business?.profiles??{})){
    for(const id of profile.skillIds)if(!config.skills.some(s=>s.id===id))throw new Error('Unregistered skill: '+id);
    for(const id of profile.extensionIds)if(!config.extensions.some(e=>e.id===id&&e.enabled!==false))throw new Error('Unavailable extension: '+id);
    const fields=[...CORE_MEMORY_FIELDS,...(config.memory?.fields??[])];
    for(const key of profile.memoryFields??[])if(!fields.some(field=>field.key===key))throw new Error('Unregistered member field: '+key);
  }
}
function readSettings(root:string) {
  const envFile=join(root,'.env'),configFile=join(root,'config.local.json');
  const envText=existsSync(envFile)?readFileSync(envFile,'utf8'):'';
  const configText=existsSync(configFile)?readFileSync(configFile,'utf8'):'';
  // The local admin writes .env; its explicit values must replace older inherited values.
  return {env:{...process.env,...parseEnv(envText)},disk:configText?JSON.parse(configText):{},revision:createHash('sha256').update(envText).update('\0').update(configText).digest('hex')};
}
function modelDefaults(role:'router'|'worker',selection:Partial<ModelSelection>={}):ModelSelection {
  return {provider:'boe-'+role,model:'YOUR_MODEL_ID',reasoningEffort:role==='router'?'low':'high',maxTokens:role==='router'?1200:16000,...selection};
}
function roleCredential(config:Pick<Config,'router'|'worker'|'providers'|'apiKey'>,role:'router'|'worker',env:NodeJS.ProcessEnv):string {
  const selection=config[role];
  const ref=selection.apiKeyEnv??config.providers?.[selection.provider]?.apiKeyEnv??(selection.provider==='boe-openai'?'OPENAI_API_KEY':role.toUpperCase()+'_API_KEY');
  return env[ref]??(selection.provider==='boe-openai'&&ref==='OPENAI_API_KEY'?config.apiKey:'');
}
function validateModels(config:Pick<Config,'router'|'worker'>) {
  for(const role of ['router','worker'] as const){
    const selection=config[role];
    for(const key of ['provider','model'] as const)if(typeof selection[key]!=='string'||!selection[key].trim())throw new Error(`Invalid ${role} ${key}`);
    if(selection.apiKeyEnv!==undefined&&!/^[A-Za-z_][A-Za-z0-9_]*$/.test(selection.apiKeyEnv))throw new Error(`Invalid ${role} API key environment reference`);
    if(selection.baseUrl!==undefined){const url=new URL(selection.baseUrl);if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw new Error(`Invalid ${role} API base URL`);}
  }
}
/** Hash only: callers never receive private file contents. */
export function agentSettingsRevision(root:string):string{return readSettings(root).revision;}
/** Agent, business and capability configuration reloads for new calls; transport and storage stay fixed. */
export function reloadAgentConfig(initial:Config):{config:Config;revision:string} {
  const {disk,env,revision}=readSettings(initial.root);
  const localPath=(value:string)=>value.startsWith('~/')?join(homedir(),value.slice(2)):resolve(initial.root,value);
  const config:Config={...initial,
    router:modelDefaults('router',disk.router??initial.router),worker:modelDefaults('worker',disk.worker??initial.worker),
    providers:disk.providers??initial.providers,
    business:disk.business??initial.business,
    skills:disk.skills===undefined?initial.skills:disk.skills.map((s:SkillSpec)=>({...s,path:localPath(s.path)})),
    extensions:disk.extensions??initial.extensions,
    memory:initial.memory?{...initial.memory,fields:disk.memory?.fields??initial.memory.fields}:undefined,
    baseUrl:env.OPENAI_BASE_URL??disk.baseUrl??initial.baseUrl,apiKey:env.OPENAI_API_KEY??initial.apiKey,
  };
  config.routerApiKey=roleCredential(config,'router',env);config.workerApiKey=roleCredential(config,'worker',env);
  validateBusinessSettings(config.business??DEFAULT_BUSINESS_SETTINGS);
  validateCapabilities(config.skills,config.extensions);validateMemoryFieldDefinitions(config.memory?.fields??[]);
  validateBusinessReferences(config);validateModels(config);return {config,revision};
}
export function loadConfig(root = process.cwd(), overrides: Partial<Config> = {}): Config {
  root = resolve(root);
  const localPath=(value:string)=>value.startsWith('~/')?join(homedir(),value.slice(2)):resolve(root,value);
  const {env,disk}=readSettings(root);
  const config: Config = {
    root, stateDir: localPath(disk.stateDir ?? '.runtime'),
    router: modelDefaults('router',disk.router),
    worker: modelDefaults('worker',disk.worker),
    baseUrl: env.OPENAI_BASE_URL ?? disk.baseUrl ?? 'https://api.openai.com/v1',
    apiKey: env.OPENAI_API_KEY ?? '',
    routerApiKey:'',workerApiKey:'',
    providers: disk.providers,
    botCallNames: disk.botCallNames ?? ['机器人'],
    plugins: disk.plugins ?? [],
    scheduledTasks:{enabled:false,defaultTimezone:'Asia/Shanghai',minIntervalMs:3_600_000,scanIntervalMs:1000,concurrency:1,
      maxPerOwner:20,maxPerRoom:100,maxSchedules:1000,failureThreshold:3,catchUpWindowMs:86_400_000,timeoutMs:3_600_000,
      commandTtlMs:300_000,roleMaxAgeMs:300_000,...disk.scheduledTasks},
    memory: {
      enabled:false,provider:'openviking',baseUrl:'http://127.0.0.1:1933',namespace:'brain-of-exile-2',
      rootKeyEnv:'OPENVIKING_ROOT_API_KEY',timeoutMs:15_000,recallBytes:6000,ingestBatchSize:32,ingestBatchWindowMs:300_000,
      ...disk.memory,
    },
    concurrency: disk.concurrency ?? 5,
    workerTimeoutMs: disk.workerTimeoutMs ?? 3_600_000,
    routerTimeoutMs: disk.routerTimeoutMs ?? 30_000,
    routerTurnTimeoutMs: disk.routerTurnTimeoutMs ?? 120_000,
    routerQueueTimeoutMs: disk.routerQueueTimeoutMs ?? 180_000,
    routerContextChars: disk.routerContextChars ?? 48_000,
    routerSessionMaxBytes: disk.routerSessionMaxBytes ?? 4_000_000,
    persistentRouter: disk.persistentRouter ?? false,
    maxWorkerSteps: disk.maxWorkerSteps ?? 96,
    recentMessageLimit: disk.recentMessageLimit ?? 16,
    threadCardLimit: disk.threadCardLimit ?? 12,
    threadIdleTtlMs: disk.threadIdleTtlMs ?? 6 * 60 * 60 * 1000,
    routerBatchWindowMs: disk.routerBatchWindowMs ?? 150,
    routerBatchSize: disk.routerBatchSize ?? 8,
    business: disk.business ?? structuredClone(DEFAULT_BUSINESS_SETTINGS),
    skills: (disk.skills??[]).map((skill:SkillSpec)=>({...skill,path:localPath(skill.path)})),
    extensions: disk.extensions ?? [],
    python: disk.python ?? 'python3',
    browser: disk.browser,
    qq: { enabled: disk.qq?.enabled ?? false, selfId: env.QQ_SELF_ID ?? disk.qq?.selfId ?? '',
      accessToken: env.ONEBOT_ACCESS_TOKEN ?? '', allowedGroupIds: disk.qq?.allowedGroupIds ?? [],
      imageCacheRoot:(env.QQ_IMAGE_CACHE_ROOT||disk.qq?.imageCacheRoot)?localPath(env.QQ_IMAGE_CACHE_ROOT||disk.qq.imageCacheRoot):undefined,
      host: '127.0.0.1', port: disk.qq?.port ?? 8083 },
    ...overrides,
  };
  config.routerApiKey=overrides.routerApiKey??roleCredential(config,'router',env);
  if(config.scheduledTasks){
    const tasks=config.scheduledTasks;
    if(typeof tasks.enabled!=='boolean')throw new Error('Invalid scheduledTasks.enabled');
    for(const key of ['minIntervalMs','scanIntervalMs','concurrency','maxPerOwner','maxPerRoom','maxSchedules','failureThreshold','catchUpWindowMs','timeoutMs','commandTtlMs','roleMaxAgeMs'] as const)
      if(tasks[key]!==undefined&&(!Number.isSafeInteger(tasks[key])||tasks[key]!<1))throw new Error('Invalid scheduledTasks.'+key);
    if((tasks.minIntervalMs??3_600_000)<3_600_000)throw new Error('Periodic tasks require at least one hour between executions');
    if((tasks.roleMaxAgeMs??300_000)>300_000)throw new Error('Task role verification must expire within five minutes');
    try{new Intl.DateTimeFormat('en',{timeZone:tasks.defaultTimezone??'Asia/Shanghai'});}catch{throw new Error('Invalid scheduledTasks.defaultTimezone');}
  }
  config.workerApiKey=overrides.workerApiKey??roleCredential(config,'worker',env);
  if(config.memory){
    const memory=config.memory;
    if(memory.provider!=='openviking'||typeof memory.enabled!=='boolean'||!memory.namespace||memory.namespace.length>120)
      throw new Error('Invalid shared memory configuration');
    if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(memory.rootKeyEnv))throw new Error('Invalid memory key environment reference');
    const url=new URL(memory.baseUrl);
    if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)throw new Error('Invalid memory endpoint');
    for(const key of ['timeoutMs','recallBytes','ingestBatchSize'] as const)
      if(!Number.isSafeInteger(memory[key])||memory[key]<1)throw new Error('Invalid memory '+key);
    if(memory.ingestBatchSize>100||memory.recallBytes<4||memory.recallBytes>32_000||memory.timeoutMs>120_000)throw new Error('Shared memory bounds exceeded');
    if(memory.ingestBatchWindowMs!==undefined&&(!Number.isSafeInteger(memory.ingestBatchWindowMs)||memory.ingestBatchWindowMs<0||memory.ingestBatchWindowMs>3_600_000))
      throw new Error('Invalid memory ingestBatchWindowMs');
    config.memoryApiKey=overrides.memoryApiKey??env[memory.rootKeyEnv]??'';
    if(memory.enabled&&!config.memoryApiKey)throw new Error('OpenViking root API key is not configured');
  }
  validateBusinessSettings(config.business??DEFAULT_BUSINESS_SETTINGS);
  validateCapabilities(config.skills,config.extensions);
  validateMemoryFieldDefinitions(config.memory?.fields??[]);
  validateBusinessReferences(config);validateModels(config);
  for(const key of ['routerTurnTimeoutMs','routerQueueTimeoutMs'] as const)if(!Number.isSafeInteger(config[key])||config[key]!<=0)throw new Error(`Invalid ${key}`);
  if(typeof config.persistentRouter!=='boolean')throw new Error('Invalid persistentRouter');
  if(!Array.isArray(config.botCallNames)||config.botCallNames.length>32||config.botCallNames.some(name=>typeof name!=='string'||!name.trim()||name!==name.trim()||name.length>80))throw new Error('Invalid botCallNames');
  for (const key of ['concurrency','workerTimeoutMs','routerTimeoutMs','routerContextChars','routerSessionMaxBytes','maxWorkerSteps','recentMessageLimit','threadCardLimit','threadIdleTtlMs','routerBatchSize'] as const) {
    if (!Number.isInteger(config[key]) || config[key] <= 0) throw new Error(`Invalid positive integer: ${key}`);
  }
  if(!Number.isInteger(config.routerBatchWindowMs)||config.routerBatchWindowMs<0)throw new Error('Invalid batch window');
  if(config.routerBatchSize>20)throw new Error('routerBatchSize must be at most 20');
  validateAgentPlugins(config.plugins??[]);
  if(config.browser)validateBrowserConfig(config.browser);
  mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
  return config;
}
export function safeConfig(config: Config) {
  const {apiKey,routerApiKey,workerApiKey,memoryApiKey,qq,browser,providers,plugins,extensions,...rest}=config;
  return {...rest,memoryApiKeyConfigured:!!memoryApiKey,plugins:plugins?.map(p=>({module:p.module,scope:p.scope,enabled:p.enabled!==false})),
    extensions:extensions.map(e=>({id:e.id,module:e.module,version:e.version,enabled:e.enabled!==false})),
    browser:browser?{command:browser.command,args:browser.args,networkIsolation:browser.networkIsolation??'managed',envKeys:Object.keys(browser.env??{})}:undefined,
    apiKeyConfigured:!!apiKey,routerApiKeyConfigured:!!routerApiKey,workerApiKeyConfigured:!!workerApiKey,
    providers:Object.fromEntries(Object.entries(providers??{}).map(([name,p])=>[name,{api:p.api,baseURL:p.baseURL,models:p.models?.map(m=>m.id),apiKeyEnv:p.apiKeyEnv}])),
    qq:{...qq,accessToken:qq.accessToken?'[configured]':''}};
}
