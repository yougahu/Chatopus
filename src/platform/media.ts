import { createHash, randomUUID } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { imageMime } from '../output-images.js';
import type { Attachment } from '../types.js';
import type { OneBotAdapter } from './onebot.js';

export interface ImageDiagnostic {
  stage: 'cache' | 'cache_write' | 'original_url' | 'get_image' | 'transport_bytes' | 'local_cache' | 'refreshed_url';
  status: 'hit' | 'success' | 'failed' | 'miss' | 'skipped';
  code?: string;
  httpStatus?: number;
  bytes?: number;
  durationMs: number;
}
export interface ImageOptions {
  maxBytes?: number;
  timeoutMs?: number;
  /** Trusted bridge filesystem root, separate from our persistent received-image cache. */
  cacheRoot?: string;
  cacheDir?: string;
  /** Host-provided room/message/attachment identity. It is hashed before use on disk. */
  cacheKey?: string;
  onDiagnostic?: (event: ImageDiagnostic) => void;
}
const qqHosts = new Set(['multimedia.nt.qq.com.cn', 'gchat.qpic.cn', 'c2cpicdw.qpic.cn']);
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

class ImageError extends Error {
  constructor(readonly code: string, message: string, readonly httpStatus?: number) { super(message); }
}
const invalid = () => new ImageError('invalid_image', 'Unsupported image content');
const oversized = () => new ImageError('image_too_large', 'Invalid or oversized image');

function validate(data: Buffer, limit: number): Buffer {
  if (!data.length) throw invalid();
  if (data.length > limit) throw oversized();
  try { imageMime(data); } catch { throw invalid(); }
  return data;
}
function decode(value: unknown, limit: number): Buffer {
  if (typeof value !== 'string' || !value.length || value.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw invalid();
  if (value.length > 4 * Math.ceil(limit / 3)) throw oversized();
  const data = Buffer.from(value, 'base64');
  if (data.toString('base64').replace(/=+$/, '') !== value.replace(/=+$/, '')) throw invalid();
  return validate(data, limit);
}

/** Bound reads even if a file grows, and reject indirect paths below the trusted root. */
async function boundedFile(root: string, file: string, limit: number): Promise<Buffer> {
  if (!isAbsolute(file) || file.split(sep).includes('..') || /[\0\r\n]/.test(file)) throw new ImageError('untrusted_path', 'Untrusted image path');
  const directory = resolve(root), realRoot = await fs.realpath(directory), target = resolve(file);
  const contained = (base: string, child: string) => { const rel = relative(base, child); return rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel); };
  const pathRoot = contained(directory, target) ? directory : contained(realRoot, target) ? realRoot : undefined;
  if (!pathRoot) throw new ImageError('untrusted_path', 'Untrusted image path');
  let current = pathRoot;
  for (const part of relative(pathRoot, target).split(sep)) {
    current = join(current, part);
    if ((await fs.lstat(current)).isSymbolicLink()) throw new ImageError('untrusted_path', 'Untrusted image path');
  }
  if (!contained(realRoot, await fs.realpath(target))) throw new ImageError('untrusted_path', 'Untrusted image path');
  const handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1) throw new ImageError('untrusted_path', 'Untrusted image path');
    if (before.size > limit) throw oversized();
    const buffer = Buffer.alloc(Math.min(before.size, limit) + 1); let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    const after = await handle.stat();
    if (length > limit) throw oversized();
    if (length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new ImageError('file_changed', 'Image file changed');
    return buffer.subarray(0, length);
  } finally { await handle.close(); }
}

