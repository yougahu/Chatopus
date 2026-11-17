/** Pauses an explicitly selected macOS test service, validates an isolated restore, then restores service. */
import { chmodSync, closeSync, copyFileSync, cpSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createConnection } from 'node:net';
import { homedir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig } from '../src/config.js';
import { DEFAULT_BUSINESS_SETTINGS } from '../src/business-config.js';
import { SharedMemoryService } from '../src/memory/shared-memory.js';
import { OpenVikingCredentials } from '../src/memory/openviking-credentials.js';
import { OpenVikingClient, OpenVikingError, memberMemoryUri, memoryPeerId } from '../src/memory/openviking-client.js';
import { bindMemberMemoryUpdates } from '../src/memory/member-updates.js';

process.umask(0o077);
if(process.platform!=='darwin')throw new Error('This probe requires a macOS launchd test deployment');
const installationInput=process.env.OPENVIKING_BACKUP_INSTALLATION, serviceLabel=process.env.OPENVIKING_BACKUP_SERVICE;
const restorePort=Number(process.env.OPENVIKING_BACKUP_RESTORE_PORT);
if(!installationInput||!serviceLabel||!/^[A-Za-z0-9.-]+$/.test(serviceLabel)||!Number.isSafeInteger(restorePort)||restorePort<1024||restorePort>65535)
  throw new Error('Set OPENVIKING_BACKUP_INSTALLATION, OPENVIKING_BACKUP_SERVICE and OPENVIKING_BACKUP_RESTORE_PORT for an isolated test deployment');
