import { afterEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { resolveOneBotImage, type ImageDiagnostic } from '../src/platform/media.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6yJkAAAAASUVORK5CYII=', 'base64');
const original = 'https://gchat.qpic.cn/expired?rkey=private-token';
const fresh = 'https://multimedia.nt.qq.com.cn/fresh?rkey=new-token';
const directories: string[] = [];
const picture = () => new Response(png, { status: 200, headers: { 'content-type': 'image/png' } });
async function directory() { const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'boe-incoming-')); directories.push(dir); return dir; }
afterEach(async () => { vi.unstubAllGlobals(); await Promise.all(directories.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true }))); });

describe('incoming image recovery', () => {
  it('uses the original URL without depending on a failing get_image action', async () => {
    const fetcher = vi.fn().mockResolvedValue(picture()); vi.stubGlobal('fetch', fetcher);
    const call = vi.fn().mockRejectedValue(new Error('bridge unavailable private details'));
    const diagnostics: ImageDiagnostic[] = [];
    const image = await resolveOneBotImage({ call }, { kind: 'image', file: 'qq-image', url: original }, { onDiagnostic: d => diagnostics.push(d) });
    expect(image.url).toBe(`data:image/png;base64,${png.toString('base64')}`);
    expect(call).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledOnce();
    expect(diagnostics).toEqual([expect.objectContaining({ stage: 'original_url', status: 'success', bytes: png.length })]);
  });

  it('records URL expiration and bridge failure separately without exposing secrets', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('expired', { status: 400 })));
    const call = vi.fn().mockRejectedValue(new Error('private-token /private/qq/cache/file.png'));
    const diagnostics: ImageDiagnostic[] = [];
    await expect(resolveOneBotImage({ call }, { kind: 'image', file: 'qq-image', url: original }, { onDiagnostic: d => diagnostics.push(d) })).rejects.toMatchObject({ code: 'get_image_failed' });
    expect(diagnostics).toEqual([
      expect.objectContaining({ stage: 'original_url', status: 'failed', code: 'http_error', httpStatus: 400 }),
      expect.objectContaining({ stage: 'get_image', status: 'failed', code: 'get_image_failed' }),
    ]);
    expect(JSON.stringify(diagnostics)).not.toMatch(/private-token|\/private|https:|rkey|unavailable/);
  });

  it.each(['base64', 'file'] as const)('loads authenticated %s bytes without requiring a URL', async field => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    const encoded = png.toString('base64');
    const image = await resolveOneBotImage({ call: async () => ({ [field]: field === 'file' ? `base64://${encoded}` : encoded }) }, { kind: 'image', file: 'qq-image' });
    expect(image.mimeType).toBe('image/png'); expect(fetcher).not.toHaveBeenCalled();
  });

  it('recovers expired URLs from the trusted bridge file and never repeats the same URL', async () => {
    const root = await directory(), file = path.join(root, 'cached.png'); await fs.writeFile(file, png);
    const fetcher = vi.fn().mockResolvedValue(new Response('expired', { status: 400 })); vi.stubGlobal('fetch', fetcher);
    const diagnostics: ImageDiagnostic[] = [];
    const image = await resolveOneBotImage({ call: async () => ({ file, url: original }) }, { kind: 'image', file: 'qq-image', url: original }, { cacheRoot: root, onDiagnostic: d => diagnostics.push(d) });
    expect(image.mimeType).toBe('image/png'); expect(fetcher).toHaveBeenCalledOnce();
    expect(diagnostics).toContainEqual(expect.objectContaining({ stage: 'local_cache', status: 'success' }));
  });

  it.each(['missing', 'invalid', 'too_large'] as const)('falls through invalid transport bytes and a %s local file to a refreshed URL', async kind => {
    const root = await directory(), file = path.join(root, 'cache.png');
    if (kind !== 'missing') await fs.writeFile(file, kind === 'too_large' ? Buffer.alloc(png.length + 1) : Buffer.from('not an image'));
    const fetcher = vi.fn().mockResolvedValueOnce(new Response('expired', { status: 400 })).mockResolvedValueOnce(picture()); vi.stubGlobal('fetch', fetcher);
    const diagnostics: ImageDiagnostic[] = [];
    const image = await resolveOneBotImage({ call: async () => ({ base64: 'bad!', file, url: fresh }) }, { kind: 'image', file: 'qq-image', url: original }, { cacheRoot: root, maxBytes: png.length, onDiagnostic: d => diagnostics.push(d) });
    expect(image.mimeType).toBe('image/png'); expect(fetcher).toHaveBeenCalledTimes(2);
    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: 'transport_bytes', status: 'failed' }),
      expect.objectContaining({ stage: 'local_cache', status: 'failed' }),
      expect.objectContaining({ stage: 'refreshed_url', status: 'success' }),
    ]));
  });

  it('does not retry an unchanged failed URL when no fallback yields bytes', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('expired', { status: 400 })); vi.stubGlobal('fetch', fetcher);
    const diagnostics: ImageDiagnostic[] = [];
    await expect(resolveOneBotImage({ call: async () => ({ url: original }) }, { kind: 'image', file: 'qq-image', url: original }, { onDiagnostic: d => diagnostics.push(d) })).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledOnce();
    expect(diagnostics.at(-1)).toMatchObject({ stage: 'refreshed_url', status: 'skipped', code: 'unchanged_url' });
  });
});

