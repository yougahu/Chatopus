/** Private, isolated live-backend probe. Production SQLite is opened read-only. */
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig } from '../src/config.js';
import { DEFAULT_BUSINESS_SETTINGS } from '../src/business-config.js';
import { Store } from '../src/store.js';
import type { GroupMessage } from '../src/types.js';
import { SharedMemoryService } from '../src/memory/shared-memory.js';
import { OpenVikingCredentials } from '../src/memory/openviking-credentials.js';
import { OpenVikingIngestion, type OpenVikingIngestionEvent } from '../src/memory/openviking-ingestion.js';
import { bindMemberMemoryUpdates } from '../src/memory/member-updates.js';
import { memoryPeerId, OPENVIKING_COMMIT, OpenVikingError } from '../src/memory/openviking-client.js';

process.umask(0o077);
const root = process.cwd(), runId = randomUUID();
const folder = resolve(root, '.runtime/verification/openviking-ingestion', runId);
mkdirSync(folder, { recursive: true, mode: 0o700 }); chmodSync(folder, 0o700);
const backend = JSON.parse(readFileSync(resolve(root, process.argv[2] ?? '.runtime/openviking-dev/ov.conf'), 'utf8'));
const baseUrl = `http://127.0.0.1:${backend.server.port}`, rootKey: string = backend.server.root_api_key;
const save = (name: string, value: unknown) => { const path = join(folder, name); writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); chmodSync(path, 0o600); };
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const code = (error: unknown) => error instanceof OpenVikingError ? `${error.code}:${error.status}` : error instanceof Error ? error.message.replace(/[^a-zA-Z0-9_: -]/g, '').slice(0, 160) : 'Error';
function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
const credentials = new OpenVikingCredentials({ baseUrl, rootKey, timeoutMs: 30_000 });
const makeMemory = (lane: string) => new SharedMemoryService(loadConfig(root, {
  stateDir: folder, business: structuredClone(DEFAULT_BUSINESS_SETTINGS), memoryApiKey: rootKey,
  memory: { enabled: true, provider: 'openviking', baseUrl, namespace: `ingestion-${runId}-${lane}`, rootKeyEnv: 'OPENVIKING_ROOT_API_KEY', timeoutMs: 30_000, recallBytes: 12000, ingestBatchSize: 100 },
}));
const live = makeMemory('synthetic'), sample = makeMemory('history');
const store = new Store(join(folder, 'source.sqlite')); chmodSync(join(folder, 'source.sqlite'), 0o600);
const started = Date.now();
const report: Record<string, any> = { runId, backendCommit: OPENVIKING_COMMIT, startedAt: new Date(started).toISOString(), productionReadOnly: true, isolatedAccounts: true, synthetic: {}, history: {}, errors: [] };
const events: OpenVikingIngestionEvent[] = [];
const onEvent = (event: OpenVikingIngestionEvent) => { events.push(event); save('events.private.json', events); };
const construct = () => new OpenVikingIngestion({ db: store.db, source: store.roomMemory, sharedMemory: live, sampleMemory: sample,
  // This probe validates protocol/recovery immediately; accumulation timing is covered by unit tests.
  batchSize: 100, batchWindowMs: 0, concurrency: 2, pollMs: 750, retryMs: 2000, maxRetryMs: 10000, maxFailures: 5, onEvent });
let worker = construct();
const syntheticRoom = 'synthetic-two-members';
const source = (id: string, member: string, text: string, order: number): GroupMessage => ({ id, platform: 'replay', roomId: syntheticRoom, messageId: id, authorId: member,
  authorName: member, text, timestamp: Date.now() + order, mentions: [], attachments: [], isMentioned: true, isAdmin: false });
