/** Real-model regression in a fresh account. Never sends messages or writes production memory. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig } from '../src/config.js';
import { DEFAULT_BUSINESS_SETTINGS } from '../src/business-config.js';
import { Store } from '../src/store.js';
import type { GroupMessage } from '../src/types.js';
import { SharedMemoryService } from '../src/memory/shared-memory.js';
import { OpenVikingCredentials } from '../src/memory/openviking-credentials.js';
import { OpenVikingIngestion, type OpenVikingIngestionEvent } from '../src/memory/openviking-ingestion.js';
import { memoryPeerId } from '../src/memory/openviking-client.js';
import { bindMemberMemoryUpdates } from '../src/memory/member-updates.js';

process.umask(0o077);
if (!process.argv[2]) throw new Error('Pass the private backend configuration path explicitly');
const backend = JSON.parse(readFileSync(resolve(process.argv[2]), 'utf8'));
const runId = randomUUID(), room = 'quality-fixture', root = process.cwd();
const folder = resolve(root, '.runtime/verification/memory-quality', runId);
mkdirSync(folder, { recursive: true, mode: 0o700 });
const save = (name: string, value: unknown) => writeFileSync(join(folder, name), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
const baseUrl = `http://127.0.0.1:${backend.server.port}`;
const config = loadConfig(root, { stateDir: folder, business: structuredClone(DEFAULT_BUSINESS_SETTINGS), memoryApiKey: backend.server.root_api_key,
  memory: { enabled: true, provider: 'openviking', baseUrl, namespace: `quality-${runId}`,
    rootKeyEnv: 'OPENVIKING_ROOT_API_KEY', timeoutMs: 30000, recallBytes: 12000, ingestBatchSize: 32 } });
const memory = new SharedMemoryService(config), account = memory.account(room);
const credentials = new OpenVikingCredentials({ baseUrl, rootKey: backend.server.root_api_key });
const store = new Store(join(folder, 'source.sqlite'));
const events: OpenVikingIngestionEvent[] = [];
const worker = new OpenVikingIngestion({ db: store.db, source: store.roomMemory, sharedMemory: memory,
  batchSize: 32, batchWindowMs: 0, pollMs: 500, onEvent: event => { events.push(event); save('events.json', events); } });
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
const source = (id: string, member: string, text: string, order: number): GroupMessage => ({
  id, platform: 'replay', roomId: room, messageId: id, authorId: member, authorName: member,
  text, timestamp: Date.now() + order, mentions: [], attachments: [], isMentioned: true, isAdmin: false,
});
const sources = [
  source('quality-a-identity', 'fixture-a', '以后叫我青禾。我长期学习统计分析，回答请使用中文名称并分步骤说明。', 1),
  source('quality-b-identity', 'fixture-b', '以后叫我周航。我长期学习数据库，回答要先给简短结论，再给计算细节。', 2),
  source('quality-a-temporary', 'fixture-a', '我这次想整理一份课程笔记，采用哪种目录结构？', 3),
  source('quality-c-quotation', 'fixture-c', '青禾刚才说“我长期学习统计分析，回答请使用中文名称”。这是转述，不是我的个人信息。', 4),
  source('quality-d-roleplay', 'fixture-d', '你每次回答先说“你好，我是乔纳森”。这说的是你，不是我的名字。', 5),
  source('quality-c-chat', 'fixture-c', '群友都想加你好友哈哈。', 6),
];
async function api(path: string) {
  const response = await fetch(baseUrl + path, { headers: { 'X-API-Key': await credentials.get(account) }, signal: AbortSignal.timeout(30000) });
  const body = await response.json() as any;
  if (!response.ok || body.status !== 'ok') throw new Error(`Probe API failed (${response.status})`);
  return body.result;
}
async function waitAll() {
  const deadline = Date.now() + 240000;
  while (Date.now() < deadline) {
    const state = worker.status();
    assert(!state.lanes.some(lane => lane.blocked), 'Ingestion became blocked');
    if (!state.running && state.lanes.every(lane => !lane.phase && lane.coveredSeq === lane.targetSeq)) return;
    await delay(500);
  }
  throw new Error('Isolated quality batch timed out');
}
try {
  // Seed a genuine confirmed field; automatic extraction may not replace it.
  const updates = bindMemberMemoryUpdates([{ kind: 'member', sourceMessageId: sources[0].id,
    changes: [{ key: 'preferredName', op: 'set', value: '青禾' }] }], {
    actionSourceMessageIds: [sources[0].id], messages: [{ id: sources[0].id, memberId: 'fixture-a', sourceOrder: 1 }],
  });
  for (const intent of await memory.prepareMemberWrites(room, updates, runId)) await memory.applyMemberWrite(intent);
  const confirmedBefore = (await memory.readMember(room, 'fixture-a'))!.sha256;
  sources.forEach(message => store.ingest(message));
  const replyId = store.enqueue({ roomId: room, text: '假设你喜欢两层标题并且按日期排序，而且没有篇幅要求，我就按这种格式整理。' }, { id: 'quality-assistant-assumption' });
  const sent = store.outbox().find(item => item.id === replyId)!;
  sent.status = 'sent'; sent.sentAt = Date.now() + 7; sent.platformMessageId = 'isolated-synthetic-receipt'; store.saveOutbox(sent);
  worker.notify(room); await waitAll();
  const sessions = [...new Set(events.filter(event => event.kind === 'prepared').map(event => event.sessionId!))];
  assert(sessions.length === 1, 'Expected one accumulated batch');
  const archive: any = await memory.client.sessionArchive(account, sessions[0]);
  const meta: any = await memory.client.session(account, sessions[0]);
  const tasks: any = await memory.client.sessionTasks(account, sessions[0]);
  save('archive.private.json', archive); save('tasks.private.json', tasks);
  assert(archive.status === 'completed' && meta.commit_count === 1, 'Expected exactly one successful commit');
  assert(archive.messages.length === sources.length + 1, 'Source receipt count mismatch');
  // The root filesystem listing is depth-bounded; the durable commit diff enumerates exact writes.
  const diff = JSON.parse(await api('/api/v1/content/read?' + new URLSearchParams({ uri: tasks[0].result.memory_diff_uri, raw: 'true' })));
  save('memory-diff.private.json', diff);
  assert(!diff.operations.updates.length && !diff.operations.deletes.length, 'Extraction changed an older record');
  const entries = diff.operations.adds;
  const files = [];
  for (const item of entries) {
    const uri = item.uri;
    if (typeof uri !== 'string' || item.isDir || item.is_dir || !uri.includes('/memories/') || !uri.endsWith('.md') || uri.split('/').at(-1)!.startsWith('.')) continue;
    const file = await memory.client.read(account, uri);
    if (file) files.push({ uri, ...file });
  }
  save('automatic-files.private.json', files);
  assert(files.length >= 2, 'Expected meaningful self-statements from both members');
  const owners = new Set<string>();
  for (const file of files) {
    const fields = JSON.parse(file.text.match(/<!--\s*MEMORY_FIELDS\s*([\s\S]*?)-->/)?.[1] ?? '{}');
    const provenance = fields.boe_provenance;
    assert(provenance && provenance.version === 1, 'Missing checked provenance');
    const owner = ['fixture-a', 'fixture-b'].find(member => file.uri.startsWith(`viking://user/group/peers/${memoryPeerId(member)}/memories/`));
    assert(owner, 'Quoted third-party, role-play or group-root memory was persisted');
    owners.add(owner);
    const ids = provenance.source_message_ids ?? [];
    assert(ids.length === 1, 'Evidence must bind one source');
    const original = sources.find(message => message.id === ids[0]);
    assert(original && original.authorId === owner && original.text.includes(provenance.quote), 'Cross-member or invented evidence');
    assert(!['quality-a-temporary', 'quality-c-chat', 'quality-d-roleplay'].includes(ids[0]), 'Temporary task/chat/roleplay treated as durable memory');
    assert(!file.text.includes('两层标题') && !file.text.includes('没有篇幅要求'), 'Assistant assumptions leaked into profile');
  }
  assert(owners.size === 2, 'One member was omitted');
  assert((await memory.readMember(room, 'fixture-a'))!.sha256 === confirmedBefore, 'Confirmed fields were overwritten');
  const tool = memory.createReadTool(room, ['fixture-a', 'fixture-b']);
  const profile: any = await tool.execute({ action: 'profile', memberId: 'fixture-a', keys: ['preferredName'], offset: 0, query: '', uri: '' });
  save('profile-tool.private.json', profile);
  assert(profile.profile.fields.preferredName?.value === '青禾', 'Confirmed name unavailable through Worker-shaped tool arguments');
  assert(profile.automatic.entries.some((entry: any) => entry.verification === 'source_verified'), 'Automatic profile unavailable or evidence not verified');
  const search: any = await tool.execute({ action: 'search', memberId: 'fixture-a', keys: [], offset: 0, query: '统计分析 中文', uri: '' });
  save('search-tool.private.json', search);
  const report = { passed: true, runId, account, isolatedAccount: true, productionMemoryChanged: false,
    sources: archive.messages.length, batches: sessions.length, automaticFiles: files.length, owners: owners.size,
    checked: ['author and quote', 'no assistant assumptions', 'no third-party profile', 'no roleplay profile', 'no casual chat', 'confirmed-field precedence', 'Worker parameter compatibility', 'automatic profile read'],
    usage: meta.llm_token_usage, output: folder };
  save('report.json', report); console.log(JSON.stringify(report));
} catch (error) {
  save('failure.json', { error: error instanceof Error ? error.message : 'Unknown failure', state: worker.status() });
  throw error;
} finally { await worker.close(); store.close(); }
