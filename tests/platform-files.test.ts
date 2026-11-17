import { afterEach, describe, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { OneBotAdapter } from '../src/platform/onebot.js';
import type { OutgoingFile } from '../src/types.js';

const adapters: OneBotAdapter[] = [], directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(adapters.splice(0).map(adapter => adapter.close()));
  await Promise.all(directories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});
async function artifact(contents = '# 文档译文\n\n这是一份 UTF-8 Markdown 文件。\n') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'boe2-publish-file-')); directories.push(root);
  const bytes = Buffer.from(contents), filename = path.join(root, 'translation.md');
  await fs.writeFile(filename, bytes);
  const file: OutgoingFile = { kind: 'file', artifactId: 'file-current-run', file: filename, name: '文档译文.md', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  return { root, file, bytes };
}
async function connect(adapter: OneBotAdapter) {
  const client = new WebSocket(`ws://127.0.0.1:${adapter.port}/onebot/v11/ws`, { headers: { Authorization: 'Bearer local-test', 'X-Self-ID': '900' } });
  await once(client, 'open'); return client;
}
async function setup(outputRoot?: string, actionTimeoutMs?: number) {
  const adapter = new OneBotAdapter({ selfId: '900', accessToken: 'local-test', allowedGroupIds: ['100'], port: 0, outputRoot, actionTimeoutMs, onMessage: async () => {} });
  adapters.push(adapter); await adapter.start();
  return { adapter, client: await connect(adapter) };
}

