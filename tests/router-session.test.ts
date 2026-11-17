import { vi } from 'vitest';
vi.mock('../src/runtime/retry-delay.js', () => ({waitForModelRetry: async () => {}}));
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { globSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CONTEXT_WINDOW_EXCEEDED_CODE, LlmAdapter, LlmError, ToolCallId, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { loadConfig, type Config } from '../src/config.js';
import { DshRuntime, routerPayload, routerSessionId } from '../src/dsh-runtime.js';
import { NativeAgentRuntime, type NativeRuntimeOptions } from '../src/runtime/native.js';
import { DEFAULT_BUSINESS_SETTINGS } from '../src/business-config.js';
import { Store } from '../src/store.js';
import { routerClock } from '../src/runtime/router-request.js';
import type { RouterRequest } from '../src/types.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });

function request(roomId: string, id: string, text = id): RouterRequest {
  return { roomId, event: 'messages', currentTime: Date.now(), recentMessages: [], threads: [], messages: [{
    id, platform: 'replay', roomId, messageId: id, authorId: 'owner', authorName: 'Owner', text,
    timestamp: Date.now(), mentions: [], attachments: [], isMentioned: true, isAdmin: false,
  }] };
}
function textOf(call: GenerateOptions) { return JSON.stringify(call.messages); }
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function currentRequest(call: GenerateOptions): RouterRequest {
  for (const message of [...call.messages].reverse()) {
    if (message.role !== 'user') continue;
    const text = message.content.filter(block => block.type === 'text').map(block => block.text).join('');
    try { const data = JSON.parse(text); if (Array.isArray(data.messages)) return data; } catch { /* Repair or summary text. */ }
  }
  throw new Error('No current Router request');
}
function reply(call: GenerateOptions) {
  const current = currentRequest(call);
  return JSON.stringify([{ action: 'reply_direct', sourceMessageIds: current.messages.map(message => message.id), text: `answer:${current.messages[0].id}` }]);
}
class RouterAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = [];
  constructor(private readonly respond: (call: GenerateOptions) => string | Promise<string> = reply) { super(); }
  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return { provider, id: model, name: model, context: { contextWindow: 32_768 } };
  }
  async *stream(call: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(call);
    const text = await this.respond(call);
    call.signal?.throwIfAborted();
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text };
    yield { type: 'block-end', index: 0, block: { type: 'text', text } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}
async function fixture(adapter = new RouterAdapter(), overrides: Partial<Config> = {}, nativeOptions: Partial<NativeRuntimeOptions> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'boe2-router-session-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'personas'));
  await writeFile(join(root, 'personas/default.md'), '# Original persona\nAnswer concisely.');
  const business = structuredClone(DEFAULT_BUSINESS_SETTINGS);business.profiles.default.personaFile='personas/default.md';
  const config = loadConfig(root, { business, stateDir: join(root, 'state'), router: { provider: 'mock', model: 'router' }, ...overrides });
  const nativeRoot = join(root, 'native');
  const native = await NativeAgentRuntime.create({ root: nativeRoot, adapters: { mock: adapter }, compaction: false, ...nativeOptions });
  const runtime = await DshRuntime.create(config, { native });
  cleanup.push(() => runtime.close());
  return { root, config, nativeRoot, native, runtime, adapter };
}

