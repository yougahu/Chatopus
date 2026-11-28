import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AdminServer } from '../src/admin/server.js';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/store.js';
import type { GroupMessage } from '../src/types.js';

const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
async function setup() {
  const root = mkdtempSync(join(tmpdir(), 'admin-token-usage-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const config = loadConfig(root, { stateDir: join(root, 'state') });
  const store = new Store(join(config.stateDir, 'state.sqlite'));
  cleanup.push(() => store.close());
  const server = new AdminServer(config, 0), url = await server.start();
  cleanup.push(() => server.close());
  return { store, config, get: async (path: string) => {
    const response = await fetch(url + path); expect(response.status).toBe(200); return response.json();
  } };
}
function task(store: Store, id = 'one') {
  const message: GroupMessage = { id, roomId: 'room-' + id, messageId: id, platform: 'replay', authorId: 'member', authorName: '成员', text: '整理资料', timestamp: 1, mentions: [], attachments: [], isMentioned: true, isAdmin: false };
  store.ingest(message);
  return store.createThread(message, '资料整理', true);
}

it('bounds the overview task preview without changing full-list pagination or usage totals', async () => {
  const { store, get } = await setup();
  for (let i = 0; i < 12; i++) {
    const thread = task(store, 'preview-' + i); thread.updatedAt = i + 1; store.saveThread(thread);
    store.telemetry('model', { role: 'worker', threadId: thread.id, inputTokens: 5, outputTokens: 2 });
  }
  const all = await get('/api/threads'), preview = await get('/api/threads?limit=6');
  expect(all).toHaveLength(12); expect(preview).toEqual(all.slice(0, 6));
  expect(await get('/api/threads?limit=6&offset=6')).toEqual(all.slice(6));
  expect(await get('/api/threads?limit=1000000')).toEqual(all);
  expect(await get('/api/threads?limit=invalid')).toEqual(all);
});

it('sums task Worker executions and repairs once, includes cache, and distinguishes unrecorded runs', async () => {
  const { store, get } = await setup(), t = task(store), other = task(store, 'other');
  store.saveRun('run-one', t.id, 'succeeded', {});
  store.saveRun('run-two', t.id, 'failed', {});
  store.saveRun('run-three', t.id, 'running', {});
  const model = (values: object) => store.telemetry('model', { role: 'worker', threadId: t.id, ...values });
  model({ runId: 'run-one', phase: 'initial', inputTokens: 100, outputTokens: 20, cacheReadTokens: 40, cacheWriteTokens: 10, compaction: { summaries: 1, inputTokens: 30, outputTokens: 5 } });
  model({ runId: 'run-one', phase: 'repair', inputTokens: 25, outputTokens: 5, cacheReadTokens: 5 });
  model({ runId: 'run-two', inputTokens: 50, outputTokens: 10 });
  model({ inputTokens: 7, outputTokens: 2 }); // Historical record without a run ID.
  model({ role: 'router', inputTokens: 900, outputTokens: 900 });
  model({ role: 'memory', inputTokens: 900, outputTokens: 900 });
  model({ threadId: other.id, runId: 'other-run', inputTokens: 900, outputTokens: 900 });
  model({ threadId: undefined, inputTokens: 900, outputTokens: 900 });
  store.telemetry('router_model_call', { threadId: t.id, inputTokens: 900, outputTokens: 900 });
  const before = store.db.prepare('SELECT count(*) AS n FROM telemetry').get();
  const expected = { inputTokens: 237, uncachedInputTokens: 182, outputTokens: 37, cacheReadTokens: 45, cacheWriteTokens: 10, recordCount: 4, missingRuns: 1 };
  const rows = await get('/api/threads?room=' + t.roomId);
  expect(rows).toHaveLength(1);
  expect(rows[0].tokenUsage).toEqual(expected);
  const detail = await get('/api/threads/' + t.id);
  expect(detail.tokenUsage).toMatchObject(expected);
  expect(detail.tokenUsage.runs).toEqual([
    { runId: 'run-one', status: 'succeeded', inputTokens: 180, uncachedInputTokens: 125, outputTokens: 25, cacheReadTokens: 45, cacheWriteTokens: 10, recordCount: 2 },
    { runId: 'run-two', status: 'failed', inputTokens: 50, uncachedInputTokens: 50, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, recordCount: 1 },
    { runId: 'run-three', status: 'running', inputTokens: 0, uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, recordCount: 0 },
    { runId: null, status: null, inputTokens: 7, uncachedInputTokens: 7, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, recordCount: 1 },
  ]);
  expect(store.db.prepare('SELECT count(*) AS n FROM telemetry').get()).toEqual(before);
});

it('uses all task records even when they are outside the overview metrics window', async () => {
  const { store, get } = await setup(), t = task(store);
  store.transaction(() => {
    for (let n = 0; n < 350; n++) store.telemetry('model', { role: 'worker', threadId: t.id, runId: 'run', inputTokens: 2, outputTokens: 1 });
    for (let n = 0; n < 350; n++) store.telemetry('model', { role: 'router', inputTokens: 10, outputTokens: 10 });
  });
  expect((await get('/api/overview')).metrics).toHaveLength(300);
  expect((await get('/api/threads'))[0].tokenUsage).toMatchObject({ inputTokens: 700, outputTokens: 350, recordCount: 350 });
  expect((await get('/api/threads/' + t.id)).tokenUsage).toMatchObject({ inputTokens: 700, outputTokens: 350, recordCount: 350 });
});

it('keeps no-record and recorded-zero states distinct', async () => {
  const { store, get } = await setup(), missing = task(store), zero = task(store, 'zero');
  store.saveRun('pending-run', missing.id, 'running', {});
  store.telemetry('model', { role: 'worker', threadId: zero.id, inputTokens: 0, outputTokens: 0 });
  const list = await get('/api/threads');
  expect(list.find((row: any) => row.id === missing.id).tokenUsage).toMatchObject({ recordCount: 0, missingRuns: 1 });
  expect(list.find((row: any) => row.id === zero.id).tokenUsage).toMatchObject({ inputTokens: 0, outputTokens: 0, recordCount: 1, missingRuns: 0 });
});

it('isolates historical data sources even when task IDs are identical', async () => {
  const { store, config, get } = await setup(), t = task(store);
  store.telemetry('model', { role: 'worker', threadId: t.id, inputTokens: 100, outputTokens: 20 });
  const archive = new Store(join(config.stateDir, 'ask', '1700000000000', 'state.sqlite'));
  cleanup.push(() => archive.close());
  archive.saveThread(t);
  archive.telemetry('model', { role: 'worker', threadId: t.id, inputTokens: 5, outputTokens: 2 });
  expect((await get('/api/threads?source=ask-1700000000000'))[0].tokenUsage).toMatchObject({ inputTokens: 5, outputTokens: 2 });
  expect((await get('/api/threads/' + t.id + '?source=ask-1700000000000')).tokenUsage).toMatchObject({ inputTokens: 5, outputTokens: 2 });
  expect((await get('/api/threads/' + t.id)).tokenUsage).toMatchObject({ inputTokens: 100, outputTokens: 20 });
});

it('keeps unknown failed usage distinct and never adds attempt details to aggregates',async()=>{
 const {store,get}=await setup(),t=task(store);
 store.saveRun('failed',t.id,'failed',{});
 store.telemetry('model',{role:'worker',threadId:t.id,runId:'failed',inputTokens:0,outputTokens:0,usageStatus:'unknown',missingUsageCalls:6});
 store.telemetry('model_call',{role:'worker',threadId:t.id,runId:'failed',usage:{inputTokens:900,outputTokens:900}});
 const usage=(await get('/api/threads/'+t.id)).tokenUsage;
 expect(usage).toMatchObject({inputTokens:0,outputTokens:0,recordCount:1,unknownRecords:1,incompleteRecords:1,missingRuns:0});
});

it('deduplicates model events and reconciles interrupted attempts without counting settled turns twice',async()=>{
 const {store,get}=await setup(),t=task(store);
 const thread=store.thread(t.id)!;thread.status='running';thread.activeRunId='interrupted';thread.workerBudget={revision:thread.revision,remainingSteps:96,deadlineAt:Date.now()+100000};store.saveThread(thread);
 const call={eventId:'call-one',measurementId:'turn-one',role:'worker',threadId:t.id,runId:'interrupted',step:2,usage:{inputTokens:10,outputTokens:5}};
 store.telemetry('model_call',call);store.telemetry('model_call',call);
 const completed={eventId:'turn-one',measurementId:'turn-one',role:'worker',threadId:t.id,runId:'interrupted',inputTokens:10,outputTokens:5,usageStatus:'known'};
 store.telemetry('model',completed);store.telemetry('model',completed);
 store.telemetry('model_call',{...call,eventId:'call-two',measurementId:'turn-two',step:3,usage:{inputTokens:7,outputTokens:3}});
 store.recovery();store.recovery();
 expect(store.db.prepare("SELECT count(*) AS n FROM telemetry WHERE kind='model_call'").get()?.n).toBe(2);
 expect((await get('/api/threads/'+t.id)).tokenUsage).toMatchObject({inputTokens:17,outputTokens:8,recordCount:2,incompleteRecords:1});
 expect(store.thread(t.id)).toMatchObject({status:'queued',workerBudget:{remainingSteps:92},lastFailure:{code:'INTERRUPTED',steps:3}});
});