describe('QQ group file uploads', () => {
  it('transfers verified Markdown bytes with their display name and accepts a file receipt without a message ID', async () => {
    const { root, file, bytes } = await artifact(), { adapter, client } = await setup(root);
    const packets: any[] = [];
    client.on('message', raw => {
      const packet = JSON.parse(raw.toString()); packets.push(packet);
      client.send(JSON.stringify({ echo: packet.echo, status: 'ok', retcode: 0, data: { file_id: '/file/uuid-123' } }));
    });
    const timeout = vi.spyOn(globalThis, 'setTimeout');
    const receipts = await Promise.all([adapter.uploadFile('qq:900:100', file, 'one-file'), adapter.uploadFile('qq:900:100', file, 'one-file')]);
    expect(receipts).toEqual([{ status: 'sent', platformFileId: '/file/uuid-123' }, { status: 'sent', platformFileId: '/file/uuid-123' }]);
    expect(timeout.mock.calls.some(call => call[1] === 120000)).toBe(true);
    expect(packets).toHaveLength(1);
    expect(packets[0].action).toBe('upload_group_file');
    expect(packets[0].params).toEqual({ group_id: '100', name: '文档译文.md', upload_file: true, file: `base64://${bytes.toString('base64')}` });
    expect(JSON.stringify(packets)).not.toContain(root);
    expect(await adapter.uploadFile('qq:900:100', file, 'one-file')).toEqual(receipts[0]);
    expect(await adapter.uploadFile('qq:900:100', { ...file, name: 'renamed.md' }, 'one-file')).toEqual({ status: 'failed', reason: 'dedupe_key_conflict' });
    expect(await adapter.uploadFile('qq:900:100', { ...file, artifactId: 'different-artifact' }, 'one-file')).toEqual({ status: 'failed', reason: 'dedupe_key_conflict' });
    expect(packets).toHaveLength(1);
  });

  it('keeps text and file delivery identities independent and refuses to silently omit file attachments', async () => {
    const { root, file } = await artifact(), { adapter, client } = await setup(root);
    const actions: string[] = [];
    client.on('message', raw => {
      const packet = JSON.parse(raw.toString()); actions.push(packet.action);
      client.send(JSON.stringify({ echo: packet.echo, status: 'ok', retcode: 0, data: packet.action === 'upload_group_file' ? { file_id: 'file-1' } : { message_id: '7' } }));
    });
    expect(await adapter.send({ roomId: 'qq:900:100', text: '译文已生成', files: [file] }, 'mixed')).toEqual({ status: 'failed', reason: 'unsupported_output' });
    expect(actions).toEqual([]);
    expect((await adapter.uploadFile('qq:900:100', file, 'same-key')).status).toBe('sent');
    expect(await adapter.send({ roomId: 'qq:900:100', text: '译文已上传', files: [] }, 'same-key')).toEqual({ status: 'sent', platformMessageId: '7' });
    expect(actions).toEqual(['upload_group_file', 'send_group_msg']);
  });

  it('rejects unbound targets and missing output configuration before contacting the bridge', async () => {
    const { root, file } = await artifact(), { adapter, client } = await setup(root);
    let packets = 0; client.on('message', () => packets++);
    for (const room of ['qq:901:100', 'qq:900:200', 'private:900:100']) expect(await adapter.uploadFile(room, file, 'wrong-room')).toEqual({ status: 'failed', reason: 'invalid_room_scope' });
    expect(await adapter.uploadFile('qq:900:100', file, '')).toEqual({ status: 'failed', reason: 'unsupported_output' });
    const unconfigured = await setup();
    expect(await unconfigured.adapter.uploadFile('qq:900:100', file, 'no-root')).toEqual({ status: 'failed', reason: 'unsupported_output' });
    expect(packets).toBe(0);
  });

  it('checks recorded bytes and task containment before any upload', async () => {
    const { root, file } = await artifact(), foreign = await artifact(), { adapter, client } = await setup(root);
    let packets = 0; client.on('message', () => packets++);
    await fs.writeFile(file.file, 'replaced contents');
    expect(await adapter.uploadFile('qq:900:100', file, 'changed')).toEqual({ status: 'failed', reason: 'invalid_output_file' });
    expect(await adapter.uploadFile('qq:900:100', foreign.file, 'foreign')).toEqual({ status: 'failed', reason: 'invalid_output_file' });
    expect(packets).toBe(0);
  });

  it('rejects an empty artifact before the bridge rejects it', async () => {
    const { root, file } = await artifact(''), { adapter, client } = await setup(root);
    let packets = 0; client.on('message', () => packets++);
    expect(await adapter.uploadFile('qq:900:100', file, 'empty')).toEqual({ status: 'failed', reason: 'invalid_output_file' });
    expect(packets).toBe(0);
  });

  it('revalidates original bytes when retrying an explicit platform rejection', async () => {
    const { root, file, bytes } = await artifact(), { adapter, client } = await setup(root);
    const packets: any[] = [];
    client.on('message', raw => {
      const packet = JSON.parse(raw.toString()); packets.push(packet);
      client.send(JSON.stringify({ echo: packet.echo, status: packets.length === 1 ? 'failed' : 'ok', retcode: packets.length === 1 ? 1404 : 0, data: { file_id: 'confirmed-file' } }));
    });
    expect(await adapter.uploadFile('qq:900:100', file, 'retry')).toEqual({ status: 'failed', reason: 'action_failed', platformCode:1404, retryable:false });
    await fs.writeFile(file.file, 'new contents');
    expect(await adapter.uploadFile('qq:900:100', file, 'retry')).toEqual({ status: 'failed', reason: 'invalid_output_file' });
    expect(packets).toHaveLength(1);
    await fs.writeFile(file.file, bytes);
    expect(await adapter.uploadFile('qq:900:100', file, 'retry')).toEqual({ status: 'sent', platformFileId: 'confirmed-file' });
    expect(packets).toHaveLength(2);
    expect(packets[0].params).toEqual(packets[1].params);
  });

  it.each([{}, { file_id: null }, { file_id: '' }, { file_id: '  ' }, { file_id: 42 }])('does not invent a receipt or retry when the successful response lacks a file ID: %j', async data => {
    const { root, file } = await artifact(), { adapter, client } = await setup(root);
    let packets = 0;
    client.on('message', raw => { packets++; client.send(JSON.stringify({ echo: JSON.parse(raw.toString()).echo, status: 'ok', retcode: 0, data })); });
    expect(await adapter.uploadFile('qq:900:100', file, 'no-id')).toEqual({ status: 'unknown', reason: 'missing_file_id' });
    expect(await adapter.uploadFile('qq:900:100', file, 'no-id')).toEqual({ status: 'unknown', reason: 'missing_file_id' });
    expect(packets).toBe(1);
  });

  it.each([null, []])('keeps malformed successful response data uncertain: %j', async data => {
    const { root, file } = await artifact(), { adapter, client } = await setup(root);
    client.on('message', raw => client.send(JSON.stringify({ echo: JSON.parse(raw.toString()).echo, status: 'ok', retcode: 0, data })));
    expect(await adapter.uploadFile('qq:900:100', file, 'bad-data')).toEqual({ status: 'unknown', reason: 'invalid_response' });
  });

  it.each([1200, 200])('does not retry a bridge handler error that could follow an upload: %j', async retcode => {
    const { root, file } = await artifact(), { adapter, client } = await setup(root);
    let packets = 0;
    client.on('message', raw => { packets++; client.send(JSON.stringify({ echo: JSON.parse(raw.toString()).echo, status: 'failed', retcode, data: null, message: 'send timeout' })); });
    expect(await adapter.uploadFile('qq:900:100', file, 'handler-error')).toEqual({ status: 'unknown', reason: 'upload_result_unknown',platformCode:retcode });
    expect(await adapter.uploadFile('qq:900:100', file, 'handler-error')).toEqual({ status: 'unknown', reason: 'upload_result_unknown',platformCode:retcode });
    expect(packets).toBe(1);
  });

  it('uses the configured action timeout and never reuploads an uncertain file', async () => {
    const { root, file } = await artifact(), { adapter, client } = await setup(root, 30);
    let packets = 0; client.on('message', () => packets++);
    expect(await adapter.uploadFile('qq:900:100', file, 'timeout')).toEqual({ status: 'unknown', reason: 'timeout' });
    expect(await adapter.uploadFile('qq:900:100', file, 'timeout')).toEqual({ status: 'unknown', reason: 'timeout' });
    expect(packets).toBe(1);
  });

  it('retains an uncertain receipt when the socket closes after the request', async () => {
    const { root, file } = await artifact(), { adapter, client } = await setup(root);
    let packets = 0; client.on('message', () => { packets++; client.close(); });
    expect(await adapter.uploadFile('qq:900:100', file, 'disconnect')).toEqual({ status: 'unknown', reason: 'disconnected' });
    expect(await adapter.uploadFile('qq:900:100', file, 'disconnect')).toEqual({ status: 'unknown', reason: 'disconnected' });
    expect(packets).toBe(1);
  });

  it('can upload with the original key after a disconnected attempt that never transmitted', async () => {
    const { root, file } = await artifact(), { adapter, client } = await setup(root);
    client.close(); await once(client, 'close');
    expect(await adapter.uploadFile('qq:900:100', file, 'offline')).toEqual({ status: 'deferred', reason: 'not_connected' });
    const reconnected = await connect(adapter); let packets = 0;
    reconnected.on('message', raw => { packets++; reconnected.send(JSON.stringify({ echo: JSON.parse(raw.toString()).echo, status: 'ok', retcode: 0, data: { file_id: 'after-reconnect' } })); });
    expect(await adapter.uploadFile('qq:900:100', file, 'offline')).toEqual({ status: 'sent', platformFileId: 'after-reconnect' });
    expect(packets).toBe(1);
  });
});
