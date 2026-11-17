import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { AdminOpenVikingModel } from '../src/admin/openviking-model.js';

const cleanup: Array<() => void> = [];
afterEach(() => { for (const clean of cleanup.splice(0).reverse()) clean(); });
const rootKey = 'fixture-root-secret-value';
const modelKey = 'fixture-model-secret-value';
const embeddingKey = 'fixture-embedding-secret-value';
const ok = (result: unknown, status = 200) => Response.json({ status: 'ok', result }, { status });
const revision = (content: string) => createHash('sha256').update(content).digest('hex');
const initialContent = () => JSON.stringify({
  server: { host: '127.0.0.1', port: 1934, root_api_key: rootKey, auth_mode: 'api_key', with_bot: false },
  storage: { workspace: '/private/fixture-memory-data', agfs: { backend: 'local' }, vectordb: { backend: 'local' } },
  embedding: { dense: { provider: 'local', model: 'unchanged-local-embedding', dimension: 512, api_key: embeddingKey } },
  vlm: { provider: 'openai', model: 'deepseek-flash', api_base: 'https://api.deepseek.com', api_key: modelKey,
    max_concurrent: 2, max_retries: 1, timeout: 60, extra_request_body: { thinking: { type: 'disabled' }, custom_flag: 'preserve' } },
  unrelated: { preserve: true },
}, null, 2) + '\n';

/** The native API intentionally returns secrets. Only the host's projected view may reach the browser. */
class NativeConfigHttp {
  content = initialContent();
  activeContent = this.content;
  instance: string | undefined = 'instance-before';
  restartRequired = false;
  restarting = false;
  rolledBack = false;
  supported = true;
  writable = true;
  formReadonly = false;
  clusterOverrides: string[] = [];
  busyStatus?: string;
  readGate?: Promise<void>;
  readyFailure = false;
  restartMode: 'success' | 'timeout' | 'rollback' | 'same-instance' | 'missing-instance' | 'empty-instance' = 'success';
  failure?: 'read' | 'save' | 'restart' | 'tasks';
  calls: Array<{ method: string; path: string; body?: any }> = [];
  get hash() { return revision(this.content); }
  get saves() { return this.calls.filter(call => call.method === 'PATCH'); }
  get restarts() { return this.calls.filter(call => call.path === '/api/v1/admin/restart'); }
  get view() {
    return { content: this.content, models: { vlm: { config: JSON.parse(this.content).vlm } },
      form_readonly: this.formReadonly, revision: this.hash, file_path: '/private/ov.conf', writable: this.writable,
      restart_required: this.restartRequired, overrides: { cluster: this.clusterOverrides, account: [] },
      restart: { supported: this.supported, instance_id: this.instance, restarting: this.restarting, rolled_back: this.rolledBack } };
  }
  fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input)), method = init?.method ?? 'GET';
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    this.calls.push({ method, path: url.pathname + url.search, body });
    if (url.pathname === '/ready') return Response.json({ status: this.readyFailure ? 'error' : 'ok', ready: !this.readyFailure }, { status: this.readyFailure ? 503 : 200 });
    expect(new Headers(init?.headers).get('X-API-Key')).toBe(rootKey);
    const failure = (operation: string) => this.failure === operation ? Response.json({ status: 'error', error: {
      code: 'INTERNAL', message: `Backend private details ${rootKey} ${modelKey} ${embeddingKey}`,
    } }, { status: 500 }) : undefined;
    if (url.pathname === '/api/v1/admin/configuration') {
      expect(url.searchParams.get('source')).toBe('file');
      if (method === 'GET') { await this.readGate; return failure('read') ?? ok(this.view); }
      if (method === 'PATCH') {
        const failed = failure('save'); if (failed) return failed;
        expect(body.revision).toBe(this.hash);
        expect(typeof body.content).toBe('string');
        this.content = body.content; this.restartRequired = true;
        return ok({ revision: this.hash, restart_required: true });
      }
    }
    if (url.pathname === '/api/v1/tasks') {
      const failed = failure('tasks'); if (failed) return failed;
      const status = url.searchParams.get('status');
      expect(['pending', 'running', 'cancelling']).toContain(status);
      expect(url.searchParams.get('include_internal')).toBe('true');
      expect(url.searchParams.get('pagination')).toBe('cursor'); expect(url.searchParams.get('limit')).toBe('1');
      return ok({ items: status === this.busyStatus ? [{ task_id: 'active-extraction', status, task_type: 'session_commit' }] : [], next_cursor: null });
    }
    if (url.pathname === '/api/v1/admin/restart') {
      const failed = failure('restart'); if (failed) return failed;
      expect(method).toBe('POST'); expect(body).toEqual({ revision: this.hash });
      const before = this.instance;
      this.restarting = this.restartMode === 'timeout';
      if (this.restartMode !== 'timeout') {
        this.instance = this.restartMode === 'same-instance' ? before : this.restartMode === 'missing-instance' ? undefined
          : this.restartMode === 'empty-instance' ? '' : 'instance-after';
        this.restartRequired = false;
        if (this.restartMode === 'rollback') { this.content = this.activeContent; this.rolledBack = true; }
        else this.activeContent = this.content;
      }
      return ok({ supported: true, instance_id: before, restarting: true, rolled_back: false }, 202);
    }
    throw new Error('Unexpected native fixture request: ' + method + ' ' + url.pathname);
  };
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'boe-ov-model-')); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const config = loadConfig(root, { stateDir: root });
  config.memory!.enabled = true; config.memory!.baseUrl = 'http://127.0.0.1:1934'; config.memoryApiKey = rootKey;
  const db = new DatabaseSync(join(root, 'state.sqlite')); cleanup.push(() => db.close());
  db.exec(`CREATE TABLE openviking_ingestion(lane TEXT PRIMARY KEY,room TEXT,account TEXT,mode TEXT,
    covered INTEGER,target INTEGER,batch TEXT,failures INTEGER DEFAULT 0,retry_at INTEGER DEFAULT 0,
    last_error TEXT,blocked INTEGER DEFAULT 0,abandoned TEXT DEFAULT '[]')`);
  const http = new NativeConfigHttp();
  const api = new AdminOpenVikingModel(config, { fetch: http.fetch, pollMs: 1, applyTimeoutMs: 30 });
  const draft = (changes: Record<string, unknown> = {}) => ({ revision: http.hash, model: 'updated-model',
    baseUrl: 'https://models.example/v1', thinking: 'default', ...changes });
  return { config, db, http, api, draft };
}
function expectNoSecrets(value: unknown, extra: string[] = []) {
  const text = JSON.stringify(value);
  for (const secret of [rootKey, modelKey, embeddingKey, ...extra]) expect(text).not.toContain(secret);
  expect(text).not.toContain('/private/');
}

