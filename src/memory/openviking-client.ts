import { createHash } from 'node:crypto';

export const OPENVIKING_COMMIT = '9ac008f9b86c91b79d6e93eb8df8ea7f4d48cecb';
export const MEMORY_USER = 'group';
export const MEMBER_DIRECTORY = `viking://user/${MEMORY_USER}/resources/member-current`;
const USER_ROOT = `viking://user/${MEMORY_USER}`;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

/** IDs come from the host's platform account and room, never from a model URI. */
export function memoryAccountId(namespace: string, botId: string, roomId: string): string {
  if (!namespace || !botId || !roomId) throw new Error('Memory account scope is incomplete');
  return 'boe_' + digest(JSON.stringify([namespace, botId, roomId])).slice(0, 40);
}
export function memoryPeerId(memberId: string): string {
  if (!memberId) throw new Error('Memory member identity is missing');
  return 'member_' + digest(memberId).slice(0, 40);
}
export function memberMemoryUri(memberId: string): string {
  return `${MEMBER_DIRECTORY}/${memoryPeerId(memberId)}.json`;
}

export class OpenVikingError extends Error {
  constructor(readonly code: string, readonly status: number, readonly uncertain: boolean) {
    // Backend bodies and URLs may contain private content. Never copy them to logs.
    super(`OpenViking ${code} (${status || 'transport'})`);
    this.name = 'OpenVikingError';
  }
}
export interface OpenVikingOptions {
  baseUrl: string;
  /** Resolves a user-role key for exactly this account; root keys are not data credentials. */
  credential: (accountId: string) => Promise<string>;
  timeoutMs?: number;
  maxResponseBytes?: number;
  fetch?: typeof fetch;
}
export interface MemoryHit { uri: string; text: string; score?: number }
export interface MemorySourceMessage {
  role: 'user' | 'assistant'; content: string; sourceMessageId: string;
  authorId?: string; timestamp: number;
}
export interface MemoryFile { text: string; sha256: string }
export interface MemoryListing { entries: Array<{ uri: string; isDirectory: boolean; modifiedAt?: number }>; truncated: boolean }
type Envelope = { status?: string; result?: unknown; error?: { code?: unknown } };

