import { describe, expect, it } from 'vitest';
import { OpenVikingClient, OpenVikingError, memoryAccountId, memoryPeerId, memberMemoryUri } from '../src/memory/openviking-client.js';
import { createHash } from 'node:crypto';

const account = memoryAccountId('test', 'bot', 'qq:one');
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const ok = (result: unknown) => Response.json({ status: 'ok', result });
const error = (status: number, code: string) => Response.json({ status: 'error', error: { code, message: 'private body must not escape' } }, { status });
describe('OpenViking host client', () => {
  it('isolates full host identity and never uses display names or path fragments', () => {
    expect(account).not.toBe(memoryAccountId('test', 'otherbot', 'qq:one'));
    expect(account).not.toBe(memoryAccountId('test', 'bot', 'qq:two'));
    expect(account).not.toBe(memoryAccountId('production', 'bot', 'qq:one'));
    expect(memberMemoryUri('../../x')).toMatch(/^viking:\/\/user\/group\/resources\/member-current\/member_[a-f0-9]{40}\.json$/);
  });
  it('rejects stale updates and late timed-out requests using server-side content conditions', async () => {
    let text: string | undefined; let late: (() => void) | undefined;
    const apply = (body: any) => {
      const op = body.operations[0];
      if ((op.if_absent && text !== undefined) || (op.expected_sha256 && (text === undefined || hash(text) !== op.expected_sha256))) return error(409, 'CONFLICT');
      text = op.content; return ok({ semantic_status: 'deferred' });
    };
    let delay = false;
    const client = new OpenVikingClient({ baseUrl: 'http://127.0.0.1:1933', credential: async id => { expect(id).toBe(account); return 'user-only'; },
      fetch: (async (url, init) => {
        expect(new Headers(init?.headers).get('X-API-Key')).toBe('user-only');
        if (String(url).includes('/read?')) return text === undefined ? error(404, 'NOT_FOUND') : ok(text);
        const body = JSON.parse(String(init?.body));
        expect(body.defer_processing).toBe(true);
        if (delay) { delay = false; late = () => { apply(body); }; throw new Error('socket closed'); }
        return apply(body);
      }) as typeof fetch });
    await client.writeMember(account, 'a', '{"revision":1}', null);
    const first = await client.read(account, memberMemoryUri('a'));
    delay = true;
    await expect(client.writeMember(account, 'a', '{"revision":2}', first!.sha256)).rejects.toMatchObject({ uncertain: true });
    await client.writeMember(account, 'a', '{"revision":3}', first!.sha256);
    late!(); // The delayed old write compares against revision 1, and cannot overwrite 3.
    expect((await client.read(account, memberMemoryUri('a')))!.text).toBe('{"revision":3}');
    await expect(client.writeMember(account, 'a', '{"revision":2}', first!.sha256)).rejects.toMatchObject({ code: 'CONFLICT', uncertain: false });
  });
  it('does not equate failed authorization or malformed reads with an absent profile', async () => {
    for (const response of [error(403, 'PERMISSION_DENIED'), ok({ text: 'wrong contract' }), new Response('invalid')]) {
      const client = new OpenVikingClient({ baseUrl: 'http://localhost:1933', credential: async () => 'k', fetch: (async () => response) as typeof fetch });
      await expect(client.read(account, memberMemoryUri('a'))).rejects.toBeInstanceOf(OpenVikingError);
    }
    const client = new OpenVikingClient({ baseUrl: 'http://localhost:1933', credential: async () => 'k', fetch: (async () => error(404, 'NOT_FOUND')) as typeof fetch });
    expect(await client.read(account, memberMemoryUri('a'))).toBeNull();
  });
  it('bounds responses and excludes secrets and provider content from errors', async () => {
    const client = new OpenVikingClient({ baseUrl: 'http://localhost:1933', credential: async () => 'secret', maxResponseBytes: 100,
      fetch: (async () => ok('private'.repeat(100))) as typeof fetch });
    try { await client.read(account, memberMemoryUri('a')); throw new Error('Expected rejection'); }
    catch (e) { expect(String(e)).toBe('OpenVikingError: OpenViking INVALID_RESPONSE (200)'); }
  });
  it('rejects resource escape before sending and rejects search results outside the scoped peer', async () => {
    let calls = 0;
    const client = new OpenVikingClient({ baseUrl: 'http://localhost:1933', credential: async () => 'k', fetch: (async () => { calls++; return ok({ memories: [{ uri: `viking://user/group/peers/${memoryPeerId('b')}/memories/profile.md`, abstract: 'B' }] }); }) as typeof fetch });
    for (const uri of ['viking://user/other/memories/x', 'viking://user/group/../other', 'viking://user/group/%2e%2e/other', 'viking://resources/x', 'viking://user/group/memories/a\nb', 'viking://user/group/memories/a\u007fb'])
      await expect(client.read(account, uri)).rejects.toThrow('outside');
    expect(calls).toBe(0);
    await expect(client.find(account, '背景', { memberId: 'a' })).rejects.toThrow('out-of-scope');
  });
  it('retrieves generated memory filenames containing spaces using encoded query parameters', async () => {
    const uri = 'viking://user/group/memories/entities/项目 overview.md';
    const client = new OpenVikingClient({ baseUrl: 'http://localhost:1933', credential: async () => 'k', fetch: (async (url) => {
      const endpoint = new URL(String(url));
      if (endpoint.pathname === '/api/v1/search/find') return ok({ memories: [{ uri, abstract: '学习目标' }] });
      expect(endpoint.pathname).toBe('/api/v1/content/read');
      expect(endpoint.searchParams.get('uri')).toBe(uri);
      expect(String(url)).not.toContain(' ');
      return ok('角色详细记忆');
    }) as typeof fetch });
    expect(await client.find(account, '学习')).toEqual([{ uri, text: '学习目标' }]);
    expect((await client.read(account, uri))?.text).toBe('角色详细记忆');
  });
  it('keeps retrieval bounded and sends no planning or rewrite requests', async () => {
    const client = new OpenVikingClient({ baseUrl: 'http://localhost:1933', credential: async () => 'k', fetch: (async (url, init) => {
      expect(String(url).endsWith('/api/v1/search/find')).toBe(true);
      const body = JSON.parse(String(init?.body)); expect(body.target_uri).toBe('viking://user/group');
      expect(body.context_type).toBe('memory');
      return ok({ memories: [{ uri: 'viking://user/group/memories/a.md', abstract: '中文' }, { uri: 'viking://user/group/memories/b.md', abstract: 'large'.repeat(100) }] });
    }) as typeof fetch });
    expect(await client.find(account, 'query', { maxBytes: 6 })).toEqual([{ uri: 'viking://user/group/memories/a.md', text: '中文' }]);
  });
});
