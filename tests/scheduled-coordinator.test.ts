import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { Coordinator } from '../src/coordinator.js';
import { MemoryPublisher } from '../src/platform/memory.js';
import { Store } from '../src/store.js';
import { HOUR_MS, type ScheduleActor, type ScheduleInput } from '../src/scheduled-tasks/types.js';
import type { ScheduleModelMutation } from '../src/scheduled-tasks/tools.js';
import type { GroupMessage, OutgoingMessage, RouteAction, RouterRequest, RuntimePort, SendReceipt, ThreadInput, ToolDefinition, WorkerReport, WorkerRequest } from '../src/types.js';

const ROOM = 'qq:100:200';
const ADMIN = { kind: 'admin' } as const;
const INITIAL = Date.UTC(2026, 10, 10);
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
  vi.restoreAllMocks();
});

class TaskRuntime implements RuntimePort {
  readonly routes: RouterRequest[] = [];
  readonly workers: WorkerRequest[] = [];
  readonly cancellations: string[] = [];
  readonly steers: ThreadInput[] = [];
  ignoreAbort = false;
  private pending = new Map<number, { resolve: (report: WorkerReport) => void; reject: (error: Error) => void }>();
  decide: (request: RouterRequest, tools: ToolDefinition[]) => RouteAction[] | Promise<RouteAction[]> = request => request.result
    ? [{ action: 'publish_result', resultId: request.result.id }]
    : [{ action: 'open_thread', sourceMessageIds: request.messages.map(m => m.id), subject: 'Current question' }];
  async route(request: RouterRequest, _read?: Parameters<RuntimePort['route']>[1], _execution?: Parameters<RuntimePort['route']>[2], tools: ToolDefinition[] = []) {
    this.routes.push(structuredClone(request));
    return this.decide(request, tools);
  }
  runWorker(request: WorkerRequest): Promise<WorkerReport> {
    const index = this.workers.push(request) - 1;
    return new Promise((resolve, reject) => {
      this.pending.set(index, { resolve, reject });
      request.signal?.addEventListener('abort', () => {
        if (this.ignoreAbort) return;
        this.pending.delete(index);
        reject(new Error('aborted'));
      }, { once: true });
    });
  }
  complete(index: number, report: Partial<WorkerReport> = {}) {
    const request = this.workers[index], pending = this.pending.get(index);
    if (!pending) throw new Error(`No pending worker ${index}`);
    this.pending.delete(index);
    pending.resolve({ threadId: request.thread.id, runId: request.runId, coveredInputSeq: request.thread.latestInputSeq,
      basedOnRevision: request.thread.revision, status: 'ready', shortAnswer: 'The scheduled report is ready.',
      assumptions: [], evidenceRefs: [], openQuestions: [], ...report });
  }
  fail(index: number, error = new Error('Temporary runtime failure')) {
    const pending = this.pending.get(index);
    if (!pending) throw new Error(`No pending worker ${index}`);
    this.pending.delete(index); pending.reject(error);
  }
  async steer(_threadId: string, input: ThreadInput) { this.steers.push(input); }
  async cancel(threadId: string) { this.cancellations.push(threadId); }
  async close() {
    for (const pending of this.pending.values()) pending.reject(new Error('closed'));
    this.pending.clear();
  }
}
class VerifiedPublisher extends MemoryPublisher {
  roles = new Map<string, 'member' | 'group_admin' | 'unknown'>();
  roleCalls: string[] = [];
  deferred = false;
  blocked = false;
  pendingSend?: { message: OutgoingMessage; key: string; resolve: (receipt: SendReceipt) => void };
  async resolveMemberRole(_roomId: string, memberId: string) {
    this.roleCalls.push(memberId);
    return { roleGroup: this.roles.get(memberId) ?? 'member' as const, verifiedAt: Date.now() };
  }
  override async send(message: OutgoingMessage, key: string): Promise<SendReceipt> {
    if (key.startsWith('schedule-result:') && this.deferred) return { status: 'deferred', reason: 'offline' };
    if (key.startsWith('schedule-result:') && this.blocked) return new Promise(resolve => { this.pendingSend = { message, key, resolve }; });
    return super.send(message, key);
  }
  async release() {
    const pending = this.pendingSend;
    if (!pending) throw new Error('No blocked send');
    this.pendingSend = undefined;
    pending.resolve(await super.send(pending.message, pending.key));
  }
}
function message(id: string, overrides: Partial<GroupMessage> = {}): GroupMessage {
  return { id: `${ROOM}:${id}`, platform: 'qq', roomId: ROOM, messageId: id, authorId: '301', authorName: 'Requester',
    text: '助手，处理我的任务', timestamp: Date.now(), mentions: ['100'], attachments: [], isMentioned: true, isAdmin: false,
    memberRoleGroup: 'member', roleVerifiedAt: Date.now(), ...overrides };
}
function actor(memberId = '301', registeredBy: 'router' | 'worker' = 'router'): Extract<ScheduleActor, { kind: 'user' }> {
  return { kind: 'user', roomId: ROOM, memberId, roleGroup: 'member', roleVerifiedAt: Date.now(), sourceMessageIds: [`${ROOM}:request`], registeredBy };
}
function task(overrides: Partial<ScheduleInput> = {}): ScheduleInput {
  return { roomId: ROOM, title: 'Notes report', executionKind: 'worker', content: 'Summarize the saved notes.',
    scheduleSpec: { kind: 'once', at: Date.now() + 1000 }, ...overrides };
}
function modelCreate(overrides: Partial<ScheduleInput> = {}): ScheduleModelMutation {
  const { roomId: _roomId, ...input } = task(overrides);
  return { op: 'create', input };
}
function fixture(publisher = new VerifiedPublisher()) {
  let now = INITIAL;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const directory = mkdtempSync(join(tmpdir(), 'boe2-scheduled-coordinator-'));
  const config = loadConfig(directory, { botCallNames: ['助手'], apiKey: 'test-key', workerApiKey: 'test-key',
    worker: { model: 'test', provider: 'boe-openai' }, stateDir: join(directory, 'state'), concurrency: 2, routerBatchWindowMs: 0, workerInputScheduling: {settleMs:0,maxWaitMs:0},
    scheduledTasks: { enabled: true, scanIntervalMs: 1, concurrency: 1 },
    qq: { enabled: false, selfId: '100', accessToken: '', allowedGroupIds: ['200'], host: '127.0.0.1', port: 0 } });
  let store = new Store(join(directory, 'state.sqlite'));
  let runtime = new TaskRuntime();
  let coordinator = new Coordinator(config, store, runtime, publisher, true);
  cleanup.push(async () => { if (publisher.pendingSend) await publisher.release(); await coordinator.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { directory, config, publisher, get store() { return store; }, get runtime() { return runtime; },
    get coordinator() { return coordinator; }, get service() { return coordinator.scheduledTasks.service; },
    advance(ms = 1000) { now += ms; },
    async restart() {
      await coordinator.close(); store.close();
      store = new Store(join(directory, 'state.sqlite')); runtime = new TaskRuntime();
      coordinator = new Coordinator(config, store, runtime, publisher, true);
      await coordinator.start();
    } };
}
async function until(check: () => boolean, coordinator?: Coordinator) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    if (coordinator) await coordinator.tick();
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  throw new Error('Condition timed out');
}
function scheduleSends(f: ReturnType<typeof fixture>) { return f.publisher.messages.filter(m => m.dedupeKey.startsWith('schedule-result:')); }
async function finish(f: ReturnType<typeof fixture>, index = 0, report: Partial<WorkerReport> = {}) {
  f.runtime.complete(index, report);
  await until(() => f.store.thread(f.runtime.workers[index].thread.id)?.status !== 'running', f.coordinator);
  await until(() => f.store.outbox().some(row => row.resultId === `result-${f.runtime.workers[index].runId}` && row.status === 'sent'), f.coordinator);
}
function manage(runtime: TaskRuntime, operation: ScheduleModelMutation) {
  runtime.decide = request => [{ action: 'manage_schedule', sourceMessageIds: request.messages.map(m => m.id), operation }];
}

describe('scheduled execution through the Coordinator', () => {
  it('carries Router-registered recipients through restart into reminder delivery', async()=>{
    const f=fixture();manage(f.runtime,modelCreate({executionKind:'reminder',content:'Remember the meeting.',recipientIds:['302','303','302']}));
    await f.coordinator.receive(message('recipient-request'));
    const schedule=f.service.list(ADMIN).items[0];expect(schedule.recipientIds).toEqual(['302','303']);
    expect(f.publisher.messages.some(m=>m.message.text.includes('收件人：302、303'))).toBe(true);
    await f.restart();f.advance();await f.coordinator.tick();
    expect(scheduleSends(f)).toHaveLength(1);
    expect(scheduleSends(f)[0].message).toEqual({roomId:ROOM,text:'Remember the meeting.',recipientIds:['302','303']});
    expect(f.runtime.workers).toHaveLength(0);
  });
  it('uses the running Worker snapshot recipients even after the next plan is edited',async()=>{
    const f=fixture(),schedule=f.service.create(ADMIN,task({recipientIds:['302','303'],scheduleSpec:{kind:'interval',anchorAt:Date.now()+1000,intervalMs:HOUR_MS}}),'worker-recipients');
    f.advance();await f.coordinator.tick();
    expect(f.runtime.workers[0].scheduledInput?.recipientIds).toEqual(['302','303']);
    f.service.update(ADMIN,schedule.id,schedule.version,{recipientIds:['304']},'next-recipients');
    await finish(f);
    expect(scheduleSends(f)[0].message.recipientIds).toEqual(['302','303']);
    expect(f.service.get(ADMIN,schedule.id).recipientIds).toEqual(['304']);
  });
  it.each(['ready','failed','needs_input'] as const)('stores local system %s reports without sending messages', async status => {
    const f=fixture(),schedule=f.service.create(ADMIN,task({deliveryMode:'local'}),'local');
    f.advance();await f.coordinator.tick();f.runtime.complete(0,{status});
    await until(()=>f.service.runs(ADMIN,schedule.id).items[0]?.finishedAt!==undefined,f.coordinator);
    await f.coordinator.tick();
    expect(f.store.outbox()).toHaveLength(0);expect(f.publisher.messages).toHaveLength(0);
    expect(f.store.routingThreads(ROOM,100,86400000)).toHaveLength(0);
    expect(f.service.runs(ADMIN,schedule.id).items[0]).toMatchObject({resultId:expect.any(String),status:status==='ready'?'succeeded':status,deliveryStatus:'stored'});
    expect(f.store.db.prepare("SELECT status FROM results").all()).toEqual([{status:'stored'}]);
  });
  it('keeps terminal local worker failures in the backend without sending a failure notice', async()=>{
    const f=fixture(),schedule=f.service.create(ADMIN,task({deliveryMode:'local'}),'local-error');
    f.advance();await f.coordinator.tick();f.runtime.fail(0,Object.assign(new Error('budget'),{code:'STEP_LIMIT'}));
    await until(()=>f.service.runs(ADMIN,schedule.id).items[0]?.status==='failed',f.coordinator);
    expect(f.store.outbox()).toHaveLength(0);expect(f.publisher.messages).toHaveLength(0);
  });
  it('runs the next local occurrence after its result is stored, including after restart', async()=>{
    const f=fixture(),schedule=f.service.create(ADMIN,task({deliveryMode:'local',scheduleSpec:{kind:'interval',anchorAt:Date.now()+1000,intervalMs:HOUR_MS}}),'local-recurring');
    f.advance();await f.coordinator.tick();f.runtime.complete(0);
    await until(()=>f.store.results('stored').length===1,f.coordinator);
    expect(f.service.runs(ADMIN,schedule.id).items[0].deliveryStatus).toBe('stored');
    f.advance(HOUR_MS);await f.coordinator.tick();expect(f.runtime.workers).toHaveLength(2);
    f.runtime.complete(1);await until(()=>f.store.results('stored').length===2,f.coordinator);
    await f.restart();f.advance(HOUR_MS);await f.coordinator.tick();
    expect(f.runtime.workers).toHaveLength(1);
    expect(f.service.runs(ADMIN,schedule.id).items.map(run=>run.status)).toEqual(['running','succeeded','succeeded']);
    expect(f.store.outbox()).toHaveLength(0);expect(f.publisher.messages).toHaveLength(0);
  });
  it('reconciles a legacy pending local delivery from its stored result before dispatching again', async()=>{
    const f=fixture(),schedule=f.service.create(ADMIN,task({deliveryMode:'local',scheduleSpec:{kind:'interval',anchorAt:Date.now()+1000,intervalMs:HOUR_MS}}),'legacy-local');
    f.advance();await f.coordinator.tick();f.runtime.complete(0);
    await until(()=>f.store.results('stored').length===1,f.coordinator);
    const run=f.service.runs(ADMIN,schedule.id).items[0];f.service.recordDelivery(run.id,'pending');
    await f.restart();expect(f.service.getRun(run.id)?.deliveryStatus).toBe('stored');
    await f.restart();expect(f.service.getRun(run.id)?.deliveryStatus).toBe('stored');
    f.advance(HOUR_MS);await f.coordinator.tick();expect(f.runtime.workers).toHaveLength(1);
    expect(f.service.runs(ADMIN,schedule.id).items[0].status).toBe('running');
    expect(f.store.outbox()).toHaveLength(0);expect(f.publisher.messages).toHaveLength(0);
  });
  it.each(['missing-result','wrong-thread','wrong-epoch','room-delivery','unknown','outbox'] as const)('preserves an unproven delivery blocker on recovery: %s', async kind=>{
    const f=fixture(),schedule=f.service.create(ADMIN,task({deliveryMode:'local',scheduleSpec:{kind:'interval',anchorAt:Date.now()+1000,intervalMs:HOUR_MS}}),'unproven-local');
    f.advance();await f.coordinator.tick();f.runtime.complete(0);
    await until(()=>f.store.results('stored').length===1,f.coordinator);
    const run=f.service.runs(ADMIN,schedule.id).items[0],result=f.store.results('stored')[0];
    run.deliveryStatus=kind==='unknown'?'unknown':'pending';
    if(kind==='missing-result')f.store.db.prepare('DELETE FROM results WHERE id=?').run(result.id);
    if(kind==='wrong-thread'){result.threadId='unrelated-thread';f.store.saveResult(result);}
    if(kind==='wrong-epoch'){result.epoch++;f.store.saveResult(result);}
    if(kind==='room-delivery')run.snapshot.deliveryMode='room';
    if(kind==='outbox')run.outboxId='unresolved-outbox';
    f.store.db.prepare('UPDATE schedule_runs SET data=? WHERE id=?').run(JSON.stringify(run),run.id);
    await f.restart();expect(f.service.getRun(run.id)?.deliveryStatus).toBe(run.deliveryStatus);
    f.advance(HOUR_MS);await f.coordinator.tick();expect(f.runtime.workers).toHaveLength(0);
    expect(f.store.outbox()).toHaveLength(0);expect(f.publisher.messages).toHaveLength(0);
  });
  it('rejects local delivery for reminders and user-owned work',()=>{
    const f=fixture();expect(()=>f.service.create(ADMIN,task({deliveryMode:'local',executionKind:'reminder'}),'bad')).toThrow('系统 Worker');
    const actor:ScheduleActor={kind:'user',roomId:ROOM,memberId:'alice',roleGroup:'member',roleVerifiedAt:Date.now(),sourceMessageIds:['m1'],registeredBy:'router'};
    expect(()=>f.service.create(actor,task({deliveryMode:'local'}),'bad-user')).toThrow('系统 Worker');
  });

  it('runs system work with an explicit host source and publishes one independent titled group result', async () => {
    const f = fixture();
    const schedule = f.service.create(ADMIN, task(), 'system');
    f.advance(); await f.coordinator.tick();
    expect(f.runtime.workers).toHaveLength(1);
    const request = f.runtime.workers[0];
    expect(request.scheduledInput).toMatchObject({ kind: 'scheduled', scheduleId: schedule.id, authority: 'system', ownerId: null,
      roomId: ROOM, title: schedule.title, instructions: schedule.content, sourceRefs: [] });
    expect(request.inputs).toEqual([]); expect(request.thread.participants).toEqual([]);
    expect(request.thread.sourceMessageId).toBe(''); expect(request.thread.ownerId).toBe('');
    expect(request.previousRequirementSnapshot).toBeUndefined(); expect(request.taskTools).toEqual([]);
    expect(f.store.db.prepare('SELECT count(*) n FROM messages').get()?.n).toBe(0);
    expect(f.store.inputs(request.thread.id)).toEqual([]);
    await finish(f);
    expect(f.runtime.routes).toHaveLength(0);
    expect(scheduleSends(f)).toHaveLength(1);
    expect(scheduleSends(f)[0].message).toEqual({ roomId: ROOM, text: '【Notes report】\nThe scheduled report is ready.' });
    const run = f.service.runs(ADMIN, schedule.id).items[0];
    expect(run).toMatchObject({ status: 'succeeded', threadId: request.thread.id, resultId: `result-${request.runId}`,
      outboxId: `schedule-result:${run.id}`, deliveryStatus: 'sent' });
    f.advance(); await f.coordinator.tick(); expect(scheduleSends(f)).toHaveLength(1);
  });

  it('delivers a fixed reminder without a Router, Worker, or synthetic platform input', async () => {
    const f = fixture();
    const schedule = f.service.create(ADMIN, task({ executionKind: 'reminder', content: 'Remember the meeting.' }), 'reminder');
    f.advance(); await f.coordinator.tick();
    expect(f.runtime.workers).toEqual([]); expect(f.runtime.routes).toEqual([]); expect(f.store.threads()).toEqual([]);
    expect(scheduleSends(f)[0].message).toEqual({ roomId: ROOM, text: 'Remember the meeting.' });
    expect(f.service.runs(ADMIN, schedule.id).items[0]).toMatchObject({ status: 'succeeded', deliveryStatus: 'sent' });
    expect(f.store.db.prepare('SELECT count(*) n FROM messages').get()?.n).toBe(0);
  });

  it('registers a batched Router request once, ignores delivery replay, and directly lists the requester tasks', async () => {
    const f = fixture(); f.config.routerBatchWindowMs = 15;
    manage(f.runtime, modelCreate({ scheduleSpec: { kind: 'once', at: Date.now() + HOUR_MS } }));
    const first = message('first'), second = message('second');
    await Promise.all([f.coordinator.receive(first), f.coordinator.receive(second)]);
    await f.coordinator.receive(first); await f.coordinator.receive(second);
    expect(f.service.list(ADMIN).total).toBe(1);
    expect(f.runtime.workers).toHaveLength(0);
    const schedule = f.service.list(ADMIN).items[0];
    expect(schedule).toMatchObject({ ownerId: '301', registeredBy: 'router', authority: 'user', roomId: ROOM });
    const receipt=f.store.outbox().filter(row => row.id.startsWith('schedule-control:'));
    expect(receipt).toHaveLength(1);
    expect(receipt[0].message.text).toContain(schedule.title+'：已登记。');
    expect(receipt[0].message.text).not.toContain(schedule.id);
    let page: any;
    f.runtime.decide = async (request, tools) => {
      page = await tools.find(tool => tool.name === 'scheduled_tasks_query')!.execute({ sourceMessageId: request.messages[0].id, query: { operation: 'list' } });
      return [{ action: 'reply_direct', sourceMessageIds: [request.messages[0].id], text: `You have ${page.total} task.` }];
    };
    await f.coordinator.receive(message('list'));
    expect(page.items.map((s: any) => s.id)).toEqual([schedule.id]); expect(page.items[0].canManage).toBe(true);
    expect(f.runtime.workers).toHaveLength(0);
    expect(f.publisher.messages.some(m => m.message.text === 'You have 1 task.')).toBe(true);
  });

  it('commits a Worker proposal only after ready acceptance and lets the same owner cancel through Router', async () => {
    const f = fixture(); f.runtime.ignoreAbort=true; await f.coordinator.receive(message('work'));
    const request = f.runtime.workers[0], tool = request.taskTools![0];
    const args = { operation: 'propose', slot: 'daily', mutation: modelCreate({ scheduleSpec: { kind: 'interval', anchorAt: Date.now() + HOUR_MS, intervalMs: HOUR_MS } }) };
    const proposal = await tool.execute(args) as { id: string; status: string };
    expect(await tool.execute(args)).toEqual(proposal); expect(proposal.status).toBe('proposed');
    expect(f.service.list(ADMIN).total).toBe(0);
    await finish(f, 0, { shortAnswer: 'Finished the current work.', scheduleProposalIds: [proposal.id] });
    const schedule = f.service.list(ADMIN).items[0];
    expect(schedule).toMatchObject({ ownerId: '301', authority: 'user', registeredBy: 'worker', sourceMessageIds: [`${ROOM}:work`] });
    const confirmation=f.publisher.messages.find(m => m.message.text.includes(schedule.title) && m.message.text.includes('已登记'));
    expect(confirmation).toBeDefined();expect(confirmation!.message.text).not.toContain(schedule.id);
    manage(f.runtime, { op: 'cancel', id: schedule.id, expectedVersion: schedule.version });
    await f.coordinator.receive(message('cancel'));
    expect(f.service.get(ADMIN, schedule.id).status).toBe('cancelled');
    expect(f.runtime.workers).toHaveLength(1);
  });

  it('rejects Worker proposals after a live role revocation instead of persisting the promised task', async () => {
    const f = fixture(); f.runtime.ignoreAbort=true; await f.coordinator.receive(message('work'));
    const proposal = await f.runtime.workers[0].taskTools![0].execute({ operation: 'propose', slot: 'later', mutation: modelCreate() }) as { id: string };
    f.service.updatePolicy(ADMIN, ['group_admin'], f.service.readPolicy().version);
    f.runtime.complete(0, { scheduleProposalIds: [proposal.id] });
    await until(() => f.store.thread(f.runtime.workers[0].thread.id)?.status !== 'running', f.coordinator);
    expect(f.service.list(ADMIN).total).toBe(0);
    expect(f.service.getCommand(ADMIN, proposal.id).status).toBe('superseded');
    expect(f.publisher.roleCalls.filter(id => id === '301').length).toBeGreaterThanOrEqual(1);
  });

  it('lets the original requester withdraw a pending Worker proposal through Router before ready commits', async () => {
    const f = fixture(); f.runtime.ignoreAbort=true; await f.coordinator.receive(message('work'));
    const proposal = await f.runtime.workers[0].taskTools![0].execute({ operation: 'propose', slot: 'later', mutation: modelCreate() }) as { id: string };
    let proposals: any;
    f.runtime.decide = async (request, tools) => {
      proposals = await tools[0].execute({ sourceMessageId: request.messages[0].id, query: { operation: 'proposals' } });
      return [{ action: 'reply_direct', sourceMessageIds: [request.messages[0].id], text: 'Your proposal is awaiting completion.' }];
    };
    await f.coordinator.receive(message('pending'));
    expect(proposals.items.map((p: any) => p.id)).toEqual([proposal.id]);
    manage(f.runtime, { op: 'withdraw_proposal', id: proposal.id });
    await f.coordinator.receive(message('foreign-withdraw', { authorId: '302' }));
    expect(f.service.getCommand(ADMIN, proposal.id).status).toBe('proposed');
    await f.coordinator.receive(message('withdraw'));
    expect(f.service.getCommand(ADMIN, proposal.id)).toMatchObject({ status: 'superseded', error: 'withdrawn' });
    expect(f.publisher.messages.some(m => /撤回|撤销/.test(m.message.text))).toBe(true);
    f.runtime.complete(0, { scheduleProposalIds: [proposal.id] });
    await until(() => f.store.thread(f.runtime.workers[0].thread.id)?.status !== 'running', f.coordinator);
    expect(f.service.list(ADMIN).total).toBe(0);
  });

  it('pages every pending proposal beyond 100 while keeping counts scoped to the requester', async () => {
    const f = fixture(); await f.coordinator.receive(message('owner-work'));
    const ownIds = new Set<string>();
    for (let index = 0; index < 103; index++) {
      const proposal = await f.runtime.workers[0].taskTools![0].execute({ operation: 'propose', slot: `own-${index}`, mutation: modelCreate() }) as { id: string };
      ownIds.add(proposal.id);
    }
    await f.coordinator.receive(message('other-work', { authorId: '302' }));
    for (let index = 0; index < 3; index++) {
      await f.runtime.workers[1].taskTools![0].execute({ operation: 'propose', slot: `other-${index}`, mutation: modelCreate() });
    }
    const pages: any[] = [];
    f.runtime.decide = async (request, tools) => {
      for (const offset of [0, 100]) pages.push(await tools[0].execute({ sourceMessageId: request.messages[0].id, query: { operation: 'proposals', offset, limit: 10 } }));
      return [{ action: 'reply_direct', sourceMessageIds: [request.messages[0].id], text: 'All pending proposals are available.' }];
    };
    await f.coordinator.receive(message('all-proposals'));
    expect(pages[0]).toMatchObject({ total: 103, hasMore: true, nextOffset: 10 });
    expect(pages[0].items).toHaveLength(10);
    expect(pages[1]).toMatchObject({ total: 103, hasMore: false });
    expect(pages[1].nextOffset).toBeUndefined(); expect(pages[1].items).toHaveLength(3);
    expect(pages.flatMap(page => page.items).every(proposal => ownIds.has(proposal.id))).toBe(true);
    expect(f.service.pendingProposals(ADMIN)).toHaveLength(106);
  });

  it('opens current work independently of an ordinary quoted thread and registers one future task per batched action', async () => {
    const f = fixture(); await f.coordinator.receive(message('original')); await finish(f);
    const original = f.runtime.workers[0].thread.id;
    f.config.routerBatchWindowMs = 15;
    f.runtime.decide = request => [{ action: 'open_thread', sourceMessageIds: request.messages.map(m => m.id), subject: 'Fresh work and future report',
      scheduleOperations: [modelCreate({ scheduleSpec: { kind: 'once', at: Date.now() + HOUR_MS } })] }];
    await Promise.all([
      f.coordinator.receive(message('combined-1', { replyToMessageId: 'original' })),
      f.coordinator.receive(message('combined-2', { replyToMessageId: 'original' })),
    ]);
    expect(f.service.list(ADMIN).total).toBe(1);
    expect(f.runtime.workers).toHaveLength(2);
    expect(f.runtime.workers[1].thread.id).not.toBe(original);
    expect(f.runtime.workers[1].inputs.map(input => input.message.id)).toEqual([`${ROOM}:combined-1`, `${ROOM}:combined-2`]);
    expect(f.store.thread(original)).toMatchObject({ revision: 1, latestInputSeq: 1 });
  });

  it('discards an old Worker proposal after an attributed correction changes the thread revision', async () => {
    const f = fixture(); f.runtime.ignoreAbort=true; await f.coordinator.receive(message('work'));
    const request = f.runtime.workers[0];
    const proposal = await request.taskTools![0].execute({ operation: 'propose', slot: 'later', mutation: modelCreate() }) as { id: string };
    f.runtime.decide = next => [{ action: 'append_thread', sourceMessageIds: [next.messages[0].id], threadId: request.thread.id, kind: 'correction' }];
    await f.coordinator.receive(message('correct', { text: '助手，只处理当前问题，暂时不要登记未来任务' }));
    f.runtime.complete(0, { scheduleProposalIds: [proposal.id] });
    await until(() => f.runtime.workers.length === 2, f.coordinator);
    expect(f.service.getCommand(ADMIN, proposal.id).status).toBe('superseded');
    expect(f.service.list(ADMIN).total).toBe(0);
    expect(f.runtime.workers[1].thread.revision).toBe(2);
  });

  it('never lends the original owner authorization to a later different-author scheduling request', async () => {
    const f = fixture(); await f.coordinator.receive(message('owner'));
    const threadId = f.runtime.workers[0].thread.id;
    expect(f.runtime.workers[0].taskTools?.map(tool => tool.name)).toContain('scheduled_tasks');
    f.runtime.decide = request => [{ action: 'append_thread', sourceMessageIds: [request.messages[0].id], threadId, kind: 'supplement' }];
    await f.coordinator.receive(message('other', { authorId: '302', text: '助手，把这件事每天再做一次' }));
    await until(() => f.runtime.workers.length === 2, f.coordinator);
    expect(f.runtime.workers[0].signal?.aborted).toBe(true);
    expect(f.runtime.workers[1].thread.ownerId).toBe('301');
    expect(f.runtime.workers[1].taskTools).toEqual([]);
    await f.coordinator.receive(message('owner-again', { text: '助手，我同意登记未来计划' }));
    await until(() => f.runtime.workers.length === 3, f.coordinator);
    expect(f.runtime.workers[2].taskTools?.map(tool => tool.name)).toContain('scheduled_tasks');
    expect(f.service.list(ADMIN).total).toBe(0);
  });

  it('keeps user ownership across entry points and makes all group roles powerless over system tasks', async () => {
    const f = fixture();
    const user = f.service.create(actor('301', 'worker'), task({ scheduleSpec: { kind: 'once', at: Date.now() + HOUR_MS } }), 'user');
    const system = f.service.create(ADMIN, task({ scheduleSpec: { kind: 'once', at: Date.now() + HOUR_MS } }), 'system');
    manage(f.runtime, { op: 'cancel', id: user.id, expectedVersion: 1 });
    await f.coordinator.receive(message('foreign', { authorId: '302', isAdmin: true }));
    expect(f.service.get(ADMIN, user.id).status).toBe('active');
    f.publisher.roles.set('302', 'group_admin');
    await f.coordinator.receive(message('group-admin', { authorId: '302', isAdmin: true }));
    expect(f.service.get(ADMIN, user.id).status).toBe('cancelled');
    manage(f.runtime, { op: 'cancel', id: system.id, expectedVersion: 1 });
    for (const role of ['member', 'group_admin'] as const) {
      f.publisher.roles.set('302', role);
      await f.coordinator.receive(message('system-' + role, { authorId: '302', isAdmin: true }));
      expect(f.service.get(ADMIN, system.id).status).toBe('active');
    }
    expect(f.runtime.workers).toHaveLength(0);
  });

  it('keeps owner reads available after registration permission is removed and denies further writes', async () => {
    const f = fixture();
    const schedule = f.service.create(actor(), task({ scheduleSpec: { kind: 'once', at: Date.now() + HOUR_MS } }), 'user');
    f.service.updatePolicy(ADMIN, [], f.service.readPolicy().version);
    let page: any;
    f.runtime.decide = async (request, tools) => {
      page = await tools[0].execute({ sourceMessageId: request.messages[0].id, query: { operation: 'list' } });
      return [{ action: 'reply_direct', sourceMessageIds: [request.messages[0].id], text: 'Read only.' }];
    };
    await f.coordinator.receive(message('read'));
    expect(page.items).toHaveLength(1); expect(page.items[0].canManage).toBe(false);
    manage(f.runtime, { op: 'cancel', id: schedule.id, expectedVersion: 1 });
    await f.coordinator.receive(message('write'));
    expect(f.service.get(ADMIN, schedule.id).status).toBe('active');
  });

  it('refreshes a claimed administrator role before writes instead of trusting an old message flag', async () => {
    const f = fixture();
    f.service.updatePolicy(ADMIN, ['group_admin'], f.service.readPolicy().version);
    manage(f.runtime, modelCreate());
    await f.coordinator.receive(message('demoted', { memberRoleGroup: 'group_admin', isAdmin: true, roleVerifiedAt: Date.now() }));
    expect(f.publisher.roleCalls).toContain('301');
    expect(f.service.list(ADMIN).total).toBe(0);
    f.publisher.roles.set('301', 'group_admin');
    await f.coordinator.receive(message('promoted'));
    expect(f.service.list(ADMIN).total).toBe(1);
  });

  it('enforces the hourly floor across automatic starts, manual commands, edits, and the next occurrence', async () => {
    const f = fixture();
    const schedule = f.service.create(actor(), task({ scheduleSpec: { kind: 'interval', anchorAt: Date.now() + 1000, intervalMs: HOUR_MS } }), 'periodic');
    f.advance(); await f.coordinator.tick(); await finish(f);
    f.advance(60_000);
    manage(f.runtime, { op: 'run_now', id: schedule.id, expectedVersion: 1 });
    await f.coordinator.receive(message('too-soon'));
    expect(f.runtime.workers).toHaveLength(1);
    expect(f.publisher.messages.some(m => m.message.text.includes('每小时'))).toBe(true);
    f.service.update(ADMIN, schedule.id, 1, { title: 'Renamed report' }, 'rename');
    expect(() => f.service.command(ADMIN, schedule.id, 'run_now', 2, 'early-admin')).toThrow('每小时');
    f.advance(HOUR_MS - 60_000); await f.coordinator.tick();
    expect(f.runtime.workers).toHaveLength(2);
    expect(f.runtime.workers[1].thread.id).not.toBe(f.runtime.workers[0].thread.id);
    expect(f.runtime.workers[1].scheduledInput?.title).toBe('Renamed report');
    const runs = f.service.runs(ADMIN, schedule.id).items.filter(run => run.startedAt !== undefined);
    expect(runs[0].startedAt! - runs[1].startedAt!).toBe(HOUR_MS);
  });

  it('aborts cancelled active work and fences a late ready result', async () => {
    const f = fixture(); f.runtime.ignoreAbort = true;
    const schedule = f.service.create(ADMIN, task(), 'running');
    f.advance(); await f.coordinator.tick();
    const request = f.runtime.workers[0];
    f.service.command(ADMIN, schedule.id, 'cancel', 1, 'cancel'); await f.coordinator.tick();
    expect(request.signal?.aborted).toBe(true); expect(f.runtime.cancellations).toContain(request.thread.id);
    f.runtime.complete(0, { shortAnswer: 'This late result must be dropped.' });
    await until(() => f.store.thread(request.thread.id)?.status === 'cancelled', f.coordinator);
    await new Promise(resolve => setTimeout(resolve, 5)); await f.coordinator.tick();
    expect(f.service.runs(ADMIN, schedule.id).items[0].status).toBe('cancelled');
    expect(scheduleSends(f)).toHaveLength(0); expect(f.store.results()).toEqual([]);
  });

  it('cancels a queued occurrence before capacity becomes available', async () => {
    const f = fixture(); f.config.concurrency = 1;
    await f.coordinator.receive(message('occupy'));
    const schedule = f.service.create(ADMIN, task(), 'queued');
    f.advance(); await f.coordinator.tick();
    const run = f.service.runs(ADMIN, schedule.id).items[0];
    expect(f.store.thread(run.threadId!)?.status).toBe('queued');
    f.service.command(ADMIN, schedule.id, 'cancel', 1, 'cancel'); await f.coordinator.tick();
    expect(f.store.thread(run.threadId!)?.status).toBe('cancelled');
    await finish(f);
    expect(f.runtime.workers).toHaveLength(1); expect(scheduleSends(f)).toHaveLength(0);
  });

  it('invalidates a cancelled pending delivery before retrying a restored connection', async () => {
    const f = fixture(); f.publisher.deferred = true;
    const schedule = f.service.create(ADMIN, task({ executionKind: 'reminder' }), 'offline');
    f.advance(); await f.coordinator.tick();
    const run = f.service.runs(ADMIN, schedule.id).items[0];
    expect(f.store.outbox().find(row => row.scheduleRunId === run.id)).toMatchObject({ status: 'pending', attempts: 0 });
    f.service.command(ADMIN, schedule.id, 'cancel', 1, 'cancel'); f.publisher.deferred = false;
    f.advance(5000); await f.coordinator.tick();
    expect(f.store.outbox().find(row => row.scheduleRunId === run.id)?.status).toBe('stale');
    expect(scheduleSends(f)).toHaveLength(0);
  });

  it('records an already sending receipt after cancellation without retrying the send', async () => {
    const f = fixture(); f.publisher.blocked = true;
    const schedule = f.service.create(ADMIN, task({ executionKind: 'reminder' }), 'sending');
    f.advance(); const dispatch = f.coordinator.tick();
    await until(() => Boolean(f.publisher.pendingSend));
    const run = f.service.runs(ADMIN, schedule.id).items[0];
    expect(run.deliveryStatus).toBe('sending');
    f.service.command(ADMIN, schedule.id, 'cancel', 1, 'cancel');
    await f.publisher.release(); await dispatch;
    expect(f.service.getRun(run.id)).toMatchObject({ status: 'cancelled', deliveryStatus: 'sent' });
    expect(f.service.get(ADMIN, schedule.id).status).toBe('cancelled');
    f.advance(); await f.coordinator.tick(); expect(scheduleSends(f)).toHaveLength(1);
  });

  it('recovers the same durable occurrence after restart without creating a second trigger', async () => {
    const f = fixture(); const schedule = f.service.create(ADMIN, task(), 'restart');
    f.advance(); await f.coordinator.tick();
    const first = f.runtime.workers[0];
    await f.restart();
    expect(f.runtime.workers).toHaveLength(1);
    const recovered = f.runtime.workers[0];
    expect(recovered.thread.id).toBe(first.thread.id);
    expect(recovered.scheduledInput?.scheduleRunId).toBe(first.scheduledInput?.scheduleRunId);
    expect(recovered.runId).not.toBe(first.runId); expect(recovered.thread.epoch).toBeGreaterThan(first.thread.epoch);
    expect(f.service.runs(ADMIN, schedule.id).total).toBe(1);
    expect(recovered.inputs).toEqual([]);
    await finish(f); expect(scheduleSends(f)).toHaveLength(1);
  });

  it('persists only a configuration hash and refuses to retry an occurrence under changed model settings', async () => {
    const f = fixture(); const schedule = f.service.create(ADMIN, task(), 'config-change');
    f.advance(); await f.coordinator.tick();
    const request = f.runtime.workers[0];
    expect(request.thread.scheduledTask?.executionConfigRevision).toMatch(/^[a-f0-9]{64}$/);
    expect(f.store.thread(request.thread.id)?.scheduledTask?.executionConfigRevision).toBe(request.thread.scheduledTask?.executionConfigRevision);
    expect(JSON.stringify(f.store.thread(request.thread.id))).not.toContain('test-key');
    writeFileSync(join(f.directory, 'config.local.json'), JSON.stringify({ worker: { model: 'changed-model', provider: 'boe-openai' } }));
    f.runtime.fail(0);
    await until(() => f.store.thread(request.thread.id)?.status === 'cancelled', f.coordinator);
    expect(f.runtime.workers).toHaveLength(1);
    expect(f.service.get(ADMIN, schedule.id)).toMatchObject({ status: 'blocked', stateReason: 'execution_config_changed' });
    expect(scheduleSends(f)).toHaveLength(0);
  });

  it('fences a runtime configuration mismatch without publishing a generic failure result', async () => {
    const f = fixture(); const schedule = f.service.create(ADMIN, task(), 'runtime-config-change');
    f.advance(); await f.coordinator.tick();
    const request = f.runtime.workers[0];
    f.runtime.fail(0, Object.assign(new Error('Changed during runtime setup'), { code: 'SCHEDULE_CONFIG_CHANGED' }));
    await until(() => f.store.thread(request.thread.id)?.status === 'cancelled', f.coordinator);
    expect(f.service.get(ADMIN, schedule.id)).toMatchObject({ status: 'blocked', stateReason: 'execution_config_changed' });
    expect(f.runtime.workers).toHaveLength(1); expect(scheduleSends(f)).toHaveLength(0);
  });

  it('treats interrupted sending as unknown on startup and blocks automatic future occurrences', async () => {
    const f = fixture();
    const schedule = f.service.create(ADMIN, task({ executionKind: 'reminder', scheduleSpec: { kind: 'interval', anchorAt: Date.now() + 1000, intervalMs: HOUR_MS } }), 'uncertain');
    f.advance(); f.coordinator.scheduledTasks.tick();
    const run = f.service.runs(ADMIN, schedule.id).items[0];
    const row = f.store.outbox().find(value => value.scheduleRunId === run.id)!;
    row.status = 'sending'; row.attempts = 1; f.store.saveOutbox(row); f.service.recordDelivery(run.id, 'sending');
    await f.restart();
    expect(f.store.outbox().find(value => value.id === row.id)?.status).toBe('unknown');
    expect(f.service.get(ADMIN, schedule.id)).toMatchObject({ status: 'blocked', stateReason: 'delivery_unknown' });
    f.advance(HOUR_MS); await f.coordinator.tick();
    expect(f.service.runs(ADMIN, schedule.id).total).toBe(1); expect(scheduleSends(f)).toHaveLength(0);
  });

  it('rejects quoted system-thread control while allowing a separate user follow-up', async () => {
    const f = fixture(); const schedule = f.service.create(ADMIN, task(), 'protected');
    f.advance(); await f.coordinator.tick(); await finish(f);
    const thread = f.runtime.workers[0].thread;
    const published = f.store.outbox().find(row => row.scheduleRunId === thread.scheduledTask!.scheduleRunId)!;
    f.publisher.roles.set('301', 'group_admin');
    for (const action of ['request_cancel', 'append_thread'] as const) {
      f.runtime.decide = request => [action === 'request_cancel'
        ? { action, sourceMessageIds: [request.messages[0].id], threadId: thread.id }
        : { action, sourceMessageIds: [request.messages[0].id], threadId: thread.id, kind: 'correction' }];
      await f.coordinator.receive(message(action, { replyToMessageId: published.platformMessageId, isAdmin: true }));
      expect(f.store.thread(thread.id)).toMatchObject({ status: 'idle', revision: 1, latestInputSeq: 1 });
      expect(f.runtime.workers).toHaveLength(1);
    }
    f.runtime.decide = request => [{ action: 'open_thread', sourceMessageIds: [request.messages[0].id], subject: 'Explain the public report' }];
    await f.coordinator.receive(message('follow-up', { replyToMessageId: published.platformMessageId }));
    expect(f.runtime.workers).toHaveLength(2);
    const followup = f.runtime.workers[1];
    expect(followup.thread.scheduledTask).toBeUndefined(); expect(followup.scheduledInput).toBeUndefined();
    expect(followup.thread.ownerId).toBe('301'); expect(followup.inputs[0].message.id).toBe(`${ROOM}:follow-up`);
    expect(f.service.runs(ADMIN, schedule.id).total).toBe(1);
  });

  it('pauses a system task that needs clarification and points the group to backend management', async () => {
    const f = fixture(); const schedule = f.service.create(ADMIN, task({ scheduleSpec: { kind: 'interval', anchorAt: Date.now() + 1000, intervalMs: HOUR_MS } }), 'clarification');
    f.advance(); await f.coordinator.tick(); await finish(f, 0, { status: 'needs_input', shortAnswer: 'Please change my confidential task parameters.' });
    expect(f.service.get(ADMIN, schedule.id)).toMatchObject({ status: 'paused', stateReason: 'needs_input' });
    expect(scheduleSends(f)[0].message.text).toContain('后台');
    expect(scheduleSends(f)[0].message.text).not.toContain('confidential');
    f.advance(HOUR_MS); await f.coordinator.tick(); expect(f.runtime.workers).toHaveLength(1);
  });

  it('blocks missing required capabilities before dispatch and fences pending delivery when disabled', async () => {
    const f = fixture();
    const unavailable = f.service.create(ADMIN, task({ requiredCapabilityIds: ['missing-capability'] }), 'unavailable');
    f.advance(); await f.coordinator.tick();
    expect(f.service.get(ADMIN, unavailable.id)).toMatchObject({ status: 'blocked', stateReason: 'capability_unavailable' });
    expect(f.runtime.workers).toHaveLength(0);
    f.publisher.deferred = true;
    const reminder = f.service.create(ADMIN, task({ executionKind: 'reminder' }), 'disable');
    f.advance(); await f.coordinator.tick();
    f.config.scheduledTasks!.enabled = false; f.publisher.deferred = false;
    f.advance(5000); await f.coordinator.tick();
    const run = f.service.runs(ADMIN, reminder.id).items[0];
    expect(f.store.outbox().find(row => row.scheduleRunId === run.id)?.status).toBe('stale');
    expect(scheduleSends(f)).toHaveLength(0);
  });
});
