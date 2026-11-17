import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../src/config.js';
import { Store } from '../src/store.js';
import type { GroupMessage } from '../src/types.js';
import { OpenVikingClient, memoryPeerId } from '../src/memory/openviking-client.js';
import { SharedMemoryService } from '../src/memory/shared-memory.js';
import { OpenVikingIngestion, type OpenVikingIngestionOptions } from '../src/memory/openviking-ingestion.js';
import { openVikingPrepareAfter, pauseOpenVikingPreparation } from '../src/memory/openviking-maintenance.js';

const ok = (result: unknown) => Response.json({ status: 'ok', result });
const fail = (status = 404, code = 'NOT_FOUND') => Response.json({ status: 'error', error: { code } }, { status });
type RawMessage = { role: string; peer_id?: string; source_message_ids: string[]; turn_id: string; parts: Array<{ type: string; text: string }> };
type Session = { id: string; account: string; policy: unknown; messages: RawMessage[]; archive?: {
  archive_id: string; status: 'pending' | 'failed' | 'completed'; messages: RawMessage[]; messages_sha256: string; failure?: { stage: string };
}; task?: { task_id: string; resource_id: string; status: string } };

class SessionHttp {
  sessions = new Map<string, Session>();
  appends: Array<{ account: string; sessionId: string; messages: RawMessage[] }> = [];
  commits: string[] = [];
  retries: Array<{ sessionId: string; hash: string }> = [];
  creates: Array<Record<string, any>> = [];
  loseAppendAfter = false;
  loseAppendBefore = false;
  loseEveryAppendBefore = false;
  loseCommitAfter = false;
  loseCommitBefore = false;
  autoComplete = true;
  forceAutoCommit = false;
  delayedAppends: Array<() => void> = [];
  appendGate?: Promise<void>;
  appendEntered?: () => void;
  key(account: string, id: string) { return JSON.stringify([account, id]); }
  finish(session: Session) { session.archive!.status = 'completed'; session.task!.status = 'completed'; }
  fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const account = new Headers(init?.headers).get('X-API-Key')!;
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    if (url.pathname === '/api/v1/sessions') {
      this.creates.push(body);
      const key = this.key(account, body.session_id);
      if (this.sessions.has(key)) return fail(409, 'ALREADY_EXISTS');
      this.sessions.set(key, { id: body.session_id, account, policy: this.forceAutoCommit ? { message_count_threshold: 1 } : body.auto_commit_policy, messages: [] });
      return ok({ session_id: body.session_id });
    }
    if (url.pathname === '/api/v1/content/read') {
      const match = /^viking:\/\/user\/group\/sessions\/([^/]+)\/messages.jsonl$/.exec(url.searchParams.get('uri')!);
      if (!match) throw new Error('Unexpected non-session read');
      const session = this.sessions.get(this.key(account, match[1]));
      return session ? ok(session.messages.map(message => JSON.stringify(message)).join('\n')) : fail();
    }
    if (url.pathname === '/api/v1/tasks') {
      const session = this.sessions.get(this.key(account, url.searchParams.get('resource_id')!));
      return ok(session?.task ? [session.task] : []);
    }
    const match = /^\/api\/v1\/sessions\/([^/]+)(.*)$/.exec(url.pathname);
    if (!match) throw new Error('Unexpected endpoint: ' + url.pathname);
    const [, id, suffix] = match;
    const session = this.sessions.get(this.key(account, id));
    if (!session) return fail();
    if (!suffix) return ok({ session_id: id, auto_commit_policy: session.policy, message_count: session.messages.length, commit_count: session.archive ? 1 : 0 });
    if (suffix === '/messages/batch') {
      const messages = body.messages.map((message: Record<string, any>) => ({ ...message, parts: [{ type: 'text', text: message.content }] })) as RawMessage[];
      this.appends.push({ account, sessionId: id, messages }); this.appendEntered?.();
      if (this.appendGate) await new Promise<void>((resolve, reject) => {
        const aborted = () => reject(init?.signal?.reason ?? new Error('aborted'));
        init?.signal?.addEventListener('abort', aborted, { once: true });
        this.appendGate!.then(() => { init?.signal?.removeEventListener('abort', aborted); resolve(); }, reject);
      });
      if (this.loseAppendBefore || this.loseEveryAppendBefore) {
        this.loseAppendBefore = false; this.delayedAppends.push(() => session.messages.push(...messages));
        throw new TypeError('Append outcome unknown');
      }
      session.messages.push(...messages);
      if (this.loseAppendAfter) { this.loseAppendAfter = false; throw new TypeError('Append response lost'); }
      return ok({ message_count: session.messages.length });
    }
    if (suffix === '/commit') {
      this.commits.push(id);
      if (this.loseCommitBefore) { this.loseCommitBefore = false; throw new TypeError('Commit outcome unknown'); }
      if (!session.messages.length) return ok({ session_id: id, status: 'skipped', archived: false, task_id: null, archive_uri: null });
      const messages = session.messages; session.messages = [];
      session.archive = { archive_id: 'archive_001', status: this.autoComplete ? 'completed' : 'pending', messages,
        messages_sha256: createHash('sha256').update(JSON.stringify(messages)).digest('hex') };
      session.task = { task_id: 'task_' + id, resource_id: id, status: this.autoComplete ? 'completed' : 'running' };
      if (this.loseCommitAfter) { this.loseCommitAfter = false; throw new TypeError('Commit response lost'); }
      return ok({ session_id: id, status: 'accepted', archived: true, task_id: session.task.task_id,
        archive_uri: `viking://user/group/sessions/${id}/history/archive_001` });
    }
    if (suffix === '/archives/archive_001') return session.archive ? ok(session.archive) : fail();
    if (suffix === '/archives/archive_001/retry') {
      if (!session.archive || body.expected_messages_sha256 !== session.archive.messages_sha256) return fail(412, 'FAILED_PRECONDITION');
      this.retries.push({ sessionId: id, hash: body.expected_messages_sha256 });
      session.task = { task_id: 'retry_' + id, resource_id: id, status: 'completed' };
      session.archive.status = 'completed'; delete session.archive.failure;
      return ok({ status: 'accepted', task_id: session.task.task_id });
    }
    throw new Error('Unexpected session endpoint: ' + suffix);
  };
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  try { for (const clean of cleanups.splice(0).reverse()) await clean(); }
  finally { vi.useRealTimers(); }
});
function service(http: SessionHttp, namespace = 'live') {
  const config = { qq: { selfId: 'bot' }, memoryApiKey: 'fixture-root', memory: {
    enabled: true, provider: 'openviking', baseUrl: 'https://memory.invalid', namespace, rootKeyEnv: 'UNUSED', timeoutMs: 1000, recallBytes: 6000, ingestBatchSize: 32,
  } } as Config;
  return new SharedMemoryService(config, new OpenVikingClient({ baseUrl: config.memory!.baseUrl, credential: async account => account, fetch: http.fetch }));
}
function openStore(path = ':memory:') { const store = new Store(path); cleanups.push(() => store.close()); return store; }
function worker(store: Store, http: SessionHttp, opts: Partial<OpenVikingIngestionOptions> = {}) {
  const ingestion = new OpenVikingIngestion({ db: store.db, source: store.roomMemory, sharedMemory: service(http), batchWindowMs: 0, retryMs: 2, maxRetryMs: 8, pollMs: 2, ...opts });
  cleanups.push(() => ingestion.close()); return ingestion;
}
function add(store: Store, id: string, roomId = 'room', timestamp = Date.now(), authorId = 'alice') {
  const message: GroupMessage = { id, roomId, messageId: id, authorId, authorName: authorId, platform: 'replay', text: `Source ${id}`, timestamp,
    mentions: [], attachments: [], isMentioned: false, isAdmin: false };
  store.ingest(message); return store.roomMemory.latestSeq(roomId);
}
async function until(predicate: () => boolean) {
  for (let i = 0; i < 400; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 2)); }
  throw new Error('Ingestion transition did not complete');
}
const covered = (ingestion: OpenVikingIngestion, roomId = 'room') => ingestion.status().lanes.find(lane => lane.roomId === roomId && lane.mode === 'live')?.coveredSeq;

