import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { RoomMemoryStore, type MemoryEvent } from '../room-memory-store.js';
import { OpenVikingError, memoryPeerId, type MemorySourceMessage } from './openviking-client.js';
import type { SharedMemoryService } from './shared-memory.js';

type Phase = 'prepared' | 'creating' | 'appending' | 'appended' | 'committing' | 'archived';
interface SourceRecord { seq: number; kind: 'message' | 'reply'; id: string; digest: string; message: MemorySourceMessage }
interface Batch {
  id: string; sessionId: string; attempt: number; abandoned: string[]; phase: Phase;
  through: number; sources: SourceRecord[]; taskId?: string; archiveId?: string;
  uncertainReads: number; archiveRetries: number;
}
interface Lane {
  key: string; room: string; account: string; mode: 'live' | 'sample'; covered: number; target: number;
  batch: Batch | null; abandoned: string[]; failures: number; retryAt: number; lastError: string | null; blocked: boolean;
}
export interface OpenVikingIngestionEvent {
  kind: 'prepared' | 'completed' | 'failed' | 'abandoned'; roomId: string; lane: string;
  coveredSeq: number; targetSeq: number; sessionId?: string; code?: string;
}
export interface OpenVikingIngestionOptions {
  db: DatabaseSync;
  sharedMemory: SharedMemoryService;
  source: RoomMemoryStore;
  /** Historical samples must use a different account namespace from live ingestion. */
  sampleMemory?: SharedMemoryService;
  concurrency?: number;
  batchSize?: number;
  batchBytes?: number;
  /** Flush a partial live batch after this age of its oldest accepted source. Zero disables waiting. */
  batchWindowMs?: number;
  /** A short administrative lease can defer new batches while the backend restarts. */
  prepareAfter?: () => number;
  pollMs?: number;
  retryMs?: number;
  maxRetryMs?: number;
  maxFailures?: number;
  maxSessionAttempts?: number;
  uncertainChecks?: number;
  onEvent?: (event: OpenVikingIngestionEvent) => void;
}
const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const object = (value: unknown): Record<string, any> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new IngestionError('INVALID_BACKEND_RESPONSE', true);
  return value as Record<string, any>;
};
const integer = (value: number, name: string, min = 0, max = Number.MAX_SAFE_INTEGER) => {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid ingestion ${name}`);
  return value;
};
class IngestionError extends Error {
  constructor(readonly code: string, readonly permanent = false) { super(code); }
}
const missing = (error: unknown) => error instanceof OpenVikingError && error.status === 404 && error.code === 'NOT_FOUND';
const codeOf = (error: unknown) => error instanceof OpenVikingError || error instanceof IngestionError ? error.code : 'INGESTION_FAILED';

/** One operational row per room/sample range. No transcript mirror or second memory authority. */
export class OpenVikingIngestion {
  private readonly running = new Map<string, { room: string; abort: AbortController; promise: Promise<void> }>();
  private readonly concurrency: number;
  private readonly batchSize: number;
  private readonly batchBytes: number;
  private readonly batchWindowMs: number;
  private readonly pollMs: number;
  private readonly retryMs: number;
  private readonly maxRetryMs: number;
  private readonly maxFailures: number;
  private readonly maxSessionAttempts: number;
  private readonly uncertainChecks: number;
  private scheduled?: ReturnType<typeof setImmediate>;
  private timer?: ReturnType<typeof setTimeout>;
  private closed = false;
  private lastScheduled?: string;
  private waiters = new Set<{ resolve: () => void; reject: (error: unknown) => void }>();

  constructor(private readonly options: OpenVikingIngestionOptions) {
    this.concurrency = integer(options.concurrency ?? 2, 'concurrency', 1, 32);
    this.batchSize = integer(options.batchSize ?? 32, 'batch size', 1, 100);
    this.batchBytes = integer(options.batchBytes ?? 128_000, 'batch bytes', 1, 1_000_000);
    this.batchWindowMs = integer(options.batchWindowMs ?? 300_000, 'batch window', 0, 3_600_000);
    this.pollMs = integer(options.pollMs ?? 1000, 'poll interval', 1, 60_000);
    this.retryMs = integer(options.retryMs ?? 5000, 'retry interval', 1, 300_000);
    this.maxRetryMs = integer(options.maxRetryMs ?? 60_000, 'maximum retry interval', this.retryMs, 3_600_000);
    this.maxFailures = integer(options.maxFailures ?? 5, 'failure limit', 1, 100);
    this.maxSessionAttempts = integer(options.maxSessionAttempts ?? 3, 'session attempts', 1, 10);
    this.uncertainChecks = integer(options.uncertainChecks ?? 2, 'uncertain checks', 1, 10);
    options.db.exec(`CREATE TABLE IF NOT EXISTS openviking_ingestion(
      lane TEXT PRIMARY KEY,room TEXT NOT NULL,account TEXT NOT NULL,mode TEXT NOT NULL,
      covered INTEGER NOT NULL,target INTEGER NOT NULL,batch TEXT,failures INTEGER NOT NULL DEFAULT 0,
      retry_at INTEGER NOT NULL DEFAULT 0,last_error TEXT,blocked INTEGER NOT NULL DEFAULT 0,abandoned TEXT NOT NULL DEFAULT '[]'
    )`);
    // This runs before future intake notifications. Existing history is not imported implicitly.
    for (const room of options.source.rooms()) {
      const key = this.liveKey(room), current = this.load(key), latest = options.source.latestSeq(room);
      if (!current) this.insert(key, room, options.sharedMemory.account(room), 'live', latest, latest);
      else { current.target = Math.max(current.target, latest); this.save(current); }
    }
    this.kick();
  }

  private liveKey(room: string) { return 'live_' + sha([this.options.sharedMemory.account(room), room]); }
  private insert(key: string, room: string, account: string, mode: Lane['mode'], covered: number, target: number) {
    this.options.db.prepare('INSERT OR IGNORE INTO openviking_ingestion(lane,room,account,mode,covered,target) VALUES(?,?,?,?,?,?)').run(key, room, account, mode, covered, target);
  }
  private load(key: string): Lane | undefined {
    const row = this.options.db.prepare('SELECT * FROM openviking_ingestion WHERE lane=?').get(key) as Record<string, any> | undefined;
    return row ? { key: row.lane, room: row.room, account: row.account, mode: row.mode, covered: row.covered, target: row.target,
      batch: row.batch ? JSON.parse(row.batch) : null, abandoned: JSON.parse(row.abandoned), failures: row.failures, retryAt: row.retry_at, lastError: row.last_error, blocked: !!row.blocked } : undefined;
  }
  private lanes(): Lane[] {
    return (this.options.db.prepare('SELECT lane FROM openviking_ingestion ORDER BY rowid').all() as { lane: string }[]).map(row => this.load(row.lane)!);
  }
  private save(lane: Lane) {
    // Notifications may increase the target while an HTTP call is in flight.
    this.options.db.prepare(`UPDATE openviking_ingestion SET covered=?,target=MAX(target,?),batch=?,failures=?,retry_at=?,last_error=?,blocked=?,abandoned=? WHERE lane=?`)
      .run(lane.covered, lane.target, lane.batch ? JSON.stringify(lane.batch) : null, lane.failures, lane.retryAt, lane.lastError, lane.blocked ? 1 : 0, JSON.stringify(lane.abandoned), lane.key);
  }
  /** Optional explicit first enable; calling it later never advances an existing cursor. */
  enable(roomId: string): void {
    if (this.closed) throw new Error('Ingestion is closed');
    const latest = this.options.source.latestSeq(roomId);
    this.insert(this.liveKey(roomId), roomId, this.options.sharedMemory.account(roomId), 'live', latest, latest);
  }
  notify(roomId: string, targetSeq = this.options.source.latestSeq(roomId)): void {
    if (this.closed) return;
    const latest = this.options.source.latestSeq(roomId);
    integer(targetSeq, 'target');
    if (targetSeq > latest) throw new Error('Ingestion target is beyond accepted sources');
    const key = this.liveKey(roomId);
    // A room first observed after construction contains new intake, not pre-enable history.
    this.insert(key, roomId, this.options.sharedMemory.account(roomId), 'live', 0, 0);
    this.options.db.prepare('UPDATE openviking_ingestion SET target=MAX(target,?) WHERE lane=?').run(targetSeq, key);
    this.kick();
  }
  importSample(roomId: string, range: { afterSeq: number; throughSeq: number }): string {
    if (this.closed) throw new Error('Ingestion is closed');
    integer(range.afterSeq, 'sample start'); integer(range.throughSeq, 'sample end');
    if (range.throughSeq <= range.afterSeq || range.throughSeq > this.options.source.latestSeq(roomId)) throw new Error('Invalid sample source range');
    const sample = this.options.sampleMemory;
    if (!sample || sample.account(roomId) === this.options.sharedMemory.account(roomId)) throw new Error('Historical samples require an isolated account namespace');
    const account = sample.account(roomId), key = 'sample_' + sha([account, roomId, range]);
    this.insert(key, roomId, account, 'sample', range.afterSeq, range.throughSeq); this.kick(); return key;
  }
  /** Operator retry retains the frozen batch and its uncertain phase. It never resets source ownership. */
  retry(roomId: string): void {
    if (this.closed) return;
    for (const lane of this.lanes().filter(lane => lane.room === roomId)) {
      lane.blocked = false; lane.failures = 0; lane.retryAt = 0; lane.lastError = null; this.save(lane);
    }
    this.kick();
  }
  status() {
    return { closed: this.closed, running: this.running.size, lanes: this.lanes().map(lane => ({
      lane: lane.key, roomId: lane.room, mode: lane.mode, coveredSeq: lane.covered, targetSeq: lane.target,
      phase: lane.batch?.phase, sessionId: lane.batch?.sessionId, taskId: lane.batch?.taskId,
      abandonedSessionIds: lane.abandoned, blocked: lane.blocked, retryAt: lane.retryAt, lastError: lane.lastError,
      batchReadyAt: !lane.batch && lane.covered < lane.target ? this.batchReadyAt(lane) : undefined,
    })) };
  }
  private emit(kind: OpenVikingIngestionEvent['kind'], lane: Lane, code?: string) {
    try { this.options.onEvent?.({ kind, roomId: lane.room, lane: lane.key, coveredSeq: lane.covered, targetSeq: lane.target, sessionId: lane.batch?.sessionId, ...(code ? { code } : {}) }); } catch { /* telemetry cannot break durable progress */ }
  }
  private service(lane: Lane): SharedMemoryService {
    const service = lane.mode === 'sample' ? this.options.sampleMemory : this.options.sharedMemory;
    if (!service || service.account(lane.room) !== lane.account) throw new IngestionError('ACCOUNT_CONFIG_CHANGED', true);
    return service;
  }
  private kick() {
    if (this.closed || this.scheduled) return;
    this.scheduled = setImmediate(() => { this.scheduled = undefined; this.pump(); });
  }
  private batchReadyAt(lane: Lane): number {
    // Frozen work and explicit historical imports must retain their existing recovery behavior.
    if (lane.batch || lane.mode === 'sample' || !this.batchWindowMs) return 0;
    const pending = this.options.source.pendingWindow(lane.room, {
      afterSeq: lane.covered, throughSeq: lane.target, limit: this.batchSize,
    });
    if (!pending.count || pending.count >= this.batchSize || pending.oldestReceivedAt === null) return 0;
    // Source receipt times are durable: later notifications and restarts cannot postpone the deadline.
    return pending.oldestReceivedAt + this.batchWindowMs;
  }
  private pump() {
    if (this.closed) return;
    if (this.timer) clearTimeout(this.timer); this.timer = undefined;
    let next = Infinity;
    const all = this.lanes(), after = all.findIndex(lane => lane.key === this.lastScheduled) + 1;
    for (const lane of [...all.slice(after), ...all.slice(0, after)]) {
      if ((!lane.batch && lane.covered >= lane.target) || lane.blocked || this.running.has(lane.key)) continue;
      if ([...this.running.values()].some(run => run.room === lane.room)) continue;
      const maintenanceUntil = lane.batch ? 0 : this.options.prepareAfter?.() ?? 0;
      const readyAt = Math.max(lane.retryAt, this.batchReadyAt(lane), maintenanceUntil);
      if (readyAt > Date.now()) {
        // The admin can release its lease early without a new group message to wake this process.
        next = Math.min(next, readyAt, maintenanceUntil > Date.now() ? Date.now() + 1000 : Infinity); continue;
      }
      if (this.running.size >= this.concurrency) break;
      this.lastScheduled = lane.key;
      const abort = new AbortController();
      const promise = this.step(lane, abort.signal).catch(error => {
        if (this.closed || abort.signal.aborted) return;
        lane.failures++; lane.lastError = codeOf(error);
        lane.blocked = (error instanceof IngestionError && error.permanent) || lane.failures >= this.maxFailures;
        lane.retryAt = lane.blocked ? 0 : Date.now() + Math.min(this.maxRetryMs, this.retryMs * 2 ** (lane.failures - 1));
        this.save(lane); this.emit('failed', lane, lane.lastError);
      }).finally(() => { this.running.delete(lane.key); this.settle(); this.kick(); });
      this.running.set(lane.key, { room: lane.room, abort, promise });
    }
    if (Number.isFinite(next)) { this.timer = setTimeout(() => this.kick(), Math.max(1, next - Date.now())); this.timer.unref(); }
    this.settle();
  }
  private pending(lane: Lane) { lane.retryAt = Date.now() + this.pollMs; this.save(lane); }
  private freeze(lane: Lane): void {
    const events = this.options.source.events(lane.room, { afterSeq: lane.covered, throughSeq: lane.target, limit: this.batchSize, inputBudgetBytes: this.batchBytes });
    if (!events.length) { lane.covered = lane.target; this.save(lane); return; }
    const sources = events.map(event => this.sourceRecord(event));
    if (Buffer.byteLength(JSON.stringify(sources)) > this.batchBytes) throw new IngestionError('SOURCE_BATCH_TOO_LARGE', true);
    const id = sha([lane.account, lane.room, sources.map(source => [source.seq, source.kind, source.id, source.digest])]);
    lane.batch = { id, sessionId: `ingest_${id}_1`, attempt: 1, abandoned: [], phase: 'prepared',
      through: events.at(-1)!.seq, sources, uncertainReads: 0, archiveRetries: 0 };
    lane.failures = 0; lane.lastError = null; this.save(lane); this.emit('prepared', lane);
  }
  private sourceRecord(event: MemoryEvent): SourceRecord {
    const timestamp = event.message?.timestamp ?? event.reply?.sentAt;
    if (timestamp === undefined || !Number.isFinite(timestamp)) throw new IngestionError('INVALID_SOURCE_TIME', true);
    return { seq: event.seq, kind: event.kind, id: event.sourceId, digest: event.digest, message: {
      role: event.kind === 'message' ? 'user' : 'assistant', content: event.text, sourceMessageId: event.sourceId,
      timestamp, ...(event.kind === 'message' ? { authorId: event.authorId! } : {}),
    } };
  }
  private verifySources(lane: Lane) {
    const sources = lane.batch!.sources, current = this.options.source.eventsBySeq(lane.room, sources.map(source => source.seq));
    if (current.length !== sources.length || current.some((event, i) => event.digest !== sources[i].digest || event.sourceId !== sources[i].id || event.kind !== sources[i].kind))
      throw new IngestionError('SOURCE_CHANGED', true);
  }
  private verifyMessages(messages: unknown, batch: Batch): void {
    if (!Array.isArray(messages) || messages.length !== batch.sources.length) throw new IngestionError('SOURCE_RECEIPT_MISMATCH', true);
    for (let i = 0; i < messages.length; i++) {
      const got = object(messages[i]), want = batch.sources[i].message;
      const parts = got.parts;
      const text = Array.isArray(parts) && parts.every(part => part?.type === 'text' && typeof part.text === 'string') ? parts.map(part => part.text).join('') : got.content;
      if (got.role !== want.role || JSON.stringify(got.source_message_ids) !== JSON.stringify([want.sourceMessageId])
        || got.turn_id !== want.sourceMessageId || text !== want.content
        || (want.role === 'user' && got.peer_id !== memoryPeerId(want.authorId!))
        || (want.role === 'assistant' && got.peer_id != null)) throw new IngestionError('SOURCE_RECEIPT_MISMATCH', true);
    }
  }
  private async archive(lane: Lane, signal: AbortSignal): Promise<Record<string, any> | null> {
    try { return object(await this.service(lane).client.sessionArchive(lane.account, lane.batch!.sessionId, lane.batch!.archiveId ?? 'archive_001', signal)); }
    catch (error) { if (missing(error)) return null; throw error; }
  }
  private abandon(lane: Lane): void {
    const batch = lane.batch!;
    if (!['creating', 'appending'].includes(batch.phase)) throw new IngestionError('COMMIT_OUTCOME_UNKNOWN', true);
    if (batch.attempt >= this.maxSessionAttempts) throw new IngestionError('APPEND_RECOVERY_EXHAUSTED', true);
    batch.abandoned.push(batch.sessionId); lane.abandoned.push(batch.sessionId); batch.attempt++;
    batch.sessionId = `ingest_${batch.id}_${batch.attempt}`; batch.phase = 'prepared'; batch.uncertainReads = 0;
    lane.retryAt = Date.now() + this.retryMs; this.save(lane); this.emit('abandoned', lane);
  }
  private async step(lane: Lane, signal: AbortSignal): Promise<void> {
    this.service(lane);
    if (!lane.batch) this.freeze(lane);
    if (!lane.batch) return;
    this.verifySources(lane);
    const batch = lane.batch, client = this.service(lane).client;
    let meta: Record<string, any> | null;
    try { meta = object(await client.session(lane.account, batch.sessionId, signal)); }
    catch (error) { if (!missing(error)) throw error; meta = null; }
    if (!meta) {
      if (batch.phase === 'prepared') {
        batch.phase = 'creating'; this.save(lane);
        await client.createSession(lane.account, batch.sessionId, signal);
        meta = object(await client.session(lane.account, batch.sessionId, signal));
      } else if (batch.phase === 'creating') {
        if (++batch.uncertainReads >= this.uncertainChecks) this.abandon(lane); else this.pending(lane);
        return;
      } else throw new IngestionError('SESSION_MISSING_AFTER_APPEND', true);
    }
    if (meta.auto_commit_policy !== null) throw new IngestionError('AUTO_COMMIT_NOT_DISABLED', true);
    if (meta.session_id !== batch.sessionId || (meta.commit_count ?? 0) > 1) throw new IngestionError('SESSION_IDENTITY_MISMATCH', true);
    if (!['committing', 'archived'].includes(batch.phase) && (meta.commit_count ?? 0) !== 0)
      throw new IngestionError('UNEXPECTED_SESSION_COMMIT', true);
    const archived = await this.archive(lane, signal);
    if (archived) { await this.reconcileArchive(lane, archived, signal); return; }
    if (batch.phase === 'archived') throw new IngestionError('ARCHIVE_MISSING', true);
    if (batch.phase === 'committing') {
      if (++batch.uncertainReads >= this.maxFailures) throw new IngestionError('COMMIT_OUTCOME_UNKNOWN', true);
      this.pending(lane); return;
    }
    const messages = await client.sessionMessages(lane.account, batch.sessionId, signal);
    if (messages.length) {
      this.verifyMessages(messages, batch); batch.phase = 'appended'; batch.uncertainReads = 0; this.save(lane);
    } else if (batch.phase === 'appending') {
      if (meta.message_count !== 0) throw new IngestionError('SESSION_RECEIPT_INCOMPLETE');
      // Only a proven auto-commit-disabled, never-committed session may be abandoned.
      if (++batch.uncertainReads >= this.uncertainChecks) this.abandon(lane); else this.pending(lane);
      return;
    } else if (batch.phase === 'appended') throw new IngestionError('APPENDED_SOURCES_MISSING', true);
    else {
      batch.phase = 'appending'; this.save(lane);
      await client.appendSources(lane.account, batch.sessionId, batch.sources.map(source => source.message), signal);
      this.verifyMessages(await client.sessionMessages(lane.account, batch.sessionId, signal), batch);
      batch.phase = 'appended'; batch.uncertainReads = 0; this.save(lane);
    }
    this.verifySources(lane);
    signal.throwIfAborted();
    batch.phase = 'committing'; batch.uncertainReads = 0; this.save(lane);
    const committed = object(await client.commitSession(lane.account, batch.sessionId, signal));
    if (committed.status !== 'accepted' || committed.archived !== true || typeof committed.task_id !== 'string'
      || committed.archive_uri !== `viking://user/group/sessions/${batch.sessionId}/history/archive_001`)
      throw new IngestionError('COMMIT_RECEIPT_INVALID', true);
    batch.taskId = committed.task_id; batch.archiveId = 'archive_001'; batch.phase = 'archived'; this.save(lane);
    const archive = await this.archive(lane, signal);
    if (archive) await this.reconcileArchive(lane, archive, signal); else this.pending(lane);
  }
  private async reconcileArchive(lane: Lane, archive: Record<string, any>, signal: AbortSignal): Promise<void> {
    const batch = lane.batch!, client = this.service(lane).client;
    if (archive.archive_id !== 'archive_001' || !['pending', 'failed', 'completed'].includes(archive.status)
      || typeof archive.messages_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(archive.messages_sha256)) throw new IngestionError('INVALID_ARCHIVE', true);
    this.verifyMessages(archive.messages, batch);
    if (batch.phase !== 'archived') batch.uncertainReads = 0;
    batch.archiveId = archive.archive_id; batch.phase = 'archived'; this.save(lane);
    // .done is durable extraction completion even when the task history expired after restart.
    if (archive.status === 'completed') {
      this.verifySources(lane); lane.covered = batch.through; lane.batch = null;
      lane.failures = 0; lane.retryAt = 0; lane.lastError = null; lane.blocked = false; this.save(lane); this.emit('completed', lane); return;
    }
    const tasks = await client.sessionTasks(lane.account, batch.sessionId, signal);
    if (!Array.isArray(tasks) || tasks.some(task => object(task).resource_id !== batch.sessionId)) throw new IngestionError('INVALID_TASK_RECEIPT', true);
    const active = tasks.find(task => ['pending', 'running', 'cancelling'].includes(task.status));
    if (active) { batch.taskId = String(active.task_id); batch.uncertainReads = 0; this.pending(lane); return; }
    if (tasks.some(task => task.status === 'cancelled') || archive.failure?.stage === 'cancelled') throw new IngestionError('ARCHIVE_CANCELLED', true);
    if (tasks.some(task => task.status === 'completed') && archive.status === 'pending') {
      if (++batch.uncertainReads >= this.maxFailures) throw new IngestionError('EXTRACTION_COMPLETION_UNVERIFIED', true);
      this.pending(lane); return;
    }
    if (batch.archiveRetries >= this.maxFailures) throw new IngestionError('EXTRACTION_RETRY_EXHAUSTED', true);
    // Per-room serial processing prevents an older failed batch replaying over a later live batch.
    if (lane.lastError !== 'ARCHIVE_RETRY_READY') {
      lane.lastError = 'ARCHIVE_RETRY_READY'; lane.retryAt = Date.now() + this.retryMs; this.save(lane); return;
    }
    batch.archiveRetries++; this.save(lane);
    const recovered = object(await client.retrySessionArchive(lane.account, batch.sessionId, 'archive_001', archive.messages_sha256, signal));
    if (!['accepted', 'skipped'].includes(recovered.status)) throw new IngestionError('INVALID_RECOVERY_RECEIPT', true);
    if (typeof recovered.task_id === 'string') batch.taskId = recovered.task_id;
    lane.lastError = null; this.pending(lane);
  }
  whenIdle(signal?: AbortSignal): Promise<void> {
    if (this.closed) return Promise.reject(new Error('Ingestion is closed'));
    return new Promise((resolve, reject) => {
      const waiter = { resolve: () => { signal?.removeEventListener('abort', abort); resolve(); }, reject: (error: unknown) => { signal?.removeEventListener('abort', abort); reject(error); } };
      const abort = () => { this.waiters.delete(waiter); waiter.reject(signal?.reason ?? new Error('Aborted')); };
      if (signal?.aborted) { abort(); return; }
      signal?.addEventListener('abort', abort, { once: true }); this.waiters.add(waiter); this.kick();
    });
  }
  private settle() {
    if (this.running.size) return;
    const pending = this.lanes().filter(lane => lane.batch || lane.covered < lane.target);
    const failed = pending.find(lane => lane.blocked || (lane.lastError && lane.lastError !== 'ARCHIVE_RETRY_READY'));
    if (pending.length && !failed && !this.closed) return;
    for (const waiter of this.waiters) {
      if (this.closed) waiter.reject(new Error('Ingestion closed before idle'));
      else if (failed) waiter.reject(new IngestionError(failed.lastError ?? 'INGESTION_BLOCKED', failed.blocked));
      else waiter.resolve();
    }
    this.waiters.clear();
  }
  async close(): Promise<void> {
    this.closed = true;
    if (this.scheduled) clearImmediate(this.scheduled); if (this.timer) clearTimeout(this.timer);
    for (const run of this.running.values()) run.abort.abort(new Error('Ingestion closed'));
    await Promise.allSettled([...this.running.values()].map(run => run.promise)); this.settle();
  }
}
