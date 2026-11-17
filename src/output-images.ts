import { constants, promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { OutgoingImage } from './types.js';

export const MAX_OUTPUT_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_OUTPUT_IMAGE_COUNT = 4;
export const MAX_OUTPUT_TOTAL_BYTES = 20 * 1024 * 1024;

export function imageMime(data: Buffer): OutgoingImage['mimeType'] {
  if (data.length >= 24 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (data.length >= 4 && data[0] === 255 && data[1] === 216 && data[2] === 255) return 'image/jpeg';
  if (data.length >= 13 && ['GIF87a', 'GIF89a'].includes(data.subarray(0, 6).toString())) return 'image/gif';
  if (data.length >= 16 && data.subarray(0, 4).toString() === 'RIFF' && data.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  throw new Error('Unsupported image content');
}

const contained = (root: string, file: string) => file.startsWith(root + path.sep);

/** Read only the exact, host-recorded bytes of an artifact inside this service's workspace. */
export async function readOutgoingImage(image: OutgoingImage, root: string): Promise<Buffer> {
  try {
    if (!image || image.kind !== 'image' || typeof image.artifactId !== 'string' || !image.artifactId
      || typeof image.file !== 'string' || !path.isAbsolute(image.file) || /[\0\r\n]/.test(image.file)
      || !Number.isInteger(image.bytes) || image.bytes < 1 || image.bytes > MAX_OUTPUT_IMAGE_BYTES
      || typeof image.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(image.sha256)) throw new Error('Invalid image metadata');
    const directory = path.resolve(root), file = path.resolve(image.file);
    const rootStat = await fs.lstat(directory);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error('Invalid image output root');
    const realRoot = await fs.realpath(directory);
    // macOS may spell the trusted root through /var while artifacts use /private/var.
    const pathRoot = contained(directory, file) ? directory : contained(realRoot, file) ? realRoot : undefined;
    if (!pathRoot) throw new Error('Image outside output root');
    const segments = path.relative(pathRoot, file).split(path.sep);
    let current = pathRoot;
    for (const [index, segment] of segments.entries()) {
      current = path.join(current, segment);
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink() || (index < segments.length - 1 ? !stat.isDirectory() : !stat.isFile())) throw new Error('Invalid image artifact path');
    }
    if (!contained(realRoot, await fs.realpath(file))) throw new Error('Image outside output root');
    const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.size !== image.bytes) throw new Error('Image artifact changed');
      // Read at most the expected size plus one byte, even if a writer grows it.
      const buffer = Buffer.alloc(image.bytes + 1); let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      const after = await handle.stat();
      if (length !== image.bytes || after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new Error('Image artifact changed');
      const data = buffer.subarray(0, length);
      if (imageMime(data) !== image.mimeType || createHash('sha256').update(data).digest('hex') !== image.sha256) throw new Error('Image artifact content mismatch');
      return data;
    } finally { await handle.close(); }
  } catch {
    // Do not expose filesystem paths, file contents, or low-level open errors.
    throw new Error('Invalid or unavailable output image');
  }
}