const root = process.cwd(), installation = resolve(root, installationInput);
// A prior probe that stopped before copying may be resumed without another model extraction.
const fromBackup = process.argv[2] === '--from-backup';
const resuming = process.argv[2] !== undefined, runId = (fromBackup ? process.argv[3] : process.argv[2]) ?? randomUUID();
assert(/^[a-f0-9-]{36}$/.test(runId), 'INVALID_RUN_ID');
const folder = resolve(root, '.runtime/verification/openviking-backup', runId);
mkdirSync(folder, { recursive: true, mode: 0o700 });
const sourceConfigPath = join(installation, 'ov.conf'), sourceKeyPath = join(installation, 'root-api-key');
const originalConfig = JSON.parse(readFileSync(sourceConfigPath, 'utf8'));
const sourceData = resolve(originalConfig.storage.workspace), sourcePort = Number(originalConfig.server.port);
const rootKey = readFileSync(sourceKeyPath, 'utf8').trim(), sourceBase = `http://127.0.0.1:${sourcePort}`;
const label = serviceLabel, domain = `gui/${process.getuid!()}`, target = `${domain}/${label}`;
const plist = join(homedir(), 'Library/LaunchAgents', label + '.plist');
const backup = join(folder, 'backup'), restored = join(folder, fromBackup ? 'restored-recheck-' + Date.now() : 'restored');
assert(fromBackup ? existsSync(backup) : !existsSync(backup) && !existsSync(restored), 'INVALID_BACKUP_RESUME');
if (resuming && existsSync(join(folder, 'report.json'))) copyFileSync(join(folder, 'report.json'), join(folder, `previous-report-${Date.now()}.private.json`));
const save = (name: string, value: unknown) => { const path = join(folder, name); writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); chmodSync(path, 0o600); };
const sha = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
assert(Number.isSafeInteger(sourcePort) && sourcePort >= 1024 && sourcePort <= 65535 && sourcePort !== restorePort && originalConfig.server.port === sourcePort && originalConfig.server.host === '127.0.0.1', 'UNEXPECTED_SOURCE_ENDPOINT');
assert(sourceData === join(installation, 'data') && originalConfig.server.root_api_key === rootKey, 'UNEXPECTED_SOURCE_CONFIG');
assert(existsSync(plist), 'SERVICE_PLIST_MISSING');
const report: Record<string, any> = { runId, startedAt: new Date().toISOString(), sourcePort, restorePort, errors: [], phases: [], productionBotUnchanged: true };
const start = Date.now();
const stage = (name: string, details: Record<string, unknown> = {}) => { report.phases.push({ name, elapsedMs: Date.now() - start, ...details }); save('report.json', report); console.log(JSON.stringify({ phase: name, ...details })); };
const errorCode = (error: unknown) => error instanceof OpenVikingError ? `${error.code}:${error.status}` : error instanceof Error ? error.message.replace(/[^a-zA-Z0-9_ :,-]/g, '').slice(0, 160) : 'Error';
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const listening = (port: number) => new Promise<boolean>(done => {
  const socket = createConnection({ host: '127.0.0.1', port }); const finish = (value: boolean) => { socket.destroy(); done(value); };
  socket.once('connect', () => finish(true)); socket.once('error', () => finish(false)); socket.setTimeout(500, () => finish(false));
});
async function ready(port: number, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const response = await fetch(`http://127.0.0.1:${port}/ready`, { signal: AbortSignal.timeout(2000) }); if (response.ok && (await response.json() as any).status === 'ready') return; } catch { /* startup */ }
    await delay(500);
  }
  throw new Error('SERVICE_READY_TIMEOUT_' + port);
}
function launchctl(args: string[]) {
  const result = spawnSync('launchctl', args, { encoding: 'utf8', timeout: 30_000 });
  if (result.status !== 0) throw new Error('LAUNCHCTL_' + args[0].toUpperCase() + '_FAILED');
  return result.stdout;
}
function processTree(pid: number): number[] {
  const text = spawnSync('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8' }).stdout;
  const rows = text.trim().split('\n').map(line => line.trim().split(/\s+/).map(Number));
  const ids = new Set([pid]); let added = true;
  while (added) { added = false; for (const [child, parent] of rows) if (ids.has(parent) && !ids.has(child)) { ids.add(child); added = true; } }
  return [...ids];
}
function manifest(path: string, prefix = ''): Array<{ path: string; bytes: number; sha256: string }> {
  return readdirSync(path).sort().flatMap(name => { const file = join(path, name), rel = prefix + name, stat = statSync(file);
    return stat.isDirectory() ? manifest(file, rel + '/') : [{ path: rel, bytes: stat.size, sha256: sha(readFileSync(file)) }]; });
}
const namespace = 'backup-probe-' + runId, room = 'backup-fixture-room', member = 'backup-fixture-member';
const service = new SharedMemoryService(loadConfig(root, { stateDir: folder, business: structuredClone(DEFAULT_BUSINESS_SETTINGS), memoryApiKey: rootKey,
  memory: { enabled: true, provider: 'openviking', baseUrl: sourceBase, namespace, rootKeyEnv: 'OPENVIKING_ROOT_API_KEY', timeoutMs: 30_000, recallBytes: 6000, ingestBatchSize: 32 } }));
