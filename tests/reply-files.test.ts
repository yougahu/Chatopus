import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ReplyFiles } from '../src/tools/reply-files.js';
import { MAX_OUTPUT_FILE_BYTES, readOutgoingFile } from '../src/output-files.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'chat-reply-files-')); roots.push(root);
  const run = join(root, 'run'), source = join(root, 'workspace'); await mkdir(run); await mkdir(source);
  return { root, run, source, registry: new ReplyFiles(run) };
}
it('registers a private snapshot, returns no host paths, and retains bytes after the source changes', async () => {
  const { run, source, registry } = await fixture(); const content = '# 翻译\n\n完整的中性文档。';
  await writeFile(join(source, 'translation.md'), content);
  const result = await registry.publish(source, 'translation.md', '译文.md');
  expect(result).toMatchObject({ artifactId: expect.stringMatching(/^file-/), name: '译文.md', bytes: Buffer.byteLength(content) });
  expect(JSON.stringify(result)).not.toContain(source); expect(JSON.stringify(result)).not.toContain(run);
  expect(result.note).toContain('not uploaded yet');
  const repeated = await registry.publish(source, 'translation.md', '译文.md'); expect(repeated.artifactId).toBe(result.artifactId);
  await writeFile(join(source, 'translation.md'), '# updated');
  const resolved = await registry.resolve([result.artifactId]);
  expect((await readOutgoingFile(resolved[0], run)).toString()).toBe(content);
  expect(resolved[0].file).toContain('.reply-files');
  resolved[0].name = 'mutated.md'; expect((await registry.resolve([result.artifactId]))[0].name).toBe('译文.md');
});
it('never resolves other-run, fabricated, duplicate or too many IDs', async () => {
  const { run, source, registry } = await fixture(); await writeFile(join(source, 'answer.md'), '# Answer');
  const prepared = await registry.publish(source, 'answer.md'); const another = new ReplyFiles(run);
  await expect(another.resolve([prepared.artifactId])).rejects.toThrow('unavailable in this run');
  await expect(registry.resolve(['file-forged'])).rejects.toThrow('unavailable in this run');
  await expect(registry.resolve([prepared.artifactId, prepared.artifactId])).rejects.toThrow('distinct');
  await expect(registry.resolve(['a', 'b', 'c', 'd', 'e'])).rejects.toThrow('four');
});
it('rejects private paths, traversal, absolute paths, directories, and symlinks even within the task', async () => {
  const { root, source, registry } = await fixture();
  await mkdir(join(source, '.secret')); await writeFile(join(source, '.secret', 'secret.md'), 'private');
  await writeFile(join(source, 'answer.md'), 'answer'); await symlink(join(source, 'answer.md'), join(source, 'alias.md'));
  await symlink(join(source, '.secret'), join(source, 'public')); await mkdir(join(source, 'directory'));
  for (const path of ['.secret/secret.md', '../escape.md', join(root, 'outside.md'), 'alias.md', 'public/secret.md', 'directory', './answer.md', 'a/../answer.md', 'file:///answer.md']) await expect(registry.publish(source, path)).rejects.toThrow();
});
it('rejects an unsafe output name or empty input without creating snapshots', async () => {
  const { run, source, registry } = await fixture(); await writeFile(join(source, 'empty.md'), '');
  await expect(registry.publish(source, 'empty.md')).rejects.toThrow('empty');
  await writeFile(join(source, 'answer.md'), '# hello');
  await expect(registry.publish(source, 'answer.md', '../../bad')).rejects.toThrow('filename');
  expect(await readdir(run)).toEqual([]);
});
it('caps selected aggregate bytes and detects tampering with registered snapshots', async () => {
  const { run, source, registry } = await fixture();
  await writeFile(join(source, 'large.bin'), Buffer.alloc(MAX_OUTPUT_FILE_BYTES, 33));
  const a = await registry.publish(source, 'large.bin', 'a.bin'), b = await registry.publish(source, 'large.bin', 'b.bin');
  await writeFile(join(source, 'small.csv'), 'name,value\nA,1\n'); const c = await registry.publish(source, 'small.csv');
  expect(await registry.resolve([a.artifactId, b.artifactId])).toHaveLength(2);
  await expect(registry.resolve([a.artifactId, b.artifactId, c.artifactId])).rejects.toThrow('20 MiB');
  const file = (await registry.resolve([c.artifactId]))[0]; await chmod(file.file, 0o600);
  const changed = await readFile(file.file); changed[0] = 33; await writeFile(file.file, changed);
  await expect(registry.resolve([c.artifactId])).rejects.toThrow('output file');
  expect((await readdir(join(run, '.reply-files'))).length).toBe(3);
});
it('cannot register files after cancellation', async () => {
  const { run, source, registry } = await fixture(); await writeFile(join(source, 'answer.md'), '# Answer');
  const abort = new AbortController(); abort.abort(new Error('Task cancelled'));
  await expect(registry.publish(source, 'answer.md', undefined, abort.signal)).rejects.toThrow('cancelled');
  expect(await readdir(run)).toEqual([]);
});
