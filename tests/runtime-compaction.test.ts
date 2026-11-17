import { vi } from 'vitest';
vi.mock('../src/runtime/retry-delay.js', () => ({waitForModelRetry: async () => {}}));
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CONTEXT_WINDOW_EXCEEDED_CODE, LlmAdapter, LlmError, ToolCallId,
  type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk,
} from '@deepseek-ai/dsh-llm';
import type { BasicCompactionConfig } from '@deepseek-ai/dsh-compaction-basic';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import { NativeAgentRuntime, type NativeRuntimeOptions } from '../src/runtime/native.js';

const model = { provider: 'mock', model: 'bounded-model' };
const summary = 'Verified source: official Node.js documentation. Budget remains 10 dollars; compare the document without changing its requirements.';
const compact: BasicCompactionConfig = {
  thresholdRatio: 0.5, headroomTokens: 512, maxTokens: 512, retainTokens: 1,
};

function textResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ];
}
function toolResponse(): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId('read-page'), name: 'resource_page', arguments: '{}' } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ];
}
class CompactionAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = [];
  private mainCalls = 0;
  constructor(
    private readonly window: number,
    private readonly main: (request: GenerateOptions, index: number) => StreamChunk[],
    private readonly summarize: (request: GenerateOptions) => StreamChunk[] | Promise<StreamChunk[]> = () => [
      ...textResponse(summary).slice(0, -1),
      { type: 'usage', usage: { inputTokens: 17, outputTokens: 3 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ],
  ) { super(); }
  override async resolveModel(provider: string, name: string): Promise<LlmResolvedModelInfo> {
    return { provider, id: name, name, context: { contextWindow: this.window } };
  }
  async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(request);
    const chunks = request.purpose === 'compaction'
      ? await this.summarize(request) : this.main(request, this.mainCalls++);
    for (const chunk of chunks) { request.signal?.throwIfAborted(); yield chunk; }
  }
  get summaries() { return this.requests.filter(request => request.purpose === 'compaction'); }
  get mainRequests() { return this.requests.filter(request => request.purpose !== 'compaction'); }
}
class CurrentModelOnlyAdapter extends CompactionAdapter {
  constructor(private readonly currentModel: string) { super(1_000_000, () => textResponse('answered with the current model')); }
  override resolveModel(provider: string, name: string): Promise<LlmResolvedModelInfo> {
    if (name !== this.currentModel) throw new Error(`Retired model is unavailable: ${name}`);
    return super.resolveModel(provider, name);
  }
  override async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    if (request.model !== this.currentModel) throw new Error(`Retired model cannot receive requests: ${request.model}`);
    yield* super.stream(request);
  }
}

const roots = new Set<string>();
const runtimes: NativeAgentRuntime[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close();
  for (const root of roots) await rm(root, { recursive: true, force: true });
  roots.clear();
});
async function mount(adapter: CompactionAdapter, options: Partial<NativeRuntimeOptions> = {}) {
  const root = options.root ?? await mkdtemp(join(tmpdir(), 'boe2-compaction-'));
  roots.add(root);
  const runtime = await NativeAgentRuntime.create({ root, adapters: { mock: adapter }, compaction: compact, ...options });
  runtimes.push(runtime);
  return { runtime, root };
}
function textOf(request: GenerateOptions) { return JSON.stringify(request.messages); }