describe('fresh Router sessions through the real dsh runtime', () => {
  it('uses only the supplied snapshot in a fresh session while routing current IDs', async () => {
    const { runtime, adapter } = await fixture();
    const first = request('room', 'first-id', 'Owner budget remains ten dollars.');
    await runtime.route(first);
    const next = request('room', 'second-id', 'Continue with that budget.');
    next.recentMessages = first.messages;
    const result = await runtime.route(next);
    expect(result).toEqual([{ action: 'reply_direct', sourceMessageIds: ['second-id'], text: 'answer:second-id' }]);
    expect(adapter.requests[1].sessionId).not.toBe(adapter.requests[0].sessionId);
    expect(textOf(adapter.requests[1])).toContain('Owner budget remains ten dollars.');
    expect(textOf(adapter.requests[1])).not.toContain('answer:first-id');
    expect(adapter.requests[1].messages.filter(message => message.role === 'user')).toHaveLength(1);
    expect(currentRequest(adapter.requests[1]).recentMessages).toMatchObject([{ id: 'first-id', authorId: 'owner' }]);
    expect(currentRequest(adapter.requests[1]).messages.map(message => message.id)).toEqual(['second-id']);
  });

  it('isolates arbitrary room identities even when their sanitized names would collide', async () => {
    const { runtime, adapter } = await fixture();
    await runtime.route(request('qq:room/one', 'first-id', 'PRIVATE_ROOM_ONE_BUDGET'));
    await runtime.route(request('qq_room_one', 'second-id', 'PRIVATE_ROOM_TWO_BUDGET'));
    expect(adapter.requests[1].sessionId).not.toBe(adapter.requests[0].sessionId);
    expect(textOf(adapter.requests[1])).not.toContain('PRIVATE_ROOM_ONE_BUDGET');
    await runtime.route(request('qq:room/one', 'third-id'));
    expect(textOf(adapter.requests[2])).not.toContain('PRIVATE_ROOM_ONE_BUDGET');
    expect(textOf(adapter.requests[2])).not.toContain('PRIVATE_ROOM_TWO_BUDGET');
    expect(new Set(adapter.requests.map(call => call.sessionId)).size).toBe(3);
  });

  it('does not restore prior room history after closing and recreating the native host', async () => {
    const { runtime, config, nativeRoot, adapter } = await fixture();
    await runtime.route(request('room', 'first-id', 'Remember the original equipment constraint.'));
    await runtime.close();
    const nextAdapter = new RouterAdapter();
    const native = await NativeAgentRuntime.create({ root: nativeRoot, adapters: { mock: nextAdapter }, compaction: false });
    const restored = await DshRuntime.create(config, { native });
    cleanup.push(() => restored.close());
    await restored.route(request('room', 'second-id', 'Continue after restart.'));
    expect(nextAdapter.requests[0].sessionId).not.toBe(adapter.requests[0].sessionId);
    expect(textOf(nextAdapter.requests[0])).not.toContain('Remember the original equipment constraint.');
    expect(textOf(nextAdapter.requests[0])).not.toContain('answer:first-id');
    expect(currentRequest(nextAdapter.requests[0]).messages.map(message => message.id)).toEqual(['second-id']);
  });

  it('uses the newly configured model with a fresh room session', async () => {
    const { runtime, config, nativeRoot, adapter } = await fixture();
    await runtime.route(request('room', 'old-model-input', 'Preserve the original author and budget.'));
    await runtime.close();
    const nextAdapter = new RouterAdapter();
    const native = await NativeAgentRuntime.create({ root: nativeRoot, adapters: { mock: nextAdapter }, compaction: false });
    const restored = await DshRuntime.create({ ...config, router: { provider: 'mock', model: 'replacement-router' } }, { native });
    cleanup.push(() => restored.close());
    await restored.route(request('room', 'new-model-input'));
    expect(nextAdapter.requests[0].model).toBe('replacement-router');
    expect(nextAdapter.requests[0].sessionId).not.toBe(adapter.requests[0].sessionId);
    expect(textOf(nextAdapter.requests[0])).not.toContain('Preserve the original author and budget.');
  });

  it('serializes one room while a different room can finish independently', async () => {
    const entered = deferred(), gate = deferred();
    const adapter = new RouterAdapter(async call => {
      if (currentRequest(call).messages[0].id === 'slow-first') { entered.resolve(); await gate.promise; }
      return reply(call);
    });
    const { runtime } = await fixture(adapter);
    const first = runtime.route(request('same-room', 'slow-first'));
    await entered.promise;
    const second = runtime.route(request('same-room', 'queued-second'));
    try {
      expect(await runtime.route(request('other-room', 'independent'))).toMatchObject([{ text: 'answer:independent' }]);
      expect(adapter.requests.map(call => currentRequest(call).messages[0].id)).toEqual(['slow-first', 'independent']);
    } finally { gate.resolve(); }
    await Promise.all([first, second]);
    const queued = adapter.requests.find(call => currentRequest(call).messages[0].id === 'queued-second')!;
    expect(textOf(queued)).not.toContain('answer:slow-first');
    expect(textOf(queued)).not.toContain('answer:independent');
    expect(new Set(adapter.requests.map(call => call.sessionId)).size).toBe(3);
  });

  it('releases the room after failed output so a queued request can succeed', async () => {
    const adapter = new RouterAdapter(call => currentRequest(call).messages[0].id === 'bad-first' ? '{invalid-json' : reply(call));
    const { runtime } = await fixture(adapter);
    const first = runtime.route(request('room', 'bad-first'));
    const failed = expect(first).rejects.toMatchObject({code:'ROUTER_RECOVERY_FAILED'});
    const second = runtime.route(request('room', 'good-second'));
    await failed;
    expect(await second).toMatchObject([{ sourceMessageIds: ['good-second'], text: 'answer:good-second' }]);
    expect(adapter.requests).toHaveLength(3);
    expect(adapter.requests[0].sessionId).not.toBe(adapter.requests[1].sessionId);
    expect(adapter.requests[2].sessionId).not.toBe(adapter.requests[0].sessionId);
    expect(textOf(adapter.requests[2])).not.toContain('bad-first');
    expect(textOf(adapter.requests[2])).not.toContain('invalid-json');
  });

  it('repairs stale but schema-valid actions against the newest supplied message IDs', async () => {
    let nextTurnCalls = 0;
    const adapter = new RouterAdapter(call => {
      if (currentRequest(call).messages[0].id === 'new-id' && nextTurnCalls++ === 0) {
        return JSON.stringify([{ action: 'reply_direct', sourceMessageIds: ['old-id'], text: 'stale reply' }]);
      }
      return reply(call);
    });
    const { runtime } = await fixture(adapter);
    await runtime.route(request('room', 'old-id'));
    const next = request('room', 'new-id', 'This is the current request.');
    next.currentTime = 123456;
    expect(await runtime.route(next)).toMatchObject([{ sourceMessageIds: ['new-id'], text: 'answer:new-id' }]);
    expect(adapter.requests).toHaveLength(3);
    expect(adapter.requests[1].sessionId).not.toBe(adapter.requests[0].sessionId);
    expect(adapter.requests[2].sessionId).not.toBe(adapter.requests[1].sessionId);
    expect(textOf(adapter.requests[1])).not.toContain('answer:old-id');
    expect(textOf(adapter.requests[2])).toContain('stale reply');
    expect(currentRequest(adapter.requests[2])).toMatchObject({ currentTime: 123456, messages: [{ id: 'new-id', text: 'This is the current request.' }] });
  });

  it('does not load or accept an old thread omitted from the bounded latest snapshot', async () => {
    const adapter = new RouterAdapter(call => currentRequest(call).messages[0].id === 'second-id'
      ? JSON.stringify([{ action: 'append_thread', sourceMessageIds: ['second-id'], threadId: 'old-thread' }])
      : reply(call));
    const { runtime } = await fixture(adapter, { threadCardLimit: 1 });
    const first = request('room', 'first-id');
    first.threads.push({ id: 'old-thread', roomId: 'room', subject: 'Prior comparison', ownerId: 'owner', sourceMessageId: 'first-id', explicit: true,
      participants: ['owner'], status: 'idle', revision: 1, latestInputSeq: 1, sessionId: 'old-worker', epoch: 1, summary: 'Prior answer' });
    await runtime.route(first);
    const next = request('room', 'second-id');
    next.threads = [{ ...first.threads[0], id: 'visible-thread' }, first.threads[0]];
    await expect(runtime.route(next)).rejects.toMatchObject({code:'ROUTER_RECOVERY_FAILED'});
    expect(adapter.requests).toHaveLength(3);
    expect(textOf(adapter.requests[1])).not.toContain('old-thread');
    expect(currentRequest(adapter.requests[2]).threads.map(thread => thread.id)).toEqual(['visible-thread']);
  });

  it('repairs a mixed batch in an independent session with every current ID intact', async () => {
    const batch=request('room','explicit-question','Please summarize the patch.');
    batch.messages.push({...batch.messages[0],id:'chatter',messageId:'chatter',authorId:'other',text:'nice',isMentioned:false});
    batch.recentMessages=[{...batch.messages[1],id:'historical-message',messageId:'historical-message'}];
    let calls=0;
    const adapter=new RouterAdapter(call=>{
      calls++;
      if(calls===1)return JSON.stringify({action:'open_thread',sourceMessageIds:['explicit-question'],subject:'Summarize the patch'});
      const latest=call.messages.filter(m=>m.role==='user').at(-1)!;
      const repaired=JSON.parse(latest.content.filter(b=>b.type==='text').map(b=>b.text).join(''));
      expect(repaired.repair.validationError).toContain('"missing":["chatter"]');
      const {repair,...snapshot}=repaired;
      expect(snapshot).toEqual(JSON.parse(routerPayload({...batch,currentTimeContext:routerClock(batch.currentTime!,config.scheduledTasks!.defaultTimezone!)},config)));
      expect(textOf(call)).not.toContain('<compacted-summary>');
      const snapshots=call.messages.filter(m=>m.role==='user').filter(m=>{
        try{return Array.isArray(JSON.parse(m.content.filter(b=>b.type==='text').map(b=>b.text).join('')).messages);}
        catch{return false;}
      });
      expect(snapshots).toHaveLength(1); // Recovery receives one snapshot, with no earlier model history.
      return JSON.stringify([
        {action:'open_thread',sourceMessageIds:[snapshot.messages[0].id],subject:'Summarize the patch'},
        {action:'silence',sourceMessageIds:[snapshot.messages[1].id]},
      ]);
    });
    const {runtime,config}=await fixture(adapter);
    expect((await runtime.route(batch)).map(a=>a.action)).toEqual(['open_thread','silence']);
    expect(adapter.requests.filter(call=>call.purpose==='compaction')).toHaveLength(0);
    expect(new Set(adapter.requests.map(call=>call.sessionId)).size).toBe(2);
    expect(calls).toBe(2);
  });

  it('returns provider context overflow immediately for compaction or host reconstruction', async () => {
    const adapter = new RouterAdapter(() => { throw new LlmError('provider rejected the context window', CONTEXT_WINDOW_EXCEEDED_CODE); });
    const { runtime } = await fixture(adapter);
    await expect(runtime.route(request('room', 'overflow'))).rejects.toMatchObject({code:CONTEXT_WINDOW_EXCEEDED_CODE,message:expect.stringContaining('context window')});
    expect(adapter.requests).toHaveLength(1);
    expect(adapter.requests[0].purpose).not.toBe('compaction');
  });

  it('returns an invalid result decision immediately for Coordinator publication fallback', async () => {
    const adapter=new RouterAdapter(()=>JSON.stringify({action:'publish_result',resultId:'stale-result'}));
    const {runtime}=await fixture(adapter);
    const input=request('room','unused');input.event='worker_result';input.messages=[];
    input.result={id:'current-result',threadId:'thread',explicit:true,report:{threadId:'thread',runId:'run',
      coveredInputSeq:1,basedOnRevision:1,status:'ready',shortAnswer:'Completed',assumptions:[],evidenceRefs:[],openQuestions:[]}};
    await expect(runtime.route(input)).rejects.toMatchObject({code:'STRUCTURED_OUTPUT_INVALID'});
    expect(adapter.requests).toHaveLength(1);
  });

  it('refreshes the current persona without carrying forward a previous conversation', async () => {
    const { runtime, adapter, config } = await fixture();
    await runtime.route(request('room', 'first-id', 'Remember this shared conversation.'));
    await writeFile(join(config.root, 'personas/default.md'), '# Replacement persona\nUse the refreshed operator style.');
    await runtime.route(request('room', 'second-id'));
    const second = adapter.requests[1];
    const system = JSON.stringify(second.messages.filter(message => message.role === 'system'));
    expect(system).toContain('Replacement persona');
    expect(system).not.toContain('Original persona');
    expect(textOf(second)).not.toContain('Remember this shared conversation.');
    expect(second.sessionId).not.toBe(adapter.requests[0].sessionId);
  });

  it('keeps repeated room requests bounded without accumulating history or invoking compaction', async () => {
    class BoundedAdapter extends RouterAdapter {
      override async resolveModel(provider:string,model:string):Promise<LlmResolvedModelInfo>{
        return {provider,id:model,name:model,context:{contextWindow:65_536}};
      }
    }
    const { runtime, adapter } = await fixture(new BoundedAdapter(), { routerContextChars: 20_000 });
    for (let i = 0; i < 12; i++) await runtime.route(request('room', `message-${i}`, `ORIGINAL_NOTE_${i} ` + 'detailed earlier observation '.repeat(110)));
    expect(adapter.requests).toHaveLength(12);
    expect(new Set(adapter.requests.map(call => call.sessionId)).size).toBe(12);
    expect(adapter.requests.filter(call => call.purpose === 'compaction')).toHaveLength(0);
    for (const [index, call] of adapter.requests.entries()) {
      expect(call.messages.filter(message => message.role === 'user')).toHaveLength(1);
      expect(call.messages.filter(message => message.role === 'assistant')).toHaveLength(0);
      expect(textOf(call)).not.toContain('<compacted-summary>');
      expect(currentRequest(call).messages[0]).toMatchObject({ id: `message-${index}`, authorId: 'owner', text: `ORIGINAL_NOTE_${index} ` + 'detailed earlier observation '.repeat(110) });
    }
    const lengths = adapter.requests.map(call => textOf(call).length);
    expect(Math.max(...lengths) - Math.min(...lengths)).toBeLessThan(100);
  });

  it('leaves an existing persistent room log byte-for-byte intact and never loads it', async () => {
    const { runtime, native, nativeRoot, config, adapter } = await fixture();
    const legacyId = routerSessionId('room');
    const legacy = await native.start({ id: legacyId, model: config.router, cwd: nativeRoot, systemPrompt: 'Legacy Router', resume: 'auto' });
    await legacy.send(routerPayload(request('room', 'legacy-id', 'LEGACY_ONLY_BUDGET_37'), config));
    await legacy.dispose();
    const legacyFiles = globSync(join(nativeRoot, 'sessions', '*', legacyId, 'session.v4.jsonl'));
    expect(legacyFiles).toHaveLength(1);
    const before = await readFile(legacyFiles[0]);
    await runtime.route(request('room', 'fresh-id', 'Use the new host snapshot.'));
    const current = adapter.requests.at(-1)!;
    expect(current.sessionId).not.toBe(legacyId);
    expect(textOf(current)).not.toContain('LEGACY_ONLY_BUDGET_37');
    expect(textOf(current)).not.toContain('answer:legacy-id');
    expect(await readFile(legacyFiles[0])).toEqual(before);
    await runtime.close();
    expect(await readFile(legacyFiles[0])).toEqual(before);
  });

  it('recalls older stored evidence outside the recent snapshot without carrying tool history to the next route', async () => {
    const store = new Store(':memory:');
    cleanup.push(async () => store.close());
    const original = request('room', 'original', '原始预算为37元，仅买键盘。');
    store.ingest(original.messages[0]);
    const recent = Array.from({ length: 20 }, (_, i) => request('room', `filler-${i}`, `Unrelated observation ${i}`).messages[0]);
    for (const message of recent) store.ingest(message);
    const followup = request('room', 'followup', '继续查找之前预算以内的键盘。');
    followup.recentMessages = recent.slice(-16);
    store.ingest(followup.messages[0]);
    class RecallAdapter extends RouterAdapter {
      override async *stream(call: GenerateOptions): AsyncIterable<StreamChunk> {
        this.requests.push(call);
        const id = currentRequest(call).messages[0].id;
        if (id === 'followup' && !call.messages.some(message => message.role === 'tool')) {
          expect(textOf(call)).not.toContain('原始预算为37元');
          expect(call.tools?.map(tool => tool.name)).toEqual(['router_context']);
          yield { type: 'block-start', index: 0, blockType: 'tool-call' };
          yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId('recall-budget'), name: 'router_context', arguments: JSON.stringify({ kind: 'messages', query: '预算', authorId: 'owner' }) } };
          yield { type: 'finish', reason: { kind: 'tool-calls' } };
          return;
        }
        if (id === 'followup') {
          expect(textOf(call)).toContain('原始预算为37元');
          expect(currentRequest(call).messages.map(message => message.id)).toEqual(['followup']);
        }
        const text = id === 'followup'
          ? JSON.stringify([{ action: 'open_thread', sourceMessageIds: ['followup'], subject: '查找37元以内键盘', contextMessageIds: ['original'] }])
          : reply(call);
        yield { type: 'block-start', index: 0, blockType: 'text' };
        yield { type: 'text-delta', index: 0, text };
        yield { type: 'block-end', index: 0, block: { type: 'text', text } };
        yield { type: 'finish', reason: { kind: 'stop' } };
      }
    }
    const adapter = new RecallAdapter();
    const { runtime } = await fixture(adapter);
    await runtime.route(original);
    expect(await runtime.route(followup, store.routerContextReader('room', 'followup'))).toEqual([
      { action: 'open_thread', sourceMessageIds: ['followup'], subject: '查找37元以内键盘', contextMessageIds: ['original'] },
    ]);
    expect(adapter.requests[1].sessionId).not.toBe(adapter.requests[0].sessionId);
    expect(adapter.requests[2].sessionId).toBe(adapter.requests[1].sessionId);
    await runtime.route(request('room', 'next-id', 'An unrelated request.'));
    const next = adapter.requests.at(-1)!;
    expect(next.sessionId).not.toBe(adapter.requests[1].sessionId);
    expect(textOf(next)).not.toContain('原始预算为37元');
    expect(next.messages.filter(message => message.role === 'tool')).toHaveLength(0);
    expect(adapter.requests.filter(call => call.purpose === 'compaction')).toHaveLength(0);
  });

  it('aborts an active route and rejects queued work when the runtime closes', async () => {
    const entered = deferred();
    const adapter = new RouterAdapter(async call => {
      entered.resolve();
      await new Promise<void>((_, reject) => {
        if (call.signal?.aborted) reject(call.signal.reason);
        else call.signal?.addEventListener('abort', () => reject(new Error('request aborted')), { once: true });
      });
      return reply(call);
    });
    const { runtime } = await fixture(adapter);
    const first = runtime.route(request('room', 'active'));
    const firstFailure = expect(first).rejects.toThrow();
    await entered.promise;
    const queued = runtime.route(request('room', 'queued'));
    const queuedFailure = expect(queued).rejects.toThrow(/closed/i);
    await runtime.close();
    await Promise.all([firstFailure, queuedFailure]);
    await expect(runtime.route(request('room', 'after-close'))).rejects.toThrow(/closed/i);
    expect(adapter.requests).toHaveLength(1);
  });
});
