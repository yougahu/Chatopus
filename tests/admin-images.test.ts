import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AdminServer, redactAudit } from '../src/admin/server.js';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/store.js';
import type { OutgoingImage } from '../src/types.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
function image(root: string, name = 'reply.png'): OutgoingImage {
  const directory = join(root, 'workspaces/topic/run/.reply-images'); mkdirSync(directory, { recursive: true });
  const file = join(directory, name); writeFileSync(file, png);
  return { kind: 'image', artifactId: 'image-fixture', file, mimeType: 'image/png', bytes: png.length,
    sha256: createHash('sha256').update(png).digest('hex') };
}
async function setup() {
  const root = mkdtempSync(join(tmpdir(), 'boe-admin-images-')); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const store = new Store(join(root, 'state.sqlite')); cleanup.push(() => store.close());
  const server = new AdminServer(loadConfig(root, { stateDir: root, apiKey: '' }), 0);
  const url = await server.start(); cleanup.push(() => server.close());
  const attachment = image(root);
  store.enqueue({ roomId: 'test', text: '截图', attachments: [attachment] }, { id: 'result:fixture', status: 'sent' });
  const endpoint = '/api/outbox/' + encodeURIComponent('result:fixture') + '/images/0';
  return { root, store, url, attachment, endpoint };
}

describe('local reply image audit', () => {
  it('serves image bytes without a token while rejecting cross-site origins and writes', async () => {
    const { url, endpoint } = await setup();
    expect((await fetch(url + endpoint, { headers: { Origin: 'https://foreign.invalid' } })).status).toBe(403);
    expect((await fetch(url + endpoint, { method: 'POST' })).status).toBe(405);
    const response = await fetch(url + endpoint);
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(png);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(Number(response.headers.get('content-length'))).toBe(png.length);
    expect(response.headers.get('content-disposition')).toContain('inline; filename="reply-image-1.png"');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('content-security-policy')).toContain('blob:');
  });

  it('resolves image indices only from the selected outbox and rejects arbitrary file requests', async () => {
    const { url, endpoint, root } = await setup();
    for (const path of [endpoint.replace('/0', '/4'), endpoint.replace('/0', '/-1'), endpoint.replace('/0', '/1'),
      '/api/outbox/missing/images/0', '/api/outbox/' + encodeURIComponent('../secret') + '/images/0',
      endpoint + '?source=missing', '/api/outbox/image?file=' + encodeURIComponent(join(root, '.env'))]) {
      const response = await fetch(url + path);
      expect(response.status).toBe(404);
      expect(await response.text()).not.toContain(root);
    }
    const response = await fetch(url + endpoint + '?file=/etc/passwd&url=https://example.com/secret');
    expect(Buffer.from(await response.arrayBuffer())).toEqual(png);
    const rows = await (await fetch(url + '/api/outbox')).text();
    expect(rows).not.toContain(png.toString('base64'));
    expect(rows).toContain('image/png');
  });

  it('keeps artifacts and matching outbox IDs isolated by source', async () => {
    const { root, store, url, endpoint, attachment } = await setup();
    const otherRoot = join(root, 'ask/123'); mkdirSync(otherRoot, { recursive: true });
    const other = new Store(join(otherRoot, 'state.sqlite')); cleanup.push(() => other.close());
    const otherImage = image(otherRoot, 'other.png');
    other.enqueue({ roomId: 'other', text: '', attachments: [otherImage] }, { id: 'result:fixture' });
    expect((await fetch(url + endpoint + '?source=ask-123')).status).toBe(200);
    other.enqueue({ roomId: 'other', text: '', attachments: [attachment] }, { id: 'foreign-image' });
    expect((await fetch(url + '/api/outbox/foreign-image/images/0?source=ask-123')).status).toBe(404);
    store.enqueue({ roomId: 'main', text: '', attachments: [otherImage] }, { id: 'foreign-image' });
    expect((await fetch(url + '/api/outbox/foreign-image/images/0')).status).toBe(404);
  });

  it('refuses altered images and symlinked files rather than serving changed bytes', async () => {
    const { root, store, url, endpoint, attachment } = await setup();
    const changed = Buffer.from(png); changed[30] ^= 1; writeFileSync(attachment.file, changed);
    expect((await fetch(url + endpoint)).status).toBe(404);
    const original = image(root, 'original.png'), alias = join(root, 'workspaces/topic/run/.reply-images/link.png');
    symlinkSync(original.file, alias);
    store.enqueue({ roomId: 'test', text: '', attachments: [{ ...original, file: alias }] }, { id: 'alias' });
    expect((await fetch(url + '/api/outbox/alias/images/0')).status).toBe(404);
  });

  it('redacts binary image blocks in raw audit data while still removing credentials', () => {
    expect(redactAudit({ type: 'image', data: png.toString('base64'), mimeType: 'image/png', apiKey: 'secret' }))
      .toEqual({ type: 'image', data: '[image attachment]', mimeType: 'image/png', apiKey: '[redacted]' });
  });
});
