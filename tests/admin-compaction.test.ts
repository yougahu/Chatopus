import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AdminServer } from '../src/admin/server.js';
import { loadConfig } from '../src/config.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const action of cleanup.splice(0).reverse()) await action(); });

it('previews compaction checkpoints and usage without exposing raw summarizer output or altering the log', async () => {
  const root = mkdtempSync(join(tmpdir(), 'boe-admin-compaction-'));
  cleanup.push(async () => rmSync(root, { recursive: true, force: true }));
  const config = loadConfig(root, { stateDir: root, apiKey: 'test-compaction-secret' });
  const directory = join(root, 'dsh/sessions/work/worker-compacted');
  mkdirSync(directory, { recursive: true });
  const records = [
    { type: 'compaction/start', data: { compactionId: 'compact-1', turn: 2 } },
    { type: 'compaction/prune', data: { shadowedRange: { start: 3, end: 3 }, shadowedSeqs: [3], shadowedTokenCount: 20000 } },
    { type: 'compaction/summary', data: {
      compactionId: 'compact-1', summary: [{ type: 'text', text: '预算 10元，保留已确认的文档条件。' }, { type: 'thinking', text: 'private-summary-block' }],
      rawOutput: [{ type: 'thinking', text: 'private-summarizer-reasoning' }, { type: 'text', text: 'unprojected-output' }],
      shadowedRange: { start: 2, end: 8 }, shadowedSeqs: [2, 3, 5, 8], shadowedTokenCount: 24000,
      provider: 'worker', model: 'configured-model', usage: { inputTokens: 25000, outputTokens: 320 },
    } },
    { type: 'compaction/end', data: { compactionId: 'compact-1', turn: 2 } },
    { type: 'compaction/end', data: { compactionId: 'compact-2', turn: 3, error: 'Summary failed with test-compaction-secret' } },
  ];
  const file = join(directory, 'session.v4.jsonl');
  const original = records.map(row => JSON.stringify(row)).join('\n') + '\n';
  writeFileSync(file, original);
  const server = new AdminServer(config, 0), url = await server.start();
  cleanup.push(() => server.close());
  const response = await fetch(url + '/api/sessions/worker-compacted');
  expect(response.status).toBe(200);
  const body = await response.text(), rows = JSON.parse(body);
  expect(rows.map((row: { type: string }) => row.type)).toEqual(records.map(row => row.type));
  expect(rows[2].data).not.toHaveProperty('rawOutput');
  expect(rows[2].data.summary).toEqual([{ type: 'text', text: '预算 10元，保留已确认的文档条件。' }]);
  expect(rows[2].data.usage).toEqual({ inputTokens: 25000, outputTokens: 320 });
  expect(rows[2].data.shadowedSeqs).toEqual([2, 3, 5, 8]);
  expect(body).not.toContain('private-summary-block');
  expect(body).not.toContain('private-summarizer-reasoning');
  expect(body).not.toContain('unprojected-output');
  expect(body).not.toContain('test-compaction-secret');
  expect(readFileSync(file, 'utf8')).toBe(original);
});
