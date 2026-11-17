import { describe, expect, it } from 'vitest';
import { OpenVikingCredentials } from '../src/memory/openviking-credentials.js';
import { memoryAccountId } from '../src/memory/openviking-client.js';

describe('OpenViking group credentials', () => {
  it('recovers lost provisioning replies and only returns USER keys, including after restart', async () => {
    const accounts = new Map<string, { role: string; api_key: string; user_id: string }[]>();
    let writes = 0;
    const request: typeof fetch = async (url, init) => {
      expect(new Headers(init?.headers).get('X-API-Key')).toBe('root-private');
      const path = new URL(String(url)).pathname;
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      const account = path.split('/')[5];
      if (body?.account_id) { accounts.set(body.account_id, []); writes++; throw new Error('lost create response'); }
      if (!accounts.has(account)) return Response.json({ status: 'error', error: { code: 'NOT_FOUND' } }, { status: 404 });
      if (body?.user_id) { accounts.get(account)!.push({ ...body, api_key: 'group-only-' + account }); writes++; throw new Error('lost user response'); }
      return Response.json({ status: 'ok', result: path.endsWith('/users') ? accounts.get(account) : { account_id: account } });
    };
    const options = { baseUrl: 'http://localhost:1933', rootKey: 'root-private', fetch: request };
    const credentials = new OpenVikingCredentials(options);
    const a = memoryAccountId('test', 'bot', 'a'), b = memoryAccountId('test', 'bot', 'b');
    const [key, duplicate] = await Promise.all([credentials.get(a), credentials.get(a)]);
    expect(key).toBe(duplicate); expect(key).toBe('group-only-' + a); expect(writes).toBe(2);
    expect(await new OpenVikingCredentials(options).get(a)).toBe(key); expect(writes).toBe(2);
    expect(await credentials.get(b)).not.toBe(key); expect(writes).toBe(4);
  });
  it('rejects elevated existing data identities and does not silently rotate keys', async () => {
    let calls = 0;
    const c = new OpenVikingCredentials({ baseUrl: 'http://localhost:1933', rootKey: 'secret', fetch: (async (_url, init) => {
      calls++; expect(init?.method).toBe('GET');
      return Response.json({ status: 'ok', result: [{ user_id: 'group', role: 'admin', api_key: 'admin-key' }] });
    }) as typeof fetch });
    await expect(c.get(memoryAccountId('test', 'bot', 'a'))).rejects.toThrow('must be USER');
    expect(calls).toBe(1);
  });
});
