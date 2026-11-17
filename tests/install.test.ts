import { afterEach, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('..', import.meta.url));
const temporaries: string[] = [];
afterEach(() => { for (const path of temporaries.splice(0)) rmSync(path, { recursive: true, force: true }); });

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'chatopus-install-'))); temporaries.push(root);
  // Shell metacharacters must remain literal in the generated launcher.
  const source = join(root, "source ' $literal"), deployment = join(root, "deployment ' $literal");
  const bin = join(root, 'bin'), installer = join(source, 'scripts', 'install.mjs'), npmLog = join(root, 'npm-args');
  for (const path of [dirname(installer), bin, join(source, 'src'), join(source, 'node_modules', 'tsx', 'dist')]) mkdirSync(path, { recursive: true });
  copyFileSync(join(repository, 'scripts', 'install.mjs'), installer);
  for (const file of ['config.example.json', '.env.example']) copyFileSync(join(repository, file), join(source, file));
  writeFileSync(join(source, 'src', 'cli.ts'), '// Fixture entrypoint\n');
  writeFileSync(join(source, 'node_modules', 'tsx', 'dist', 'cli.mjs'), `
    import { readFileSync } from 'node:fs';
    const [entry, command, ...args] = process.argv.slice(2);
    console.log('CLI_FIXTURE ' + JSON.stringify({ entry, command, args, cwd: process.cwd(),
      config: JSON.parse(readFileSync('config.local.json', 'utf8')) }));
    if (command === 'doctor' && process.env.INSTALL_TEST_DOCTOR_FAIL) process.exitCode = 1;
  `);
  writeFileSync(join(bin, 'npm'), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$INSTALL_TEST_NPM_LOG"\n');
  writeFileSync(join(bin, 'rg'), '#!/bin/sh\nprintf "ripgrep fixture\\n"\n');
  chmodSync(join(bin, 'npm'), 0o700); chmodSync(join(bin, 'rg'), 0o700);
  const env = { PATH: bin + ':' + (process.env.PATH ?? ''), INSTALL_TEST_NPM_LOG: npmLog };
  const install = (args: string[] = [], extraEnv: Record<string, string> = {}) => spawnSync(process.execPath,
    [installer, '--deploy-dir', deployment, ...args], { cwd: root, env: { ...env, ...extraEnv }, encoding: 'utf8', timeout: 15_000 });
  return { root, source, deployment, installer, npmLog, env, install };
}

it('installs empty external configuration, runtime dependencies and a launcher that safely forwards arguments', () => {
  const f = fixture(), result = f.install();
  expect(result.status, result.stderr).toBe(0);
  expect(readFileSync(f.npmLog, 'utf8')).toBe('--version\nci --include=dev\n');
  const config = JSON.parse(readFileSync(join(f.deployment, 'config.local.json'), 'utf8'));
  expect(config.stateDir).toBe(join(f.deployment, 'runtime'));
  expect(config.router.model).toBe('YOUR_MODEL_ID'); expect(config.worker.model).toBe('YOUR_MODEL_ID');
  expect(config.qq.enabled).toBe(false); expect(config.memory.enabled).toBe(false);
  expect(readFileSync(join(f.deployment, '.env'), 'utf8')).toBe(readFileSync(join(f.source, '.env.example'), 'utf8'));
  for (const [file, mode] of [['config.local.json', 0o600], ['.env', 0o600], ['chatopus', 0o700]] as const) {
    expect(statSync(join(f.deployment, file)).mode & 0o777).toBe(mode);
  }
  expect(statSync(f.deployment).mode & 0o777).toBe(0o700);
  expect(existsSync(join(f.deployment, 'runtime'))).toBe(true);
  expect(existsSync(join(f.source, 'config.local.json'))).toBe(false);
  const argument = "keep spaces, 'quotes', $literal and $(touch unexpected-file)";
  const launched = spawnSync(join(f.deployment, 'chatopus'), ['ask', argument], { cwd: f.root, env: f.env, encoding: 'utf8' });
  expect(launched.status, launched.stderr).toBe(0);
  const report = JSON.parse(launched.stdout.trim().replace('CLI_FIXTURE ', ''));
  expect(report.cwd).toBe(f.deployment); expect(report.args).toEqual([argument]);
  expect(report.entry).toBe(join(f.source, 'src', 'cli.ts'));
  expect(existsSync(join(f.root, 'unexpected-file'))).toBe(false);
});

