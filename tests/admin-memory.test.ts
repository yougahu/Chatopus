import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AdminMemoryApi } from '../src/admin/memory.js';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/store.js';
import type { GroupMessage } from '../src/types.js';
import { memoryAccountId, memoryPeerId, memberMemoryUri } from '../src/memory/openviking-client.js';
import { OpenVikingCredentials } from '../src/memory/openviking-credentials.js';
import * as automaticProfiles from '../src/memory/automatic-member-profile.js';

const cleanup: (() => void)[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const fn of cleanup.splice(0).reverse()) fn(); });
const url = (route = '', params: Record<string, string> = {}) => new URL('http://localhost/api/memory' + route + '?' + new URLSearchParams(params));
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'boe-memory-admin-')); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const config = loadConfig(root, { stateDir: root, apiKey: 'model-private-key' });
  config.memory!.enabled = true; config.memory!.namespace = 'admin-test'; config.memoryApiKey = 'root-private-key'; config.qq.selfId = 'bot';
  const store = new Store(join(root, 'state.sqlite')); cleanup.push(() => store.close());
  const message = (room: string, id: string, author: string, at: number): GroupMessage => ({
    id, roomId: room, messageId: 'platform-' + id, authorId: author, authorName: author + '-name', timestamp: at,
    text: 'original ' + id, platform: 'qq', mentions: [], attachments: [], isMentioned: false, isAdmin: false,
  });
  store.ingest(message('a', 'a1', 'alice', 100)); store.ingest(message('b', 'b1', 'charlie', 101));
  store.ingest(message('a', 'a2', 'bob', 102)); store.ingest(message('a', 'a3', 'alice', 103));
  const api = new AdminMemoryApi(config), account = memoryAccountId('admin-test', 'bot', 'a');
  return { root, config, store, api, account, message };
}
function backend(result: (path: string, init?: RequestInit) => unknown) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const endpoint = new URL(String(input));
    if (endpoint.pathname.includes('/admin/accounts/')) {
      expect(init?.method).toBe('GET'); expect(new Headers(init?.headers).get('X-API-Key')).toBe('root-private-key');
      expect(endpoint.pathname.endsWith('/users')).toBe(true);
      return Response.json({ status: 'ok', result: [{ user_id: 'group', role: 'user', api_key: 'group-private-key' }] });
    }
    expect(new Headers(init?.headers).get('X-API-Key')).toBe('group-private-key');
    return Response.json({ status: 'ok', result: result(endpoint.pathname + endpoint.search, init) });
  });
}
describe('read-only shared memory administration', () => {
  it('lists local rooms and paged latest member names without any backend requests or database writes', async () => {
    const { api, store, root } = setup(), fetch = vi.spyOn(globalThis, 'fetch');
    store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); const before = readFileSync(join(root, 'state.sqlite'));
    expect(await api.data(url())).toMatchObject({ enabled: true, available: true, connection: 'not_checked', rooms: [
      { id: 'a', name: 'a', memberCount: 2 }, { id: 'b', name: 'b', memberCount: 1 },
    ] });
    expect(await api.data(url('/members', { room: 'a', limit: '1' }))).toEqual({ room: 'a', members: [{ id: 'alice', name: 'alice-name', lastSeen: 103 }], offset: 0, hasMore: true, nextOffset: 1 });
    expect(await api.data(url('/members', { room: 'a', offset: '1', limit: '1' }))).toMatchObject({ members: [{ id: 'bob' }], hasMore: false, nextOffset: null });
    await expect(api.data(url('/members', { room: 'unknown' }))).rejects.toMatchObject({ status: 404 });
    await expect(api.data(url('/members', { room: 'a', offset: '-1' }))).rejects.toMatchObject({ status: 400 });
    await expect(api.data(url('/members', { room: 'a', limit: '101' }))).rejects.toMatchObject({ status: 400 });
    expect(fetch).not.toHaveBeenCalled(); expect(readFileSync(join(root, 'state.sqlite'))).toEqual(before);
  });
  it('searches QQ IDs and latest group nicknames with trimmed, case-insensitive substring matching', async () => {
    const { api, store, message } = setup(), fetch = vi.spyOn(globalThis, 'fetch');
    store.ingest({ ...message('a', 'a4', '123456789', 104), authorName: '晨光 Dawn' });
    store.ingest({ ...message('a', 'a5', 'alice', 105), authorName: '当前昵称' });
    store.ingest({ ...message('b', 'b2', 'alice', 200), authorName: '别群昵称' });
    expect(await api.data(url('/members', { room: 'a', q: ' 4567 ' }))).toEqual({ room: 'a',
      members: [{ id: '123456789', name: '晨光 Dawn', lastSeen: 104 }], offset: 0, hasMore: false, nextOffset: null });
    for (const q of ['晨光', 'dAwN'])
      expect(await api.data(url('/members', { room: 'a', q }))).toMatchObject({ members: [{ id: '123456789' }] });
    for (const q of ['ALI', '当前'])
      expect(await api.data(url('/members', { room: 'a', q }))).toMatchObject({ members: [{ id: 'alice', name: '当前昵称', lastSeen: 105 }] });
    for (const q of ['alice-name', '别群昵称', 'charlie'])
      expect(await api.data(url('/members', { room: 'a', q }))).toMatchObject({ members: [], hasMore: false, nextOffset: null });
    const unfiltered = await api.data(url('/members', { room: 'a' }));
    for (const q of ['', '   ']) expect(await api.data(url('/members', { room: 'a', q }))).toEqual(unfiltered);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('paginates matching members after deduplication and filtering', async () => {
    const { api, store, message } = setup();
    for (let n = 0; n < 3; n++)
      store.ingest({ ...message('a', 'match-' + n, 'member-' + n, 110 + n), authorName: '目标成员' + n });
    store.ingest({ ...message('a', 'match-latest', 'member-2', 115), authorName: '最新目标成员' });
    store.ingest({ ...message('a', 'unmatched', 'unmatched', 120), authorName: '其他成员' });
    expect(await api.data(url('/members', { room: 'a', q: '目标', limit: '2' }))).toEqual({ room: 'a', members: [
      { id: 'member-2', name: '最新目标成员', lastSeen: 115 }, { id: 'member-1', name: '目标成员1', lastSeen: 111 },
    ], offset: 0, hasMore: true, nextOffset: 2 });
    expect(await api.data(url('/members', { room: 'a', q: '目标', limit: '2', offset: '2' }))).toEqual({ room: 'a',
      members: [{ id: 'member-0', name: '目标成员0', lastSeen: 110 }], offset: 2, hasMore: false, nextOffset: null });
    expect(await api.data(url('/members', { room: 'a', q: '目标', limit: '2', offset: '3' }))).toEqual({ room: 'a',
      members: [], offset: 3, hasMore: false, nextOffset: null });
  });
  it('treats search wildcard and SQL syntax literally and only matches displayed nickname values', async () => {
    const { api, store, message } = setup();
    store.ingest({ ...message('a', 'percent', 'percent', 110), authorName: '百分%号' });
    store.ingest({ ...message('a', 'underscore', 'underscore', 111), authorName: '下_划线' });
    const malformed = { ...message('a', 'malformed', 'malformed', 112), authorName: 7890 };
    store.db.prepare('INSERT INTO messages(id,room,at,data) VALUES(?,?,?,?)').run(malformed.id, malformed.roomId, malformed.timestamp, JSON.stringify(malformed));
    expect(await api.data(url('/members', { room: 'a', q: '%' }))).toMatchObject({ members: [{ id: 'percent' }] });
    expect(await api.data(url('/members', { room: 'a', q: '_' }))).toMatchObject({ members: [{ id: 'underscore' }] });
    for (const q of ["' OR 1=1 --", '7890'])
      expect(await api.data(url('/members', { room: 'a', q }))).toMatchObject({ members: [] });
    expect(await api.data(url('/members', { room: 'a', q: 'malformed' }))).toMatchObject({ members: [{ id: 'malformed', name: 'malformed' }] });
  });
  it('bounds member queries and rejects control characters before trimming', async () => {
    const { api, store, message } = setup(), name = 'x'.repeat(100);
    store.ingest({ ...message('a', 'long-name', 'long-name', 110), authorName: name });
    expect(await api.data(url('/members', { room: 'a', q: ' ' + name + ' ' }))).toMatchObject({ members: [{ id: 'long-name' }] });
    for (const q of ['x'.repeat(101), 'alice\x00', 'alice\x1f', '\nalice', 'alice\t', '\x7f', '\x85'])
      await expect(api.data(url('/members', { room: 'a', q }))).rejects.toMatchObject({ status: 400 });
    await expect(api.data(new URL('http://localhost/api/memory/members?room=a&q=alice&q=bob'))).rejects.toMatchObject({ status: 400 });
  });
  it('never connects disabled, missing-credential, missing-state or non-main sources to the live account', async () => {
    const { api, config, root } = setup(), fetch = vi.spyOn(globalThis, 'fetch');
    expect(await api.data(url('', { source: 'ask-anything' }))).toMatchObject({ available: false, rooms: [] });
    for (const path of ['/members', '/profile', '/search', '/source', '/status', '/content'])
      await expect(api.data(url(path, { source: '../main' }))).rejects.toMatchObject({ status: 503 });
    config.memory!.enabled = false;
    expect(await api.data(url())).toMatchObject({ enabled: false, available: false });
    config.memory!.enabled = true; config.memoryApiKey = '';
    expect(await new AdminMemoryApi(config).data(url())).toMatchObject({ available: false });
    config.memoryApiKey = 'root-private-key'; config.stateDir = join(root, 'absent');
    expect(await new AdminMemoryApi(config).data(url())).toMatchObject({ available: false });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('uses only existing USER identities; missing identities never trigger account or user creation', async () => {
    const { api, account } = setup();
    const request = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ status: 'error', error: { code: 'NOT_FOUND' } }, { status: 404 }));
    const credentials = new OpenVikingCredentials({ baseUrl: 'http://localhost:1933', rootKey: 'root-private-key' });
    expect(await credentials.lookupExisting(account)).toBeNull();
    // Each call needs a fresh body, as a real HTTP exchange would provide.
    request.mockImplementation(async () => Response.json({ status: 'ok', result: [] }));
    await expect(api.data(url('/profile', { room: 'a', member: 'alice' }))).rejects.toMatchObject({ status: 503 });
    expect(request.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true);
    request.mockImplementation(async () => Response.json({ status: 'ok', result: [{ user_id: 'group', role: 'admin', api_key: 'elevated-private' }] }));
    await expect(credentials.lookupExisting(account)).rejects.toThrow('must be USER');
  });
  it('reads confirmed profiles, preserves clears/expiry and resolves only same-member source messages', async () => {
    const { api, account } = setup();
    const document = { schemaVersion: 1, memberId: 'alice', revision: 2, commitId: 'commit-1', updatedAt: 200,
      fields: { preferredName: { state: 'set', value: 'Alice', sourceMessageId: 'a1', sourceOrder: 1, updatedAt: 200 },
        retiredTag: { state: 'cleared', sourceMessageId: 'a2', sourceOrder: 3, updatedAt: 201 },
        language: { state: 'set', value: '中文', sourceMessageId: 'b1', sourceOrder: 2, updatedAt: 200, expiresAt: 1 } } };
    const request = backend((path, init) => { expect(init?.method).toBe('GET'); expect(new URL('http://local' + path).searchParams.get('uri')).toBe(memberMemoryUri('alice')); return JSON.stringify(document); });
    expect(await api.data(url('/profile', { room: 'a', member: 'alice' }))).toMatchObject({ exists: true, revision: 2, fields: [
      { key: 'preferredName', value: 'Alice', sourceAvailable: true }, { key: 'language', expired: true, sourceAvailable: false }, { key: 'retiredTag', state: 'cleared', sourceAvailable: false },
    ] });
    expect(String(request.mock.calls[0][0])).toContain('/' + account + '/users');
    const count = request.mock.calls.length;
    await expect(api.data(url('/profile', { room: 'a', member: 'charlie' }))).rejects.toMatchObject({ status: 404 });
    expect(request).toHaveBeenCalledTimes(count);
    document.memberId = 'bob';
    await expect(api.data(url('/profile', { room: 'a', member: 'alice' }))).rejects.toMatchObject({ status: 503 });
  });
  it('exposes automatic records even without explicit fields, with sources restricted to the same member and room', async () => {
    const { api, account } = setup(), uri = `viking://user/group/peers/${memoryPeerId('alice')}/memories/profile.md`;
    const readAutomatic = vi.spyOn(automaticProfiles, 'readAutomaticMemberProfile').mockResolvedValue({ entries: [{
      uri, type: 'profile', text: '自动内容 model-private-key', verification: 'unverified',
      sourceMessageIds: ['a1', 'a2', 'b1', 'missing'], sha256: 'digest', truncated: false,
    }], truncated: true });
    const request = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const path = new URL(String(input)).pathname;
      expect(init?.method).toBe('GET');
      if (path.includes('/admin/accounts/')) return Response.json({ status: 'ok', result: [{ user_id: 'group', role: 'user', api_key: 'group-private-key' }] });
      return Response.json({ status: 'error', error: { code: 'NOT_FOUND' } }, { status: 404 });
    });
    expect(await api.data(url('/profile', { room: 'a', member: 'alice' }))).toEqual({ room: 'a', member: 'alice', exists: false,
      revision: null, updatedAt: null, fields: [], automatic: { entries: [{ uri, type: 'profile', text: '自动内容 [redacted]',
        verification: 'unverified', sourceMessageIds: ['a1', 'a2', 'b1', 'missing'], sha256: 'digest', truncated: false,
        sources: [{ id: 'a1', available: true }, { id: 'a2', available: false }, { id: 'b1', available: false }, { id: 'missing', available: false }],
      }], truncated: true } });
    expect(readAutomatic).toHaveBeenCalledWith(expect.anything(), account, 'alice', { maxBytes: 6000, maxEntries: 8 });
    expect(request.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true);
  });
  it('keeps explicit preferences separate and readable when automatic retrieval fails', async () => {
    const { api } = setup();
    const document = { schemaVersion: 1, memberId: 'alice', revision: 1, commitId: 'commit-1', updatedAt: 200,
      fields: { preferredName: { state: 'set', value: 'Explicit Alice', sourceMessageId: 'a1', sourceOrder: 1, updatedAt: 200 } } };
    backend(() => JSON.stringify(document));
    const automatic = vi.spyOn(automaticProfiles, 'readAutomaticMemberProfile').mockResolvedValue({ entries: [{
      uri: `viking://user/group/peers/${memoryPeerId('alice')}/memories/profile.md`, type: 'profile', text: 'Automatic Bob',
      verification: 'unverified', sourceMessageIds: [], sha256: 'digest', truncated: false,
    }], truncated: false });
    expect(await api.data(url('/profile', { room: 'a', member: 'alice' }))).toMatchObject({ fields: [{ value: 'Explicit Alice' }],
      automatic: { entries: [{ text: 'Automatic Bob', verification: 'unverified' }] } });
    automatic.mockRejectedValue(new Error('root-private-key /private/backend/path'));
    expect(await api.data(url('/profile', { room: 'a', member: 'alice' }))).toMatchObject({ fields: [{ value: 'Explicit Alice' }],
      automatic: { entries: [], truncated: false, unavailable: true } });
  });
  it('bounds searches to persisted room/member identity and strips secret values and unsafe hits', async () => {
    const { api } = setup(), safe = `viking://user/group/peers/${memoryPeerId('alice')}/memories/preferences/item.md`;
    backend((path, init) => {
      expect(path).toBe('/api/v1/search/find'); expect(init?.method).toBe('POST');
      const body = JSON.parse(String(init?.body)); expect(body.target_uri).toBe('viking://user/group'); expect(body.limit).toBe(8);
      return { memories: [{ uri: safe, abstract: 'root-private-key group-private-key model-private-key', score: 0.9 },
        { uri: 'viking://user/group/sessions/private/messages.jsonl', abstract: 'session transcript' },
        { uri: `viking://user/group/peers/${memoryPeerId('charlie')}/memories/item.md`, abstract: 'unknown member' }] };
    });
    expect(await api.data(url('/search', { room: 'a', q: 'document' }))).toMatchObject({ hits: [{ uri: safe, text: '[redacted] [redacted] [redacted]', score: 0.9 }] });
    await expect(api.data(url('/search', { room: 'a', q: 'x'.repeat(2001) }))).rejects.toMatchObject({ status: 400 });
    await expect(api.data(url('/search', { room: 'a', member: 'charlie', q: 'x' }))).rejects.toMatchObject({ status: 404 });
  });
  it('rejects arbitrary credentials, paths, private sessions and traversal before accessing OpenViking', async () => {
    const { api } = setup(), request = vi.spyOn(globalThis, 'fetch');
    for (const uri of ['viking://user/other/memories/x', 'viking://accounts/other/x', 'viking://user/group/sessions/x',
      'viking://user/group/memories/../sessions/x', 'viking://user/group/memories/%2e%2e/x', 'viking://user/group/memories/private/x',
      'viking://user/group/memories/.secret', 'viking://user/group/resources/member-current/anything.json',
      `viking://user/group/peers/${memoryPeerId('stranger')}/memories/x`, 'file:///etc/passwd'])
      await expect(api.data(url('/content', { room: 'a', uri }))).rejects.toMatchObject({ status: 400 });
    await expect(api.data(url('/profile', { room: 'a', member: 'alice', account: 'other' }))).rejects.toMatchObject({ status: 400 });
    await expect(api.data(url('/unknown'))).rejects.toMatchObject({ status: 404 });
    expect(request).not.toHaveBeenCalled();
  });
  it('pages raw memory text without splitting Unicode characters and returns safe failures', async () => {
    const { api, config } = setup(); config.memory!.recallBytes = 4;
    const uri = 'viking://user/group/memories/preferences/item.md';
    backend(() => '😀中');
    expect(await api.data(url('/content', { room: 'a', uri }))).toMatchObject({ text: '😀', offset: 0, nextOffset: 2, totalCharacters: 3 });
    expect(await api.data(url('/content', { room: 'a', uri, offset: '2' }))).toMatchObject({ text: '中', nextOffset: null });
    await expect(api.data(url('/content', { room: 'a', uri, offset: '1' }))).rejects.toMatchObject({ status: 400 });
    vi.mocked(fetch).mockRejectedValue(new Error('root-private-key transport /private/path'));
    try { await api.data(url('/content', { room: 'a', uri })); throw new Error('must fail'); }
    catch (error) { expect(error).toMatchObject({ status: 503 }); expect(String(error)).not.toMatch(/private-key|\/private\/path/); }
  });
  it('binds original messages and confirmed outbox sources to both persisted and serialized room identity', async () => {
    const { api, store } = setup();
    expect(await api.data(url('/source', { room: 'a', id: 'a1' }))).toMatchObject({ kind: 'message', authorId: 'alice', text: 'original a1' });
    await expect(api.data(url('/source', { room: 'a', id: 'b1' }))).rejects.toMatchObject({ status: 404 });
    const outgoingId = store.enqueue({ roomId: 'a', text: 'confirmed answer' }, {});
    const outgoing = store.outbox().find(row => row.id === outgoingId)!;
    await expect(api.data(url('/source', { room: 'a', id: outgoing.id }))).rejects.toMatchObject({ status: 404 });
    outgoing.status = 'sent'; outgoing.sentAt = 300; outgoing.platformMessageId = 'sent-1'; store.saveOutbox(outgoing);
    expect(await api.data(url('/source', { room: 'a', id: outgoing.id }))).toMatchObject({ kind: 'reply', messageId: 'sent-1', text: 'confirmed answer' });
    outgoing.message.roomId = 'b'; store.saveOutbox(outgoing);
    await expect(api.data(url('/source', { room: 'a', id: outgoing.id }))).rejects.toMatchObject({ status: 404 });
  });
  it('reports only current live account ingestion and counts room events instead of subtracting global cursors', async () => {
    const { api, store, account } = setup();
    store.db.exec(`CREATE TABLE openviking_ingestion(lane TEXT PRIMARY KEY,room TEXT,account TEXT,mode TEXT,covered INTEGER,target INTEGER,batch TEXT,failures INTEGER,retry_at INTEGER,last_error TEXT,blocked INTEGER)`);
    const insert = store.db.prepare('INSERT INTO openviking_ingestion VALUES(?,?,?,?,?,?,?,?,?,?,?)');
    insert.run('live', 'a', account, 'live', 1, 4, JSON.stringify({ phase: 'committing', sources: ['DO_NOT_EXPOSE'], taskId: 'PRIVATE' }), 1, 400, 'TIMEOUT_OR_ABORTED', 0);
    insert.run('sample', 'a', account, 'sample', 0, 900, null, 0, 0, null, 0);
    insert.run('old', 'a', 'old-account', 'live', 0, 900, null, 0, 0, null, 0);
    expect(await api.data(url('/status', { room: 'a' }))).toEqual({ room: 'a', tracked: true, lanes: [
      { mode: 'live', covered: 1, target: 4, pending: 2, batchPhase: 'committing', failures: 1, retryAt: 400, lastError: 'TIMEOUT_OR_ABORTED', blocked: false },
    ] });
    expect(await api.data(url('/status', { room: 'b' }))).toEqual({ room: 'b', tracked: false, lanes: [] });
    expect(await api.data(url())).toMatchObject({ ingestion: { laneCount: 1, blocked: 0, retrying: 1, pending: 2 } });
  });
});