describe('OpenViking model administration', () => {
  it('projects model fields and credential presence without exposing the native file or secrets', async () => {
    const { api, http } = setup();
    const view = await api.read();
    expect(view).toMatchObject({ available: true, model: 'deepseek-flash', baseUrl: 'https://api.deepseek.com',
      thinking: 'disabled', apiKeyConfigured: true, revision: http.hash, restartRequired: false, restartSupported: true });
    expectNoSecrets(view); expect(view).not.toHaveProperty('content'); expect(view).not.toHaveProperty('models');
    expect(http.saves).toHaveLength(0); expect(http.restarts).toHaveLength(0);
  });

  it.each([undefined, ''])('preserves a %s replacement key and changes only requested VLM fields', async apiKey => {
    const { api, config, http, draft } = setup(), original = JSON.parse(http.content);
    const result = await api.save(draft(apiKey === undefined ? {} : { apiKey }));
    expect(result).toMatchObject({ saved: true, applied: true, config: { model: 'updated-model', restartRequired: false } });
    const saved = JSON.parse(http.content);
    expect(saved.vlm.api_key).toBe(modelKey);
    expect(saved.vlm).toMatchObject({ provider: 'openai', model: 'updated-model', api_base: 'https://models.example/v1',
      timeout: 60, max_concurrent: 2, max_retries: 1, extra_request_body: { custom_flag: 'preserve' } });
    expect(saved.vlm.extra_request_body).not.toHaveProperty('thinking');
    expect({ ...saved, vlm: null }).toEqual({ ...original, vlm: null });
    expect(http.saves).toHaveLength(1); expect(http.restarts).toHaveLength(1);
    expect(http.calls.some(call => call.path === '/ready')).toBe(true);
    expect(existsSync(join(config.stateDir, 'openviking-model-maintenance.json'))).toBe(false);
    expectNoSecrets(result);
  });

  it('replaces the model key without changing the root or embedding credentials', async () => {
    const { api, http, draft } = setup();
    const key = 'fixture-new-model-secret';
    const result = await api.save(draft({ apiKey: key, thinking: 'enabled' }));
    const saved = JSON.parse(http.content);
    expect(saved.vlm.api_key).toBe(key); expect(saved.vlm.extra_request_body.thinking).toEqual({ type: 'enabled' });
    expect(saved.server.root_api_key).toBe(rootKey); expect(saved.embedding.dense.api_key).toBe(embeddingKey);
    expect(result).toMatchObject({ saved: true, applied: true, config: { apiKeyConfigured: true, thinking: 'enabled' } });
    expectNoSecrets(result, [key]);
  });

  it.each([
    { model: '' }, { model: 'model\nsecret' }, { baseUrl: 'http://remote.example/v1' },
    { baseUrl: 'https://user:password@example.com/v1' }, { baseUrl: 'https://example.com/v1?key=value' },
    { thinking: 'arbitrary' }, { apiKey: 'secret\nvalue' }, { apiKey: 123 }, { timeout: 10 },
  ])('rejects invalid or out-of-scope fields before saving: %j', async changes => {
    const { api, http, draft } = setup(), before = http.content;
    await expect(api.save(draft(changes))).rejects.toMatchObject({ status: 400 });
    expect(http.content).toBe(before); expect(http.saves).toHaveLength(0); expect(http.restarts).toHaveLength(0);
  });

  it.each(['model', 'baseUrl', 'apiKey'].flatMap(field => ['$MODEL_VALUE', '%MODEL_VALUE%', String.raw`\u0024MODEL_VALUE`].map(reference => ({ field, reference }))))(
    'rejects $field environment reference $reference rather than changing startup expansion', async ({ field, reference }) => {
      const { api, http, draft } = setup(), before = http.content;
      const value = field === 'baseUrl' ? 'https://models.example/' + reference : reference;
      await expect(api.save(draft({ [field]: value }))).rejects.toMatchObject({ status: 400 });
      expect(http.content).toBe(before); expect(http.saves).toHaveLength(0); expect(http.restarts).toHaveLength(0);
    },
  );

  it('rejects a stale revision without saving or restarting', async () => {
    const { api, http, draft } = setup();
    await expect(api.save(draft({ revision: 'a'.repeat(64) }))).rejects.toMatchObject({ status: 409 });
    expect(http.saves).toHaveLength(0); expect(http.restarts).toHaveLength(0);
  });

  it('rejects overlapping saves before the second request can change the model', async () => {
    const { api, http, draft } = setup();
    let release!: () => void; http.readGate = new Promise<void>(resolve => { release = resolve; });
    const first = api.save(draft({ model: 'first-update' }));
    await expect(api.save(draft({ model: 'second-update' }))).rejects.toMatchObject({ status: 409 });
    release(); expect(await first).toMatchObject({ saved: true, applied: true });
    expect(JSON.parse(http.content).vlm.model).toBe('first-update'); expect(http.saves).toHaveLength(1);
  });

  it.each(['pending', 'running', 'cancelling'])('saves but defers application while a backend task is %s', async status => {
    const { api, config, http, draft } = setup(); http.busyStatus = status;
    const result = await api.save(draft());
    expect(result).toMatchObject({ saved: true, applied: false, config: { restartRequired: true } });
    expect(http.saves).toHaveLength(1); expect(http.restarts).toHaveLength(0); expectNoSecrets(result);
    expect(existsSync(join(config.stateDir, 'openviking-model-maintenance.json'))).toBe(false);
    http.busyStatus = undefined;
    expect(await api.apply({ revision: http.hash })).toMatchObject({ applied: true, config: { restartRequired: false } });
    expect(http.saves).toHaveLength(1); expect(http.restarts).toHaveLength(1);
  });

  it('defers restart when the host has a frozen source batch, even before a backend task exists', async () => {
    const { api, http, db, draft } = setup();
    db.prepare('INSERT INTO openviking_ingestion(lane,room,account,mode,covered,target,batch) VALUES(?,?,?,?,?,?,?)')
      .run('live', 'room', 'account', 'live', 0, 2, JSON.stringify({ phase: 'creating' }));
    expect(await api.save(draft())).toMatchObject({ saved: true, applied: false });
    expect(http.saves).toHaveLength(1); expect(http.restarts).toHaveLength(0);
  });

  it('can apply a repaired model while a failed source batch is blocked and the backend is idle', async () => {
    const { api, config, http, db, draft } = setup();
    db.prepare('INSERT INTO openviking_ingestion(lane,room,account,mode,covered,target,batch,blocked) VALUES(?,?,?,?,?,?,?,?)')
      .run('live', 'room', 'account', 'live', 0, 2, JSON.stringify({ phase: 'archived' }), 1);
    expect(await api.save(draft())).toMatchObject({ saved: true, applied: true });
    expect(http.saves).toHaveLength(1); expect(http.restarts).toHaveLength(1);
    expect(existsSync(join(config.stateDir, 'openviking-model-maintenance.json'))).toBe(false);
    expect(db.prepare('SELECT covered,blocked FROM openviking_ingestion').get()).toEqual({ covered: 0, blocked: 1 });
  });

  it('leaves a saved revision pending when the native server cannot restart remotely', async () => {
    const { api, http, draft } = setup(); http.supported = false;
    expect(await api.save(draft())).toMatchObject({ saved: true, applied: false,
      config: { restartRequired: true, restartSupported: false } });
    expect(http.saves).toHaveLength(1); expect(http.restarts).toHaveLength(0);
  });

  it.each(['timeout', 'rollback', 'same-instance', 'missing-instance', 'empty-instance'] as const)('does not report application after %s restart evidence', async mode => {
    const { api, config, http, draft } = setup(); http.restartMode = mode;
    const result = await api.save(draft());
    expect(result).toMatchObject({ saved: true, applied: false });
    expect(http.restarts).toHaveLength(1); expectNoSecrets(result);
    expect(existsSync(join(config.stateDir, 'openviking-model-maintenance.json'))).toBe(false);
  });

  it('requires readiness after observing the new instance and revision', async () => {
    const { api, http, draft } = setup(); http.readyFailure = true;
    expect(await api.save(draft())).toMatchObject({ saved: true, applied: false });
    expect(http.instance).toBe('instance-after'); expect(http.restartRequired).toBe(false);
    expect(http.calls.some(call => call.path === '/ready')).toBe(true);
  });

  it.each(['restart', 'tasks'] as const)('keeps saved state visible and suppresses backend secrets after a %s failure', async failure => {
    const { api, http, draft } = setup(); http.failure = failure;
    const result = await api.save(draft());
    expect(result).toMatchObject({ saved: true, applied: false, config: { restartRequired: true } });
    expectNoSecrets(result);
  });

  it('returns a safe read failure and never forwards the backend error body on save', async () => {
    const { api, http, draft } = setup(); http.failure = 'read';
    const unavailable = await api.read();
    expect(unavailable).toMatchObject({ available: false }); expectNoSecrets(unavailable);
    http.failure = 'save';
    const error = await api.save(draft()).then(() => null, error => error);
    expect(error).toBeInstanceOf(Error); expectNoSecrets({ message: error.message });
    expect(http.restarts).toHaveLength(0);
  });

  it.each(['readonly', 'references', 'credentials', 'providers', 'backup', 'cluster-override'])('does not overwrite a %s configuration using the simple model form', async mode => {
    const { api, http, draft } = setup();
    if (mode === 'readonly') http.writable = false;
    else if (mode === 'references') http.formReadonly = true;
    else if (mode === 'cluster-override') http.clusterOverrides = ['vlm'];
    else {
      const config = JSON.parse(http.content);
      config.vlm[mode] = mode === 'credentials' ? [{ id: 'primary', api_key: 'extra-credential-secret' }]
        : mode === 'backup' ? { provider: 'openai', model: 'fallback', api_key: 'extra-backup-secret' }
          : { openai: { api_key: 'extra-provider-secret' } };
      http.content = JSON.stringify(config);
    }
    const view = await api.read(); expect(view).toMatchObject({ available: false }); expectNoSecrets(view, ['extra-credential-secret', 'extra-provider-secret', 'extra-backup-secret']);
    await expect(api.save(draft())).rejects.toBeInstanceOf(Error);
    expect(http.saves).toHaveLength(0); expect(http.restarts).toHaveLength(0);
  });

  it('does not call the native server when memory is disabled', async () => {
    const { api, config, http } = setup(); config.memory!.enabled = false;
    expect(await api.read()).toMatchObject({ available: false });
    expect(http.calls).toHaveLength(0);
  });
});