const synthetic = [
  source('fixture-a-1', 'fixture-a', '我叫林青，是一名中学数学老师。我主要在周末晚上学习数据分析，工作日没时间。我原来长期学习电子表格，课程预算通常不超过五十元。讲解课程时我喜欢中文名称和分步骤说明，不要一次给十几个方案。', 1),
  source('fixture-b-1', 'fixture-b', '我叫周航，是后端开发工程师。我主要学习数据库，每晚有两小时学习时间。我喜欢看英文技术名称，教程请先给简洁结论，再给计算过程。我目前只关心查询效率，不追求参加竞赛。', 2),
  source('fixture-a-2', 'fixture-a', '更正一下我的学习方向：我已经放弃电子表格，以后长期学习统计分析，不再把电子表格当作我的偏好。另外以后叫我青禾，不要再叫林青。我的职业还是数学老师，周末晚上学习、五十元预算、中文分步骤说明都没变。', 3),
  source('fixture-b-2', 'fixture-b', '我引用一下青禾之前的话：“我叫林青，是数学老师，长期喜欢电子表格。”这是她以前的自述，不是我的个人信息，而且她刚才已经更正成统计分析了。我自己还是周航，后端开发工程师，喜欢数据库和英文技术名。', 4),
];
async function seedExplicit(service: SharedMemoryService, room: string, member: string, sourceId: string, order: number, value: string) {
  const updates = bindMemberMemoryUpdates([{ kind: 'member', sourceMessageId: sourceId, changes: [{ key: 'preferredName', op: 'set', value },
    ...(member === 'fixture-a' ? [{ key: 'learningGoals', op: 'set', value: '统计分析' }, { key: 'interests', op: 'set', value: ['数据分析'] }] : [])] }],
    { actionSourceMessageIds: [sourceId], messages: [{ id: sourceId, memberId: member, sourceOrder: order }] });
  for (const intent of await service.prepareMemberWrites(room, updates, `${runId}-${sourceId}`)) await service.applyMemberWrite(intent);
  return (await service.readMember(room, member))!.sha256;
}
async function waitAll(restart = false) {
  const deadline = Date.now() + 420_000; let restarted = false;
  while (Date.now() < deadline) {
    const state = worker.status();
    if (state.lanes.some(lane => lane.blocked)) throw new Error('INGESTION_BLOCKED:' + state.lanes.filter(lane => lane.blocked).map(lane => lane.lastError).join(','));
    if (restart && !restarted) {
      const lane = state.lanes.find(lane => lane.taskId && lane.phase === 'archived');
      if (lane) {
        const before = { sessionId: lane.sessionId, taskId: lane.taskId, coveredSeq: lane.coveredSeq };
        await worker.close(); worker = construct();
        const after = worker.status().lanes.find(item => item.lane === lane.lane);
        assert(after && after.taskId === before.taskId && after.sessionId === before.sessionId, 'RESTART_CHANGED_BATCH_OR_TASK');
        report.synthetic.restart = { stoppedWhileTaskPending: true, sameSession: true, sameTask: true, cursorUnchanged: after.coveredSeq === before.coveredSeq };
        save('restart.private.json', { before, after }); restarted = true;
        console.log(JSON.stringify({ phase: 'synthetic-restarted-same-task' }));
      }
    }
    if (!state.running && state.lanes.every(lane => lane.coveredSeq === lane.targetSeq && !lane.phase)) {
      if (restart && !restarted) report.synthetic.restart = { stoppedWhileTaskPending: false, reason: 'Task completed before observation' };
      return;
    }
    await delay(500);
  }
  save('timeout-state.private.json', worker.status()); throw new Error('INGESTION_TIMEOUT');
}
async function rawRequest(service: SharedMemoryService, room: string, path: string) {
  const response = await fetch(baseUrl + path, { headers: { 'X-API-Key': await credentials.get(service.account(room)) }, signal: AbortSignal.timeout(30_000) });
  const body = await response.json() as any;
  if (!response.ok || body.status !== 'ok') throw new Error('AUDIT_API_' + response.status);
  return body.result;
}
async function peerFiles(service: SharedMemoryService, room: string, member: string) {
  const prefix = `viking://user/group/peers/${memoryPeerId(member)}/memories`;
  let listing: any;
  try { listing = await rawRequest(service, room, '/api/v1/fs/ls?' + new URLSearchParams({ uri: prefix, recursive: 'true', output: 'original', node_limit: '200' })); }
  catch (error) { if (code(error) === 'AUDIT_API_404') return { listing: [], files: [] }; throw error; }
  const entries: any[] = Array.isArray(listing) ? listing : listing.entries ?? listing.items ?? [];
  const files = [];
  for (const item of entries) {
    const uri = typeof item.uri === 'string' ? item.uri : typeof item.name === 'string' ? prefix + '/' + item.name : '';
    if (!uri.startsWith(prefix + '/') || item.isDir === true || item.is_dir === true || !uri.endsWith('.md')) continue;
    const file = await service.client.read(service.account(room), uri);
    if (file) files.push({ uri, ...file });
  }
  return { listing, files };
}
async function auditSession(service: SharedMemoryService, room: string, sessionId: string, label: string) {
  const account = service.account(room), archive: any = await service.client.sessionArchive(account, sessionId);
  const tasks: any = await service.client.sessionTasks(account, sessionId);
  const meta: any = await service.client.session(account, sessionId);
  save(label + '-archive.private.json', archive); save(label + '-tasks.private.json', tasks); save(label + '-session.private.json', meta);
  const messages: any[] = archive.messages ?? [];
  // Audit exact sources rather than a bounded foreground/history page.
  const sourceSeq = store.db.prepare('SELECT seq FROM room_memory_events WHERE room=? AND source_id=? AND valid=1');
  const seqs = messages.flatMap(message => (message.source_message_ids ?? []).flatMap((id: string) => {
    const row = sourceSeq.get(room, id) as { seq: number } | undefined; return row ? [row.seq] : [];
  }));
  const expected = store.roomMemory.eventsBySeq(room, seqs);
  const traced = messages.every(message => message.source_message_ids?.length === 1 && expected.some(event => event.sourceId === message.source_message_ids[0] && event.text === message.parts?.map((part: any) => part.text ?? '').join('')));
  const result = tasks.find((task: any) => task.status === 'completed')?.result ?? {};
  return { status: archive.status, sourceCount: messages.length, sourceIdsTraceable: traced, commitCount: meta.commit_count,
    taskCount: tasks.length, taskStatuses: tasks.map((task: any) => task.status), tokenUsage: result.token_usage ?? { llm: meta.llm_token_usage, embedding: meta.embedding_token_usage },
    memoriesExtracted: result.memories_extracted, extractionSkipped: result.memory_extraction?.skipped };
}
type HistorySource = { seq: number; room: string; message: GroupMessage };
function historySamples() {
  const disk = JSON.parse(readFileSync(join(root, 'config.local.json'), 'utf8'));
  const productionPath = resolve(root, disk.stateDir ?? '.runtime', 'state.sqlite');
  assert(productionPath !== join(folder, 'source.sqlite'), 'PRODUCTION_PATH_COLLISION');
  const db = new DatabaseSync(productionPath, { readOnly: true });
  let rows: HistorySource[];
  try { rows = (db.prepare("SELECT e.seq,e.room,m.data FROM room_memory_events e JOIN messages m ON m.id=e.source_id WHERE e.valid=1 AND e.kind='message' ORDER BY e.seq").all() as any[])
    .map(row => ({ seq: row.seq, room: row.room, message: JSON.parse(row.data) })); } finally { db.close(); }
  const groups = new Map<string, HistorySource[]>();
  // Consecutive messages by one real member preserve authorship without importing an entire room.
  for (const row of rows) { const key = JSON.stringify([row.room, row.message.authorId]); if (!groups.has(key)) groups.set(key, []); groups.get(key)!.push(row); }
  const firstPerson = /我(?:的|现在|目前|比较|喜欢|只|不|玩|要|想|这|已经|希望|习惯|是|用|打|还|有|准备)/;
  const preference = /喜欢|偏好|学习|工作|预算|时间|语言|说明|步骤|简洁|详细|经验|目标|课程|项目/;
  const candidates: Array<{ rows: HistorySource[]; chars: number; score: number }> = [];
  for (const group of groups.values()) for (let i = 0; i < group.length; i++) {
    if (!firstPerson.test(group[i].message.text) || !preference.test(group[i].message.text)) continue;
    const selected: HistorySource[] = []; let chars = 0, score = 0;
    for (let j = Math.max(0, i - 2); j < group.length && selected.length < 90 && chars < 700; j++) {
      if (selected.length && group[j].message.timestamp - selected[0].message.timestamp > 3 * 24 * 60 * 60 * 1000) break;
      const text = group[j].message.text; const n = [...text.matchAll(/[\u3400-\u9fff]/g)].length;
      if (chars + n > 1250) break;
      selected.push(group[j]); chars += n;
      if (firstPerson.test(text) && preference.test(text)) score += 2;
      if (/喜欢|习惯|预算|我是|我学|我用|我目前|我现在|我主要|我准备/.test(text)) score += 3;
    }
    if (chars >= 500 && score >= 5) candidates.push({ rows: selected, chars, score });
  }
  candidates.sort((a, b) => b.score - a.score);
  const selected: typeof candidates = [], used = new Set<string>();
  for (const candidate of candidates) {
    if (candidate.rows.some(row => used.has(row.message.id))) continue;
    selected.push(candidate); candidate.rows.forEach(row => used.add(row.message.id)); if (selected.length === 4) break;
  }
  assert(selected.length >= 3 && selected.reduce((sum, item) => sum + item.chars, 0) >= 2000, 'INSUFFICIENT_QUALIFYING_HISTORY');
  return selected.sort((a, b) => a.rows[0].seq - b.rows[0].seq);
}

