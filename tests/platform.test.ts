import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { once } from 'node:events';
import { deflateSync } from 'node:zlib';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { OneBotAdapter, normalizeOneBotMessage } from '../src/platform/onebot.js';
import { resolveOneBotImage } from '../src/platform/media.js';
import type { GroupMessage, OutgoingImage } from '../src/types.js';

const makeEvent = (messageId = 11, extra: Record<string, unknown> = {}) => ({
  post_type: 'message', message_type: 'group', self_id: 900, user_id: 901, group_id: 100,
  message_id: messageId, time: 1700000000, sender: { nickname: 'Alice', role: 'member' },
  message: [{ type: 'text', data: { text: '这个辅助能生效吗？' } }], ...extra,
});
const disposables: OneBotAdapter[] = [];
const imageDirectories: string[] = [];
afterEach(async () => { await Promise.all(disposables.splice(0).map(x => x.close())); await Promise.all(imageDirectories.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true }))); });
async function setup(onMessage: (message: GroupMessage) => Promise<void> = async () => {}, timeout = 80, outputRoot?: string) {
  const errors: string[] = [];
  const adapter = new OneBotAdapter({ selfId: '900', accessToken: 'local-test', allowedGroupIds: ['100'], port: 0,
    actionTimeoutMs: timeout, outputRoot, onMessage, onError: code => errors.push(code) });
  disposables.push(adapter); await adapter.start();
  const client = new WebSocket(`ws://127.0.0.1:${adapter.port}/onebot/v11/ws`, { headers: { Authorization: 'Bearer local-test', 'X-Self-ID': '900' } });
  await once(client, 'open');
  return { adapter, client, errors };
}
async function until(check: () => boolean) {
  for (let i = 0; i < 100; i++) { if (check()) return; await new Promise(r => setTimeout(r, 5)); }
  throw new Error('condition timeout');
}
function pngChunk(type: string, data: Buffer): Buffer {
  const chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length); chunk.write(type, 4, 'ascii'); data.copy(chunk, 8);
  let crc = 0xffffffff;
  for (const byte of chunk.subarray(4, -4)) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, chunk.length - 4);
  return chunk;
}

describe('normalization', () => {
  it('admits unmentioned group messages and retains trusted references/identity', () => {
    const p = normalizeOneBotMessage(makeEvent(), '900', new Set(['100']))!;
    expect(p.isMentioned).toBe(false); expect(p.id).toBe('qq:900:100:11');
    expect(p.timestamp).toBe(1700000000000); expect(p.authorId).toBe('901');
  });
  it('preserves structured mentions, negative reply IDs, images; text never creates mentions', () => {
    const p = normalizeOneBotMessage(makeEvent(11, { message: [
      { type: 'text', data: { text: '[CQ:at,qq=900]' } }, { type: 'at', data: { qq: '902' } },
      { type: 'reply', data: { id: '-42' } }, { type: 'image', data: { file: 'abc.png', url: 'https://gchat.qpic.cn/a' } },
    ] }), '900', new Set(['100']))!;
    expect(p.mentions).toEqual(['902']); expect(p.isMentioned).toBe(false); expect(p.replyToMessageId).toBe('-42');
    expect(p.attachments[0].file).toBe('abc.png');
  });
  it.each([{ self_id: 111 }, { user_id: 900 }, { group_id: 999 }, { message_type: 'private' }, { message: '[CQ:at,qq=900]' }, { user_id: true }])('rejects malformed/out-of-scope %j', extra => {
    expect(normalizeOneBotMessage(makeEvent(11, extra), '900', new Set(['100']))).toBeUndefined();
  });
});