const credentials = new OpenVikingCredentials({ baseUrl: sourceBase, rootKey, timeoutMs: 30_000 });
const account = service.account(room), sessionId = 'backup_' + runId.replaceAll('-', '_'), sourceId = 'backup-source-' + runId;
const message = { role: 'user' as const, content: '我叫青松，是中学数学老师。长期学习统计分析，课程解释请用中文并分步骤说明。', authorId: member, sourceMessageId: sourceId, timestamp: Date.now() };
const recallQuery = '青松的职业、长期学习目标和课程解释偏好';
let stopped = false, temporary: ChildProcess | undefined, logFd: number | undefined;
let userKey = '', currentSha = '', currentText = '', oldSha = '', expectedHits: string[] = [], archiveSha = '';
try {
  await ready(sourcePort); assert(!await listening(restorePort), 'RESTORE_PORT_OCCUPIED');
  stage('source-ready');
  if (fromBackup) {
    const original = JSON.parse(readFileSync(join(folder, 'source.private.json'), 'utf8'));
    assert(original.account === account && original.sessionId === sessionId, 'BACKUP_PROBE_IDENTITY_CHANGED');
    currentSha = original.currentSha; currentText = original.currentText; oldSha = original.oldSha;
    expectedHits = original.originalHits.map((hit: any) => hit.uri).sort(); archiveSha = sha(JSON.stringify(original.archive.messages));
    userKey = await credentials.get(account);
    assert((await service.client.read(account, memberMemoryUri(member)))?.sha256 === currentSha, 'ORIGINAL_PROBE_CHANGED_SINCE_BACKUP');
    report.probe = { currentHash: currentSha, sourceCount: original.archive.messages.length, searchHits: expectedHits.length, reusedConsistentBackup: true };
    stage('probe-reused', { searchHits: expectedHits.length });
  } else {
  const prior = resuming ? await service.readMember(room, member) : null;
  const initialOrder = prior?.document.fields.preferredName?.sourceOrder ?? 0;
  for (const [order, name] of [[initialOrder + 1, '旧称呼'], [initialOrder + 2, '青松']] as const) {
    const id = sourceId + '-' + order;
    const updates = bindMemberMemoryUpdates([{ kind: 'member', sourceMessageId: id, changes: [{ key: 'preferredName', op: 'set', value: name }] }],
      { actionSourceMessageIds: [id], messages: [{ id, memberId: member, sourceOrder: order }] });
    for (const intent of await service.prepareMemberWrites(room, updates, 'backup-turn-' + order)) await service.applyMemberWrite(intent);
    const file = await service.readMember(room, member); assert(file, 'CURRENT_NOT_WRITTEN'); if (order === initialOrder + 1) oldSha = file.sha256;
  }
  const original = await service.client.read(account, memberMemoryUri(member)); assert(original, 'CURRENT_MISSING'); currentSha = original.sha256; currentText = original.text;
  userKey = await credentials.get(account);
  if (!resuming) {
    await service.client.createSession(account, sessionId);
    await service.client.appendSources(account, sessionId, [message]);
    const committed: any = await service.client.commitSession(account, sessionId); assert(committed.status === 'accepted' && committed.archived, 'COMMIT_NOT_ACCEPTED');
  }
  const deadline = Date.now() + 180_000; let archive: any;
  while (Date.now() < deadline) {
    archive = await service.client.sessionArchive(account, sessionId);
    if (archive.status === 'completed') break;
    if (archive.status === 'failed') throw new Error('EXTRACTION_FAILED');
    await delay(750);
  }
  assert(archive.status === 'completed', 'EXTRACTION_TIMEOUT');
  // Extraction completion and vector-index visibility are separate backend milestones.
  let originalHits = await service.client.find(account, recallQuery, { memberId: member, limit: 8, maxBytes: 12000 });
  const searchDeadline = Date.now() + 60_000; let searchPolls = 1;
  while (!originalHits.length && Date.now() < searchDeadline) {
    await delay(1000); originalHits = await service.client.find(account, recallQuery, { memberId: member, limit: 8, maxBytes: 12000 }); searchPolls++;
  }
  assert(originalHits.length > 0, 'SOURCE_SEARCH_EMPTY'); expectedHits = originalHits.map(hit => hit.uri).sort(); archiveSha = sha(JSON.stringify(archive.messages));
  save('source.private.json', { namespace, account, room, member, sessionId, sourceId, currentSha, oldSha, currentText, archive, originalHits, tasks: await service.client.sessionTasks(account, sessionId) });
  report.probe = { currentHash: currentSha, sourceCount: archive.messages.length, searchHits: originalHits.length, searchPolls, resumedExistingExtraction: resuming };
  stage('probe-ready', { searchHits: originalHits.length });
  }

  const serviceState = launchctl(['print', target]);
  const sourcePid = Number(/\bpid = (\d+)/.exec(serviceState)?.[1]); assert(sourcePid > 0, 'SOURCE_PID_NOT_FOUND');
  const pids = processTree(sourcePid);
  stopped = true; launchctl(['bootout', target]);
  const stopDeadline = Date.now() + 60_000;
  while (Date.now() < stopDeadline && (await listening(sourcePort) || pids.some(alive))) await delay(250);
  assert(!await listening(sourcePort) && pids.every(pid => !alive(pid)), 'SOURCE_DID_NOT_FULLY_STOP');
  stage('source-stopped', { processesExited: pids.length });
  if (!fromBackup) {
    mkdirSync(backup, { mode: 0o700 });
    cpSync(sourceData, join(backup, 'data'), { recursive: true, errorOnExist: true, force: false });
    copyFileSync(sourceConfigPath, join(backup, 'ov.conf')); copyFileSync(sourceKeyPath, join(backup, 'root-api-key'));
    chmodSync(join(backup, 'ov.conf'), 0o600); chmodSync(join(backup, 'root-api-key'), 0o600);
  }
  const sourceManifest = fromBackup ? JSON.parse(readFileSync(join(folder, 'backup-manifest.private.json'), 'utf8')) : manifest(sourceData), backupManifest = manifest(join(backup, 'data'));
  assert(JSON.stringify(sourceManifest) === JSON.stringify(backupManifest), 'BACKUP_HASH_MISMATCH');
  assert(sha(readFileSync(sourceConfigPath)) === sha(readFileSync(join(backup, 'ov.conf'))) && sha(readFileSync(sourceKeyPath)) === sha(readFileSync(join(backup, 'root-api-key'))), 'BACKUP_CONFIG_KEY_MISMATCH');
  save('backup-manifest.private.json', backupManifest);
  report.backup = { files: backupManifest.length, bytes: backupManifest.reduce((sum, file) => sum + file.bytes, 0), allFileHashesMatch: true, configAndRootKeyMatch: true, reused: fromBackup };
  stage('consistent-backup-written', { files: backupManifest.length, bytes: report.backup.bytes });

  mkdirSync(restored, { mode: 0o700 }); cpSync(join(backup, 'data'), join(restored, 'data'), { recursive: true, errorOnExist: true, force: false });
  const restoredConfig = JSON.parse(readFileSync(join(backup, 'ov.conf'), 'utf8'));
  restoredConfig.storage.workspace = join(restored, 'data'); restoredConfig.server.port = restorePort; restoredConfig.server.host = '127.0.0.1';
  const restoredConfigPath = join(restored, 'ov.conf'); writeFileSync(restoredConfigPath, JSON.stringify(restoredConfig, null, 2) + '\n', { mode: 0o600 });
  copyFileSync(join(backup, 'root-api-key'), join(restored, 'root-api-key')); chmodSync(join(restored, 'root-api-key'), 0o600);
  logFd = openSync(join(folder, 'restore-server.private.log'), 'a', 0o600);
  const env: NodeJS.ProcessEnv = { ...process.env, OPENVIKING_CONFIG_FILE: restoredConfigPath }; delete env.PYTHONHOME; delete env.PYTHONPATH; delete env.VIRTUAL_ENV;
  temporary = spawn(join(installation, 'venv/bin/openviking-server'), ['--config', restoredConfigPath, '--host', '127.0.0.1', '--port', String(restorePort)],
    { cwd: restored, env, stdio: ['ignore', logFd, logFd], detached: true });
  temporary.on('error', () => { /* ready timeout reports sanitized failure; logs remain private */ });
  await ready(restorePort); stage('restored-instance-ready');
  const client = new OpenVikingClient({ baseUrl: `http://127.0.0.1:${restorePort}`, credential: async requested => { assert(requested === account, 'CREDENTIAL_SCOPE_CHANGED'); return userKey; }, timeoutMs: 30_000 });
  const restoredCurrent = await client.read(account, memberMemoryUri(member)); assert(restoredCurrent?.sha256 === currentSha, 'RESTORED_CURRENT_CHANGED');
  const restoredArchive: any = await client.sessionArchive(account, sessionId); assert(restoredArchive.status === 'completed' && sha(JSON.stringify(restoredArchive.messages)) === archiveSha, 'RESTORED_ARCHIVE_CHANGED');
  assert(restoredArchive.messages[0].source_message_ids?.[0] === sourceId && restoredArchive.messages[0].peer_id === memoryPeerId(member), 'RESTORED_SOURCE_IDENTITY_CHANGED');
  const hits = await client.find(account, recallQuery, { memberId: member, limit: 8, maxBytes: 12000 });
  assert(JSON.stringify(hits.map(hit => hit.uri).sort()) === JSON.stringify(expectedHits), 'RESTORED_SEARCH_CHANGED');
  const details = await Promise.all(hits.map(hit => client.read(account, hit.uri))); assert(details.every(file => file && file.text.length > 0), 'RESTORED_SEARCH_UNREADABLE');
  // Establish an actual newer version on the disposable restored copy, then try its true prior hash.
  const newer = JSON.parse(currentText); newer.revision++; newer.commitId = 'restore-probe-' + runId; newer.updatedAt = Date.now();
  newer.fields.preferredName = { ...newer.fields.preferredName, value: '青松（恢复测试新值）', sourceMessageId: 'restore-probe-source-' + runId,
    sourceOrder: newer.fields.preferredName.sourceOrder + 1, updatedAt: newer.updatedAt };
  const newerText = JSON.stringify(newer), newerSha = sha(newerText);
  await client.writeMember(account, member, newerText, currentSha);
  assert((await client.read(account, memberMemoryUri(member)))?.sha256 === newerSha, 'RESTORED_NEW_VERSION_NOT_WRITTEN');
  let staleRejected = false; try { await client.writeMember(account, member, currentText, currentSha); } catch (error) { staleRejected = error instanceof OpenVikingError && error.status === 409; }
  assert(staleRejected && (await client.read(account, memberMemoryUri(member)))?.sha256 === newerSha, 'RESTORED_STALE_CAS_NOT_REJECTED');
  save('restored.private.json', { current: restoredCurrent, archive: restoredArchive, hits, details });
  report.restore = { sameUserCredentialAccepted: true, currentHashMatches: true, archiveHashMatches: true, sourceIdentityMatches: true, searchUrisMatch: true, searchReadable: details.length, staleCasRejected: true, newerRestoredVersionPreserved: true };
  stage('restore-verification-passed', { searchReadable: details.length });
} catch (error) { report.errors.push(errorCode(error)); process.exitCode = 1; }
finally {
  if (temporary?.pid) {
    const pid = temporary.pid; try { process.kill(-pid, 'SIGTERM'); } catch { /* already stopped */ }
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && (alive(pid) || await listening(restorePort))) await delay(250);
    if (alive(pid)) { try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ } await delay(500); }
    report.restoredInstanceStopped = !await listening(restorePort) && !alive(pid);
    if (!report.restoredInstanceStopped) { report.errors.push('RESTORED_INSTANCE_DID_NOT_STOP'); process.exitCode = 1; }
  }
  if (logFd !== undefined) closeSync(logFd);
  if (stopped) {
    try {
      if (spawnSync('launchctl', ['print', target], { encoding: 'utf8' }).status !== 0) launchctl(['bootstrap', domain, plist]);
      await ready(sourcePort);
      const originalClient = new OpenVikingClient({ baseUrl: sourceBase, credential: async () => userKey, timeoutMs: 30_000 });
      assert((await originalClient.read(account, memberMemoryUri(member)))?.sha256 === currentSha, 'ORIGINAL_RESTART_HASH_CHANGED');
      report.sourceServiceRestored = true; stage('source-service-restored-ready');
    } catch (error) { report.errors.push(errorCode(error)); report.sourceServiceRestored = false; process.exitCode = 1; }
  }
  report.elapsedMs = Date.now() - start;
  report.passed = report.errors.length === 0 && report.restore?.staleCasRejected && report.sourceServiceRestored && report.restoredInstanceStopped;
  report.limitations = ['Small isolated probe validates a stopped local workspace copy on the same runtime/model installation; it is not an active-write or remote-disaster-recovery test.', 'Private backup includes service credentials and must retain restricted filesystem permissions.'];
  save('report.json', report);
  console.log(JSON.stringify({ report: join(folder, 'report.json'), passed: report.passed, errors: report.errors, sourceServiceRestored: report.sourceServiceRestored }));
}
