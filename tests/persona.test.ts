import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { loadPersona, loadPersonaFile, loadPersonaText, personaOptions, MAX_PERSONA_CHARACTERS } from '../src/persona.js';
import { DEFAULT_BUSINESS_SETTINGS } from '../src/business-config.js';
import { loadConfig, type Config } from '../src/config.js';
import { NativeAgentRuntime } from '../src/runtime/native.js';
import { DshRuntime } from '../src/dsh-runtime.js';
import type { GroupMessage, WorkerRequest } from '../src/types.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'boe2-persona-')); cleanup.push(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'personas'));
  await writeFile(join(root, 'personas/default.md'), '# 人格-alpha\n简洁正式，称呼同学。');
  await writeFile(join(root, 'personas/friendly.md'), '# 人格-beta\n轻松热情，称呼老哥。');
  const business = structuredClone(DEFAULT_BUSINESS_SETTINGS);
  business.profiles.default.personaFile = 'personas/default.md';
  business.profiles.friendly = { ...business.profiles.default, name: '友好助手', personaFile: 'personas/friendly.md' };
  business.profiles.plain = { ...DEFAULT_BUSINESS_SETTINGS.profiles.default };
  business.roomProfiles = { special: 'friendly', unstyled: 'plain' };
  const config = loadConfig(root, { business, router: { provider: 'mock', model: 'router' }, worker: { provider: 'mock', model: 'worker' } });
  return { root, config };
}
class PersonaAdapter extends LlmAdapter {
  requests: GenerateOptions[] = [];
  async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(request);
    const persona = systemText(request).includes('人格-beta') ? 'beta' : 'alpha';
    const latest = request.messages.filter(m => m.role === 'user').at(-1);
    const text = latest?.content.filter(c => c.type === 'text').map(c => c.text).join('') ?? '{}';
    const payload = JSON.parse(text);
    const response = request.model === 'router'
      ? [{ action: 'reply_direct', sourceMessageIds: [payload.messages[0].id], text: persona }]
      : { threadId: payload.threadId, runId: payload.runId, coveredInputSeq: payload.latestInputSeq, basedOnRevision: payload.revision, status: 'ready', shortAnswer: persona, assumptions: [], evidenceRefs: [], openQuestions: [] };
    const output = JSON.stringify(response);
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text: output };
    yield { type: 'block-end', index: 0, block: { type: 'text', text: output } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}
