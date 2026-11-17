import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { evaluateReplay, type Scenario } from '../src/replay.js';
import type { GroupMessage, RouterRequest, RuntimePort } from '../src/types.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
function scenario(id: string): Scenario {
  const first: GroupMessage = { id: `qq:bot:group:${id}-first`, messageId: `${id}-first`, platform: 'replay', roomId: 'qq:bot:shared-group',
    authorId: id, authorName: id, text: 'Original question', timestamp: 1, mentions: [], attachments: [], isMentioned: true, isAdmin: false };
  const second = { ...first, id: `qq:bot:group:${id}-second`, messageId: `${id}-second`, text: 'Follow-up', timestamp: 2, replyToMessageId: first.messageId };
  return { id, title: id, tags: [], split: 'development', messages: [first, second], expected: [
    { messageId: first.id, actions: ['open_thread'] },
    { messageId: second.id, actions: ['append_thread'], threadFrom: first.id },
  ] };
}

it('isolates replay runs and scenarios while keeping each scenario continuous and fixture IDs exact', async () => {
  const root = await mkdtemp(join(tmpdir(), 'boe2-replay-session-')); roots.push(root);
  await mkdir(join(root, 'fixtures'));
  const fixtures = { scenarios: [scenario('one'), scenario('two')] };
  const original = JSON.stringify(fixtures);
  await writeFile(join(root, 'fixtures/group-replay.json'), original);
  const config = loadConfig(root);
  const calls: RouterRequest[] = [];
  const histories = new Map<string, string[]>();
  const runtime: RuntimePort = {
    async route(request) {
      calls.push(structuredClone(request));
      const history = histories.get(request.roomId) ?? [];
      const message = request.messages[0];
      if (message.text === 'Original question') expect(history).toEqual([]);
      else expect(history).toEqual([message.id.replace('second', 'first')]);
      history.push(message.id); histories.set(request.roomId, history);
      return request.threads.length
        ? [{ action: 'append_thread', sourceMessageIds: [message.id], threadId: request.threads[0].id }]
        : [{ action: 'open_thread', sourceMessageIds: [message.id], subject: 'Comparison' }];
    },
    async runWorker() { throw new Error('Replay must not run Workers'); },
    async steer() {}, async cancel() {}, async close() {},
  };
  const first = await evaluateReplay(config, runtime, { concurrency: 2 });
  const second = await evaluateReplay(config, runtime, { concurrency: 2 });
  expect(first.passed).toBe(4); expect(second.passed).toBe(4);
  expect(second.runId).not.toBe(first.runId);
  expect(histories.size).toBe(4);
  expect([...histories.values()].every(history => history.length === 2)).toBe(true);
  for (const call of calls) {
    expect(call.roomId).not.toBe('qq:bot:shared-group');
    expect(call.messages.every(message => message.roomId === call.roomId)).toBe(true);
    expect(call.recentMessages.every(message => message.roomId === call.roomId)).toBe(true);
    expect(call.threads.every(thread => thread.roomId === call.roomId)).toBe(true);
    const current = call.messages[0];
    expect(current.id).toBe(`qq:bot:group:${current.messageId}`);
    if (current.text === 'Follow-up') {
      expect(current.replyToMessageId).toBe(`${current.authorId}-first`);
      expect(call.recentMessages.map(message => message.id)).toEqual([`qq:bot:group:${current.authorId}-first`]);
    }
  }
  expect(first.rows.map(row => row.messageId).sort()).toEqual(fixtures.scenarios.flatMap(s => s.messages.map(message => message.id)).sort());
  expect(await readFile(join(root, 'fixtures/group-replay.json'), 'utf8')).toBe(original);
});

it('applies content assertions from the selected fixture without a domain-wide veto', async () => {
  const root = await mkdtemp(join(tmpdir(), 'generic-replay-assertions-')); roots.push(root);
  const fixture = scenario('content');
  fixture.expected[0].requiredText = ['edition-two'];
  fixture.expected[1].forbiddenText = ['unsupported-claim'];
  await writeFile(join(root, 'external-fixture.json'), JSON.stringify({ scenarios: [fixture] }));
  const runtime = {
    async route(request: RouterRequest) { return request.threads.length
      ? [{ action: 'append_thread', sourceMessageIds: [request.messages[0].id], threadId: request.threads[0].id, resolvedRequest: 'unsupported-claim' }]
      : [{ action: 'open_thread', sourceMessageIds: [request.messages[0].id], subject: 'edition-two' }]; },
  } as RuntimePort;
  const result = await evaluateReplay(loadConfig(root), runtime, { fixturePath: 'external-fixture.json' });
  expect(result.rows.map(row => row.pass)).toEqual([true, false]);
});
