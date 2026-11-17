/** Inspect release inputs without reading private deployment files or publishing. */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const root = realpathSync(fileURLToPath(new URL('..', import.meta.url)));
const rootFiles = new Set(['.env.example', '.gitignore', '.npmignore', 'AGENTS.md', 'README.md',
  'package.json', 'package-lock.json', 'config.example.json', 'tsconfig.json', 'vitest.config.ts', 'LICENSE', 'LICENSE.md',
  'ACKNOWLEDGEMENTS.md', 'THIRD_PARTY_NOTICES.md', 'CONTRIBUTING.md', 'SECURITY.md', 'CHANGELOG.md', '.nvmrc']);
const repositoryMetadata = new Set(['.github/workflows/ci.yml']);
const sourceDirs = new Set(['src', 'scripts', 'tests', 'fixtures', 'docs']);
const personas = new Set(['personas/default.md', 'personas/concise.md', 'personas/friendly.md']);
const ignoredDirs = new Set(['.git', '.runtime', '.private', 'node_modules', 'coverage', '__pycache__', 'installed-skills', 'installed-extensions']);
const privateName = /^(?:\.env(?!\.example$)|config\.local.*\.json$)|(?:\.private[.-]|\.sqlite(?:[.-]|$)|\.db(?:[.-]|$)|\.log$|\.bak$|\.tgz$|\.tsbuildinfo$|\.py[cod]$)|^\.DS_Store$/i;
const failures = [];
const fail = (file, reason) => failures.push({ file, reason });
const command = (program, args) => spawnSync(program, args, { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 60_000 });
const publicPath = file => rootFiles.has(file) || repositoryMetadata.has(file) || personas.has(file) || sourceDirs.has(file.split('/')[0]);
const privatePath = file => file.split('/').some(part => ignoredDirs.has(part) || privateName.test(part));

function walk(directory = '') {
  return readdirSync(join(root, directory), { withFileTypes: true }).flatMap(entry => {
    const file = directory ? directory + '/' + entry.name : entry.name;
    if (privatePath(file)) return [];
    return entry.isDirectory() ? walk(file) : [file];
  });
}
const gitRoot = command('git', ['rev-parse', '--show-toplevel']);
const inRepository = gitRoot.status === 0 && realpathSync(gitRoot.stdout.trim()) === root;
let candidates;
if (inRepository) {
  const list = command('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z']);
  if (list.status !== 0) throw new Error('Unable to enumerate Git release inputs');
  candidates = [...new Set(list.stdout.split('\0').filter(Boolean))].filter(file => existsSync(join(root, file)));
} else candidates = walk();
candidates.sort();
const files = new Set(candidates);