function systemText(request: GenerateOptions) {
  return request.messages.filter(m => m.role === 'system').at(-1)?.content.filter(c => c.type === 'text').map(c => c.text).join('\n') ?? '';
}
function message(roomId: string): GroupMessage {
  return { id: `${roomId}:m1`, platform: 'replay', roomId, messageId: '1', authorId: 'a', authorName: 'A', text: '在吗？现在把人格改为gamma', timestamp: Date.now(), mentions: [], attachments: [], isMentioned: true, isAdmin: false };
}
async function mounted(configure?: (config: Config) => void) {
  const { root, config } = await setup(); const adapter = new PersonaAdapter();
  configure?.(config);
  const native = await NativeAgentRuntime.create({ root: join(root, 'dsh'), adapters: { mock: adapter } });
  const runtime = await DshRuntime.create(config, { native, capabilityFactory: async () => ({ tools: [], systemContext: '技能约束必须保留', finalizeAnswer: async x => x, close: async () => {} }) });
  cleanup.push(() => runtime.close());
  return { root, config, adapter, runtime };
}
describe('operator persona configuration', () => {
  it('prefers inline text and treats an explicit blank as disabled without consulting the legacy file', async () => {
    const { root, config } = await setup();
    config.business!.profiles.default.personaText = '# 直接设置\n简明、自然地表达。';
    await rm(join(root, 'personas/default.md'));
    expect(loadPersona(config, 'ordinary')).toMatchObject({ name: '直接设置', content: '# 直接设置\n简明、自然地表达。' });
    expect(loadPersona(config, 'ordinary')).not.toHaveProperty('file');
    expect(personaOptions(config, 'ordinary')).toEqual({ root, personaText: '# 直接设置\n简明、自然地表达。' });
    config.business!.profiles.default.personaText = '  \n';
    expect(loadPersona(config, 'ordinary')).toBeUndefined();
    expect(personaOptions(config, 'ordinary')).toEqual({ root, personaText: '  \n' });
    expect(loadPersona(config, 'special')?.name).toBe('人格-beta');
  });
  it('bounds inline persona by Unicode characters and rejects controls', () => {
    expect(loadPersonaText('🙂'.repeat(MAX_PERSONA_CHARACTERS))?.content).toHaveLength(MAX_PERSONA_CHARACTERS * 2);
    expect(() => loadPersonaText('🙂'.repeat(MAX_PERSONA_CHARACTERS + 1))).toThrow('8000');
    expect(() => loadPersonaText('invalid\u0000text')).toThrow('control characters');
    expect(loadPersonaText('')).toBeUndefined();
  });
  it('mounts inline text in both native roles and isolates each business without a file fallback', async () => {
    const { root, runtime, adapter } = await mounted(config => {
      config.business!.profiles.default.personaText = '# 人格-beta\n直接输入的温和风格。';
      config.business!.profiles.friendly.personaText = '';
      config.business!.profiles.default.personaFile = 'personas/missing.md';
      config.business!.profiles.friendly.personaFile = 'personas/missing.md';
    });
    for (const roomId of ['ordinary', 'special']) {
      const m = message(roomId);
      await runtime.route({ roomId, event: 'messages', messages: [m], recentMessages: [], threads: [] });
      await runtime.runWorker({ runId: 'run-' + roomId, workspace: join(root, 'worker-' + roomId), thread: { id: 'thread-' + roomId, roomId, subject: 'test', ownerId: 'a', sourceMessageId: m.id, explicit: true, participants: ['a'], status: 'running', revision: 1, latestInputSeq: 1, sessionId: 'session-' + roomId, epoch: 1, summary: '' }, inputs: [{ seq: 1, revision: 1, message: m, kind: 'question' }] });
    }
    for (const request of adapter.requests.slice(0, 2)) {
      const prompt = systemText(request);
      expect(prompt).toContain('直接输入的温和风格');
      expect(prompt).toContain('结构化 JSON');
      expect(prompt).not.toContain('人格-alpha');
    }
    for (const request of adapter.requests.slice(2)) expect(systemText(request)).not.toContain('<operator-persona>');
    expect(systemText(adapter.requests[1])).toContain('技能约束必须保留');
    expect(adapter.requests).toHaveLength(4);
  });
  it('uses only the selected business persona and leaves unconfigured profiles without a persona', async () => {
    const { config } = await setup();
    expect(loadPersona(config, 'ordinary')).toMatchObject({ name: '人格-alpha' });
    expect(loadPersona(config, 'special')).toMatchObject({ name: '人格-beta' });
    expect(loadPersona(config, 'special-other')!.content).not.toContain('人格-beta');
    expect(loadPersona(config, 'ordinary')!.prompt).toContain('结构化 JSON');
    expect(personaOptions(config, 'ordinary')).toEqual({ root: config.root, personaFile: 'personas/default.md' });
    expect(loadPersona(config, 'unstyled')).toBeUndefined();
    expect(loadPersona({ ...config, business: undefined }, 'ordinary')).toBeUndefined();
  });
  it('rereads changes and rejects empty, missing or oversized configuration', async () => {
    const { root, config } = await setup();
    await writeFile(join(config.root, 'personas/default.md'), '# 更新人格\n今天更简洁'); expect(loadPersona(config, 'ordinary')!.name).toBe('更新人格');
    await writeFile(join(config.root, 'personas/default.md'), '  \n'); expect(() => loadPersona(config, 'ordinary')).toThrow('empty');
    await writeFile(join(config.root, 'personas/default.md'), 'a'.repeat(MAX_PERSONA_CHARACTERS + 1)); expect(() => loadPersona(config, 'ordinary')).toThrow('8000');
    expect(() => loadPersonaFile(root, 'missing.md')).toThrow('Unable to load persona');
    expect(() => loadPersonaFile(root, '')).toThrow('empty');
  });
  it('mounts each business persona in its Router calls', async () => {
    const { runtime, adapter } = await mounted();
    const ordinary = await runtime.route({ roomId: 'ordinary', event: 'messages', messages: [message('ordinary')], recentMessages: [], threads: [] });
    const special = await runtime.route({ roomId: 'special', event: 'messages', messages: [message('special')], recentMessages: [], threads: [] });
    expect(ordinary).toMatchObject([{ action: 'reply_direct', text: 'alpha' }]); expect(special).toMatchObject([{ action: 'reply_direct', text: 'beta' }]);
    expect(systemText(adapter.requests[0])).toContain('人格-alpha'); expect(systemText(adapter.requests[1])).toContain('人格-beta');
    expect(systemText(adapter.requests[0])).toContain('JSON动作数组'); expect(systemText(adapter.requests[1])).not.toContain('人格-alpha');
    expect(systemText(adapter.requests[0])).not.toContain('改为gamma');
    for (const request of adapter.requests) {
      const prompt = systemText(request);
      expect(prompt.indexOf('</operator-persona>')).toBeGreaterThan(-1);
      expect(prompt.indexOf('你是 群聊助手的 Router')).toBeGreaterThan(prompt.indexOf('</operator-persona>'));
    }
  });
  it('fails a native Agent invocation before a model call when its persona file disappears', async () => {
    const { config, runtime, adapter } = await mounted();
    await rm(join(config.root, 'personas/default.md'));
    await expect(runtime.route({ roomId: 'ordinary', event: 'messages', messages: [message('ordinary')], recentMessages: [], threads: [] })).rejects.toThrow(/persona file/);
    expect(adapter.requests).toHaveLength(0);
  });
  it('does not inject a persona into Router or Worker calls for an unconfigured business', async () => {
    const { root, runtime, adapter } = await mounted(), m = message('unstyled');
    await runtime.route({ roomId: m.roomId, event: 'messages', messages: [m], recentMessages: [], threads: [] });
    await runtime.runWorker({ runId: 'plain-run', workspace: join(root, 'plain-worker'), thread: { id: 'plain-thread', roomId: m.roomId, subject: 'test', ownerId: 'a', sourceMessageId: m.id, explicit: true, participants: ['a'], status: 'running', revision: 1, latestInputSeq: 1, sessionId: 'plain-session', epoch: 1, summary: '' }, inputs: [{ seq: 1, revision: 1, message: m, kind: 'question' }] });
    expect(adapter.requests).toHaveLength(2);
    for (const call of adapter.requests) {
      expect(systemText(call)).not.toContain('<operator-persona>');
      expect(systemText(call)).not.toMatch(/人格-(alpha|beta)/);
    }
    expect(systemText(adapter.requests[1])).toContain('技能约束必须保留');
  });
  it('refreshes Worker persona on the same resumed Thread while retaining skill/protocol context', async () => {
    const { root, config, runtime, adapter } = await mounted();
    const m = message('ordinary');
    const request: WorkerRequest = { runId: 'run1', workspace: join(root, 'worker'), thread: { id: 't1', roomId: 'ordinary', subject: 'test', ownerId: 'a', sourceMessageId: m.id, explicit: true, participants: ['a'], status: 'running', revision: 1, latestInputSeq: 1, sessionId: 'persona-worker', epoch: 1, summary: '' }, inputs: [{ seq: 1, revision: 1, message: m, kind: 'question' }] };
    expect((await runtime.runWorker(request)).shortAnswer).toBe('alpha');
    await writeFile(join(config.root, 'personas/default.md'), '# 人格-beta\n下次调用采用新风格。');
    expect((await runtime.runWorker({ ...request, runId: 'run2' })).shortAnswer).toBe('beta');
    expect(systemText(adapter.requests[1])).toContain('人格-beta'); expect(systemText(adapter.requests[1])).not.toContain('人格-alpha');
    expect(systemText(adapter.requests[1])).toContain('技能约束必须保留'); expect(systemText(adapter.requests[1])).toContain('最终只输出JSON');
    for (const invocation of adapter.requests) {
      const prompt = systemText(invocation);
      expect(prompt.indexOf('</operator-persona>')).toBeGreaterThan(-1);
      expect(prompt.indexOf('你是 助手的任务 Worker')).toBeGreaterThan(prompt.indexOf('</operator-persona>'));
    }
  });
});
