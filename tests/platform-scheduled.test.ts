import { afterEach, describe, expect, it } from 'vitest';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { normalizeOneBotMessage, OneBotAdapter } from '../src/platform/onebot.js';

const adapters: OneBotAdapter[] = [];
afterEach(async () => { await Promise.all(adapters.splice(0).map(adapter => adapter.close())); });
function adapter() {
  const value = new OneBotAdapter({ selfId: '900', accessToken: 'schedule-test-only', allowedGroupIds: ['100'], port: 0, actionTimeoutMs: 500, onMessage: async () => {} });
  adapters.push(value); return value;
}
async function connected() {
  const host = adapter(); await host.start();
  const client = new WebSocket(`ws://127.0.0.1:${host.port}/onebot/v11/ws`, { headers: { Authorization: 'Bearer schedule-test-only', 'X-Self-ID': '900' } });
  await once(client, 'open');
  const requests: Array<{ action: string; params: Record<string, unknown>; echo: string }> = [];
  let reply: Record<string, unknown> = { group_id: 100, user_id: 301, role: 'member' };
  client.on('message', raw => { const request = JSON.parse(raw.toString()); requests.push(request); client.send(JSON.stringify({ status: 'ok', retcode: 0, data: reply, echo: request.echo })); });
  return { host, requests, setReply: (value: Record<string, unknown>) => { reply = value; } };
}

describe('OneBot scheduled task role evidence', () => {
  it.each([
    ['owner', 'group_admin', true], ['admin', 'group_admin', true], ['member', 'member', false],
    ['custom', 'unknown', false], [undefined, 'unknown', false],
  ])('normalizes sender role %s to %s without guessing privilege', (role, expected, isAdmin) => {
    const before = Date.now();
    const message = normalizeOneBotMessage({ post_type: 'message', message_type: 'group', self_id: 900, user_id: 301, group_id: 100, message_id: 11,
      sender: { nickname: 'Alice', role }, message: [{ type: 'text', data: { text: '明天提醒我检查资料' } }] }, '900', new Set(['100']));
    expect(message).toMatchObject({ authorId: '301', roomId: 'qq:900:100', memberRoleGroup: expected, isAdmin });
    expect(message!.roleVerifiedAt).toBeGreaterThanOrEqual(before); expect(message!.roleVerifiedAt).toBeLessThanOrEqual(Date.now());
  });

  it('fetches fresh role evidence for every lookup and reflects demotion immediately', async () => {
    const f = await connected();
    for (const [role, expected] of [['owner', 'group_admin'], ['admin', 'group_admin'], ['member', 'member'], ['custom', 'unknown']]) {
      f.setReply({ group_id: '100', user_id: '301', role }); const before = Date.now();
      const evidence = await f.host.resolveMemberRole('qq:900:100', '301');
      expect(evidence.roleGroup).toBe(expected); expect(evidence.verifiedAt).toBeGreaterThanOrEqual(before); expect(evidence.verifiedAt).toBeLessThanOrEqual(Date.now());
    }
    expect(f.requests).toHaveLength(4);
    for (const request of f.requests) expect(request).toMatchObject({ action: 'get_group_member_info', params: { group_id: '100', user_id: '301', no_cache: true } });
    expect(new Set(f.requests.map(request => request.echo)).size).toBe(4);
  });

  it('rejects mismatched or missing reply identities even when a reply claims owner status', async () => {
    const f = await connected();
    for (const identity of [{ group_id: 101, user_id: 301 }, { group_id: 100, user_id: 302 }, { group_id: 100 }, { user_id: 301 }, { group_id: '0100', user_id: 301 }]) {
      f.setReply({ ...identity, role: 'owner' });
      await expect(f.host.resolveMemberRole('qq:900:100', '301')).rejects.toThrow('identity mismatch');
    }
  });

  it('rejects foreign rooms and malformed member identities before making a platform call', async () => {
    const f = await connected();
    for (const [roomId, memberId] of [['qq:901:100', '301'], ['qq:900:101', '301'], ['room', '301'], ['qq:900:100', ''], ['qq:900:100', '0'], ['qq:900:100', '301:other']]) {
      await expect(f.host.resolveMemberRole(roomId, memberId)).rejects.toThrow('Invalid member scope');
    }
    expect(f.requests).toHaveLength(0);
  });

  it('fails closed when live role verification is unavailable', async () => {
    await expect(adapter().resolveMemberRole('qq:900:100', '301')).rejects.toMatchObject({ code: 'not_connected' });
  });
});