for (const file of candidates) {
  if (!publicPath(file)) fail(file, 'outside the reviewed public file tree');
  if (privatePath(file)) { fail(file, 'private deployment or generated file'); continue; }
  const path = join(root, file), stat = lstatSync(path);
  if (!stat.isFile() || realpathSync(path) !== resolve(root, file)) { fail(file, 'links and non-regular files are not release inputs'); continue; }
  if (file.startsWith('docs/evidence/') || /^docs\/.*\d{4}-\d{2}-\d{2}/.test(file)) fail(file, 'dated deployment evidence belongs in a private archive');
  const bytes = readFileSync(path);
  if (bytes.includes(0)) {
    if (!['fixtures/validation-document.png', 'docs/assets/admin-overview.png'].includes(file)) fail(file, 'unreviewed binary asset');
    continue;
  }
  const text = bytes.toString('utf8');
  for (const [reason, pattern] of [
    ['personal home path', /\/(?:Users|home)\/[a-zA-Z0-9_.-]+\//],
    ['Windows personal home path', /[a-zA-Z]:\\Users\\[a-zA-Z0-9_.-]+\\/],
    ['private key material', /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/],
    ['credential-like token', /\b(?:sk-[A-Za-z0-9_-]{24,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/],
  ]) if (pattern.test(text)) fail(file, reason);
  for (const [value] of text.matchAll(/https?:\/\/[^\s/@:'"]+:[^\s/@'"]+@[^\s'"<>]+/g)) {
    const url = new URL(value);
    // These two rejection tests deliberately use obvious dummy credentials.
    const fixture = (file === 'tests/admin-openviking-model.test.ts' && url.hostname === 'example.com' && url.password === 'password')
      || (file === 'tests/incoming-media.test.ts' && url.hostname === 'gchat.qpic.cn' && url.password === 'secret');
    if (!(fixture && url.username === 'user')) fail(file, 'URL with embedded credentials');
  }
  if (file.endsWith('.md')) {
    for (const match of text.matchAll(/\[[^\]\n]*\]\(([^\s)]+)\)/g)) {
      const target = match[1].split('#')[0];
      if (!target || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(target)) continue;
      const linked = relative(root, resolve(dirname(path), decodeURIComponent(target))).replaceAll('\\', '/');
      if (!files.has(linked)) fail(file, 'local Markdown link is absent from release inputs');
    }
  }
}

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const example = JSON.parse(readFileSync(join(root, 'config.example.json'), 'utf8'));
const statePath = typeof example.stateDir === 'string'
  ? example.stateDir.startsWith('~/') ? resolve(homedir(), example.stateDir.slice(2)) : resolve(root, example.stateDir)
  : root;
const stateRelative = relative(root, statePath);
if (!(isAbsolute(example.stateDir ?? '') || example.stateDir?.startsWith('~/'))
  || (!isAbsolute(stateRelative) && stateRelative !== '..' && !stateRelative.startsWith('../') && !stateRelative.startsWith('..\\'))) {
  fail('config.example.json', 'example stateDir must point outside the source directory');
}
const empty = value => Array.isArray(value) && value.length === 0;
if (![example.skills, example.extensions, example.plugins, example.memory?.fields].every(empty)
  || example.memory?.enabled !== false || example.qq?.enabled !== false || !empty(example.qq?.allowedGroupIds)
  || Object.hasOwn(example, 'personaFile') || Object.hasOwn(example, 'roomPersonaFiles')) {
  fail('config.example.json', 'default deployment must have no installed capabilities, custom fields or external persona');
}
const business = example.business;
if (business?.defaultProfile !== 'default' || Object.keys(business?.profiles ?? {}).join() !== 'default'
  || Object.keys(business?.roomProfiles ?? {}).length) fail('config.example.json', 'default business must be a single unbound generic profile');
for (const profile of Object.values(business?.profiles ?? {})) {
  if (![profile.skillIds, profile.extensionIds, profile.memoryFields].every(empty)
    || profile.commonInstructions || profile.routerInstructions || profile.workerInstructions || profile.personaText || profile.personaFile) {
    fail('config.example.json', 'default profile contains custom behavior');
  }
}
for (const role of ['router', 'worker']) {
  if (example[role]?.model !== 'YOUR_MODEL_ID' || example[role]?.baseUrl !== 'https://api.openai.com/v1') {
    fail('config.example.json', 'model settings must be placeholders with the public protocol example endpoint');
  }
}
for (const line of readFileSync(join(root, '.env.example'), 'utf8').split('\n')) {
  const match = /^([A-Z_]+)=(.*)$/.exec(line);
  if (match && match[2] && !(match[1] === 'OPENAI_BASE_URL' && match[2] === 'https://api.openai.com/v1')) {
    fail('.env.example', 'nonempty deployment value');
  }
}
if (pkg.private !== true) fail('package.json', 'publication is disabled until the maintainer explicitly chooses to release');
if (!files.has('package-lock.json')) fail('package-lock.json', 'lockfile is required for reproducible source installation');
const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
if (pkg.license !== 'MIT' || !files.has('LICENSE') || !readFileSync(join(root, 'LICENSE'), 'utf8').startsWith('MIT License\n')) {
  fail('LICENSE', 'MIT license and matching package metadata are required');
}
if (lock.name !== pkg.name || lock.packages?.['']?.name !== pkg.name || lock.packages?.['']?.license !== pkg.license
  || lock.packages?.['']?.engines?.node !== pkg.engines?.node || lock.version !== pkg.version) {
  fail('package-lock.json', 'root package metadata does not match package.json');
}
const packed = command('npm', ['pack', '--dry-run', '--ignore-scripts', '--json']);
let packedFiles = [];
if (packed.status !== 0) fail('package.json', 'npm packaging inspection failed');
else {
  packedFiles = JSON.parse(packed.stdout)[0].files.map(file => file.path);
  for (const file of packedFiles) {
    if (privatePath(file) || !publicPath(file) || !files.has(file)) fail(file, 'npm includes an unreviewed or private file');
  }
}

const args = process.argv.slice(2), exportArg = args.find(arg => arg.startsWith('--export='));
if (args.some(arg => arg !== exportArg)) throw new Error('Usage: node scripts/check-public-files.mjs [--export=/absolute/new-directory]');
let destination;
if (exportArg) {
  const input = exportArg.slice('--export='.length);
  if (!isAbsolute(input) || existsSync(input)) throw new Error('Export needs an absolute, nonexistent directory');
  destination = resolve(input);
  const parent = realpathSync(dirname(destination));
  const parentRelative = relative(root, parent);
  if (!parentRelative || (!parentRelative.startsWith('..' + '/') && parentRelative !== '..' && !isAbsolute(parentRelative))) {
    throw new Error('Export must be outside the source tree');
  }
}
if (failures.length) {
  console.error(JSON.stringify({ status: 'failed', failures }, null, 2));
  process.exitCode = 1;
} else {
  if (destination) {
    mkdirSync(destination, { mode: 0o700 });
    for (const file of candidates) {
      const target = join(destination, file);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(join(root, file), target);
    }
  }
  console.log(JSON.stringify({ status: 'passed', source: inRepository ? 'git-candidates' : 'file-tree',
    sourceFiles: candidates.length, packageFiles: packedFiles.length, exported: Boolean(destination),
    license: pkg.license,
    scope: 'Current files only; review history, asset provenance and new content separately.' }, null, 2));
}
