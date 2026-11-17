import { it, expect } from 'vitest';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

it('exports clean inputs and refuses tracked private files, personal paths and symlinks', () => {
  const folder = mkdtempSync(join(tmpdir(), 'public-files-')), root = join(folder, 'source');
  mkdirSync(root);
  const command = (program: string, args: string[]) => spawnSync(program, args, { cwd: root, encoding: 'utf8', timeout: 30_000 });
  const run = (output: string) => command(process.execPath, ['scripts/check-public-files.mjs', '--export=' + output]);
  try {
    for (const file of ['package.json', 'package-lock.json', '.gitignore', '.npmignore', '.env.example', 'config.example.json',
      'scripts/check-public-files.mjs', 'LICENSE', 'personas/default.md', 'personas/concise.md', 'personas/friendly.md']) {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      copyFileSync(new URL('../' + file, import.meta.url), join(root, file));
    }
    writeFileSync(join(root, 'README.md'), '# Synthetic release fixture\n');
    mkdirSync(join(root, 'scripts/__pycache__'));
    writeFileSync(join(root, 'scripts/__pycache__/test.pyc'), 'cache');
    writeFileSync(join(root, '.env'), 'PRIVATE_FIXTURE=do-not-export\n');
    const output = join(folder, 'export');
    const result = run(output);
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(join(output, '.env'))).toBe(false);
    expect(existsSync(join(output, 'scripts/__pycache__'))).toBe(false);
    expect(readFileSync(join(output, 'package-lock.json'), 'utf8')).toBe(readFileSync(join(root, 'package-lock.json'), 'utf8'));
    const license = readFileSync(join(root, 'LICENSE'), 'utf8');
    rmSync(join(root, 'LICENSE'));
    let blocked = run(join(folder, 'blocked-license'));
    expect(blocked.status).toBe(1); expect(blocked.stderr).toContain('MIT license');
    expect(existsSync(join(folder, 'blocked-license'))).toBe(false);
    writeFileSync(join(root, 'LICENSE'), license);
    const examplePath = join(root, 'config.example.json'), example = readFileSync(examplePath, 'utf8');
    writeFileSync(examplePath, JSON.stringify({ ...JSON.parse(example), stateDir: '.runtime' }));
    blocked = run(join(folder, 'blocked-state-dir'));
    expect(blocked.status).toBe(1); expect(blocked.stderr).toContain('stateDir must point outside');
    expect(existsSync(join(folder, 'blocked-state-dir'))).toBe(false);
    writeFileSync(examplePath, example);
    mkdirSync(join(root, '.github/workflows'), { recursive: true });
    writeFileSync(join(root, '.github/workflows/unreviewed.yml'), 'name: unreviewed\n');
    blocked = run(join(folder, 'blocked-workflow'));
    expect(blocked.status).toBe(1); expect(blocked.stderr).toContain('outside the reviewed public file tree');
    rmSync(join(root, '.github'), { recursive: true });
    expect(command('git', ['init', '-q']).status).toBe(0);
    expect(command('git', ['add', '-f', '.env']).status).toBe(0);
    blocked = run(join(folder, 'blocked-private'));
    expect(blocked.status).toBe(1); expect(blocked.stderr).toContain('private deployment');
    expect(blocked.stderr).not.toContain('do-not-export');
    expect(existsSync(join(folder, 'blocked-private'))).toBe(false);
    expect(command('git', ['rm', '--cached', '-f', '.env']).status).toBe(0);
    mkdirSync(join(root, 'docs'));
    const personalPath = ['', 'Users', 'fixture-user', 'private.md'].join('/');
    writeFileSync(join(root, 'docs/local.md'), personalPath);
    blocked = run(join(folder, 'blocked-path'));
    expect(blocked.status).toBe(1); expect(blocked.stderr).toContain('personal home path');
    expect(blocked.stderr).not.toContain('fixture-user');
    rmSync(join(root, 'docs/local.md'));
    symlinkSync(join(root, '.env'), join(root, 'docs/link.md'));
    blocked = run(join(folder, 'blocked-link'));
    expect(blocked.status).toBe(1); expect(blocked.stderr).toContain('non-regular files');
    expect(blocked.stderr).not.toContain('do-not-export');
    expect(existsSync(join(folder, 'blocked-link'))).toBe(false);
  } finally { rmSync(folder, { recursive: true, force: true }); }
}, 30_000);
