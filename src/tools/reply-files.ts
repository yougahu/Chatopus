import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { OutgoingFile } from '../types.js';
import { MAX_OUTPUT_FILE_COUNT, MAX_OUTPUT_FILE_TOTAL_BYTES, readOutgoingFile, readTaskFile, validateOutputFileName } from '../output-files.js';

type FileMetadata = Pick<OutgoingFile, 'artifactId' | 'name' | 'bytes'>;

/** Registers private immutable copies, so later edits cannot alter a selected delivery. */
export class ReplyFiles {
  private files = new Map<string, OutgoingFile>();
  constructor(private readonly workspace: string) {}

  async publish(root: string, relative: unknown, requestedName?: unknown, signal?: AbortSignal): Promise<FileMetadata & { note: string }> {
    signal?.throwIfAborted();
    if (typeof relative !== 'string' || !relative || relative.length > 1000 || path.isAbsolute(relative)
      || /[\\:\u0000-\u001f\u007f]/u.test(relative) || relative.split('/').some(part => !part || part.startsWith('.'))) throw new Error('Select a visible file inside the current task workspace or run');
    const name = validateOutputFileName(requestedName ?? path.basename(relative));
    let bytes: Buffer;
    try { bytes = await readTaskFile(path.resolve(root, relative), root); }
    catch { throw new Error('Task file is unavailable, outside its root, empty, not a regular file, or exceeds 10 MiB'); }
    signal?.throwIfAborted();
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const duplicate = [...this.files.values()].find(file => file.name === name && file.sha256 === sha256);
    if (duplicate) { await readOutgoingFile(duplicate, this.workspace); signal?.throwIfAborted(); return this.metadata(duplicate); }
    let file: string | undefined;
    try {
      const runStat = await fs.lstat(this.workspace);
      if (!runStat.isDirectory() || runStat.isSymbolicLink()) throw new Error('Invalid file output directory');
      const directory = path.join(await fs.realpath(this.workspace), '.reply-files');
      try { await fs.mkdir(directory, { mode: 0o700 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      const stat = await fs.lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Invalid file output directory');
      const artifactId = `file-${randomUUID()}`; file = path.join(directory, artifactId);
      signal?.throwIfAborted();
      await fs.writeFile(file, bytes, { flag: 'wx', mode: 0o400 });
      signal?.throwIfAborted();
      const snapshot: OutgoingFile = { kind: 'file', artifactId, file, name, bytes: bytes.length, sha256 };
      await readOutgoingFile(snapshot, this.workspace);
      signal?.throwIfAborted();
      this.files.set(artifactId, snapshot);
      return this.metadata(snapshot);
    } catch {
      if (file) await fs.unlink(file).catch(() => {});
      signal?.throwIfAborted();
      throw new Error('File output directory or snapshot is unavailable');
    }
  }

  private metadata({ artifactId, name, bytes }: OutgoingFile): FileMetadata & { note: string } {
    return { artifactId, name, bytes, note: 'Prepared for delivery, not uploaded yet. Select this artifactId in the final report files array. The host uploads selected files to the task group after accepting your report; do not claim upload success before a receipt.' };
  }

  async resolve(ids: string[]): Promise<OutgoingFile[]> {
    if (!Array.isArray(ids) || ids.length > MAX_OUTPUT_FILE_COUNT || new Set(ids).size !== ids.length) throw new Error('Select at most four distinct reply files');
    const files = ids.map(id => {
      const file = this.files.get(id);
      if (!file) throw new Error('Reply file ID is unavailable in this run; prepare it with artifact_publish');
      return file;
    });
    if (files.reduce((total, file) => total + file.bytes, 0) > MAX_OUTPUT_FILE_TOTAL_BYTES) throw new Error('Reply files exceed the 20 MiB total size limit');
    for (const file of files) await readOutgoingFile(file, this.workspace);
    return files.map(file => ({ ...file }));
  }
}