describe('reverse websocket', () => {
  it('allows the same delivery key after disconnected attempts without a platform send',async()=>{
    const {adapter,client}=await setup();client.close();await once(client,'close');await until(()=>!adapter.connected);
    const outgoing={roomId:'qq:900:100',text:'waiting for connection'};
    for(let n=0;n<4;n++)expect(await adapter.send(outgoing,'offline')).toEqual({status:'deferred',reason:'not_connected'});
    const reconnected=new WebSocket(`ws://127.0.0.1:${adapter.port}/onebot/v11/ws`,{headers:{Authorization:'Bearer local-test','X-Self-ID':'900'}});
    await once(reconnected,'open');let sends=0;
    reconnected.on('message',raw=>{sends++;reconnected.send(JSON.stringify({echo:JSON.parse(raw.toString()).echo,status:'ok',retcode:0,data:{message_id:88}}));});
    expect(await adapter.send(outgoing,'offline')).toEqual({status:'sent',platformMessageId:'88'});expect(sends).toBe(1);
  });
  it('stops intake without waiting for a handler that needs coordinator cancellation',async()=>{
    let entered=false,release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve);
    const {adapter,client}=await setup(async()=>{entered=true;await gate;});
    client.send(JSON.stringify(makeEvent()));await until(()=>entered);
    adapter.stopIntake();
    expect(await adapter.send({roomId:'qq:900:100',text:'closing'},'closing')).toEqual({status:'deferred',reason:'not_connected'});
    release();await adapter.close();
  });
  it('delivers each group message once including unmentioned input', async () => {
    const received: GroupMessage[] = [];
    const { client } = await setup(async m => { received.push(m); });
    client.send(JSON.stringify(makeEvent())); client.send(JSON.stringify(makeEvent())); client.send(JSON.stringify(makeEvent(12)));
    await until(() => received.length === 2);
    expect(received.map(m => m.messageId)).toEqual(['11', '12']);
  });
  it('can redeliver after handler failed rather than losing the message', async () => {
    let calls = 0;
    const { client, errors } = await setup(async () => { if (++calls === 1) throw new Error('db unavailable'); });
    client.send(JSON.stringify(makeEvent())); await until(() => errors.includes('message_handler_failed'));
    client.send(JSON.stringify(makeEvent())); await until(() => calls === 2);
  });
  it('rejects invalid token and mismatched bot handshake', async () => {
    const { adapter } = await setup();
    for (const headers of [{ Authorization: 'Bearer wrong', 'X-Self-ID': '900' }, { Authorization: 'Bearer local-test', 'X-Self-ID': '901' }]) {
      const client = new WebSocket(`ws://127.0.0.1:${adapter.port}/onebot/v11/ws`, { headers });
      const [error] = await once(client, 'error'); expect(String(error)).toContain('403');
    }
  });
  it('sends literal segments, waits for receipt, and deduplicates concurrent publication', async () => {
    const { adapter, client } = await setup();
    const packets: any[] = [];
    client.on('message', raw => {
      const p = JSON.parse(raw.toString()); packets.push(p);
      client.send(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: -99 }, echo: p.echo }));
    });
    const outgoing = { roomId: 'qq:900:100', replyToMessageId: '11', text: '[CQ:at,qq=all]' };
    const receipts = await Promise.all([adapter.send(outgoing, 'r1'), adapter.send(outgoing, 'r1')]);
    expect(packets).toHaveLength(1); expect(receipts[0]).toEqual({ status: 'sent', platformMessageId: '-99' });
    expect(packets[0].params.message[1]).toEqual({ type: 'text', data: { text: '[CQ:at,qq=all]' } });
    expect((await adapter.send({ ...outgoing, roomId: 'qq:900:200' }, 'r2')).reason).toBe('invalid_room_scope');
    expect((await adapter.send({ ...outgoing, text: 'changed' }, 'r1')).reason).toBe('dedupe_key_conflict');
  });
  it('sends explicit recipients as real at segments and deduplicates both recipients and publication', async () => {
    const { adapter, client } = await setup();
    const packets: any[] = [];
    client.on('message', raw => {
      const packet = JSON.parse(raw.toString()); packets.push(packet);
      client.send(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 99 }, echo: packet.echo }));
    });
    const outgoing = { roomId: 'qq:900:100', replyToMessageId: '11', text: '@Alice [CQ:at,qq=all]', recipientIds: ['301', '302', '301'] };
    const receipts = await Promise.all([adapter.send(outgoing, 'mentions'), adapter.send(outgoing, 'mentions')]);
    expect(receipts[0].status).toBe('sent'); expect(packets).toHaveLength(1);
    expect(packets[0].params.message).toEqual([
      { type: 'reply', data: { id: '11' } },
      { type: 'at', data: { qq: '301' } }, { type: 'text', data: { text: ' ' } },
      { type: 'at', data: { qq: '302' } }, { type: 'text', data: { text: ' ' } },
      { type: 'text', data: { text: outgoing.text } },
    ]);
    expect(await adapter.send({ ...outgoing, recipientIds: ['303'] }, 'mentions')).toMatchObject({ status: 'failed', reason: 'dedupe_key_conflict' });
    expect(packets).toHaveLength(1);
    expect(await adapter.send({ roomId: outgoing.roomId, text: '', recipientIds: ['301'] }, 'mention-only')).toMatchObject({ status: 'sent' });
    expect(packets[1].params.message[0]).toEqual({ type: 'at', data: { qq: '301' } });
  });
  it('rejects malformed or excessive recipients before any platform transmission', async () => {
    const { adapter, client } = await setup(); const packets: unknown[] = [];
    client.on('message', raw => packets.push(raw));
    for (const recipientIds of [null, '301', [301], [''], ['0'], ['all'], ['Alice'], ['301:other'], Array.from({ length: 51 }, (_, i) => String(i + 1))]) {
      expect(await adapter.send({ roomId: 'qq:900:100', text: 'Reminder', recipientIds } as never, 'invalid')).toMatchObject({ status: 'failed', reason: 'invalid_recipient_ids' });
    }
    expect(packets).toHaveLength(0);
  });
  it('treats timeout after sending as unknown and does not retry it', async () => {
    const { adapter, client } = await setup(); let calls = 0;
    client.on('message', () => calls++);
    const outgoing = { roomId: 'qq:900:100', text: 'result' };
    expect(await adapter.send(outgoing, 'timeout')).toEqual({ status: 'unknown', reason: 'timeout' });
    expect((await adapter.send(outgoing, 'timeout')).status).toBe('unknown'); expect(calls).toBe(1);
  });
  it('distinguishes explicit platform rejection from uncertain delivery', async () => {
    const { adapter, client } = await setup();
    client.on('message', raw => client.send(JSON.stringify({ echo: JSON.parse(raw.toString()).echo, status: 'failed', retcode: 1404, data: {} })));
    expect(await adapter.send({ roomId: 'qq:900:100', text: 'result' }, 'reject')).toEqual({ status: 'failed', reason: 'action_failed', platformCode:1404, retryable:false });
  });
  it.each([1200,200,1500])('never retries an ambiguous send handler error %i, including duplicate callers',async retcode=>{
    const {adapter,client}=await setup();let requests=0;
    client.on('message',raw=>{requests++;client.send(JSON.stringify({echo:JSON.parse(raw.toString()).echo,status:'failed',retcode,data:null}));});
    const message={roomId:'qq:900:100',text:'One result'};
    const receipts=await Promise.all([adapter.send(message,'same-result'),adapter.send(message,'same-result')]);
    expect(receipts).toEqual(Array(2).fill({status:'unknown',reason:'send_result_unknown',platformCode:retcode}));
    expect(await adapter.send(message,'same-result')).toEqual(receipts[0]);expect(requests).toBe(1);
  });
  it('marks sent actions unknown after connection loss', async () => {
    const { adapter, client } = await setup();
    client.on('message', () => client.close());
    expect(await adapter.send({ roomId: 'qq:900:100', text: 'result' }, 'disconnect')).toEqual({ status: 'unknown', reason: 'disconnected' });
  });
});

