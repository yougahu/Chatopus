import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { ReplyImages } from '../src/tools/reply-images.js';
import { readOutgoingImage, MAX_OUTPUT_IMAGE_BYTES } from '../src/output-images.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lWQAAAAASUVORK5CYII=', 'base64');
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
async function workspace() { const root = await fs.mkdtemp(path.join(os.tmpdir(), 'boe2-reply-images-')); roots.push(root); return root; }
const imageBlock = (data = png, mimeType = 'image/png') => ({ type: 'image', mimeType, data: data.toString('base64') });
type Captured = { content: unknown[]; replyImages: { artifactId: string; mimeType: string; bytes: number }[] };

describe('run-scoped screenshot reply artifacts', () => {
  it('keeps the original screenshot for model vision and stores selected reply bytes durably with no paths in metadata', async () => {
    const root = await workspace(), registry = new ReplyImages(root);
    const content = [{ type: 'text', text: 'Screenshot captured' }, imageBlock()];
    const result = await registry.capture({ content }) as Captured;
    expect(result.content.slice(0, 2)).toEqual(content);
    expect(result.replyImages).toHaveLength(1);
    expect(result.replyImages[0]).toMatchObject({ mimeType: 'image/png', bytes: png.length });
    expect(result.replyImages[0].artifactId).toMatch(/^image-[a-f0-9-]+$/);
    expect(JSON.stringify(result.replyImages)).not.toContain(root);
    expect(result.content.at(-1)).toMatchObject({ type: 'text' });
    const [artifact] = await registry.resolve([result.replyImages[0].artifactId]);
    expect(artifact.sha256).toBe(createHash('sha256').update(png).digest('hex'));
    expect((await fs.stat(artifact.file)).mode & 0o777).toBe(0o600);
    expect(await readOutgoingImage(artifact, root)).toEqual(png);
    // Registry changes or transport restarts do not remove the persisted bytes.
    const durableRecord = JSON.parse(JSON.stringify(artifact));
    artifact.file = '/untrusted/mutated-by-caller';
    expect((await registry.resolve([durableRecord.artifactId]))[0].file).toBe(durableRecord.file);
    expect(await readOutgoingImage(durableRecord, root)).toEqual(png);
  });

  it('rejects unknown, duplicate, and other-run IDs rather than trusting filenames or old conversation text', async () => {
    const root = await workspace(), registry = new ReplyImages(root);
    const result = await registry.capture({ content: [imageBlock()] }) as Captured;
    const id = result.replyImages[0].artifactId;
    await expect(registry.resolve(['../other-run/image.png'])).rejects.toThrow('unavailable');
    await expect(new ReplyImages(root).resolve([id])).rejects.toThrow('unavailable');
    await expect(new ReplyImages(await workspace()).resolve([id])).rejects.toThrow('unavailable');
    await expect(registry.resolve([id, id])).rejects.toThrow('distinct');
    expect(await registry.resolve([])).toEqual([]);
  });

  it('does not register failed tools or file paths without image content', async () => {
    const root = await workspace(), registry = new ReplyImages(root);
    const failed = { isError: true, content: [imageBlock()] };
    expect(await registry.capture(failed)).toBe(failed);
    const result = await registry.capture({ content: [{ type: 'text', text: '/tmp/untrusted.png' }] }) as Captured;
    expect(result.replyImages).toEqual([]);
    expect(JSON.stringify(result.content.at(-1))).toContain('No image bytes');
    await expect(fs.stat(path.join(root, '.reply-images'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('validates all image blocks before registering any of them', async () => {
    const root = await workspace(), registry = new ReplyImages(root);
    for (const block of [imageBlock(png, 'image/jpeg'), { type: 'image', mimeType: 'image/png', data: 'not base64' }, imageBlock(Buffer.from('<svg>not a screenshot</svg>'))]) {
      await expect(registry.capture({ content: [imageBlock(), block] })).rejects.toThrow();
      await expect(fs.stat(path.join(root, '.reply-images'))).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });

  it('refuses a tampered image and a symlink substitution even if the referenced bytes match', async () => {
    const root = await workspace(), registry = new ReplyImages(root);
    const result = await registry.capture({ content: [imageBlock()] }) as Captured;
    const id = result.replyImages[0].artifactId, [artifact] = await registry.resolve([id]);
    const changed = Buffer.from(png); changed[changed.length - 1] ^= 1;
    await fs.writeFile(artifact.file, changed);
    await expect(registry.resolve([id])).rejects.toThrow('Invalid or unavailable');
    await fs.unlink(artifact.file);
    const elsewhere = path.join(await workspace(), 'same.png'); await fs.writeFile(elsewhere, png);
    await fs.symlink(elsewhere, artifact.file);
    await expect(registry.resolve([id])).rejects.toThrow('Invalid or unavailable');
  });

  it('rejects a linked private artifact directory before writing outside the run', async () => {
    const root = await workspace(), outside = await workspace();
    await fs.symlink(outside, path.join(root, '.reply-images'));
    await expect(new ReplyImages(root).capture({ content: [imageBlock()] })).rejects.toThrow('symlink');
    expect(await fs.readdir(outside)).toEqual([]);
  });

  it('bounds individual images, number of attachments, and total selected bytes across screenshot calls', async () => {
    const root = await workspace(), registry = new ReplyImages(root);
    const oversized = Buffer.alloc(MAX_OUTPUT_IMAGE_BYTES + 1); png.copy(oversized);
    await expect(registry.capture({ content: [imageBlock(oversized)] })).rejects.toThrow('oversized');
    await expect(registry.capture({ content: Array.from({ length: 5 }, () => imageBlock()) })).rejects.toThrow('too many');
    const ids: string[] = [];
    for (let index = 0; index < 5; index++) {
      const result = await registry.capture({ content: [imageBlock()] }) as Captured; ids.push(result.replyImages[0].artifactId);
    }
    await expect(registry.resolve(ids)).rejects.toThrow('four');
    expect(await registry.resolve(ids.slice(0, 4))).toHaveLength(4);
    const large = Buffer.alloc(7 * 1024 * 1024); png.copy(large);
    const largeIds: string[] = [];
    for (let index = 0; index < 3; index++) {
      const result = await registry.capture({ content: [imageBlock(large)] }) as Captured; largeIds.push(result.replyImages[0].artifactId);
    }
    await expect(registry.resolve(largeIds)).rejects.toThrow('total size');
    await expect(registry.capture({ content: [imageBlock(large), imageBlock(large), imageBlock(large)] })).rejects.toThrow('total size');
  });
});