function batchingClock() {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  vi.setSystemTime(new Date('2026-11-08T07:00:00Z'));
}
// Keep setImmediate real so the scheduler and mocked HTTP microtasks can drain
// without advancing the accumulation window or retry clock.
async function flushScheduled() {
  for (let i = 0; i < 3; i++) await new Promise<void>(resolve => setImmediate(resolve));
}
async function advanceBatchClock(ms: number) {
  await vi.advanceTimersByTimeAsync(ms);
  await flushScheduled();
}

describe('OpenViking live accumulation window', () => {
  it('defaults to five minutes from receipt and groups later messages and replies without extending the deadline', async () => {
    batchingClock();
    const store = openStore(), http = new SessionHttp(), ingestion = worker(store, http, { batchWindowMs: undefined });
    // An old platform timestamp must not bypass the fresh host receipt window.
    add(store, 'first', 'room', 1); ingestion.notify('room');
    let idle = false; const waiting = ingestion.whenIdle().then(() => { idle = true; });
    await flushScheduled();
    expect(http.creates).toHaveLength(0); expect(idle).toBe(false);
    await advanceBatchClock(60_000);
    add(store, 'second', 'room', Date.now() + 86_400_000); ingestion.notify('room');
    store.enqueue({ roomId: 'room', text: 'Confirmed response' }, { id: 'sent' });
    const sent = store.outbox().find(item => item.id === 'sent')!;
    sent.status = 'sent'; sent.sentAt = Date.now(); sent.platformMessageId = 'qq-confirmed'; store.saveOutbox(sent);
    const latest = store.roomMemory.latestSeq('room'); ingestion.notify('room');
    await advanceBatchClock(180_000);
    ingestion.notify('room'); // Duplicate notifications cannot postpone the oldest source.
    await advanceBatchClock(59_999);
    expect(http.creates).toHaveLength(0); expect(idle).toBe(false);
    // No further intake notification is needed to flush the final partial batch.
    await advanceBatchClock(1); await waiting;
    expect(http.appends).toHaveLength(1); expect(http.commits).toHaveLength(1);
    expect(http.appends[0].messages.map(message => message.source_message_ids[0])).toEqual(['first', 'second', 'sent']);
    expect(covered(ingestion)).toBe(latest);
  });

  it('flushes full groups immediately and counts only valid sources within that group', async () => {
    batchingClock();
    const store = openStore(), http = new SessionHttp(), ingestion = worker(store, http, { batchSize: 3, batchWindowMs: 1000 });
    add(store, 'a1', 'a'); add(store, 'b1', 'b'); add(store, 'a-deleted', 'a'); add(store, 'b2', 'b');
    add(store, 'a2', 'a'); store.db.prepare('DELETE FROM messages WHERE id=?').run('a-deleted');
    ingestion.notify('a'); ingestion.notify('b'); await flushScheduled();
    expect(http.creates).toHaveLength(0);
    const latestA = add(store, 'a3', 'a'); ingestion.notify('a'); await flushScheduled();
    expect(http.appends).toHaveLength(1);
    expect(http.appends[0].messages.map(message => message.source_message_ids[0])).toEqual(['a1', 'a2', 'a3']);
    expect(covered(ingestion, 'a')).toBe(latestA); expect(covered(ingestion, 'b')).toBe(0);
    await advanceBatchClock(1000); await ingestion.whenIdle();
    expect(http.appends).toHaveLength(2);
    expect(http.appends[1].messages.map(message => message.source_message_ids[0])).toEqual(['b1', 'b2']);
    expect(http.appends[0].account).not.toBe(http.appends[1].account);
  });

  it('retains the original receipt deadline after reopening durable state', async () => {
    batchingClock();
    const directory = mkdtempSync(join(tmpdir(), 'ov-batching-')); cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
    const path = join(directory, 'state.db'), http = new SessionHttp(), store = openStore(path);
    const ingestion = worker(store, http, { batchWindowMs: 1000 });
    add(store, 'before-restart'); ingestion.notify('room'); await flushScheduled();
    await advanceBatchClock(400); await ingestion.close();
    cleanups.pop(); cleanups.pop(); store.close();
    await advanceBatchClock(200);
    const reopened = openStore(path), restored = worker(reopened, http, { batchWindowMs: 1000 });
    const latest = add(reopened, 'after-restart'); restored.notify('room'); await flushScheduled();
    await advanceBatchClock(399); expect(http.creates).toHaveLength(0);
    await advanceBatchClock(1); await restored.whenIdle();
    expect(http.appends).toHaveLength(1);
    expect(http.appends[0].messages.map(message => message.source_message_ids[0])).toEqual(['before-restart', 'after-restart']);
    expect(covered(restored)).toBe(latest);
  });

  it('times sources arriving during extraction separately and delivers every source once', async () => {
    batchingClock();
    const store = openStore(), http = new SessionHttp(); http.autoComplete = false;
    const ingestion = worker(store, http, { batchSize: 2, batchWindowMs: 1000, pollMs: 100 });
    add(store, 'first'); const firstBatch = add(store, 'second'); ingestion.notify('room'); await flushScheduled();
    expect(http.commits).toHaveLength(1); expect(covered(ingestion)).toBe(0);
    await advanceBatchClock(600);
    const latest = add(store, 'during-extraction'); ingestion.notify('room');
    await advanceBatchClock(400);
    http.finish([...http.sessions.values()][0]); http.autoComplete = true;
    await advanceBatchClock(100);
    expect(covered(ingestion)).toBe(firstBatch); expect(http.appends).toHaveLength(1);
    await advanceBatchClock(499); expect(http.appends).toHaveLength(1);
    await advanceBatchClock(1); await ingestion.whenIdle();
    expect(http.appends.map(batch => batch.messages.map(message => message.source_message_ids[0]))).toEqual([
      ['first', 'second'], ['during-extraction'],
    ]);
    expect(http.commits).toHaveLength(2); expect(covered(ingestion)).toBe(latest);
  });

  it('recovers an already frozen append without imposing a new accumulation window', async () => {
    batchingClock();
    const store = openStore(), http = new SessionHttp(), ingestion = worker(store, http);
    const latest = add(store, 'one'); http.loseAppendAfter = true; ingestion.notify('room');
    await expect(ingestion.whenIdle()).rejects.toMatchObject({ code: 'TRANSPORT' });
    await ingestion.close();
    const restored = worker(store, http, { batchWindowMs: 300_000 });
    await flushScheduled(); await advanceBatchClock(2); await restored.whenIdle();
    expect(http.appends).toHaveLength(1); expect(http.commits).toHaveLength(1);
    expect(covered(restored)).toBe(latest);
  });
});