/** No hidden write retries: callers persist an intent and resolve uncertain outcomes by readback. */
export class OpenVikingClient {
  private readonly base: string;
  private readonly requestFetch: typeof fetch;
  constructor(private readonly options: OpenVikingOptions) {
    const url = new URL(options.baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
      throw new Error('Invalid OpenViking endpoint');
    this.base = url.toString().replace(/\/$/, '');
    this.requestFetch = options.fetch ?? fetch;
  }
  private async request<T>(accountId: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    if (!/^boe_[a-f0-9]{40}$/.test(accountId)) throw new Error('Invalid memory account');
    const key = await this.options.credential(accountId);
    if (!key || /[\r\n]/.test(key)) throw new Error('Memory credential unavailable');
    const combined = AbortSignal.any([AbortSignal.timeout(this.options.timeoutMs ?? 15_000), ...(signal ? [signal] : [])]);
    const mutation = body !== undefined;
    let response: Response;
    try {
      response = await this.requestFetch(this.base + path, {
        method: mutation ? 'POST' : 'GET', redirect: 'error', signal: combined,
        headers: { 'X-API-Key': key, ...(mutation ? { 'Content-Type': 'application/json' } : {}) },
        ...(mutation ? { body: JSON.stringify(body) } : {}),
      });
    } catch { throw new OpenVikingError(combined.aborted ? 'TIMEOUT_OR_ABORTED' : 'TRANSPORT', 0, mutation); }
    const chunks: Uint8Array[] = []; let bytes = 0;
    try {
      const reader = response.body?.getReader();
      if (!reader) throw new Error('Missing response');
      for (;;) {
        const { value, done } = await reader.read(); if (done) break;
        bytes += value.byteLength;
        if (bytes > (this.options.maxResponseBytes ?? 2_000_000)) { await reader.cancel(); throw new Error('Large response'); }
        chunks.push(value);
      }
    } catch { throw new OpenVikingError('INVALID_RESPONSE', response.status, mutation); }
    let value: Envelope;
    try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new OpenVikingError('INVALID_RESPONSE', response.status, mutation); }
    if (!response.ok || value.status !== 'ok') {
      const raw = value.error?.code;
      const code = typeof raw === 'string' && /^[A-Z_]{1,64}$/.test(raw) ? raw : 'REQUEST_FAILED';
      throw new OpenVikingError(code, response.status, mutation && response.status >= 500);
    }
    return value.result as T;
  }
  private assertReadable(uri: string): void {
    // OpenViking may name memory files with spaces; URLSearchParams encodes them on reads.
    if (!uri.startsWith(USER_ROOT + '/') || /[\x00-\x1f\x7f\\?#%]/.test(uri) || uri.split('/').some(p => p === '.' || p === '..'))
      throw new Error('Memory URI outside the bound user');
  }
  async read(accountId: string, uri: string, signal?: AbortSignal): Promise<MemoryFile | null> {
    this.assertReadable(uri);
    try {
      const text = await this.request<unknown>(accountId, '/api/v1/content/read?' + new URLSearchParams({ uri, raw: 'true' }), undefined, signal);
      if (typeof text !== 'string') throw new OpenVikingError('INVALID_RESPONSE', 200, false);
      return { text, sha256: digest(text) };
    } catch (error) {
      if (error instanceof OpenVikingError && error.status === 404 && error.code === 'NOT_FOUND') return null;
      throw error;
    }
  }
  /** Bounded listing under a host-selected directory, never trusting backend paths as authorization. */
  async list(accountId: string, uri: string, limit = 32, signal?: AbortSignal): Promise<MemoryListing> {
    this.assertReadable(uri);
    const count = Math.max(1, Math.min(100, Math.floor(limit)));
    try {
      const result = await this.request<unknown>(accountId, '/api/v1/fs/ls?' + new URLSearchParams({
        uri, recursive: 'true', output: 'original', node_limit: String(count), level_limit: '4',
        include_abstract: 'false', include_overview: 'false', sort_by: 'mtime', sort_order: 'desc',
      }), undefined, signal);
      if (!Array.isArray(result)) throw new OpenVikingError('INVALID_RESPONSE', 200, false);
      const entries: MemoryListing['entries'] = [];
      for (const raw of result) {
        if (!raw || typeof raw !== 'object' || typeof raw.uri !== 'string' || typeof raw.isDir !== 'boolean')
          throw new OpenVikingError('INVALID_RESPONSE', 200, false);
        this.assertReadable(raw.uri);
        if (!raw.uri.startsWith(uri + '/')) throw new Error('Memory listing returned an out-of-scope URI');
        const modifiedAt = typeof raw.modTime === 'string' ? Date.parse(raw.modTime)
          : typeof raw.mtime === 'number' ? raw.mtime * 1000 : NaN;
        entries.push({ uri: raw.uri, isDirectory: raw.isDir, ...(Number.isFinite(modifiedAt) ? { modifiedAt } : {}) });
      }
      // Reaching the ceiling is conservatively reported as incomplete; no unbounded follow-up scan.
      return { entries: entries.slice(0, count), truncated: result.length >= count };
    } catch (error) {
      if (error instanceof OpenVikingError && error.status === 404 && error.code === 'NOT_FOUND')
        return { entries: [], truncated: false };
      throw error;
    }
  }
  async ensureMemberDirectory(accountId: string, signal?: AbortSignal): Promise<void> {
    try { await this.request(accountId, '/api/v1/fs/mkdir', { uri: MEMBER_DIRECTORY }, signal); }
    catch (error) {
      if (!(error instanceof OpenVikingError) || !['ALREADY_EXISTS', 'CONFLICT'].includes(error.code)) throw error;
      const stat = await this.request<{ isDir?: boolean }>(accountId, '/api/v1/fs/stat?' + new URLSearchParams({ uri: MEMBER_DIRECTORY }), undefined, signal);
      if (stat.isDir !== true) throw new Error('Memory member directory is not a directory');
    }
  }
  async writeMember(accountId: string, memberId: string, text: string, expected: string | null, signal?: AbortSignal): Promise<void> {
    if (Buffer.byteLength(text) > 64_000) throw new Error('Member memory exceeds size limit');
    if (expected !== null && !/^[a-f0-9]{64}$/.test(expected)) throw new Error('Invalid member memory hash');
    await this.request(accountId, '/api/v1/content/batch-write', {
      root_uri: MEMBER_DIRECTORY,
      operations: [{ uri: memberMemoryUri(memberId), mode: 'replace', content: text,
        ...(expected === null ? { if_absent: true } : { expected_sha256: expected }) }],
      defer_processing: true, wait: true,
    }, signal);
  }
  async find(accountId: string, query: string, options: { memberId?: string; limit?: number; maxBytes?: number } = {}, signal?: AbortSignal): Promise<MemoryHit[]> {
    if (!query.trim() || query.length > 2000) throw new Error('Invalid memory query');
    const limit = Math.max(1, Math.min(8, options.limit ?? 4));
    const targets = options.memberId ? [`${USER_ROOT}/peers/${memoryPeerId(options.memberId)}/memories`,
      `${USER_ROOT}/memories/preferences/${memoryPeerId(options.memberId)}`] : [USER_ROOT];
    const results = await Promise.all(targets.map(async target => {
      try {
        return { target, result: await this.request<{ memories?: unknown[] }>(accountId, '/api/v1/search/find', {
          query, target_uri: target, context_type: 'memory', limit, read_content: false, include_provenance: true,
        }, signal) };
      } catch (error) {
        if (error instanceof OpenVikingError && error.status === 404 && error.code === 'NOT_FOUND') return { target, result: {} };
        throw error;
      }
    }));
    const hits: MemoryHit[] = []; let remaining = options.maxBytes ?? 6000;
    const candidates: MemoryHit[] = [];
    for (const { target, result } of results) for (const raw of result.memories ?? []) {
      if (!raw || typeof raw !== 'object') continue;
      const hit = raw as Record<string, unknown>;
      if (typeof hit.uri !== 'string' || typeof hit.abstract !== 'string') continue;
      this.assertReadable(hit.uri);
      if (!hit.uri.startsWith(target + '/')) throw new Error('Memory search returned an out-of-scope URI');
      candidates.push({ uri: hit.uri, text: hit.abstract, ...(typeof hit.score === 'number' ? { score: hit.score } : {}) });
    }
    const seen = new Set<string>();
    for (const hit of candidates.sort((a,b)=>(b.score ?? 0)-(a.score ?? 0))) {
      if (seen.has(hit.uri)) continue;
      seen.add(hit.uri);
      const size = Buffer.byteLength(hit.text);
      // Return complete entries; source reads are separately bounded by the tool layer.
      if (size > remaining) continue;
      hits.push(hit);
      remaining -= size; if (hits.length >= limit) break;
    }
    return hits;
  }
  async createSession(accountId: string, sessionId: string, signal?: AbortSignal): Promise<unknown> {
    this.assertSession(sessionId);
    return this.request(accountId, '/api/v1/sessions', {
      session_id: sessionId, auto_commit_policy: null,
      memory_policy: { self: { enabled: false }, peer: { enabled: true }, working_memory: { enabled: false },
        memory_types: ['profile', 'preferences', 'entities', 'events'] },
    }, signal);
  }
  async session(accountId: string, sessionId: string, signal?: AbortSignal): Promise<unknown> {
    this.assertSession(sessionId);
    return this.request(accountId, `/api/v1/sessions/${sessionId}`, undefined, signal);
  }
  /** Unbudgeted source audit; context() may truncate messages and cannot prove an append. */
  async sessionMessages(accountId: string, sessionId: string, signal?: AbortSignal): Promise<unknown[]> {
    this.assertSession(sessionId);
    const uri = `${USER_ROOT}/sessions/${sessionId}/messages.jsonl`;
    const raw = await this.request<unknown>(accountId, '/api/v1/content/read?' + new URLSearchParams({ uri, raw: 'true' }), undefined, signal);
    if (typeof raw !== 'string') throw new OpenVikingError('INVALID_SESSION_MESSAGES', 200, false);
    try { return raw.split('\n').filter(line => line.trim()).map(line => JSON.parse(line)); }
    catch { throw new OpenVikingError('INVALID_SESSION_MESSAGES', 200, false); }
  }
  async sessionArchive(accountId: string, sessionId: string, archiveId = 'archive_001', signal?: AbortSignal): Promise<unknown> {
    this.assertSession(sessionId);
    if (!/^archive_[0-9]+$/.test(archiveId)) throw new Error('Invalid memory archive identity');
    return this.request(accountId, `/api/v1/sessions/${sessionId}/archives/${archiveId}`, undefined, signal);
  }
  async sessionTasks(accountId: string, sessionId: string, signal?: AbortSignal): Promise<unknown> {
    this.assertSession(sessionId);
    return this.request(accountId, '/api/v1/tasks?' + new URLSearchParams({ task_type: 'session_commit', resource_id: sessionId, limit: '200' }), undefined, signal);
  }
  async retrySessionArchive(accountId: string, sessionId: string, archiveId: string, expectedMessagesSha256: string, signal?: AbortSignal): Promise<unknown> {
    this.assertSession(sessionId);
    if (!/^archive_[0-9]+$/.test(archiveId) || !/^[a-f0-9]{64}$/.test(expectedMessagesSha256)) throw new Error('Invalid memory archive recovery');
    return this.request(accountId, `/api/v1/sessions/${sessionId}/archives/${archiveId}/retry`, {
      expected_messages_sha256: expectedMessagesSha256, allow_ownerless_ready: true, allow_cancelled_failure: false,
    }, signal);
  }
  async appendSources(accountId: string, sessionId: string, messages: MemorySourceMessage[], signal?: AbortSignal): Promise<unknown> {
    this.assertSession(sessionId);
    if (!messages.length || messages.length > 100) throw new Error('Invalid memory source batch');
    return this.request(accountId, `/api/v1/sessions/${sessionId}/messages/batch`, {
      messages: messages.map(m => ({ role: m.role, content: m.content,
        ...(m.role === 'user' ? { peer_id: memoryPeerId(m.authorId ?? '') } : {}),
        created_at: new Date(m.timestamp).toISOString(), turn_id: m.sourceMessageId,
        source_message_ids: [m.sourceMessageId], message_kind: m.role === 'user' ? 'user_query' : 'assistant_step' })),
    }, signal);
  }
  async commitSession(accountId: string, sessionId: string, signal?: AbortSignal): Promise<unknown> {
    this.assertSession(sessionId);
    return this.request(accountId, `/api/v1/sessions/${sessionId}/commit`, { keep_recent_count: 0, enable_working_memory: false }, signal);
  }
  async task(accountId: string, taskId: string, signal?: AbortSignal): Promise<unknown> {
    this.assertSession(taskId);
    return this.request(accountId, `/api/v1/tasks/${taskId}`, undefined, signal);
  }
  private assertSession(value: string): void {
    if (!/^[a-zA-Z0-9_-]{1,180}$/.test(value)) throw new Error('Invalid memory session/task identity');
  }
}