describe('outgoing image replies', () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6yJkAAAAASUVORK5CYII=', 'base64');
  async function artifacts(count = 1, bytes = png) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'boe2-publish-image-')); imageDirectories.push(root);
    const attachments: OutgoingImage[] = [];
    for (let i = 0; i < count; i++) {
      const file = path.join(root, `image-${i}.png`); await fs.writeFile(file, bytes);
      attachments.push({ kind: 'image', artifactId: `image-${i}`, file, mimeType: 'image/png', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
    }
    return { root, attachments };
  }

  it('sends reply, literal text and all verified image bytes in one action and deduplicates concurrent calls', async () => {
    const { root, attachments } = await artifacts(2);
    const { adapter, client } = await setup(undefined, 1000, root); const packets: any[] = [];
    client.on('message', raw => {
      const p = JSON.parse(raw.toString()); packets.push(p);
      client.send(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: -101 }, echo: p.echo }));
    });
    const message = { roomId: 'qq:900:100', replyToMessageId: '11', text: '截图 [CQ:at,qq=all]', attachments };
    const results = await Promise.all([adapter.send(message, 'images'), adapter.send(message, 'images')]);
    expect(results).toEqual([{ status: 'sent', platformMessageId: '-101' }, { status: 'sent', platformMessageId: '-101' }]);
    expect(packets).toHaveLength(1);
    expect(packets[0].params.message.map((x: any) => x.type)).toEqual(['reply', 'text', 'image', 'image']);
    expect(packets[0].params.message[1].data.text).toBe(message.text);
    for (const image of packets[0].params.message.slice(2)) {
      expect(image.data.file.startsWith('base64://')).toBe(true);
      expect(Buffer.from(image.data.file.slice(9), 'base64')).toEqual(png);
      expect(image.data.file).not.toContain(root);
    }
    expect((await adapter.send({ ...message, attachments: attachments.slice(0, 1) }, 'images')).reason).toBe('dedupe_key_conflict');
  });

  it('permits image-only replies', async () => {
    const { root, attachments } = await artifacts(); const { adapter, client } = await setup(undefined, 1000, root);
    const packets: any[] = [];
    client.on('message', raw => { const p = JSON.parse(raw.toString()); packets.push(p); client.send(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 101 }, echo: p.echo })); });
    expect((await adapter.send({ roomId: 'qq:900:100', text: '', attachments }, 'image-only')).status).toBe('sent');
    expect(packets[0].params.message.map((x: any) => x.type)).toEqual(['image']);
  });

  it('sends a persisted pending image reply after reopening the adapter without losing its bytes', async () => {
    const { root, attachments } = await artifacts();
    const first = await setup(undefined, 1000, root);
    let beforeRestart = 0; first.client.on('message', () => beforeRestart++);
    // This is an unsent pending outbox entry, never an uncertain past send.
    const file = path.join(root, 'pending-outbox.json');
    await fs.writeFile(file, JSON.stringify({ id: 'restored-pending-image', status: 'pending', attempts: 0,
      message: { roomId: 'qq:900:100', replyToMessageId: '11', text: '恢复后发送截图', attachments } }));
    await first.adapter.close();
    expect(beforeRestart).toBe(0);

    const restored = JSON.parse(await fs.readFile(file, 'utf8'));
    const second = await setup(undefined, 1000, root); const packets: any[] = [];
    second.client.on('message', raw => {
      const packet = JSON.parse(raw.toString()); packets.push(packet);
      second.client.send(JSON.stringify({ echo: packet.echo, status: 'ok', retcode: 0, data: { message_id: 103 } }));
    });
    expect(await second.adapter.send(restored.message, restored.id)).toEqual({ status: 'sent', platformMessageId: '103' });
    expect(packets).toHaveLength(1);
    const segments = packets[0].params.message;
    expect(segments.map((segment: any) => segment.type)).toEqual(['reply', 'text', 'image']);
    expect(segments[1].data.text).toBe(restored.message.text);
    const received = Buffer.from(segments[2].data.file.slice(9), 'base64');
    expect(received).toEqual(png);
    expect(createHash('sha256').update(received).digest('hex')).toBe(restored.message.attachments[0].sha256);
    expect((await second.adapter.send(restored.message, restored.id)).status).toBe('sent');
    expect(packets).toHaveLength(1);
  });

  it('validates all images before sending any part of a reply', async () => {
    const { root, attachments } = await artifacts(2); const { adapter, client } = await setup(undefined, 1000, root);
    let packets = 0; client.on('message', () => packets++);
    await fs.writeFile(attachments[1].file, 'substituted image');
    expect(await adapter.send({ roomId: 'qq:900:100', text: 'must not partially send', attachments }, 'invalid-image')).toEqual({ status: 'failed', reason: 'invalid_output_image' });
    expect(packets).toBe(0);
    const foreign = await artifacts();
    expect((await adapter.send({ roomId: 'qq:900:100', text: 'outside', attachments: foreign.attachments }, 'outside-image')).reason).toBe('invalid_output_image');
    expect(packets).toBe(0);
  });

  it('rejects missing configuration, too many images and an oversized combined reply before platform transmission', async () => {
    const { root, attachments } = await artifacts(5); const plain = await setup();
    expect((await plain.adapter.send({ roomId: 'qq:900:100', text: 'image', attachments: attachments.slice(0, 1) }, 'no-root')).reason).toBe('unsupported_output');
    const { adapter, client } = await setup(undefined, 1000, root); let packets = 0; client.on('message', () => packets++);
    expect((await adapter.send({ roomId: 'qq:900:100', text: 'images', attachments }, 'too-many')).reason).toBe('unsupported_output');
    // Padded image fixtures exercise byte-budget validation without sending them.
    const large = Buffer.alloc(7 * 1024 * 1024); png.copy(large);
    for (const image of attachments.slice(0, 3)) {
      await fs.writeFile(image.file, large); image.bytes = large.length; image.sha256 = createHash('sha256').update(large).digest('hex');
    }
    expect((await adapter.send({ roomId: 'qq:900:100', text: 'large', attachments: attachments.slice(0, 3) }, 'too-large')).reason).toBe('invalid_output_image');
    expect(packets).toBe(0);
  });

  it('never resends an image when the platform receipt is unknown', async () => {
    const { root, attachments } = await artifacts(); const { adapter, client } = await setup(undefined, 50, root);
    let packets = 0; client.on('message', () => packets++);
    const message = { roomId: 'qq:900:100', text: 'screenshot', attachments };
    expect((await adapter.send(message, 'uncertain-image')).status).toBe('unknown');
    expect((await adapter.send(message, 'uncertain-image')).status).toBe('unknown');
    expect(packets).toBe(1);
  });

  it('revalidates the original immutable bytes on a definite-failure retry', async () => {
    const { root, attachments } = await artifacts(); const { adapter, client } = await setup(undefined, 1000, root);
    const packets: any[] = [];
    client.on('message', raw => {
      const p = JSON.parse(raw.toString()); packets.push(p);
      client.send(JSON.stringify({ echo: p.echo, status: packets.length === 1 ? 'failed' : 'ok', retcode: packets.length === 1 ? 1404 : 0, data: { message_id: 102 } }));
    });
    const message = { roomId: 'qq:900:100', text: 'screenshot', attachments };
    expect((await adapter.send(message, 'rejected-image')).status).toBe('failed');
    const changed = Buffer.from(png); changed[changed.length - 1] ^= 1; await fs.writeFile(attachments[0].file, changed);
    expect((await adapter.send(message, 'rejected-image')).reason).toBe('invalid_output_image'); expect(packets).toHaveLength(1);
    await fs.writeFile(attachments[0].file, png);
    expect((await adapter.send(message, 'rejected-image')).status).toBe('sent'); expect(packets).toHaveLength(2);
    expect(packets[0].params.message).toEqual(packets[1].params.message);
  });
});