describe('OpenViking preparation during model maintenance',()=>{
  function maintenanceDirectory(){
    const directory=mkdtempSync(join(tmpdir(),'ov-ingestion-maintenance-'));
    cleanups.push(()=>rmSync(directory,{recursive:true,force:true}));return directory;
  }

  it('holds full batches until an abandoned lease expires and then delivers every source exactly once',async()=>{
    batchingClock();
    const directory=maintenanceDirectory(),store=openStore(),http=new SessionHttp();
    pauseOpenVikingPreparation(directory);
    const ingestion=worker(store,http,{batchSize:2,prepareAfter:()=>openVikingPrepareAfter(directory)});
    add(store,'one');add(store,'two');ingestion.notify('room');await flushScheduled();
    expect(http.creates).toHaveLength(0);expect(covered(ingestion)).toBe(0);
    await advanceBatchClock(60_000);
    const latest=add(store,'three');ingestion.notify('room');await flushScheduled();
    await advanceBatchClock(59_999);expect(http.creates).toHaveLength(0);
    await advanceBatchClock(1);
    expect(covered(ingestion)).toBe(latest);
    expect(http.appends.map(batch=>batch.messages.map(message=>message.source_message_ids[0]))).toEqual([['one','two'],['three']]);
    expect(http.commits).toHaveLength(2);
  });

  it('resumes queued full batches promptly after release without another intake notification',async()=>{
    batchingClock();
    const directory=maintenanceDirectory(),store=openStore(),http=new SessionHttp();
    const release=pauseOpenVikingPreparation(directory);
    const ingestion=worker(store,http,{batchSize:2,prepareAfter:()=>openVikingPrepareAfter(directory)});
    add(store,'one');const latest=add(store,'two');ingestion.notify('room');await flushScheduled();
    expect(http.creates).toHaveLength(0);
    release();await advanceBatchClock(1000);
    // Do not call whenIdle/notify: those would incidentally wake the scheduler and hide a stale timer.
    expect(covered(ingestion)).toBe(latest);
    expect(http.appends).toHaveLength(1);expect(http.commits).toHaveLength(1);
    expect(http.appends[0].messages.map(message=>message.source_message_ids[0])).toEqual(['one','two']);
  });

  it('finishes an existing frozen batch while holding newly arrived sources until maintenance ends',async()=>{
    batchingClock();
    const directory=maintenanceDirectory(),store=openStore(),http=new SessionHttp();http.autoComplete=false;
    const ingestion=worker(store,http,{batchSize:2,pollMs:100,prepareAfter:()=>openVikingPrepareAfter(directory)});
    add(store,'first');const initial=add(store,'second');ingestion.notify('room');await flushScheduled();
    expect(http.commits).toHaveLength(1);
    const release=pauseOpenVikingPreparation(directory);
    add(store,'third');const latest=add(store,'fourth');ingestion.notify('room');
    http.finish([...http.sessions.values()][0]);http.autoComplete=true;
    await advanceBatchClock(100);
    expect(covered(ingestion)).toBe(initial);expect(http.creates).toHaveLength(1);
    await advanceBatchClock(1000);expect(http.creates).toHaveLength(1);
    release();await advanceBatchClock(1000);
    expect(covered(ingestion)).toBe(latest);
    expect(http.appends.map(batch=>batch.messages.map(message=>message.source_message_ids[0]))).toEqual([
      ['first','second'],['third','fourth'],
    ]);
    expect(http.commits).toHaveLength(2);
  });
});

