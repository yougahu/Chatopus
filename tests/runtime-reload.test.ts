import { createServer, type ServerResponse } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { DEFAULT_BUSINESS_SETTINGS } from '../src/business-config.js';
import { DshRuntime } from '../src/dsh-runtime.js';
import { SharedMemoryService } from '../src/memory/shared-memory.js';
import type { OpenVikingClient } from '../src/memory/openviking-client.js';
import type { CapabilityConfig as DomainConfig, CapabilityContext as DomainOptions } from '../src/capabilities.js';
import type { GroupMessage, RouterRequest, WorkerRequest } from '../src/types.js';

interface WireRequest { model: string; authorization?: string; url?: string; body: any }
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function response(res: ServerResponse, text: string, sequence: number) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const messageId = `msg_${sequence}`;
  const output = { id: messageId, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] };
  const events = [
    { type: 'response.created', response: { id: `resp_${sequence}`, object: 'response', status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', output_index: 0, item: { ...output, status: 'in_progress', content: [] } },
    { type: 'response.content_part.added', output_index: 0, content_index: 0, item_id: messageId, part: { type: 'output_text', text: '', annotations: [] } },
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, item_id: messageId, delta: text },
    { type: 'response.output_text.done', output_index: 0, content_index: 0, item_id: messageId, text },
    { type: 'response.output_item.done', output_index: 0, item: output },
    { type: 'response.completed', response: { id: `resp_${sequence}`, object: 'response', status: 'completed', output: [output], usage: { input_tokens: 13, output_tokens: 3, total_tokens: 16, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } },
  ];
  for (const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  res.end();
}
function latestPayload(body: any): any {
  for (const item of [...(body.input??body.messages)].reverse()) {
    if (item.role !== 'user') continue;
    const text = typeof item.content === 'string' ? item.content : item.content?.find((part: any) => ['input_text','text'].includes(part.type))?.text;
    if (text) try { return JSON.parse(text); } catch { /* Look for the current structured input. */ }
  }
  throw new Error('Missing structured native user payload');
}
function answerFor(body: any): string {
  const input = latestPayload(body);
  if (input.messages) return JSON.stringify([{ action: 'silence', sourceMessageIds: input.messages.map((m: GroupMessage) => m.id) }]);
  return JSON.stringify({ threadId: input.threadId, runId: input.runId, coveredInputSeq: input.latestInputSeq,
    basedOnRevision: input.revision, status: 'ready', shortAnswer: `answer from ${body.model}`, assumptions: [], evidenceRefs: [], openQuestions: [] });
}
async function endpoint(beforeReply: (request: WireRequest) => Promise<void> = async () => {}) {
  const requests: WireRequest[] = [];
  const server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const entry = { model: body.model, authorization: req.headers.authorization, url: req.url, body };
      requests.push(entry);
      await beforeReply(entry);
      if (!res.destroyed) {
        const text=answerFor(body);
        if(req.url?.endsWith('/chat/completions')){
          res.writeHead(200,{'Content-Type':'text/event-stream'});
          const base={id:'chat-local-'+requests.length,object:'chat.completion.chunk',created:1,model:body.model};
          res.write(`data: ${JSON.stringify({...base,choices:[{index:0,delta:{role:'assistant',content:text},finish_reason:null}]})}\n\n`);
          res.write(`data: ${JSON.stringify({...base,choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15}})}\n\n`);
          res.end('data: [DONE]\n\n');
        }else response(res,text,requests.length);
      }
    } catch (error) { if (!res.destroyed) { res.writeHead(500); res.end(String(error)); } }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing listener');
  cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  return { baseUrl: `http://127.0.0.1:${address.port}/v1`, requests };
}
function user(text = '请查配置说明'): GroupMessage {
  return { id: 'room:m1', platform: 'replay', roomId: 'room', messageId: 'm1', authorId: 'a', authorName: 'A', text,
    timestamp: 0, mentions: [], attachments: [], isMentioned: true, isAdmin: false };
}
function routeRequest(): RouterRequest { return { roomId: 'room', event: 'messages', messages: [user()], recentMessages: [], threads: [] }; }
function workerRequest(root: string, threadId: string, runId = 'run-1', text = 'remember original budget'): WorkerRequest {
  return { runId, workspace: join(root, 'workspaces', threadId, runId),
    thread: { id: threadId, roomId: 'room', subject: 'document', ownerId: 'a', sourceMessageId: 'm1', explicit: true, participants: ['a'], status: 'running', revision: 1, latestInputSeq: 1, sessionId: `worker-${threadId}`, epoch: 1, summary: '' },
    inputs: [{ seq: 1, revision: 1, message: user(text), kind: 'question' }] };
}
async function setup(routerUrl: string, workerUrl: string, beforeDomain:()=>Promise<void>=async()=>{}, withMemory=false) {
  const root = await mkdtemp(join(tmpdir(), 'boe2-runtime-reload-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'personas'));
  await writeFile(join(root, 'personas/default.md'), '# Local test persona\n简洁回答。');
  const snapshot = { router: process.env.ROUTER_API_KEY, worker: process.env.WORKER_API_KEY };
  delete process.env.ROUTER_API_KEY; delete process.env.WORKER_API_KEY;
  cleanup.push(async () => {
    if (snapshot.router === undefined) delete process.env.ROUTER_API_KEY; else process.env.ROUTER_API_KEY = snapshot.router;
    if (snapshot.worker === undefined) delete process.env.WORKER_API_KEY; else process.env.WORKER_API_KEY = snapshot.worker;
  });
  let disk: Record<string, any> = {
    router: { provider: 'boe-router', api: 'openai-responses', baseUrl: routerUrl, apiKeyEnv: 'ROUTER_API_KEY', model: 'router-a', reasoningEffort: 'off' },
    worker: { provider: 'boe-worker', api: 'openai-responses', baseUrl: workerUrl, apiKeyEnv: 'WORKER_API_KEY', model: 'worker-a', reasoningEffort: 'off' },
    stateDir: 'original-state', python: 'original-python',
    routerTimeoutMs: 5000, workerTimeoutMs: 5000,
  };
  async function write(routerKey: string, workerKey: string, change: Record<string, any> = {}) {
    disk = { ...disk, ...change };
    await writeFile(join(root, 'config.local.json'), JSON.stringify(disk));
    await writeFile(join(root, '.env'), `ROUTER_API_KEY=${routerKey}\nWORKER_API_KEY=${workerKey}\n`);
  }
  await write('router-key-a', 'worker-key-a');
  const config = loadConfig(root);
  const sharedMemory=withMemory?new SharedMemoryService({...config,memoryApiKey:'local-test-only',memory:{...config.memory!,enabled:true}},
    {read:async()=>null} as unknown as OpenVikingClient):undefined;
  const domainCalls: Array<{ config: DomainConfig; options: DomainOptions }> = [];
  const runtime = await DshRuntime.create(config, { sharedMemory, capabilityFactory: async (config, options) => {
    domainCalls.push({ config, options });
    await beforeDomain();
    return { tools: [], systemContext: 'Local inert domain', finalizeAnswer: async text => text, close: async () => {} };
  } });
  cleanup.push(() => runtime.close());
  return { root, config, runtime, domainCalls, write, disk: () => disk };
}

it('adds custom instructions by role and removes them on return to the default profile, including a resumed Worker',async()=>{
  const wire=await endpoint();
  const {runtime,root,write}=await setup(wire.baseUrl,wire.baseUrl);
  const business=structuredClone(DEFAULT_BUSINESS_SETTINGS);
  business.profiles.custom={name:'Custom fixture',commonInstructions:'COMMON_SENTINEL',routerInstructions:'ROUTER_SENTINEL',workerInstructions:'WORKER_SENTINEL',skillIds:[],extensionIds:[]};
  const prompts:string[][]=[];
  for(const [index,defaultProfile] of ['default','custom','default'].entries()){
    await write('router-key-a','worker-key-a',{business:{...business,defaultProfile}});
    await runtime.route(routeRequest());
    const task=workerRequest(root,'profile-switch','run-'+index,'Read the supplied document.');task.thread.subject='Document';
    await runtime.runWorker(task);
    prompts.push(wire.requests.slice(-2).map(({body})=>JSON.stringify([
      body.instructions??'',...(body.input??[]).filter((item:any)=>['system','developer'].includes(item.role)),
    ])));
  }
  for(const pair of [prompts[0],prompts[2]])for(const prompt of pair){
    expect(prompt).not.toContain('_SENTINEL');expect(prompt).not.toContain('<operator-business>');
  }
  expect(prompts[1][0]).toContain('COMMON_SENTINEL');expect(prompts[1][0]).toContain('ROUTER_SENTINEL');expect(prompts[1][0]).not.toContain('WORKER_SENTINEL');
  expect(prompts[1][1]).toContain('COMMON_SENTINEL');expect(prompts[1][1]).toContain('WORKER_SENTINEL');expect(prompts[1][1]).not.toContain('ROUTER_SENTINEL');
  expect(prompts[2]).toEqual(prompts[0]);
},15000);

it('removes a cleared business persona from Router and resumed Worker calls after reload',async()=>{
  const wire=await endpoint();
  const {runtime,root,write}=await setup(wire.baseUrl,wire.baseUrl);
  const business=structuredClone(DEFAULT_BUSINESS_SETTINGS), hashes:string[]=[];
  for(const [index,personaFile] of ['personas/default.md',undefined].entries()){
    if(personaFile)business.profiles.default.personaFile=personaFile;
    else { delete business.profiles.default.personaFile; await rm(join(root,'personas/default.md')); }
    await write('router-key-a','worker-key-a',{business});
    hashes.push(runtime.routerConfigurationHash('room'));
    await runtime.route(routeRequest());
    await runtime.runWorker(workerRequest(root,'persona-clear','run-'+index,'Read the supplied document.'));
    for(const {body} of wire.requests.slice(-2)){
      const prompt=JSON.stringify([body.instructions??'',...(body.input??[]).filter((item:any)=>['system','developer'].includes(item.role))]);
      expect(prompt.includes('<operator-persona>')).toBe(Boolean(personaFile));
      expect(prompt.includes('Local test persona')).toBe(Boolean(personaFile));
    }
  }
  expect(hashes[0]).not.toBe(hashes[1]);
},15000);

it('uses independent role keys/models/endpoints through native pi-ai Responses requests', async () => {
  const before=new Set(Object.keys(process.env).filter(name=>name.startsWith('BOE2_ROLE_')));
  const router = await endpoint(), worker = await endpoint();
  const { root, runtime } = await setup(router.baseUrl, worker.baseUrl);
  expect(await runtime.route(routeRequest())).toMatchObject([{ action: 'silence' }]);
  expect((await runtime.runWorker(workerRequest(root, 't1'))).shortAnswer).toBe('answer from worker-a');
  expect(router.requests.map(r => [r.authorization, r.model, r.url])).toEqual([['Bearer router-key-a', 'router-a', '/v1/responses']]);
  expect(worker.requests.map(r => [r.authorization, r.model, r.url])).toEqual([['Bearer worker-key-a', 'worker-a', '/v1/responses']]);
  expect(Object.keys(process.env).filter(name=>name.startsWith('BOE2_ROLE_')&&!before.has(name))).toHaveLength(2);
  await runtime.close();
  expect(Object.keys(process.env).filter(name=>name.startsWith('BOE2_ROLE_')&&!before.has(name))).toEqual([]);
}, 15000);

it('routes a queued room with a fresh snapshot on the reconfigured Router host',async()=>{
  const entered=deferred(),gate=deferred();
  const oldEndpoint=await endpoint(async request=>{if(request.model==='router-a'){entered.resolve();await gate.promise;}});
  const newEndpoint=await endpoint();
  const {runtime,write,disk}=await setup(oldEndpoint.baseUrl,oldEndpoint.baseUrl);
  cleanup.push(async()=>{gate.resolve();});
  const first=runtime.route({...routeRequest(),messages:[user('Remember the shared room constraint from the old model.')]});
  await entered.promise;
  const secondRequest={...routeRequest(),messages:[{...user('Apply the latest room snapshot.'),id:'room:m2',messageId:'m2'}]};
  const queued=runtime.route(secondRequest);
  await write('router-key-b','worker-key-a',{router:{...disk().router,baseUrl:newEndpoint.baseUrl,model:'router-b'}});
  gate.resolve();
  await first;
  expect(await queued).toMatchObject([{action:'silence',sourceMessageIds:['room:m2']}]);
  expect(oldEndpoint.requests).toHaveLength(1);expect(newEndpoint.requests).toHaveLength(1);
  expect(newEndpoint.requests[0]).toMatchObject({model:'router-b',authorization:'Bearer router-key-b'});
  const restored=JSON.stringify(newEndpoint.requests[0].body.input);
  expect(restored).not.toContain('Remember the shared room constraint from the old model.');
  expect(restored).toContain('Apply the latest room snapshot.');
  expect(newEndpoint.requests[0].body.input.filter((item:any)=>item.role==='user')).toHaveLength(1);
  expect(restored).not.toContain('router-key-a');
},15000);

it('hot reloads role credentials while an old Worker keeps its snapshot, blocks duplicate sessions, and preserves domain/runtime state', async () => {
  const oldEntered = deferred(), oldGate = deferred();
  // Last cleanup releases a blocked response even when an assertion fails.
  const oldEndpoint = await endpoint(async request => { if (request.model === 'worker-a') { oldEntered.resolve(); await oldGate.promise; } });
  const newEndpoint = await endpoint(async () => { await delay(30); });
  const fixture = await setup(oldEndpoint.baseUrl, oldEndpoint.baseUrl);
  cleanup.push(async () => { oldGate.resolve(); });
  const { runtime, root, config, write, disk, domainCalls } = fixture;
  const original = workerRequest(root, 'persistent');
  const oldPromise = runtime.runWorker(original);
  await oldEntered.promise;
  const oldCredentialRef=Object.keys(process.env).find(name=>name.startsWith('BOE2_ROLE_')&&process.env[name]==='worker-key-a')!;
  expect(oldCredentialRef).toBeTruthy();
  await expect(runtime.runWorker({ ...original, runId: 'duplicate' })).rejects.toThrow(/active|already|busy/i);
  const alias = workerRequest(root, 'another-thread'); alias.thread.sessionId = original.thread.sessionId;
  await expect(runtime.runWorker(alias)).rejects.toThrow(/active|already|busy/i);
  await write('router-key-b', 'worker-key-b', {
    router: { ...disk().router, baseUrl: newEndpoint.baseUrl, model: 'router-b' },
    worker: { ...disk().worker, baseUrl: newEndpoint.baseUrl, model: 'worker-b' },
    // Only model endpoint configuration is live; these require restart.
    stateDir: 'do-not-switch-state', python: 'do-not-switch-python',
    routerTimeoutMs: 1, workerTimeoutMs: 1, maxWorkerSteps: 1,
  });
  expect(await runtime.route(routeRequest())).toMatchObject([{ action: 'silence' }]);
  const newResult = await runtime.runWorker(workerRequest(root, 'new-thread'));
  expect(newResult.shortAnswer).toBe('answer from worker-b');
  expect(oldEndpoint.requests).toHaveLength(1);
  expect(oldEndpoint.requests[0]).toMatchObject({ model: 'worker-a', authorization: 'Bearer worker-key-a' });
  expect(newEndpoint.requests.map(r => [r.model, r.authorization])).toEqual([
    ['router-b', 'Bearer router-key-b'], ['worker-b', 'Bearer worker-key-b'],
  ]);
  expect(process.env[oldCredentialRef]).toBeDefined();
  oldGate.resolve();
  expect((await oldPromise).shortAnswer).toBe('answer from worker-a');
  expect(process.env[oldCredentialRef]).toBeUndefined();
  const resumed = await runtime.runWorker(workerRequest(root, 'persistent', 'run-2', 'continue with updated conditions'));
  expect(resumed.shortAnswer).toBe('answer from worker-b');
  const resumedRequest = newEndpoint.requests.at(-1)!;
  expect(JSON.stringify(resumedRequest.body.input)).toContain('remember original budget');
  expect(JSON.stringify(resumedRequest.body.input)).toContain('answer from worker-a');
  expect(JSON.stringify(resumedRequest.body.input)).toContain('continue with updated conditions');
  expect(domainCalls.every(call => JSON.stringify(call.config.skills) === JSON.stringify(config.skills) && call.config.python === config.python)).toBe(true);
  await expect(access(join(config.stateDir, 'dsh', 'sessions'))).resolves.toBeUndefined();
  await expect(access(join(root, 'do-not-switch-state', 'dsh'))).rejects.toThrow();
}, 20000);

it('reserves Thread/session IDs during asynchronous setup and releases them after early cancellation',async()=>{
  const entered=deferred(),gate=deferred();let first=true;
  const wire=await endpoint();
  const {runtime,root}=await setup(wire.baseUrl,wire.baseUrl,async()=>{if(first){first=false;entered.resolve();await gate.promise;}});
  cleanup.push(async()=>{gate.resolve();});
  const original=workerRequest(root,'initializing');
  const running=runtime.runWorker(original);
  const outcome=running.then(()=>({ok:true,error:''}),error=>({ok:false,error:String(error)}));
  await entered.promise;
  await expect(runtime.runWorker({...original,runId:'duplicate'})).rejects.toThrow(/active|already|busy/i);
  const alias=workerRequest(root,'alias');alias.thread.sessionId=original.thread.sessionId;
  await expect(runtime.runWorker(alias)).rejects.toThrow(/active|already|busy/i);
  await runtime.cancel(original.thread.id);gate.resolve();
  expect((await outcome).ok).toBe(false);expect(wire.requests).toHaveLength(0);
  expect((await runtime.runWorker({...original,runId:'after-cancel'})).shortAnswer).toBe('answer from worker-a');
},15000);

it('supports a text-only non-reasoning Chat Completions role beside a Responses role',async()=>{
  const wire=await endpoint();const {root,runtime,write,disk}=await setup(wire.baseUrl,wire.baseUrl);
  await write('gpt-route-key','ds-route-key',{worker:{...disk().worker,model:'deepseek-chat',api:'openai-completions',reasoningEffort:'off'}});
  await runtime.route(routeRequest());
  expect((await runtime.runWorker(workerRequest(root,'completions'))).shortAnswer).toBe('answer from deepseek-chat');
  expect(wire.requests.map(r=>[r.url,r.authorization,r.model])).toEqual([
    ['/v1/responses','Bearer gpt-route-key','router-a'],['/v1/chat/completions','Bearer ds-route-key','deepseek-chat'],
  ]);
  expect(wire.requests[1].body).not.toHaveProperty('reasoning_effort');
},15000);

it('keeps business instructions, resources and member field policy fixed across a config save during Worker setup',async()=>{
  const entered=deferred(),gate=deferred();let first=true;
  const wire=await endpoint();
  const {runtime,root,config,write,domainCalls}=await setup(wire.baseUrl,wire.baseUrl,async()=>{
    if(first){first=false;entered.resolve();await gate.promise;}
  },true);
  cleanup.push(async()=>gate.resolve());
  const generic={name:'General',commonInstructions:'',routerInstructions:'',workerInstructions:'',skillIds:[],extensionIds:[],memoryFields:[]};
  const profile=(version:'alpha'|'beta')=>({name:'Documents',commonInstructions:'common-'+version,routerInstructions:'router-'+version,
    workerInstructions:'worker-'+version,skillIds:[version],extensionIds:[version+'-extension'],memoryFields:[version==='alpha'?'teamArea':'caseNumber']});
  const business=(version:'alpha'|'beta')=>({defaultProfile:'general',roomProfiles:{room:'documents'},profiles:{general:generic,documents:profile(version)}});
  for(const id of ['alpha','beta']){
    await mkdir(join(root,id));await writeFile(join(root,id,'SKILL.md'),id+' documentation');
    await writeFile(join(root,id+'.mjs'),'export async function createSession(){return {tools:[],systemContext:"",async close(){}}}');
  }
  await write('router-key-a','worker-key-a',{
    business:business('alpha'),skills:['alpha','beta'].map(id=>({id,path:join(root,id)})),
    extensions:['alpha','beta'].map(id=>({id:id+'-extension',module:join(root,id+'.mjs')})),
    memory:{...config.memory,fields:[{key:'teamArea',label:'Team area',type:'text',maxLength:100},{key:'caseNumber',label:'Case number',type:'text',maxLength:100}]},
  });
  const oldRun=runtime.runWorker(workerRequest(root,'old-business','before-save','Summarize this document.'));
  await entered.promise;
  await write('router-key-a','worker-key-a',{business:business('beta')});
  expect((await runtime.runWorker(workerRequest(root,'new-business','after-save','Summarize this document.'))).status).toBe('ready');
  const other=workerRequest(root,'other-room','other-room-run','Summarize this document.');
  other.thread.roomId='other-room';other.inputs[0].message.roomId='other-room';
  expect((await runtime.runWorker(other)).status).toBe('ready');
  gate.resolve();expect((await oldRun).status).toBe('ready');
  const bodyFor=(thread:string)=>wire.requests.find(request=>latestPayload(request.body).threadId===thread)!.body;
  const oldBody=JSON.stringify(bodyFor('old-business')),newBody=JSON.stringify(bodyFor('new-business')),otherBody=JSON.stringify(bodyFor('other-room'));
  expect(oldBody).toContain('common-alpha');expect(oldBody).toContain('worker-alpha');expect(oldBody).toContain('teamArea');
  expect(oldBody).not.toContain('worker-beta');expect(oldBody).not.toContain('caseNumber');
  expect(newBody).toContain('common-beta');expect(newBody).toContain('worker-beta');expect(newBody).toContain('caseNumber');
  expect(newBody).not.toContain('worker-alpha');expect(newBody).not.toContain('teamArea');
  expect(otherBody).not.toMatch(/common-alpha|common-beta|teamArea|caseNumber/);
  expect(domainCalls.map(call=>call.config.skills.map(skill=>skill.id))).toEqual([['alpha'],['beta'],[]]);
  expect(domainCalls.map(call=>call.config.extensions.map(extension=>extension.id))).toEqual([['alpha-extension'],['beta-extension'],[]]);
},15000);