describe('question image resolution', () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6yJkAAAAASUVORK5CYII=', 'base64');
  it('receives a real PNG get_image response larger than 1 MiB over the authenticated socket', async () => {
    // A valid 600x600 RGB PNG with uncompressed DEFLATE keeps this transport case deterministic.
    const header = Buffer.alloc(13); header.writeUInt32BE(600); header.writeUInt32BE(600, 4); header[8] = 8; header[9] = 2;
    const pixels = Buffer.alloc((600 * 3 + 1) * 600, 127);
    for (let row = 0; row < 600; row++) pixels[row * (600 * 3 + 1)] = 0;
    const largePng = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), pngChunk('IHDR', header), pngChunk('IDAT', deflateSync(pixels, { level: 0 })), pngChunk('IEND', Buffer.alloc(0))]);
    const encoded = largePng.toString('base64'); expect(Buffer.byteLength(encoded)).toBeGreaterThan(1024 * 1024);
    const { adapter, client, errors } = await setup(undefined, 2000);
    client.on('message', raw => {
      const request = JSON.parse(raw.toString());
      if (request.action === 'get_image') client.send(JSON.stringify({ echo: request.echo, status: 'ok', retcode: 0, data: { base64: encoded } }));
    });
    const result = await resolveOneBotImage(adapter, { kind: 'image', file: 'large.png' });
    expect(result.mimeType).toBe('image/png'); expect(result.url).toBe('data:image/png;base64,' + encoded);
    expect(adapter.connected).toBe(true); expect(errors).toEqual([]);
  });
  it('converts authenticated get_image bytes into a validated model image', async () => {
    const result = await resolveOneBotImage({ call: async () => ({ base64: png.toString('base64') }) }, { kind: 'image', file: 'fixture.png' });
    expect(result.mimeType).toBe('image/png'); expect(result.url).toContain('data:image/png;base64,');
  });
  it('rejects untrusted URL without making a network request', async () => {
    await expect(resolveOneBotImage({ call: async () => ({}) }, { kind: 'image', url: 'http://127.0.0.1/secrets' })).rejects.toThrow('Untrusted');
  });
  it('rejects non-image content and bounded payloads', async () => {
    await expect(resolveOneBotImage({ call: async () => ({ base64: Buffer.from('not image').toString('base64') }) }, { kind: 'image', file: 'x' })).rejects.toThrow('Unsupported');
    await expect(resolveOneBotImage({ call: async () => ({ base64: png.toString('base64') }) }, { kind: 'image', file: 'x' }, { maxBytes: 3 })).rejects.toThrow('oversized');
  });
});
