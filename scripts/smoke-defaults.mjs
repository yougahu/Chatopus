/** Exercise the installed CLI and admin in a fresh, disposable deployment. */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';

const temporary = await mkdtemp(join(tmpdir(), 'chatopus-defaults-'));
const directory = join(temporary, 'deployment'), stateDir = join(temporary, 'runtime');
const env = Object.fromEntries(['PATH', 'SystemRoot', 'TMPDIR', 'TMP', 'TEMP', 'LANG'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
const args = ['--import', import.meta.resolve('tsx'), fileURLToPath(new URL('../src/cli.ts', import.meta.url))];
let admin;
try {
  await mkdir(directory);
  const example = JSON.parse(await readFile(new URL('../config.example.json', import.meta.url), 'utf8'));
  // Keep verification isolated from the operator's configured home directory.
  await writeFile(join(directory, 'config.local.json'), JSON.stringify({ ...example, stateDir }));
  const doctor = spawnSync(process.execPath, [...args, 'doctor'], { cwd: directory, env, encoding: 'utf8', timeout: 30_000 });
  assert.equal(doctor.status, 0, 'Default doctor must succeed');
  const result = JSON.parse(doctor.stdout);
  assert.deepEqual(result.checks.skills, []); assert.deepEqual(result.checks.extensions, []);
  assert.equal(result.checks.routerApiConfigured, false); assert.equal(result.checks.workerApiConfigured, false);
  admin = spawn(process.execPath, [...args, 'admin', '--port', '0'], { cwd: directory, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  admin.stderr.resume();
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Default admin startup timed out')), 15_000);
    admin.once('error', error => { clearTimeout(timer); reject(error); });
    admin.once('exit', code => { clearTimeout(timer); reject(new Error('Admin exited before startup: ' + code)); });
    admin.stdout.on('data', data => {
      output += data.toString();
      const match = /Chatopus admin: (http:\/\/127\.0\.0\.1:\d+)/.exec(output);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
  });
  const get = path => fetch(url + path, { signal: AbortSignal.timeout(5_000) });
  const page = await get(''); assert.equal(page.status, 200); assert.match(await page.text(), /Chatopus/);
  const response = await get('/api/config'); assert.equal(response.status, 200); const config = await response.json();
  assert.deepEqual(config.skills, []); assert.deepEqual(config.extensions, []); assert.deepEqual(config.plugins, []);
  assert.equal(config.stateDir, stateDir);
  await access(stateDir);
  await assert.rejects(access(join(directory, '.runtime')), { code: 'ENOENT' });
  assert.equal(config.memory.enabled, false); assert.deepEqual(config.memory.fields, []);
  assert.equal(config.qq.enabled, false); assert.deepEqual(config.qq.allowedGroupIds, []);
  assert.equal(config.business.defaultProfile, 'default'); assert.deepEqual(config.business.roomProfiles, {});
  const profile = config.business.profiles.default;
  assert.deepEqual(profile.skillIds, []); assert.deepEqual(profile.extensionIds, []);
  assert.ok(!profile.personaText && !profile.personaFile);
  assert.equal((await get('/.env')).status, 404);
  assert.equal((await fetch(url + '/api/config', { headers: { Origin: 'https://example.invalid' } })).status, 403);
  console.log('Default doctor, Chatopus admin, empty capabilities and local access controls passed');
} finally {
  if (admin && admin.exitCode === null && admin.signalCode === null) {
    const exited = once(admin, 'exit');
    admin.kill('SIGTERM');
    const timer = setTimeout(() => admin.kill('SIGKILL'), 5_000);
    try { await exited; } finally { clearTimeout(timer); }
  }
  await rm(temporary, { recursive: true, force: true });
}