/** Fetch selected question images once and retain their validated bytes across worker runs. */
export async function resolveOneBotImage(adapter: Pick<OneBotAdapter, 'call'>, attachment: Attachment, options: ImageOptions = {}): Promise<Attachment> {
  const maxBytes = options.maxBytes ?? 10 * 1024 * 1024;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new ImageError('invalid_limit', 'Invalid image size limit');
  const identity = options.cacheKey ?? (attachment.file ? `file:${attachment.file}` : `url:${attachment.url ?? ''}`);
  const cacheFile = options.cacheDir ? join(resolve(options.cacheDir), `${digest(identity)}.json`) : undefined;
  let lastError = new ImageError('image_unavailable', 'Image data unavailable');
  const record = (event: ImageDiagnostic) => { try { options.onDiagnostic?.(event); } catch { /* Diagnostics cannot break image delivery. */ } };
  async function attempt<T>(stage: ImageDiagnostic['stage'], operation: () => Promise<T>): Promise<T | undefined> {
    const started = Date.now();
    try {
      const result = await operation();
      record({ stage, status: 'success', durationMs: Date.now() - started, ...(Buffer.isBuffer(result) ? { bytes: result.length } : {}) });
      return result;
    } catch (error) {
      lastError = error instanceof ImageError ? error : new ImageError(`${stage}_failed`, `Image ${stage} failed`);
      record({ stage, status: 'failed', code: lastError.code, ...(lastError.httpStatus === undefined ? {} : { httpStatus: lastError.httpStatus }), durationMs: Date.now() - started });
      return undefined;
    }
  }
  if (cacheFile) {
    const started = Date.now();
    try {
      const raw = await boundedFile(options.cacheDir!, cacheFile, 4 * Math.ceil(maxBytes / 3) + 512);
      const item = JSON.parse(raw.toString());
      if (item.version !== 1 || typeof item.sha256 !== 'string') throw invalid();
      const data = decode(item.base64, maxBytes), mimeType = imageMime(data);
      if (item.sha256 !== digest(data) || item.mimeType !== mimeType) throw invalid();
      record({ stage: 'cache', status: 'hit', bytes: data.length, durationMs: Date.now() - started });
      return { kind: 'image', mimeType, url: `data:${mimeType};base64,${data.toString('base64')}` };
    } catch (error) {
      const missing = (error as NodeJS.ErrnoException)?.code === 'ENOENT';
      record({ stage: 'cache', status: missing ? 'miss' : 'failed', ...(missing ? {} : { code: 'cache_invalid' }), durationMs: Date.now() - started });
    }
  }
  async function finish(data: Buffer): Promise<Attachment> {
    const mimeType = imageMime(data), base64 = data.toString('base64');
    if (cacheFile) await attempt('cache_write', async () => {
      await fs.mkdir(options.cacheDir!, { recursive: true, mode: 0o700 });
      const temporary = `${cacheFile}.${randomUUID()}.tmp`;
      try {
        await fs.writeFile(temporary, JSON.stringify({ version: 1, mimeType, sha256: digest(data), base64 }), { flag: 'wx', mode: 0o600 });
        await fs.rename(temporary, cacheFile);
      } finally { await fs.rm(temporary, { force: true }); }
      return data;
    });
    return { kind: 'image', mimeType, url: `data:${mimeType};base64,${base64}` };
  }
  const attemptedUrls = new Set<string>();
  async function download(url: string, stage: 'original_url' | 'refreshed_url'): Promise<Buffer | undefined> {
    if (attemptedUrls.has(url)) { record({ stage, status: 'skipped', code: 'unchanged_url', durationMs: 0 }); return undefined; }
    attemptedUrls.add(url);
    return attempt(stage, async () => {
      let target: URL;
      try { target = new URL(url); } catch { throw new ImageError('untrusted_url', 'Untrusted image URL'); }
      if (target.protocol !== 'https:' || target.username || target.password || !qqHosts.has(target.hostname) || (target.port && target.port !== '443')) throw new ImageError('untrusted_url', 'Untrusted image URL');
      const response = await fetch(target, { redirect: 'error', signal: AbortSignal.timeout(options.timeoutMs ?? 15000) });
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new ImageError('http_error', 'Image download failed', response.status);
      }
      if (Number(response.headers.get('content-length')) > maxBytes) { await response.body.cancel(); throw oversized(); }
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of response.body) {
        size += chunk.byteLength;
        if (size > maxBytes) throw oversized();
        chunks.push(Buffer.from(chunk));
      }
      return validate(Buffer.concat(chunks), maxBytes);
    });
  }
  if (attachment.url) {
    const data = await download(attachment.url, 'original_url');
    if (data) return finish(data);
  }
  if (attachment.file) {
    const response = await attempt('get_image', () => adapter.call('get_image', { file: attachment.file }));
    if (response) {
      const encoded = response.base64 ?? (typeof response.file === 'string' && response.file.startsWith('base64://') ? response.file.slice(9) : undefined);
      if (encoded !== undefined) {
        const data = await attempt('transport_bytes', async () => decode(encoded, maxBytes));
        if (data) return finish(data);
      }
      if (options.cacheRoot && typeof response.file === 'string' && !response.file.startsWith('base64://')) {
        const data = await attempt('local_cache', async () => validate(await boundedFile(options.cacheRoot!, response.file as string, maxBytes), maxBytes));
        if (data) return finish(data);
      }
      if (typeof response.url === 'string' && response.url) {
        const data = await download(response.url, 'refreshed_url');
        if (data) return finish(data);
      }
    }
  }
  throw lastError;
}