it('preserves existing private configuration, credentials and state when rerun', () => {
  const f = fixture(); expect(f.install(['--skip-deps']).status).toBe(0);
  const config = '{ "stateDir": "./custom-state", "router": { "model": "fixture-model" }, "custom": true }\n';
  const credentials = 'ROUTER_API_KEY=fixture-router-key\nWORKER_API_KEY=fixture-worker-key\n';
  writeFileSync(join(f.deployment, 'config.local.json'), config); writeFileSync(join(f.deployment, '.env'), credentials);
  mkdirSync(join(f.deployment, 'custom-state')); writeFileSync(join(f.deployment, 'custom-state', 'sentinel'), 'existing state');
  const result = f.install(['--skip-deps']); expect(result.status, result.stderr).toBe(0);
  expect(readFileSync(join(f.deployment, 'config.local.json'), 'utf8')).toBe(config);
  expect(readFileSync(join(f.deployment, '.env'), 'utf8')).toBe(credentials);
  expect(readFileSync(join(f.deployment, 'custom-state', 'sentinel'), 'utf8')).toBe('existing state');
  expect(result.stdout).not.toContain('fixture-router-key');
  expect(readFileSync(f.npmLog, 'utf8')).not.toContain('ci');
});

it('rejects private deployment paths inside the source, including symlink aliases', () => {
  const f = fixture(), alias = join(f.root, 'alias'); symlinkSync(f.source, alias);
  for (const path of [f.source, join(f.source, 'private'), join(alias, 'private'), f.root]) {
    const result = f.install(['--deploy-dir', path]);
    expect(result.status).toBe(1); expect(result.stderr).toContain('源码目录之外');
  }
  expect(existsSync(f.npmLog)).toBe(false); expect(existsSync(join(f.source, 'private'))).toBe(false);
});

it('refuses to overwrite an unmanaged launcher or follow a private-file symlink', () => {
  const f = fixture(); mkdirSync(f.deployment);
  const launcher = join(f.deployment, 'chatopus'); writeFileSync(launcher, '# existing custom launcher\n');
  expect(f.install().status).toBe(1); expect(readFileSync(launcher, 'utf8')).toBe('# existing custom launcher\n');
  rmSync(launcher); const target = join(f.root, 'existing-env'); writeFileSync(target, 'fixture-data');
  symlinkSync(target, join(f.deployment, '.env'));
  expect(f.install().status).toBe(1); expect(readFileSync(target, 'utf8')).toBe('fixture-data');
  expect(existsSync(f.npmLog)).toBe(false);
});

it('reports missing dependencies or malformed config without announcing success or starting admin', () => {
  const f = fixture(); rmSync(join(f.source, 'node_modules'), { recursive: true });
  const missing = f.install(['--skip-deps', '--start-admin']); expect(missing.status).toBe(1);
  expect(missing.stderr).toContain('缺少 tsx'); expect(existsSync(f.deployment)).toBe(false);
  mkdirSync(f.deployment); writeFileSync(join(f.deployment, 'config.local.json'), '{ invalid fixture JSON');
  const invalid = f.install(); expect(invalid.status).toBe(1); expect(invalid.stderr).toContain('不是有效的 JSON');
  expect(readFileSync(join(f.deployment, 'config.local.json'), 'utf8')).toBe('{ invalid fixture JSON');
  expect(invalid.stdout).not.toContain('基础安装完成');
});

it('starts admin only after doctor succeeds and forwards the requested port', () => {
  const f = fixture(), failed = f.install(['--skip-deps', '--start-admin'], { INSTALL_TEST_DOCTOR_FAIL: '1' });
  expect(failed.status).toBe(1); expect(failed.stdout).not.toContain('基础安装完成'); expect(failed.stdout).not.toContain('"command":"admin"');
  const result = f.install(['--skip-deps', '--start-admin', '--port', '0']); expect(result.status, result.stderr).toBe(0);
  const reports = result.stdout.split('\n').filter(line => line.startsWith('CLI_FIXTURE ')).map(line => JSON.parse(line.slice(12)));
  expect(reports.map(report => report.command)).toEqual(['doctor', 'admin']);
  expect(reports[1].args).toEqual(['--port', '0']);
});

it.each([['--port', '-1'], ['--port', '65536'], ['--port', '1.5'], ['--deploy-dir'], ['--unexpected']])('rejects invalid installer options %j before creating a deployment', (...args) => {
  const f = fixture(), result = f.install(args);
  expect(result.status).toBe(1); expect(existsSync(f.deployment)).toBe(false); expect(existsSync(f.npmLog)).toBe(false);
});