describe('received image persistence', () => {
  it('reuses disk bytes with a fresh resolver and bridge even after the URL expires', async () => {
    const cacheDir = await directory(), cacheKey = 'qq:bot:group/message-1/0';
    const first = await resolveOneBotImage({ call: async () => ({ base64: png.toString('base64') }) }, { kind: 'image', file: 'qq-image' }, { cacheDir, cacheKey });
    const files = await fs.readdir(cacheDir); expect(files).toHaveLength(1); expect(files[0]).toMatch(/^[a-f0-9]{64}\.json$/);
    expect((await fs.stat(path.join(cacheDir, files[0]))).mode & 0o777).toBe(0o600);
    const call = vi.fn().mockRejectedValue(new Error('bridge closed')), fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    const diagnostics: ImageDiagnostic[] = [];
    const second = await resolveOneBotImage({ call }, { kind: 'image', file: 'qq-image', url: original }, { cacheDir, cacheKey, onDiagnostic: d => diagnostics.push(d) });
    expect(second).toEqual(first); expect(call).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
    expect(diagnostics).toEqual([expect.objectContaining({ stage: 'cache', status: 'hit' })]);
    expect((await fs.readFile(path.join(cacheDir, files[0]), 'utf8'))).not.toMatch(/private-token|qq-image|message-1/);
  });

  it('defaults to stable file identity when signed URLs change', async () => {
    const cacheDir = await directory();
    await resolveOneBotImage({ call: async () => ({ base64: png.toString('base64') }) }, { kind: 'image', file: 'qq-image' }, { cacheDir });
    const call = vi.fn(); const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    await resolveOneBotImage({ call }, { kind: 'image', file: 'qq-image', url: fresh }, { cacheDir });
    expect(call).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(['sha', 'base64', 'mime', 'oversized', 'truncated'] as const)('refetches a cache with %s corruption and replaces it atomically', async kind => {
    const cacheDir = await directory(), cacheKey = 'room/message/0';
    await resolveOneBotImage({ call: async () => ({ base64: png.toString('base64') }) }, { kind: 'image', file: 'qq-image' }, { cacheDir, cacheKey });
    const file = path.join(cacheDir, (await fs.readdir(cacheDir))[0]);
    const item = JSON.parse(await fs.readFile(file, 'utf8'));
    if (kind === 'sha') item.sha256 = '0'.repeat(64);
    if (kind === 'base64') item.base64 = 'invalid!';
    if (kind === 'mime') item.mimeType = 'image/jpeg';
    await fs.writeFile(file, kind === 'oversized' ? 'x'.repeat(2000) : kind === 'truncated' ? '{' : JSON.stringify(item));
    const call = vi.fn().mockResolvedValue({ base64: png.toString('base64') }), diagnostics: ImageDiagnostic[] = [];
    const image = await resolveOneBotImage({ call }, { kind: 'image', file: 'qq-image' }, { cacheDir, cacheKey, maxBytes: png.length, onDiagnostic: d => diagnostics.push(d) });
    expect(image.mimeType).toBe('image/png'); expect(call).toHaveBeenCalledOnce();
    expect(diagnostics[0]).toMatchObject({ stage: 'cache', status: 'failed', code: 'cache_invalid' });
    const repaired = JSON.parse(await fs.readFile(file, 'utf8'));
    expect(repaired.sha256).toBe(createHash('sha256').update(png).digest('hex'));
    expect(await fs.readdir(cacheDir)).toHaveLength(1);
  });

  it('does not let a cache write or diagnostic callback failure discard usable bytes', async () => {
    const root = await directory(), cacheDir = path.join(root, 'not-a-directory'); await fs.writeFile(cacheDir, 'occupied');
    const diagnostics: ImageDiagnostic[] = [];
    const image = await resolveOneBotImage({ call: async () => ({ base64: png.toString('base64') }) }, { kind: 'image', file: 'qq-image' }, { cacheDir, onDiagnostic: d => { diagnostics.push(d); throw new Error('logger failed'); } });
    expect(image.mimeType).toBe('image/png');
    expect(diagnostics).toContainEqual(expect.objectContaining({ stage: 'cache_write', status: 'failed' }));
  });
});

describe('incoming image boundaries', () => {
  it.each(['http://gchat.qpic.cn/a', 'https://127.0.0.1/a', 'https://gchat.qpic.cn.evil.test/a', 'https://user:secret@gchat.qpic.cn/a', 'https://gchat.qpic.cn:444/a'])('blocks untrusted URL %s before fetch', async url => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    await expect(resolveOneBotImage({ call: async () => ({}) }, { kind: 'image', url })).rejects.toMatchObject({ code: 'untrusted_url' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(['outside', 'symlink', 'parent', 'relative'] as const)('rejects %s bridge file paths', async kind => {
    const root = await directory(), outside = await directory(), file = path.join(outside, 'outside.png'); await fs.writeFile(file, png);
    let candidate = file;
    if (kind === 'symlink') { candidate = path.join(root, 'link.png'); await fs.symlink(file, candidate); }
    if (kind === 'parent') candidate = path.join(root, 'dummy') + '/../image.png';
    if (kind === 'relative') candidate = 'image.png';
    await expect(resolveOneBotImage({ call: async () => ({ file: candidate }) }, { kind: 'image', file: 'qq-image' }, { cacheRoot: root })).rejects.toMatchObject({ code: 'untrusted_path' });
  });

  it('never treats cacheDir as permission to read bridge-returned files', async () => {
    const cacheDir = await directory(), file = path.join(cacheDir, 'bridge.png'); await fs.writeFile(file, png);
    await expect(resolveOneBotImage({ call: async () => ({ file }) }, { kind: 'image', file: 'qq-image' }, { cacheDir })).rejects.toThrow('unavailable');
  });

  it('rejects oversized streamed content even when content-length is omitted', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(png)));
    await expect(resolveOneBotImage({ call: async () => ({}) }, { kind: 'image', url: original }, { maxBytes: png.length - 1 })).rejects.toMatchObject({ code: 'image_too_large' });
  });

  it('rejects oversized base64 and incomplete image signatures', async () => {
    await expect(resolveOneBotImage({ call: async () => ({ base64: png.toString('base64') }) }, { kind: 'image', file: 'qq-image' }, { maxBytes: 3 })).rejects.toMatchObject({ code: 'image_too_large' });
    await expect(resolveOneBotImage({ call: async () => ({ base64: png.subarray(0, 8).toString('base64') }) }, { kind: 'image', file: 'qq-image' })).rejects.toMatchObject({ code: 'invalid_image' });
  });
});
