import { afterEach, expect, it } from 'vitest';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probeExecutable, probeRipgrep } from '../src/diagnostics.js';

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
async function fixture(script?: string) {
  const directory = await mkdtemp(join(tmpdir(), 'boe2-doctor-test-'));
  directories.push(directory);
  if (script) { await writeFile(join(directory, 'rg'), '#!/bin/sh\n' + script); await chmod(join(directory, 'rg'), 0o755); }
  return directory;
}

it('fails a missing service dependency even if the interactive PATH can resolve it', async () => {
  const path = await fixture();
  expect(await probeRipgrep(path)).toEqual({ available: false, error: 'NOT_FOUND', files: false, search: false });
});

it('checks real file discovery and search instead of treating --version as readiness', async () => {
  const path = await fixture('if [ "$1" = "--version" ]; then printf "ripgrep test\n"; exit 0; fi\nprintf "private-error-must-not-leak" >&2\nexit 7\n');
  expect(await probeExecutable('rg', path)).toMatchObject({ available: true, version: 'ripgrep test' });
  const result = await probeRipgrep(path);
  expect(result).toMatchObject({ available: false, files: false, search: false, error: '7' });
  expect(JSON.stringify(result)).not.toContain('private-error-must-not-leak');
});

it('rejects unexpected search output even when a command exits successfully', async () => {
  const path = await fixture('printf "ripgrep test\n"\n');
  expect(await probeRipgrep(path)).toMatchObject({ available: false, files: false, search: false, error: 'PROBE_MISMATCH' });
});

it('reports an unconfigured executable without spawning a process', async () => {
  expect(await probeExecutable(undefined)).toEqual({ available: false, error: 'NOT_CONFIGURED' });
});
