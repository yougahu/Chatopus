import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, symlink, truncate } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { MAX_OUTPUT_FILE_BYTES, readOutgoingFile, validateOutputFileName } from '../src/output-files.js';
import type { OutgoingFile } from '../src/types.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(bytes = Buffer.from('# 翻译\n\n一份中性文档。')) {
  const root = await mkdtemp(join(tmpdir(), 'chat-output-files-')); roots.push(root);
  const file = join(root, 'output.md'); await writeFile(file, bytes);
  const artifact: OutgoingFile = { kind: 'file', artifactId: 'file-test', file, name: '翻译.md', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  return { root, file, artifact, bytes };
}
it('reads exact UTF-8 and binary artifact bytes with a portable display name', async () => {
  for (const bytes of [Buffer.from('# 文档\n\n完整正文'), Buffer.from([0, 1, 2, 255, 254, 128])]) {
    const value = await fixture(bytes);
    expect(await readOutgoingFile(value.artifact, value.root)).toEqual(bytes);
  }
  expect(validateOutputFileName('项目笔记 2026.md')).toBe('项目笔记 2026.md');
});
it.each(['', '.', '..', '.secret', '../escape.md', 'dir/file.md', 'dir\\file.md', 'file:stream', 'newline\n.md', 'bidi\u202e.md', 'nul.txt', ' report.md', 'report.md ', 'report.', 'a'.repeat(256), '文'.repeat(86)])('rejects unsafe file name %j', name => {
  expect(() => validateOutputFileName(name)).toThrow();
});
it('rejects changed bytes and forged metadata without exposing local paths', async () => {
  const { root, file, artifact, bytes } = await fixture();
  const changed = Buffer.from(bytes); changed[0] = 33; await writeFile(file, changed);
  for (const candidate of [artifact, { ...artifact, bytes: -1 }, { ...artifact, bytes: MAX_OUTPUT_FILE_BYTES + 1 }, { ...artifact, name: '../secret' }, { ...artifact, sha256: 'forged' }]) {
    await expect(readOutgoingFile(candidate, root)).rejects.toThrow('Invalid or unavailable output file');
    await expect(readOutgoingFile(candidate, root)).rejects.not.toThrow(root);
  }
});
it('rejects empty and oversized files before reading their contents', async () => {
  const { root, file, artifact } = await fixture();
  await writeFile(file, '');
  await expect(readOutgoingFile({ ...artifact, bytes: 0, sha256: createHash('sha256').update('').digest('hex') }, root)).rejects.toThrow();
  await truncate(file, MAX_OUTPUT_FILE_BYTES + 1);
  await expect(readOutgoingFile(artifact, root)).rejects.toThrow();
});
it('rejects paths outside the output root, directories, and any symlink component', async () => {
  const { root, artifact } = await fixture();
  const nested = join(root, 'nested'); await mkdir(nested); await symlink(artifact.file, join(nested, 'file-link'));
  await symlink(nested, join(root, 'directory-link')); await writeFile(join(nested, 'plain.md'), '# content');
  for (const file of [root, nested, join(nested, 'file-link'), join(root, 'directory-link', 'plain.md')]) await expect(readOutgoingFile({ ...artifact, file }, root)).rejects.toThrow();
  await expect(readOutgoingFile(artifact, nested)).rejects.toThrow();
  await expect(readOutgoingFile({ ...artifact, file: join(root, 'directory-link', 'plain.md') }, join(root, 'directory-link'))).rejects.toThrow();
});