describe('OpenViking accepted-source ingestion', () => {
  it('baselines existing history and ingests future raw messages plus only confirmed replies', async () => {
    const store = openStore(), http = new SessionHttp();
    const old = add(store, 'historical');
    const ingestion = worker(store, http);
    expect(covered(ingestion)).toBe(old);
    await ingestion.whenIdle(); expect(http.appends).toHaveLength(0);
    add(store, 'future');
    store.enqueue({ roomId: 'room', text: 'Unsent internal proposal' }, { id: 'unsent' });
    store.enqueue({ roomId: 'room', text: 'Accepted and sent reply' }, { id: 'sent' });
    const sent = store.outbox().find(item => item.id === 'sent')!;
    sent.status = 'sent'; sent.sentAt = 200; sent.platformMessageId = 'qq-bot-reply'; store.saveOutbox(sent);
    const latest = store.roomMemory.latestSeq('room'); ingestion.notify('room');
    await ingestion.whenIdle();
    expect(covered(ingestion)).toBe(latest);
    expect(http.appends.flatMap(batch => batch.messages.map(message => message.source_message_ids[0]))).toEqual(['future', 'sent']);
    expect(http.appends[0].messages.map(message => message.role)).toEqual(['user', 'assistant']);
    expect(http.appends[0].messages[0].peer_id).toBe(memoryPeerId('alice'));
    expect(http.appends[0].messages[1].peer_id).toBeUndefined();
    expect(http.creates[0]).toMatchObject({ auto_commit_policy: null, memory_policy: { self: { enabled: false }, peer: { enabled: true }, working_memory: { enabled: false }, memory_types: ['profile', 'preferences', 'entities', 'events'] } });
  });

  it('recovers a lost append response by checking source IDs and does not append twice', async () => {
    const store = openStore(), http = new SessionHttp(), ingestion = worker(store, http);
    const latest = add(store, 'one'); http.loseAppendAfter = true; ingestion.notify('room');
    await expect(ingestion.whenIdle()).rejects.toMatchObject({ code: 'TRANSPORT' });
    await until(() => covered(ingestion) === latest);
    expect(http.appends).toHaveLength(1); expect(http.commits).toHaveLength(1);
  });

  it('abandons an uncertain empty append session without ever committing its late write', async () => {
    const store = openStore(), http = new SessionHttp(), ingestion = worker(store, http);
    const latest = add(store, 'one'); http.loseAppendBefore = true; ingestion.notify('room');
    await expect(ingestion.whenIdle()).rejects.toMatchObject({ code: 'TRANSPORT' });
    await until(() => covered(ingestion) === latest);
    expect(http.appends).toHaveLength(2);
    expect(http.appends[0].sessionId).not.toBe(http.appends[1].sessionId);
    expect(ingestion.status().lanes[0].abandonedSessionIds).toEqual([http.appends[0].sessionId]);
    for (const complete of http.delayedAppends) complete();
    expect(http.commits).toEqual([http.appends[1].sessionId]);
    const old = [...http.sessions.values()].find(session => session.id === http.appends[0].sessionId)!;
    expect(old.messages).toHaveLength(1); expect(old.archive).toBeUndefined(); expect(old.policy).toBeNull();
  });

  it('recovers lost commit responses using the original archive rather than recommitting an empty session', async () => {
    const store = openStore(), http = new SessionHttp(), ingestion = worker(store, http);
    const latest = add(store, 'one'); http.loseCommitAfter = true; ingestion.notify('room');
    await expect(ingestion.whenIdle()).rejects.toMatchObject({ code: 'TRANSPORT' });
    await until(() => covered(ingestion) === latest);
    expect(http.appends).toHaveLength(1); expect(http.commits).toHaveLength(1); expect(http.retries).toHaveLength(0);
  });

  it('bounds abandonment attempts and persists their identities across recreation', async () => {
    const store = openStore(), http = new SessionHttp(); http.loseEveryAppendBefore = true;
    const ingestion = worker(store, http, { maxSessionAttempts: 2 }); add(store, 'one'); ingestion.notify('room');
    await expect(ingestion.whenIdle()).rejects.toMatchObject({ code: 'TRANSPORT' });
    await until(() => ingestion.status().lanes[0].blocked);
    expect(ingestion.status().lanes[0]).toMatchObject({ coveredSeq: 0, lastError: 'APPEND_RECOVERY_EXHAUSTED' });
    expect(http.appends).toHaveLength(2); expect(http.commits).toHaveLength(0);
    const abandoned = ingestion.status().lanes[0].abandonedSessionIds;
    await ingestion.close();
    const restored = worker(store, http);
    expect(restored.status().lanes[0].abandonedSessionIds).toEqual(abandoned);
    await expect(restored.whenIdle()).rejects.toMatchObject({ code: 'APPEND_RECOVERY_EXHAUSTED' });
  });

  it('does not treat an empty live session or accepted commit as completed extraction', async () => {
    const store = openStore(), http = new SessionHttp(); http.autoComplete = false;
    const ingestion = worker(store, http), latest = add(store, 'one'); ingestion.notify('room');
    await until(() => http.commits.length === 1);
    expect(covered(ingestion)).toBe(0);
    const session = [...http.sessions.values()][0]; expect(session.messages).toEqual([]);
    http.finish(session); await ingestion.whenIdle(); expect(covered(ingestion)).toBe(latest);
  });

  it('leaves an unresolved commit blocked after bounded checks and never abandons or reappends it', async () => {
    const store = openStore(), http = new SessionHttp(), ingestion = worker(store, http, { maxFailures: 2 });
    add(store, 'one'); http.loseCommitBefore = true; ingestion.notify('room');
    await expect(ingestion.whenIdle()).rejects.toMatchObject({ code: 'TRANSPORT' });
    await until(() => ingestion.status().lanes[0].blocked);
    expect(ingestion.status().lanes[0]).toMatchObject({ coveredSeq: 0, phase: 'committing', lastError: 'COMMIT_OUTCOME_UNKNOWN', abandonedSessionIds: [] });
    expect(http.appends).toHaveLength(1); expect(http.commits).toHaveLength(1);
  });

  it('reopens durable state and retries a failed extraction through its hash-bound archive', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ov-ingestion-')); cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
    const path = join(directory, 'state.db'), http = new SessionHttp(); http.autoComplete = false;
    const store = openStore(path), ingestion = worker(store, http), latest = add(store, 'one'); ingestion.notify('room');
    await until(() => http.commits.length === 1); await ingestion.close();
    // Remove closed resources from cleanup before reopening the file.
    cleanups.pop(); cleanups.pop(); store.close();
    const session = [...http.sessions.values()][0]; session.archive!.status = 'failed'; session.archive!.failure = { stage: 'memory_extract' }; session.task!.status = 'failed';
    const reopened = openStore(path), restored = worker(reopened, http);
    await restored.whenIdle();
    expect(covered(restored)).toBe(latest);
    expect(http.appends).toHaveLength(1); expect(http.commits).toHaveLength(1);
    expect(http.retries).toEqual([{ sessionId: session.id, hash: session.archive!.messages_sha256 }]);
  });

  it('rejects mismatched source receipts and never commits corrupted or foreign source content', async () => {
    const store = openStore(), http = new SessionHttp(), ingestion = worker(store, http);
    add(store, 'one'); http.loseAppendAfter = true; ingestion.notify('room');
    await expect(ingestion.whenIdle()).rejects.toMatchObject({ code: 'TRANSPORT' });
    [...http.sessions.values()][0].messages[0].peer_id = memoryPeerId('bob');
    await until(() => ingestion.status().lanes[0].blocked);
    expect(ingestion.status().lanes[0].lastError).toBe('SOURCE_RECEIPT_MISMATCH'); expect(http.commits).toHaveLength(0);
  });

  it('blocks a changed or withdrawn local source before reusing its frozen intent', async () => {
    const store = openStore(), http = new SessionHttp(), ingestion = worker(store, http);
    add(store, 'one'); http.loseAppendAfter = true; ingestion.notify('room');
    await expect(ingestion.whenIdle()).rejects.toMatchObject({ code: 'TRANSPORT' });
    store.db.prepare('DELETE FROM messages WHERE id=?').run('one');
    await until(() => ingestion.status().lanes[0].blocked);
    expect(ingestion.status().lanes[0].lastError).toBe('SOURCE_CHANGED');
    expect(http.commits).toHaveLength(0); expect(covered(ingestion)).toBe(0);
  });

  it('does not advance when task completion lacks the durable archive completion marker', async () => {
    const store = openStore(), http = new SessionHttp(); http.autoComplete = false;
    const ingestion = worker(store, http, { maxFailures: 2 }); add(store, 'one'); ingestion.notify('room');
    await until(() => http.commits.length === 1);
    [...http.sessions.values()][0].task!.status = 'completed';
    await until(() => ingestion.status().lanes[0].blocked);
    expect(ingestion.status().lanes[0]).toMatchObject({ coveredSeq: 0, lastError: 'EXTRACTION_COMPLETION_UNVERIFIED' });
  });

  it('refuses auto-commit-enabled sessions before sending source content', async () => {
    const store = openStore(), http = new SessionHttp(); http.forceAutoCommit = true;
    const ingestion = worker(store, http); add(store, 'one'); ingestion.notify('room');
    await expect(ingestion.whenIdle()).rejects.toMatchObject({ code: 'AUTO_COMMIT_NOT_DISABLED' });
    expect(http.appends).toHaveLength(0); expect(ingestion.status().lanes[0].blocked).toBe(true);
  });

  it('keeps source arrival order and a monotonic target when notifications and timestamps are reversed', async () => {
    const store = openStore(), http = new SessionHttp(), ingestion = worker(store, http, { batchSize: 1 });
    const first = add(store, 'one', 'room', 10_000), second = add(store, 'two', 'room', 1);
    ingestion.notify('room', second); ingestion.notify('room', first);
    await ingestion.whenIdle();
    expect(covered(ingestion)).toBe(second);
    expect(http.appends.flatMap(batch => batch.messages.map(message => message.source_message_ids[0]))).toEqual(['one', 'two']);
  });

  it('shares concurrency across isolated groups and processes each group in source order', async () => {
    const store = openStore(), http = new SessionHttp();
    let release!: () => void; http.appendGate = new Promise(resolve => { release = resolve; });
    const ingestion = worker(store, http, { concurrency: 2, batchSize: 1 });
    add(store, 'a1', 'a'); const a = add(store, 'a2', 'a'), b = add(store, 'b1', 'b');
    ingestion.notify('a'); ingestion.notify('b');
    await until(() => http.appends.length === 2);
    expect(new Set(http.appends.map(batch => batch.account)).size).toBe(2);
    expect(http.appends.flatMap(batch => batch.messages.map(message => message.source_message_ids[0]))).toEqual(['a1', 'b1']);
    release(); await ingestion.whenIdle();
    expect(covered(ingestion, 'a')).toBe(a); expect(covered(ingestion, 'b')).toBe(b);
    expect(http.appends.map(batch => batch.messages[0].source_message_ids[0])).toEqual(['a1', 'b1', 'a2']);
  });

  it('imports explicit bounded historical samples only into a distinct account namespace', async () => {
    const store = openStore(), http = new SessionHttp();
    const first = add(store, 'one'), second = add(store, 'two'); add(store, 'three');
    const shared = service(http), sample = service(http, 'isolated-sample');
    const ingestion = worker(store, http, { sharedMemory: shared, sampleMemory: sample, batchWindowMs: 300_000 });
    const liveCovered = covered(ingestion);
    const lane = ingestion.importSample('room', { afterSeq: first, throughSeq: second });
    await ingestion.whenIdle();
    expect(covered(ingestion)).toBe(liveCovered);
    expect(ingestion.status().lanes.find(state => state.lane === lane)).toMatchObject({ mode: 'sample', coveredSeq: second });
    expect(http.appends).toHaveLength(1); expect(http.appends[0].account).toBe(sample.account('room'));
    expect(http.appends[0].account).not.toBe(shared.account('room'));
    expect(http.appends[0].messages[0].source_message_ids).toEqual(['two']);
    expect(ingestion.importSample('room', { afterSeq: first, throughSeq: second })).toBe(lane);
    await ingestion.whenIdle(); expect(http.appends).toHaveLength(1);
    const unsafe = worker(store, http, { sampleMemory: shared });
    expect(() => unsafe.importSample('room', { afterSeq: 0, throughSeq: first })).toThrow('isolated account');
  });

  it('persists an in-flight append phase on close and safely recovers after recreation', async () => {
    const store = openStore(), http = new SessionHttp();
    let release!: () => void; http.appendGate = new Promise(resolve => { release = resolve; });
    const ingestion = worker(store, http), latest = add(store, 'one'); ingestion.notify('room');
    await until(() => http.appends.length === 1);
    await ingestion.close();
    expect(ingestion.status().lanes[0].phase).toBe('appending');
    http.appendGate = undefined; release();
    const restored = worker(store, http);
    await restored.whenIdle();
    expect(covered(restored)).toBe(latest);
    expect(http.commits).toHaveLength(1);
    expect(restored.status().lanes[0].abandonedSessionIds).toHaveLength(1);
  });
});