describe('official dsh compaction in the real agent loop', () => {
  it('prunes a large tool result before the next model request and preserves the original audit event', async () => {
    const original = 'PAGE-START ' + 'long wiki table row '.repeat(5500) + ' PAGE-END';
    const adapter = new CompactionAdapter(32_768, (_, index) => index === 0 ? toolResponse() : textResponse('page reviewed'));
    const { runtime, root } = await mount(adapter);
    const events: SessionEvent[] = [];
    const agent = await runtime.start({
      id: 'tool-prune', model, cwd: root, systemPrompt: 'Read the supplied technical document.',
      setup(ctx) { ctx.on('session/event', (_session, event) => { events.push(event); }); },
      tools: [{ name: 'resource_page', description: 'Read a source page', inputSchema: { type: 'object', properties: {} }, execute: async () => original }],
    });

    expect((await agent.send('Read the page.')).text).toBe('page reviewed');
    expect(adapter.summaries).toHaveLength(0);
    const next = textOf(adapter.mainRequests[1]);
    expect(next).toContain('PAGE-START');
    expect(next).toContain('PAGE-END');
    expect(next).toContain('tool result middle pruned');
    expect(next).not.toContain(original);
    expect(next.length).toBeLessThan(10_000);
    expect(events.some(event => event.type === 'compaction/prune')).toBe(true);
    expect(events.some(event => event.type === 'tool/result' && event.data.message.content.some(block => block.type === 'text' && block.text === original))).toBe(true);
  });

  it('summarizes old history, keeps the current correction verbatim, and resumes the checkpoint from disk', async () => {
    const oldHistory = 'Budget is 10 dollars. ' + 'Earlier source evidence. '.repeat(1000);
    const correction = 'Keep the budget at exactly 10 dollars; do not change my requirements.';
    const adapter = new CompactionAdapter(8192, (_, index) => textResponse(index === 0 ? 'I will compare the passive tree.' : 'comparison ready'));
    const { runtime, root } = await mount(adapter);
    const events: SessionEvent[] = [];
    const first = await runtime.start({
      id: 'persistent-compact', model, cwd: root, systemPrompt: 'Use verified technical documents.', resume: 'auto',
      setup(ctx) { ctx.on('session/event', (_session, event) => { events.push(event); }); },
    });
    await first.send(oldHistory);
    const corrected = await first.send(correction);
    expect(corrected.text).toBe('comparison ready');
    expect(corrected.compaction).toMatchObject({ summaries: 1, inputTokens: 17, outputTokens: 3 });
    expect(corrected.usage).toEqual({ inputTokens: 17, outputTokens: 3 });
    expect(adapter.summaries.length).toBeGreaterThan(0);
    expect(textOf(adapter.summaries[0])).toContain(oldHistory);
    const continued = textOf(adapter.mainRequests.at(-1)!);
    expect(continued).toContain('<compacted-summary>');
    expect(continued).toContain(summary);
    expect(continued).toContain(correction);
    expect(continued).toContain('I will compare the passive tree.');
    expect(continued).not.toContain(oldHistory);
    const starts = events.filter(event => event.type === 'compaction/start');
    const ends = events.filter(event => event.type === 'compaction/end');
    expect(starts.length).toBeGreaterThan(0);
    expect(ends).toHaveLength(starts.length);
    expect(ends.every(event => event.type === 'compaction/end' && event.data.error === undefined)).toBe(true);
    expect(events.some(event => event.type === 'user/message' && JSON.stringify(event.data).includes(oldHistory))).toBe(true);

    await runtime.close();
    const restoredAdapter = new CompactionAdapter(8192, () => textResponse('continued after restart'));
    const { runtime: restored } = await mount(restoredAdapter, { root });
    const resumed = await restored.start({ id: 'persistent-compact', model, cwd: root, systemPrompt: 'Use verified technical documents.', resume: 'auto' });
    expect((await resumed.send('Continue the same comparison.')).text).toBe('continued after restart');
    const resumedContext = textOf(restoredAdapter.mainRequests[0]);
    expect(resumedContext).toContain(summary);
    expect(resumedContext).toContain(correction);
    expect(resumedContext).not.toContain(oldHistory);
  });

  it('compacts old history before enforcing the host character ceiling even below model token pressure', async () => {
    const oldHistory = 'Old draft observations. '.repeat(450);
    const adapter = new CompactionAdapter(1_000_000, (_, index) => textResponse(index === 0 ? 'Observed details. '.repeat(100) : 'recovered'));
    const { runtime, root } = await mount(adapter);
    const agent = await runtime.start({ id: 'host-budget', model, cwd: root, systemPrompt: 'Worker', maxContextChars: 12_000 });
    await agent.send(oldHistory);

    expect((await agent.send('Now answer the current question.')).text).toBe('recovered');
    expect(adapter.summaries).toHaveLength(1);
    const recovered = textOf(adapter.mainRequests.at(-1)!);
    expect(recovered).toContain(summary);
    expect(recovered).toContain('Now answer the current question.');
    expect(recovered).not.toContain(oldHistory);
  });

  it('recovers a persisted session that already failed the old character guard after enabling compaction', async () => {
    const oldHistory = 'Old draft observations. '.repeat(450);
    const oldAdapter = new CompactionAdapter(1_000_000, () => textResponse('Observed details. '.repeat(100)));
    const { runtime, root } = await mount(oldAdapter, { compaction: false });
    const original = await runtime.start({ id: 'previously-failed', model, cwd: root, systemPrompt: 'Worker', maxContextChars: 12_000, resume: 'auto' });
    await original.send(oldHistory);
    await expect(original.send('The earlier follow-up.')).rejects.toMatchObject({ code: 'CONTEXT_LIMIT' });
    await runtime.close();

    const adapter = new CompactionAdapter(1_000_000, () => textResponse('resumed successfully'));
    const { runtime: restored } = await mount(adapter, { root });
    const resumed = await restored.start({ id: 'previously-failed', model, cwd: root, systemPrompt: 'Worker', maxContextChars: 12_000, resume: 'auto' });
    expect((await resumed.send('Current correction: keep my requirements.')).text).toBe('resumed successfully');
    expect(adapter.summaries).toHaveLength(1);
    const recovered = textOf(adapter.mainRequests[0]);
    expect(recovered).toContain(summary);
    expect(recovered).toContain('Current correction: keep my requirements.');
    expect(recovered).not.toContain(oldHistory);
  });

  it('uses the configured current model to summarize a restored session when the old model is no longer available', async () => {
    const oldAdapter = new CompactionAdapter(1_000_000, () => textResponse('Observed details. '.repeat(100)));
    const { runtime, root } = await mount(oldAdapter, { compaction: false });
    const original = await runtime.start({ id: 'switched-model', model, cwd: root, systemPrompt: 'Worker', maxContextChars: 12_000, resume: 'auto' });
    await original.send('Old draft observations. '.repeat(450));
    await runtime.close();

    const adapter = new CurrentModelOnlyAdapter('new-model');
    const { runtime: restored } = await mount(adapter, {
      root, compaction: { ...compact, summarizationProvider: 'mock', summarizationModel: 'new-model' },
    });
    const resumed = await restored.start({ id: 'switched-model', model: { ...model, model: 'new-model' }, cwd: root, systemPrompt: 'Worker', maxContextChars: 12_000, resume: 'auto' });
    expect((await resumed.send('Continue with the current model and keep the requirements.')).text).toBe('answered with the current model');
    expect(adapter.summaries).toHaveLength(1);
    expect(adapter.requests.every(request => request.model === 'new-model')).toBe(true);
    expect(textOf(adapter.mainRequests[0])).toContain(summary);
    expect(textOf(adapter.mainRequests[0])).toContain('Continue with the current model and keep the requirements.');
  });

  it('rejects an indivisible oversized new input without spending a summary or answer request', async () => {
    const adapter = new CompactionAdapter(8192, () => textResponse('unused'));
    const { runtime, root } = await mount(adapter);
    const agent = await runtime.start({ id: 'oversized-input', model, cwd: root, systemPrompt: 'Worker', maxContextChars: 1000 });
    await expect(agent.send('x'.repeat(2000))).rejects.toMatchObject({ code: 'CONTEXT_LIMIT' });
    expect(adapter.requests).toHaveLength(0);
  });

  it('rejects an oversized new input before automatic compaction of an already pressured history', async () => {
    const adapter = new CompactionAdapter(8192, () => textResponse('Ready.'));
    const { runtime, root } = await mount(adapter);
    const agent = await runtime.start({ id: 'oversized-follow-up', model, cwd: root, systemPrompt: 'Worker', maxContextChars: 30_000 });
    await agent.send('Prior evidence. '.repeat(1500));

    await expect(agent.send('x'.repeat(31_000))).rejects.toMatchObject({ code: 'CONTEXT_LIMIT' });
    expect(adapter.summaries).toHaveLength(0);
    expect(adapter.mainRequests).toHaveLength(1);
  });

  it('compacts a provider-confirmed context overflow before retrying with the current input intact', async () => {
    const oldHistory = 'Source and draft history. '.repeat(200);
    const adapter = new CompactionAdapter(1_000_000, (_, index) => {
      if (index === 1) throw new LlmError('provider rejected the context window', CONTEXT_WINDOW_EXCEEDED_CODE);
      return textResponse(index === 0 ? 'Ready for the follow-up.' : 'answer after recovery');
    });
    const { runtime, root } = await mount(adapter);
    const agent = await runtime.start({ id: 'provider-overflow', model, cwd: root, systemPrompt: 'Worker' });
    await agent.send(oldHistory);
    expect((await agent.send('Compare the same document now.')).text).toBe('answer after recovery');
    expect(adapter.mainRequests).toHaveLength(3);
    expect(adapter.summaries).toHaveLength(1);
    const retry = textOf(adapter.mainRequests.at(-1)!);
    expect(retry).toContain('Compare the same document now.');
    expect(retry).not.toContain(oldHistory);expect(retry).toContain(summary);
  });

  it('keeps the hard size limit when a retained indivisible message is still too large after compaction', async () => {
    const adapter = new CompactionAdapter(1_000_000, () => textResponse('A very long final observation. '.repeat(600)));
    const { runtime, root } = await mount(adapter);
    const agent = await runtime.start({ id: 'retained-too-large', model, cwd: root, systemPrompt: 'Worker', maxContextChars: 6000 });
    await agent.send('Prior source evidence. '.repeat(100));

    await expect(agent.send('Continue.')).rejects.toThrow('size limit');
    expect(adapter.summaries).toHaveLength(1);
    expect(adapter.mainRequests).toHaveLength(1);
  });

  it('fails the run when forced summarization fails instead of returning the previous answer as success', async () => {
    const adapter = new CompactionAdapter(1_000_000, () => textResponse('Observed details. '.repeat(100)), () => {
      throw new LlmError('summary service unavailable', 'TRANSPORT');
    });
    const { runtime, root } = await mount(adapter);
    const events: SessionEvent[] = [];
    const agent = await runtime.start({
      id: 'summary-failure', model, cwd: root, systemPrompt: 'Worker', maxContextChars: 12_000,
      setup(ctx) { ctx.on('session/event', (_session, event) => { events.push(event); }); },
    });
    await agent.send('Old draft observations. '.repeat(450));

    await expect(agent.send('Now answer the current question.')).rejects.toThrow('summary service unavailable');
    expect(adapter.summaries).toHaveLength(6);
    expect(adapter.mainRequests).toHaveLength(1);
    expect(events.some(event => event.type === 'compaction/summary')).toBe(false);
    expect(events.some(event => event.type === 'compaction/end' && event.data.error?.includes('summary service unavailable'))).toBe(true);
  });

  it('cancels an in-flight summary without calling the answer model or committing a partial checkpoint', async () => {
    let entered!: () => void;
    const entering = new Promise<void>(resolve => { entered = resolve; });
    const adapter = new CompactionAdapter(8192, () => textResponse('Ready.'), async request => {
      entered();
      await new Promise<void>((_resolve, reject) => {
        request.signal?.throwIfAborted();
        request.signal?.addEventListener('abort', () => reject(request.signal?.reason), { once: true });
      });
      return textResponse('must not commit');
    });
    const { runtime, root } = await mount(adapter);
    const events: SessionEvent[] = [];
    const agent = await runtime.start({
      id: 'cancel-summary', model, cwd: root, systemPrompt: 'Worker',
      setup(ctx) { ctx.on('session/event', (_session, event) => { events.push(event); }); },
    });
    await agent.send('Prior evidence. '.repeat(1500));
    const pending = agent.send('Continue.');
    const rejected = expect(pending).rejects.toMatchObject({ code: 'ABORTED' });
    await entering;
    await agent.cancel();
    await rejected;
    expect(adapter.mainRequests).toHaveLength(1);
    expect(events.some(event => event.type === 'compaction/summary')).toBe(false);
    expect(events.some(event => event.type === 'compaction/end' && event.data.error)).toBe(true);
  });
});