try {
  const syntheticStart = Date.now();
  const explicitA = await seedExplicit(live, syntheticRoom, 'fixture-a', 'fixture-a-2', 3, '青禾');
  const explicitB = await seedExplicit(live, syntheticRoom, 'fixture-b', 'fixture-b-2', 4, '周航');
  synthetic.forEach(message => store.ingest(message));
  store.enqueue({ roomId: syntheticRoom, text: '这是尚未发送的内容，不应该进入记忆。' }, { id: 'fixture-unsent-reply' });
  const sentId = store.enqueue({ roomId: syntheticRoom, text: '收到，后续回答会优先采用各位本人最新明确的说明，并区分转述与自述。' }, { id: 'fixture-sent-reply' });
  const sent = store.outbox().find(row => row.id === sentId)!; sent.status = 'sent'; sent.sentAt = Date.now() + 5; sent.platformMessageId = 'fixture-platform-reply'; store.saveOutbox(sent);
  save('synthetic-sources.private.json', store.roomMemory.events(syntheticRoom));
  worker.notify(syntheticRoom); await waitAll(true);
  const syntheticSessions = [...new Set(events.filter(event => event.roomId === syntheticRoom && event.kind === 'prepared').map(event => event.sessionId!))];
  report.synthetic.sessions = await Promise.all(syntheticSessions.map((id, i) => auditSession(live, syntheticRoom, id, 'synthetic-' + i)));
  const peers = [];
  for (const [member, query, ownToken, wrongToken] of [['fixture-a', '青禾的职业、当前学习方向和说明偏好', '统计分析', '后端开发'], ['fixture-b', '周航的职业、当前学习方向和说明偏好', '数据库', '数学老师']]) {
    const files = await peerFiles(live, syntheticRoom, member);
    const hits = await live.client.find(live.account(syntheticRoom), query, { memberId: member, limit: 8, maxBytes: 12000 });
    save(member + '-profile.private.json', files); save(member + '-search.private.json', hits);
    const text = files.files.map(file => file.text).join('\n');
    peers.push({ member, fileCount: files.files.length, profileExists: files.files.some(file => file.uri.endsWith('/profile.md')), scopedRetrievalHits: hits.length,
      currentLearningGoalPresent: text.includes(ownToken), otherMemberOccupationPresent: text.includes(wrongToken),
      retrievalScopeCorrect: hits.every(hit => hit.uri.startsWith(`viking://user/group/peers/${memoryPeerId(member)}/memories/`)) });
  }
  report.synthetic.peers = peers;
  report.synthetic.currentDocumentsUnchanged = (await live.readMember(syntheticRoom, 'fixture-a'))!.sha256 === explicitA && (await live.readMember(syntheticRoom, 'fixture-b'))!.sha256 === explicitB;
  const currentTool = live.createReadTool(syntheticRoom, ['fixture-a']);
  const requested: any = await currentTool.execute({ action: 'profile', memberId: 'fixture-a', keys: ['interests', 'learningGoals'] });
  const automatic = (await live.project(syntheticRoom, ['fixture-a']))[0];
  report.synthetic.backgroundProfile = { requestedKeysReadable: requested.profile.fields.learningGoals?.value === '统计分析' && requested.profile.fields.interests?.value?.includes('数据分析'),
    absentFromDefaultInjection: !automatic.fields.learningGoals && !automatic.fields.interests };
  report.synthetic.pendingReplyExcluded = report.synthetic.sessions.reduce((n: number, session: any) => n + session.sourceCount, 0) === 5;
  report.synthetic.elapsedMs = Date.now() - syntheticStart;
  save('report.json', report); console.log(JSON.stringify({ phase: 'synthetic-complete', elapsedMs: report.synthetic.elapsedMs, peers: peers.map(peer => ({ fileCount: peer.fileCount, hits: peer.scopedRetrievalHits })) }));

  await worker.close();
  const chosen = historySamples(), copied: Array<{ label: string; room: string; afterSeq: number; throughSeq: number; members: string[]; chars: number; sourceIds: string[] }> = [];
  for (const [i, item] of chosen.entries()) {
    const room = item.rows[0].room, afterSeq = store.roomMemory.latestSeq(room);
    for (const row of item.rows) store.ingest(row.message);
    const throughSeq = store.roomMemory.latestSeq(room), members = [...new Set(item.rows.map(row => row.message.authorId))];
    copied.push({ label: `history-${i + 1}`, room, afterSeq, throughSeq, members, chars: item.chars, sourceIds: item.rows.map(row => row.message.id) });
  }
  save('history-sources.private.json', chosen); save('history-ranges.private.json', copied);
  worker = construct();
  const explicitHistory: Array<{ room: string; member: string; sha256: string }> = [];
  for (const item of copied) {
    const member = item.members[0], sourceId = item.sourceIds[0];
    if (!explicitHistory.some(record => record.room === item.room && record.member === member)) explicitHistory.push({ room: item.room, member, sha256: await seedExplicit(sample, item.room, member, sourceId, item.afterSeq + 1, '验证专用当前称呼') });
  }
  const historyStart = Date.now();
  copied.forEach(item => worker.importSample(item.room, { afterSeq: item.afterSeq, throughSeq: item.throughSeq }));
  await waitAll();
  const historyEvents = events.filter(event => event.kind === 'prepared' && event.roomId !== syntheticRoom);
  report.history.cases = [];
  for (const item of copied) {
    const event = historyEvents.find(event => event.targetSeq === item.throughSeq && event.roomId === item.room)!;
    assert(event?.sessionId, 'HISTORY_SESSION_MISSING');
    const audit = await auditSession(sample, item.room, event.sessionId, item.label);
    const memberStats = [];
    for (const member of item.members) {
      const files = await peerFiles(sample, item.room, member);
      const tool = sample.createReadTool(item.room, [member]);
      const search: any = await tool.execute({ action: 'search', memberId: member, query: '这位成员自己的当前学习目标、项目需求、预算、表达偏好和经验' });
      const hits = search.entries as Array<{ uri: string; text: string }>;
      const reads = await Promise.all(hits.map(hit => tool.execute({ action: 'read', uri: hit.uri })));
      const alias = hash(member).slice(0, 12);
      save(item.label + '-member-' + alias + '.private.json', { files, hits, reads });
      memberStats.push({ member: alias, fileCount: files.files.length, profileExists: files.files.some(file => file.uri.endsWith('/profile.md')), retrievalHits: hits.length,
        readableHits: reads.filter((read: any) => typeof read.text === 'string' && read.text.length > 0).length,
        retrievalScopeCorrect: hits.every(hit => hit.uri.startsWith(`viking://user/group/peers/${memoryPeerId(member)}/memories/`)) });
    }
    report.history.cases.push({ case: item.label, chineseChars: item.chars, sources: item.sourceIds.length, members: memberStats, ...audit });
  }
  report.history.currentDocumentsUnchanged = (await Promise.all(explicitHistory.map(async item => (await sample.readMember(item.room, item.member))!.sha256 === item.sha256))).every(Boolean);
  report.history.liveAccountsUntouched = (await Promise.all(explicitHistory.map(async item => await live.readMember(item.room, item.member) === null))).every(Boolean);
  report.history.elapsedMs = Date.now() - historyStart;
  report.history.selection = 'Four non-overlapping chronological member-message sequences, selected by first-person preference and learning terms; intervening other-member chat is excluded, so this is not a full room-context quality evaluation.';
  report.verificationPassed = report.synthetic.currentDocumentsUnchanged && report.synthetic.pendingReplyExcluded
    && report.synthetic.restart.sameTask && report.synthetic.backgroundProfile.requestedKeysReadable && report.synthetic.backgroundProfile.absentFromDefaultInjection
    && report.synthetic.peers.every((peer: any) => peer.profileExists && peer.currentLearningGoalPresent && !peer.otherMemberOccupationPresent && peer.retrievalScopeCorrect && peer.scopedRetrievalHits > 0)
    && report.history.currentDocumentsUnchanged && report.history.liveAccountsUntouched
    && [...report.synthetic.sessions, ...report.history.cases].every((session: any) => session.status === 'completed' && session.sourceIdsTraceable && session.commitCount === 1 && session.taskCount === 1)
    && report.history.cases.every((item: any) => item.members.every((member: any) => member.retrievalHits > 0 && member.readableHits === member.retrievalHits && member.retrievalScopeCorrect));
  if (!report.verificationPassed) { report.errors.push('VERIFICATION_ASSERTION_FAILED'); process.exitCode = 1; }
} catch (error) {
  report.errors.push(code(error)); save('failure-state.private.json', worker.status()); process.exitCode = 1;
} finally {
  await worker.close(); store.close(); report.elapsedMs = Date.now() - started;
  report.limitations = ['Small purpose-selected sample, not a full memory quality evaluation.', 'Raw source linkage and namespace boundaries are mechanically checked; quotation attribution and correction semantics need human review.', 'Historical original messages and extracted bodies are stored only in private evidence files.', 'Backend embedding usage counters may report zero; this does not establish zero embedding cost.'];
  save('report.json', report);
  console.log(JSON.stringify({ report: join(folder, 'report.json'), errors: report.errors, elapsedMs: report.elapsedMs, historyCases: report.history.cases?.length ?? 0 }));
}
