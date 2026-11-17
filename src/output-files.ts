import { constants, promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { OutgoingFile } from './types.js';

export const MAX_OUTPUT_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_OUTPUT_FILE_COUNT = 4;
export const MAX_OUTPUT_FILE_TOTAL_BYTES = 20 * 1024 * 1024;

/** A display name is a single portable filename, never a path or control sequence. */
export function validateOutputFileName(value: unknown): string {
  if (typeof value !== 'string' || !value || value !== value.trim() || value.startsWith('.') || value.endsWith('.')
    || Buffer.byteLength(value, 'utf8') > 255 || /[\u0000-\u001f\u007f-\u009f/\\:*?"<>|\u202a-\u202e\u2066-\u2069]/u.test(value)
    || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(value)) throw new Error('Use a valid filename without directories or control characters');
  return value;
}

const contained = (root: string, file: string) => file.startsWith(root + path.sep);

/** Bounded read of a regular, non-symlink file under a trusted task directory. */
export async function readTaskFile(file: string, root: string, expectedBytes?: number): Promise<Buffer> {
  const directory = path.resolve(root), target = path.resolve(file);
  const rootStat = await fs.lstat(directory);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error('Invalid file root');
  const realRoot = await fs.realpath(directory);
  const pathRoot = contained(directory, target) ? directory : contained(realRoot, target) ? realRoot : undefined;
  if (!pathRoot) throw new Error('File outside task root');
  const segments = path.relative(pathRoot, target).split(path.sep);
  let current = pathRoot;
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink() || (index < segments.length - 1 ? !stat.isDirectory() : !stat.isFile())) throw new Error('Invalid file path');
  }
  if (!contained(realRoot, await fs.realpath(target))) throw new Error('File outside task root');
  const handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size < 1 || before.size > MAX_OUTPUT_FILE_BYTES || (expectedBytes !== undefined && before.size !== expectedBytes)) throw new Error('File size is invalid or changed');
    const buffer = Buffer.alloc(before.size + 1); let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    const after = await handle.stat();
    if (length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new Error('File changed during read');
    return buffer.subarray(0, length);
  } finally { await handle.close(); }
}

/** Read only host-recorded bytes, never a path selected by the model at delivery time. */
export async function readOutgoingFile(file: OutgoingFile, root: string): Promise<Buffer> {
  try {
    if (!file || file.kind !== 'file' || typeof file.artifactId !== 'string' || !file.artifactId || file.artifactId.length > 128
      || typeof file.file !== 'string' || !path.isAbsolute(file.file) || /[\0\r\n]/.test(file.file)
      || !Number.isSafeInteger(file.bytes) || file.bytes < 1 || file.bytes > MAX_OUTPUT_FILE_BYTES
      || typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error('Invalid file metadata');
    validateOutputFileName(file.name);
    const bytes = await readTaskFile(file.file, root, file.bytes);
    if (createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw new Error('File content changed');
    return bytes;
  } catch {
    throw new Error('Invalid or unavailable output file');
  }
}
