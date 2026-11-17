import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import type { OutgoingImage } from '../src/types.js';
import { imageMime, MAX_OUTPUT_IMAGE_BYTES, readOutgoingImage } from '../src/output-images.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6yJkAAAAASUVORK5CYII=', 'base64');
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true }))); });
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'boe2-output-image-')); directories.push(root);
  const file = path.join(root, 'topic', 'run', '.reply-images', 'image.png');
  await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, png, { mode: 0o600 });
  const image: OutgoingImage = { kind: 'image', artifactId: 'image-test', file, mimeType: 'image/png', bytes: png.length, sha256: createHash('sha256').update(png).digest('hex') };
  return { root, image };
}

describe('durable output image validation', () => {
  it('returns exactly the recorded bytes, including a canonical path under a root alias', async () => {
    const { root, image } = await fixture();
    expect(await readOutgoingImage(image, root)).toEqual(png);
    expect(await readOutgoingImage({ ...image, file: await fs.realpath(image.file) }, root)).toEqual(png);
    expect(imageMime(png)).toBe('image/png');
  });

  it('rejects substituted content and mismatched type, size or digest', async () => {
    const { root, image } = await fixture();
    for (const invalid of [
      { ...image, mimeType: 'image/jpeg' as const }, { ...image, bytes: image.bytes - 1 },
      { ...image, sha256: '0'.repeat(64) }, { ...image, bytes: MAX_OUTPUT_IMAGE_BYTES + 1 },
    ]) await expect(readOutgoingImage(invalid, root)).rejects.toThrow('Invalid or unavailable output image');
    const changed = Buffer.from(png); changed[changed.length - 1] ^= 1;
    await fs.writeFile(image.file, changed);
    await expect(readOutgoingImage(image, root)).rejects.toThrow('Invalid or unavailable output image');
  });

  it('rejects files outside the root and URLs without opening them', async () => {
    const a = await fixture(), b = await fixture();
    for (const file of [b.image.file, 'https://example.com/picture.png', 'base64://abcd', 'file://' + a.image.file, '../picture.png']) {
      await expect(readOutgoingImage({ ...a.image, file }, a.root)).rejects.toThrow('Invalid or unavailable output image');
    }
    await expect(readOutgoingImage({ ...a.image, file: a.root }, a.root)).rejects.toThrow('Invalid or unavailable output image');
  });

  it('rejects leaf and directory symlinks even when their target remains inside the root', async () => {
    const { root, image } = await fixture();
    const leaf = path.join(root, 'alias.png'), directory = path.join(root, 'alias-dir');
    await fs.symlink(image.file, leaf); await fs.symlink(path.dirname(image.file), directory);
    for (const file of [leaf, path.join(directory, 'image.png')]) {
      await expect(readOutgoingImage({ ...image, file }, root)).rejects.toThrow('Invalid or unavailable output image');
    }
    await expect(readOutgoingImage(image, directory)).rejects.toThrow('Invalid or unavailable output image');
  });

  it('rejects non-image bytes even with a matching host digest', async () => {
    const { root, image } = await fixture(); const invalid = Buffer.from('not an image or a screenshot');
    await fs.writeFile(image.file, invalid);
    await expect(readOutgoingImage({ ...image, bytes: invalid.length, sha256: createHash('sha256').update(invalid).digest('hex') }, root)).rejects.toThrow('Invalid or unavailable output image');
    expect(() => imageMime(png.subarray(0, 8))).toThrow('Unsupported image content');
  });
});
