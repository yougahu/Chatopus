import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
/** Keep this aligned with the PATH in the documented macOS LaunchAgents. */
export const SERVICE_PATH = process.platform === 'darwin'
  ? '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'
  : process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin';

export interface ExecutableProbe {
  available: boolean;
  path?: string;
  version?: string;
  error?: string;
}

/** A failed command's stderr may contain credentials; expose only its error code. */
function failureCode(error: unknown): string {
  const value = error as { code?: unknown; killed?: boolean };
  return value.killed ? 'TIMEOUT' : typeof value.code === 'string' || typeof value.code === 'number'
    ? String(value.code) : 'EXECUTION_FAILED';
}

async function executablePath(command: string, path: string): Promise<string | undefined> {
  const candidates = isAbsolute(command) || command.includes('/')
    ? [resolve(command)] : path.split(delimiter).filter(Boolean).map(directory => join(directory, command));
  for (const candidate of candidates) {
    try { await access(candidate, constants.X_OK); return candidate; } catch { /* check the next PATH entry */ }
  }
  return undefined;
}

/** Resolve and actually execute the binary in the service's PATH, without a shell. */
export async function probeExecutable(command: string | undefined, path = SERVICE_PATH): Promise<ExecutableProbe> {
  if (!command) return { available: false, error: 'NOT_CONFIGURED' };
  const file = await executablePath(command, path);
  if (!file) return { available: false, error: 'NOT_FOUND' };
  try {
    const { stdout, stderr } = await exec(file, ['--version'], {
      env: { ...process.env, PATH: path }, timeout: 5000, maxBuffer: 16_384,
    });
    return { available: true, path: file, version: (stdout || stderr).split('\n')[0].slice(0, 160) };
  } catch (error) { return { available: false, path: file, error: failureCode(error) }; }
}

/** Exercise the two operations used by resource_files / resource_search on an isolated fixture. */
export async function probeRipgrep(path = SERVICE_PATH): Promise<ExecutableProbe & { files: boolean; search: boolean }> {
  const binary = await probeExecutable('rg', path);
  if (!binary.available || !binary.path) return { ...binary, files: false, search: false };
  const directory = await mkdtemp(join(tmpdir(), 'boe2-doctor-rg-'));
  const fixture = join(directory, 'source.txt');
  try {
    await writeFile(fixture, 'BOE2_DOCTOR_SEARCH_FIXTURE\n');
    const options = { env: { ...process.env, PATH: path }, timeout: 5000, maxBuffer: 16_384 };
    const files = await exec(binary.path, ['--files', directory], options);
    const search = await exec(binary.path, ['--fixed-strings', '--line-number', 'BOE2_DOCTOR_SEARCH_FIXTURE', directory], options);
    const foundFiles = files.stdout.split('\n').includes(fixture);
    const foundSearch = search.stdout.includes('1:BOE2_DOCTOR_SEARCH_FIXTURE');
    return { ...binary, available: foundFiles && foundSearch, files: foundFiles, search: foundSearch,
      ...(!foundFiles || !foundSearch ? { error: 'PROBE_MISMATCH' } : {}) };
  } catch (error) { return { ...binary, available: false, files: false, search: false, error: failureCode(error) }; }
  finally { await rm(directory, { recursive: true, force: true }); }
}
