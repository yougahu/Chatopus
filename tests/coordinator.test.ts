import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { Coordinator } from '../src/coordinator.js';
import { Store } from '../src/store.js';
import { MemoryPublisher } from '../src/platform/memory.js';
import { MODEL_RETRIES_EXHAUSTED, MODEL_ERROR_REPLY } from '../src/runtime/model-retry.js';
import type { GroupMessage, PublisherPort, RouteAction, RouterRequest, RuntimePort, ThreadInput, WorkerReport, WorkerRequest } from '../src/types.js';

class ControlledRuntime implements RuntimePort {
  readonly routes: RouterRequest[] = [];
  readonly workers: WorkerRequest[] = [];
  readonly steers: Array<{ threadId: string; input: ThreadInput }> = [];
  readonly cancellations: string[] = [];
  private pending = new Map<number, { resolve: (report: WorkerReport) => void; reject: (error: Error) => void }>();
  decide: (request: RouterRequest) => RouteAction[] | Promise<RouteAction[]> = request => request.result
    ? [{ action: 'publish_result', resultId: request.result.id }]
    : [{ action: 'open_thread', sourceMessageIds: [request.messages[0].id], subject: request.messages[0].text }];
  async route(request: RouterRequest,_readContext?:Parameters<RuntimePort['route']>[1]): Promise<RouteAction[]> { this.routes.push(structuredClone(request)); return this.decide(request); }
  runWorker(request: WorkerRequest): Promise<WorkerReport> {
    const index = this.workers.push(request) - 1;
    return new Promise((resolve, reject) => {
      this.pending.set(index, { resolve, reject });
      request.signal?.addEventListener('abort', () => {
        this.pending.delete(index); reject(new Error('aborted'));
      }, { once: true });
    });
  }
  complete(index: number, report: Partial<WorkerReport> = {}): void {
    const request = this.workers[index], pending = this.pending.get(index);
    if (!pending) throw new Error(`No pending worker ${index}`);
    this.pending.delete(index);
    pending.resolve({ threadId: request.thread.id, runId: request.runId,
      coveredInputSeq: request.inputs.at(-1)!.seq, basedOnRevision: request.inputs.at(-1)!.revision,
      status: 'ready', shortAnswer: `answer ${index}`, assumptions: [], evidenceRefs: [], openQuestions: [], ...report });
  }
  fail(index: number, error = new Error('transient worker error')): void {
    const pending = this.pending.get(index);
    if (!pending) throw new Error(`No pending worker ${index}`);
    this.pending.delete(index); pending.reject(error);
  }
  async steer(threadId: string, input: ThreadInput): Promise<void> { this.steers.push({ threadId, input }); }
  async cancel(threadId: string): Promise<void> { this.cancellations.push(threadId); }
  async close(): Promise<void> { for (const p of this.pending.values()) p.reject(new Error('closed')); this.pending.clear(); }
}

function message(id: string, text = '请解释 HTTP 缓存机制', overrides: Partial<GroupMessage> = {}): GroupMessage {
  return { id: `room:${id}`, platform: 'replay', roomId: 'room', messageId: id, authorId: 'A', authorName: 'A',
    text, timestamp: Date.now(), mentions: [], attachments: [], isMentioned: true, isAdmin: false, ...overrides };
}
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
function fixture(publisher: PublisherPort = new MemoryPublisher()) {
  const directory = mkdtempSync(join(tmpdir(), 'boe2-coordinator-'));
  const config = loadConfig(directory, { botCallNames:['助手'], apiKey: '', stateDir: join(directory, 'state'), concurrency: 2, routerBatchWindowMs: 0 });
  const store = new Store(join(directory, 'state.sqlite'));
  const runtime = new ControlledRuntime();
  const coordinator = new Coordinator(config, store, runtime, publisher);
  cleanup.push(async () => { await coordinator.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { directory, config, store, runtime, coordinator, publisher: publisher as MemoryPublisher };
}
async function until(check: () => boolean, coordinator?: Coordinator): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    if (coordinator) await coordinator.tick();
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Condition timed out');
}
function appendTo(threadId: string, request: RouterRequest): RouteAction[] {
  return request.result ? [{ action: 'publish_result', resultId: request.result.id }]
    : [{ action: 'append_thread', sourceMessageIds: [request.messages[0].id], threadId, kind: 'correction' }];
}

function answers(publisher: MemoryPublisher) { return publisher.messages.filter(item => !item.dedupeKey.startsWith('ack:')); }
it('returns the explicit model error without launching another Worker after exhausted model retries',async()=>{
 const {coordinator,runtime,store,publisher}=fixture();await coordinator.receive(message('model-failure'));
 runtime.fail(0,Object.assign(new Error('private provider detail'),{code:MODEL_RETRIES_EXHAUSTED}));await coordinator.drain(1000);
 expect(runtime.workers).toHaveLength(1);expect(store.threads()[0].status).toBe('failed');
 expect(answers(publisher).map(x=>x.message.text)).toEqual([MODEL_ERROR_REPLY]);
});
it('returns the explicit Router model error once for a named wake without trying another route',async()=>{
 const {coordinator,runtime,store,publisher}=fixture();
 runtime.decide=()=>{throw Object.assign(new Error('private provider detail'),{code:MODEL_RETRIES_EXHAUSTED});};
 await coordinator.receive(message('router-model-failure','助手，查一下',{isMentioned:false}));await coordinator.drain(1000);
 expect(runtime.routes).toHaveLength(1);expect(runtime.workers).toHaveLength(0);
 expect(answers(publisher).map(x=>x.message.text)).toEqual([MODEL_ERROR_REPLY]);
 expect(store.db.prepare('SELECT status FROM messages').get()?.status).toBe('failed');
});
it('preserves the completed result and reports a model error when publication routing exhausts retries',async()=>{
 const {coordinator,runtime,store,publisher}=fixture();await coordinator.receive(message('result-model-failure'));
 runtime.decide=()=>{throw Object.assign(new Error('private provider detail'),{code:MODEL_RETRIES_EXHAUSTED});};
 runtime.complete(0,{shortAnswer:'saved answer'});await coordinator.drain(1000);
 expect(runtime.routes).toHaveLength(2);expect(answers(publisher).map(x=>x.message.text)).toEqual([MODEL_ERROR_REPLY]);
 expect(store.results('failed')[0].report.shortAnswer).toBe('saved answer');expect(store.results()).toHaveLength(0);
});
it('stores uncalled messages silently and requires a fresh wake for every follow-up',async()=>{
  const {coordinator,runtime,store,publisher}=fixture();
  await coordinator.receive(message('quiet','请教一下，缓存过期会清除已有连接吗',{isMentioned:false}));
  expect(runtime.routes).toHaveLength(0);expect(runtime.workers).toHaveLength(0);expect(publisher.messages).toHaveLength(0);
  expect(store.message('room:quiet')).toBeDefined();
  await coordinator.receive(message('called','助手，帮我查一下文件格式',{isMentioned:false}));
  const thread=store.threads()[0];expect(thread.explicit).toBe(true);
  expect(runtime.routes[0].recentMessages.some(m=>m.id==='room:quiet')).toBe(true);
  runtime.complete(0);await coordinator.drain(1000);
  const count=runtime.routes.length,sends=publisher.messages.length;
  await coordinator.receive(message('follow','继续',{isMentioned:false,replyToMessageId:'called'}));
  await coordinator.receive(message('cancel-quiet','不用查了',{isMentioned:false}));
  expect(runtime.routes).toHaveLength(count);expect(runtime.workers).toHaveLength(1);expect(publisher.messages).toHaveLength(sends);
  expect(store.thread(thread.id)?.latestInputSeq).toBe(1);
  runtime.decide=request=>appendTo(thread.id,request);
  await coordinator.receive(message('follow-called','助手，继续',{isMentioned:false,replyToMessageId:'called'}));
  expect(runtime.workers).toHaveLength(2);runtime.complete(1);await coordinator.drain(1000);
});

it('does not let a model group an uncalled neighbour into a called task',async()=>{
  const {coordinator,config,runtime,store}=fixture();config.routerBatchWindowMs=20;
  runtime.decide=request=>openWithAcknowledgement(request,'我来查一下');
  await Promise.all([coordinator.receive(message('silent','预算随便聊聊',{isMentioned:false})),coordinator.receive(message('called','帮我查一下'))]);
  expect(runtime.workers).toHaveLength(1);
  expect(store.inputs(store.threads()[0].id).map(i=>i.message.id)).toEqual(['room:called']);
  runtime.complete(0);await coordinator.drain(1000);
});
function acknowledgements(publisher: MemoryPublisher) { return publisher.messages.filter(item => item.dedupeKey.startsWith('ack:')); }
it('persists the current calculation requirement with the attributed input',async()=>{
 const {coordinator,runtime,store}=fixture();
 runtime.decide=request=>[{action:'open_thread',sourceMessageIds:request.messages.map(m=>m.id),subject:'键盘',resolvedRequest:'只解释缓存过期',routingMetadata:{'test-calculation':{required:false}}}];
 await coordinator.receive(message('scope','不算整理了，只解释缓存过期'));
 expect(store.inputs(store.threads()[0].id)[0]).toMatchObject({message:{authorId:'A'},routingContext:{resolvedRequest:'只解释缓存过期',routingMetadata:{'test-calculation':{required:false}}}});
});
it('uses recalled same-room originals as Worker context while keeping intake sources unchanged',async()=>{
 const {coordinator,runtime,store}=fixture();const old=message('archived','原先预算20元');store.ingest(old);store.messageStatus(old.id,'routed');
 const target=store.createThread(old,'旧任务',true);target.status='idle';target.updatedAt=0;store.saveThread(target);
 runtime.route=async(request,readContext)=>{
  expect(readContext).toBeTypeOf('function');
  const page=await readContext!({kind:'messages',id:old.id});expect(page.messages?.[0].text).toBe(old.text);
  await readContext!({kind:'threads',id:target.id});
  return [{action:'append_thread',threadId:target.id,sourceMessageIds:[request.messages[0].id],contextMessageIds:[old.id],resolvedRequest:'按原预算继续'}];
 };
 await coordinator.receive(message('current','按之前的预算继续'));
 expect(store.inputs(target.id).at(-1)).toMatchObject({message:{id:'room:current'},contextMessages:[{id:old.id,text:old.text}]});
});
it('carries host requirement checkpoints into later runs and across Store reopen',async()=>{
 const {coordinator,runtime,store,directory}=fixture();
 await coordinator.receive(message('first','预算10元，保留键盘'));
 const snapshot={throughInputSeq:1,revision:1,inputDigest:'a'.repeat(64),byAuthor:[{authorId:'A',text:'预算10元，保留键盘',sourceSeqs:[1]}]};
 runtime.complete(0,{requirementSnapshot:snapshot});await coordinator.drain(1000);
 const thread=store.threads()[0];
 expect(store.requirementSnapshot(thread.id)).toEqual(snapshot);
 const reopen=new Store(join(directory,'state.sqlite'));try{expect(reopen.requirementSnapshot(thread.id)).toEqual(snapshot);}finally{reopen.close();}
 runtime.decide=request=>appendTo(thread.id,request);
 await coordinator.receive(message('second','预算改7元'));
 expect(runtime.workers[1].previousRequirementSnapshot).toEqual(snapshot);
});

it('preserves deferred deliveries across repeated offline attempts and rechecks staleness',async()=>{
  let online=false,calls=0;
  const {coordinator,store}=fixture({send:async()=>{calls++;return online?{status:'sent',platformMessageId:'confirmed'}:{status:'deferred',reason:'not_connected'};}});
  store.enqueue({roomId:'room',text:'durable answer'},{id:'offline'});
  for(let n=0;n<5;n++){
    const row=store.outbox()[0];row.dueAt=0;store.saveOutbox(row);await coordinator.tick();
    expect(store.outbox()[0]).toMatchObject({status:'pending',attempts:0});
  }
  online=true;const row=store.outbox()[0];row.dueAt=0;store.saveOutbox(row);await coordinator.tick();
  expect(store.outbox()[0]).toMatchObject({status:'sent',attempts:1,platformMessageId:'confirmed'});expect(calls).toBe(6);
  const thread=store.createThread(message('version','old'),'old',true);
  thread.status='needs_input';store.saveThread(thread);
  store.enqueue({roomId:'room',text:'obsolete'},{id:'obsolete',threadId:thread.id,revision:thread.revision,epoch:thread.epoch});
  online=false;await coordinator.tick();expect(store.outbox().find(x=>x.id==='obsolete')).toMatchObject({status:'pending',attempts:0});
  thread.revision++;store.saveThread(thread);const stale=store.outbox().find(x=>x.id==='obsolete')!;stale.dueAt=0;store.saveOutbox(stale);
  online=true;await coordinator.tick();expect(store.outbox().find(x=>x.id==='obsolete')?.status).toBe('stale');expect(calls).toBe(7);
});

function openWithAcknowledgement(request: RouterRequest, text: string): RouteAction[] {
  return request.result ? [{ action: 'publish_result', resultId: request.result.id }]
    : [{ action: 'open_thread', sourceMessageIds: request.messages.map(m => m.id).reverse(), subject: request.messages[0].text, acknowledgement: text }];
}

describe('quoted question images', () => {
  const image = (id: string, overrides: Partial<GroupMessage> = {}) => message(id, '原图说明', {
    authorId: 'image-author', authorName: '图片发送者', isMentioned: false,
    attachments: [{ kind: 'image', file: `${id}.png`, url: `https://gchat.qpic.cn/${id}` }], ...overrides,
  });
  const silence = (request: RouterRequest): RouteAction[] => [{ action: 'silence', sourceMessageIds: request.messages.map(item => item.id) }];

  it('carries a previously silenced image as durable context without changing question ownership or sequence', async () => {
    const { coordinator, runtime, store, directory } = fixture();
    const original = image('image');
    runtime.decide = silence;
    await coordinator.receive(original);
    expect(runtime.workers).toHaveLength(0);
    runtime.decide = request => openWithAcknowledgement(request, '我看看这张图。');
    await coordinator.receive(message('question', '这张文档图能看懂吗？', { replyToMessageId: original.messageId }));
    const input = runtime.workers[0].inputs[0], thread = store.threads()[0];
    expect(input).toMatchObject({ seq: 1, revision: 1, message: { id: 'room:question', authorId: 'A' }, contextMessages: [original] });
    expect(thread).toMatchObject({ ownerId: 'A', sourceMessageId: 'question', participants: ['A'], latestInputSeq: 1, revision: 1 });
    expect(store.message('room:question')!.attachments).toEqual([]);
    const reopened = new Store(join(directory, 'state.sqlite'));
    try { expect(reopened.inputs(thread.id)[0].contextMessages).toEqual([original]); } finally { reopened.close(); }
    runtime.complete(0); await coordinator.drain(1000);
  });

  it('preserves quoted images in a running append and the next Worker run', async () => {
    const { coordinator, runtime, store } = fixture();
    await coordinator.receive(message('question'));
    const threadId = store.threads()[0].id, original = image('supplement-image');
    runtime.decide = silence; await coordinator.receive(original);
    runtime.decide = request => appendTo(threadId, request);
    await coordinator.receive(message('supplement', '补充条件见这张图', { replyToMessageId: original.messageId }));
    expect(runtime.steers).toHaveLength(1);
    expect(runtime.steers[0].input).toMatchObject({ seq: 2, contextMessages: [original] });
    runtime.complete(0);
    await until(() => runtime.workers.length === 2, coordinator);
    expect(runtime.workers[1].inputs).toHaveLength(2);
    expect(runtime.workers[1].inputs[1].contextMessages).toEqual([original]);
    runtime.complete(1); await coordinator.drain(1000);
  });

  it('continues routing a cancellation while a steered image is still downloading', async () => {
    const { coordinator, runtime, store } = fixture();
    await coordinator.receive(message('question'));
    const threadId=store.threads()[0].id;
    let release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve);
    runtime.steer=async(_thread,input)=>{runtime.steers.push({threadId,input});await gate;};
    try{
      runtime.decide=request=>appendTo(threadId,request);
      await coordinator.receive(image('slow-image',{isMentioned:true}));
      expect(runtime.steers).toHaveLength(1);
      runtime.decide=request=>[{action:'request_cancel',sourceMessageIds:request.messages.map(m=>m.id),threadId}];
      await coordinator.receive(message('cancel','停止'));
      expect(runtime.cancellations).toContain(threadId);
      expect(store.thread(threadId)!.status).toBe('cancelled');
    }finally{release();}
    await coordinator.drain(1000);
  });

  it('resolves an earlier image after splitting an intake batch at its dependent quote', async () => {
    const { coordinator, config, runtime, store } = fixture();
    config.routerBatchWindowMs = 20;
    const original = image('batch-image');
    runtime.decide = request => request.result ? [{ action: 'publish_result', resultId: request.result.id }] : request.messages.map(source=>source.id==='room:batch-question'
      ? { action: 'open_thread', sourceMessageIds: [source.id], subject: '引用图问题' }
      : { action: 'silence', sourceMessageIds: [source.id] });
    await Promise.all([
      coordinator.receive(original),
      coordinator.receive(message('batch-question', '这是什么参数？', { replyToMessageId: original.messageId })),
    ]);
    expect(runtime.workers).toHaveLength(1);
    expect(runtime.workers[0].inputs[0].contextMessages).toEqual([original]);
    expect(store.threads()[0].latestInputSeq).toBe(1);
    runtime.complete(0); await coordinator.drain(1000);
  });

  it('does not append a referenced source again when both messages belong to one grouped task', async () => {
    const { coordinator, config, runtime, store } = fixture();
    config.routerBatchWindowMs = 20;
    runtime.decide = request => openWithAcknowledgement(request, '我核对这组图片。');
    const original = image('grouped-image',{isMentioned:true});
    await Promise.all([
      coordinator.receive(original),
      coordinator.receive(message('grouped-question', '看这个', { replyToMessageId: original.messageId })),
    ]);
    const inputs = store.inputs(store.threads()[0].id);
    expect(inputs.map(input => input.message.id)).toEqual(['room:grouped-image', 'room:grouped-question']);
    expect(inputs[1].contextMessages?.[0].id).toBe(inputs[0].message.id);
    expect(store.threads()[0]).toMatchObject({ revision: 2, latestInputSeq: 2 });
    runtime.complete(0,{coveredInputSeq:2,basedOnRevision:2}); await coordinator.drain(1000);
  });

  it('never resolves another room image or an image ingested after the referencing question', async () => {
    const { coordinator, config, runtime, store } = fixture();
    config.routerBatchWindowMs = 20;
    store.ingest(image('foreign', { id: 'other:foreign', roomId: 'other' }));
    await coordinator.receive(message('foreign-question', '引用别的群', { replyToMessageId: 'foreign' }));
    expect(runtime.workers[0].inputs[0].contextMessages).toBeUndefined();
    runtime.complete(0); await coordinator.drain(1000);
    const pending = coordinator.receive(message('future-question', '不能引用尚未收到的图', { replyToMessageId: 'future' }));
    store.ingest(image('future'));
    await pending;
    expect(runtime.workers[1].inputs[0].contextMessages).toBeUndefined();
    runtime.complete(1); await coordinator.drain(1000);
  });

  it('resolves only the explicitly quoted message and does not follow a nested reference', async () => {
    const { coordinator, runtime, store } = fixture();
    store.ingest(image('original'));
    store.ingest(message('middle', '见上图', { replyToMessageId: 'original' }));
    await coordinator.receive(message('question', '引用这句说明', { replyToMessageId: 'middle' }));
    expect(runtime.workers[0].inputs[0].contextMessages?.map(context=>context.messageId)).toEqual(['middle']);
    runtime.complete(0); await coordinator.drain(1000);
  });

  it('carries the Router-selected earlier equipment image while retaining the current sticker as its own source', async () => {
    const { coordinator, runtime, store } = fixture();
    const equipment = image('equipment', { authorId: 'A', text: '我的文档截图' });
    const unrelated = image('unrelated', { authorId: 'A', text: '之前的市场图' });
    const question = message('earlier-question','这一身破烂能有四百五十吗');
    runtime.decide = silence;
    await coordinator.receive(equipment); await coordinator.receive(unrelated); await coordinator.receive(question);
    runtime.decide = request => request.result ? [{ action: 'publish_result', resultId: request.result.id }] : [{
      action: 'open_thread', sourceMessageIds: request.messages.map(item => item.id),
      contextMessageIds: [equipment.id,question.id], subject: '估算之前文档截图中的输出',
    }];
    const sticker = image('sticker', { authorId: 'A', text: '助手，看看我上面的文档' });
    await coordinator.receive(sticker);
    const input = runtime.workers[0].inputs[0];
    expect(input.message).toEqual(sticker); expect(input.contextMessages).toEqual([equipment,question]);
    expect(store.threads()[0]).toMatchObject({ latestInputSeq: 1, revision: 1 });
    runtime.complete(0); await coordinator.drain(1000);
  });

  it('deduplicates an explicitly quoted image also selected by the Router, including another author', async () => {
    const { coordinator, runtime, store } = fixture();
    const original = image('other-author-image'); store.ingest(original);
    runtime.decide = request => request.result ? [{ action: 'publish_result', resultId: request.result.id }] : [{
      action: 'open_thread', sourceMessageIds: request.messages.map(item => item.id),
      contextMessageIds: [original.id, original.id], subject: '明确引用别人的图片',
    }];
    await coordinator.receive(message('question', '帮我看看他这张图', { replyToMessageId: original.messageId }));
    expect(runtime.workers[0].inputs[0].contextMessages).toEqual([original]);
    runtime.complete(0); await coordinator.drain(1000);
  });

  it.each(['unknown', 'other-author', 'other-room'])('rejects Router image context outside the supplied source scope: %s', async kind => {
    const { coordinator, runtime, store } = fixture();
    const candidate = image('context', { authorId: 'A' });
    if(kind === 'other-author')candidate.authorId = 'B';
    if(kind === 'other-room')candidate.roomId = 'other';
    if(kind !== 'unknown')store.ingest(candidate);
    runtime.decide = request => [{ action: 'open_thread', sourceMessageIds: request.messages.map(item => item.id), contextMessageIds: [candidate.id], subject: '非法图片上下文' }];
    await coordinator.receive(message('question'));
    expect(runtime.workers).toHaveLength(0); expect(store.threads()).toHaveLength(0);
    expect(runtime.routes).toHaveLength(2);
  });
});

describe('durable work acknowledgements', () => {
  it('sends the Router wording before the slow Worker answer, including a named call without an at-mention', async () => {
    const { coordinator, runtime, publisher, store } = fixture();
    runtime.decide = request => openWithAcknowledgement(request, '我先看一下这份方案，核对结构和内容。');
    await coordinator.receive(message('1', '助手，看看这个方案', { isMentioned: false }));
    expect(runtime.workers).toHaveLength(1);
    expect(store.threads()[0].epoch).toBe(1);
    expect(publisher.messages.map(item => item.message.text)).toEqual(['我先看一下这份方案，核对结构和内容。']);
    expect(publisher.messages[0].message.replyToMessageId).toBe('1');
    expect(store.outbox('sent')[0]).toMatchObject({ kind: 'acknowledgement', threadId: store.threads()[0].id, revision: 1 });
    runtime.complete(0, { shortAnswer: '这是核查后的答案。' }); await coordinator.drain(1000);
    expect(publisher.messages.map(item => item.message.text)).toEqual(['我先看一下这份方案，核对结构和内容。', '这是核查后的答案。']);
  });

  it('acknowledges one grouped task once at the final batch revision', async () => {
    const { coordinator, config, runtime, store, publisher } = fixture();
    config.routerBatchWindowMs = 20;
    runtime.decide = request => openWithAcknowledgement(request, '我按这组条件核对一下整理路线。');
    await Promise.all(['1', '2', '3'].map(id => coordinator.receive(message(id))));
    const thread = store.threads()[0];
    expect(thread.revision).toBe(3); expect(runtime.workers).toHaveLength(1);
    expect(acknowledgements(publisher)).toHaveLength(1);
    expect(acknowledgements(publisher)[0]).toMatchObject({ dedupeKey: `ack:${thread.id}:3`, message: { replyToMessageId: '1' } });
    expect(store.outbox('sent')[0].revision).toBe(3);
    runtime.complete(0); await coordinator.drain(1000);
  });

  it('acknowledges queued work without waiting for a Worker concurrency slot', async () => {
    const { coordinator, config, runtime, store, publisher } = fixture();
    config.concurrency = 1;
    await coordinator.receive(message('1'));
    await coordinator.receive(message('2', '另一个独立问题', { authorId: 'B' }));
    expect(runtime.workers).toHaveLength(1);
    expect(store.threads().filter(thread => thread.status === 'queued')).toHaveLength(1);
    expect(acknowledgements(publisher).map(item => item.message.replyToMessageId)).toEqual(['1', '2']);
    expect(acknowledgements(publisher).every(item => item.message.text.trim().length > 0)).toBe(true);
    runtime.complete(0); await until(() => runtime.workers.length === 2, coordinator);
    runtime.complete(1); await coordinator.drain(1000);
    expect(acknowledgements(publisher)).toHaveLength(2);
  });

  it('does not repeat the acknowledgement for duplicate intake or an internal Worker retry', async () => {
    const { coordinator, runtime, publisher } = fixture();
    const first = message('1');
    await coordinator.receive(first); runtime.fail(0);
    await until(() => runtime.workers.length === 2, coordinator);
    await coordinator.receive(first);
    expect(acknowledgements(publisher)).toHaveLength(1);
    expect(runtime.routes.filter(request => request.event === 'messages')).toHaveLength(1);
    runtime.complete(1); await coordinator.drain(1000);
    expect(answers(publisher).map(item => item.message.text)).toEqual(['answer 1']);
    expect(acknowledgements(publisher)).toHaveLength(1);
  });

  it.each(['ready', 'needs_input', 'failed'] as const)('acknowledges a new follow-up after a %s result, but not another active supplement', async status => {
    const { coordinator, runtime, publisher, store } = fixture();
    await coordinator.receive(message('1')); runtime.complete(0, { status }); await coordinator.drain(1000);
    const thread = store.threads()[0];
    runtime.decide = request => request.result ? [{ action: 'publish_result', resultId: request.result.id }]
      : [{ action: 'append_thread', sourceMessageIds: request.messages.map(m => m.id), threadId: thread.id, acknowledgement: '我按你补充的条件继续核对。' }];
    await coordinator.receive(message('2', '这是补充条件'));
    expect(acknowledgements(publisher).map(item => item.message.replyToMessageId)).toEqual(['1', '2']);
    expect(acknowledgements(publisher)[1].message.text).toBe('我按你补充的条件继续核对。');
    await coordinator.receive(message('3', '还有一条补充'));
    expect(acknowledgements(publisher)).toHaveLength(2);
    runtime.complete(1, { coveredInputSeq: 3, basedOnRevision: 3 }); await coordinator.drain(1000);
    expect(runtime.workers[1].thread.sessionId).toBe(runtime.workers[0].thread.sessionId);
  });

  it.each(['completed', 'cancelled'] as const)('drops an unsent acknowledgement once its task is %s', async outcome => {
    const published = new MemoryPublisher();
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const { coordinator, runtime, store } = fixture({ send: async (message, key) => {
      if (key === 'unrelated-send') await blocked;
      return published.send(message, key);
    } });
    cleanup.push(async () => { release(); });
    store.enqueue({ roomId: 'other', text: 'an earlier send' }, { id: 'unrelated-send' });
    const dispatch = coordinator.tick(); await until(() => store.outbox('sending').length === 1);
    await coordinator.receive(message('1'));
    const ack = store.outbox('pending').find(row => row.kind === 'acknowledgement')!;
    expect(ack).toBeDefined();
    if (outcome === 'completed') {
      runtime.complete(0); await until(() => store.threads()[0].status === 'idle', coordinator);
    } else {
      runtime.decide = request => [{ action: 'request_cancel', sourceMessageIds: request.messages.map(m => m.id), threadId: store.threads()[0].id }];
      await coordinator.receive(message('2', '取消'));
    }
    release(); await dispatch; await coordinator.drain(1000);
    expect(acknowledgements(published)).toHaveLength(0);
    expect(store.outbox('stale').map(row => row.id)).toContain(ack.id);
    expect(published.messages.at(-1)?.message.text).toBe(outcome === 'completed' ? 'answer 0' : '已停止这个问题的处理。');
  });

  it('replaces an undelivered old acknowledgement with the latest correction wording', async () => {
    const published = new MemoryPublisher();
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const { coordinator, runtime, store } = fixture({ send: async (message, key) => {
      if (key === 'unrelated-send') await blocked;
      return published.send(message, key);
    } });
    cleanup.push(async () => { release(); });
    store.enqueue({ roomId: 'other', text: 'an earlier send' }, { id: 'unrelated-send' });
    const dispatch = coordinator.tick(); await until(() => store.outbox('sending').length === 1);
    runtime.decide = request => openWithAcknowledgement(request, '我查一下 Node 20 的配置。');
    await coordinator.receive(message('1', '查 Node 20 配置'));
    const thread = store.threads()[0];
    runtime.decide = request => request.result ? [{ action: 'publish_result', resultId: request.result.id }]
      : [{ action: 'append_thread', sourceMessageIds: request.messages.map(m => m.id), threadId: thread.id, kind: 'correction', acknowledgement: '我改按 Node 22 的配置核对。' }];
    await coordinator.receive(message('2', '改成 Node 22'));
    release(); await dispatch;
    await until(() => acknowledgements(published).length === 1, coordinator);
    expect(acknowledgements(published).map(item => item.message.text)).toEqual(['我改按 Node 22 的配置核对。']);
    expect(store.outbox('stale').map(row => row.id)).toContain(`ack:${thread.id}:1`);
    expect(store.outbox('sent').find(row => row.kind === 'acknowledgement')?.revision).toBe(2);
    runtime.complete(0, { coveredInputSeq: 2, basedOnRevision: 2 }); await coordinator.drain(1000);
  });

  it('does not resend an uncertain acknowledgement when active inputs or Worker retries arrive', async () => {
    const published = new MemoryPublisher(); let ackAttempts = 0;
    const { coordinator, runtime, store } = fixture({ send: async (message, key) => {
      if (key.startsWith('ack:')) { ackAttempts++; return { status: 'unknown', reason: 'receipt timed out' }; }
      return published.send(message, key);
    } });
    await coordinator.receive(message('1'));
    runtime.decide = request => appendTo(store.threads()[0].id, request);
    await coordinator.receive(message('2', '新的条件'));
    runtime.fail(0); await until(() => runtime.workers.length === 2, coordinator);
    runtime.complete(1); await coordinator.drain(1000);
    expect(ackAttempts).toBe(1);
    expect(store.outbox('unknown')).toHaveLength(1);
    expect(store.outbox('unknown')[0].kind).toBe('acknowledgement');
    expect(answers(published)).toHaveLength(1);
  });

  it('uses a host fallback when the Router leaves the acknowledgement blank', async () => {
    const { coordinator, runtime, publisher } = fixture();
    runtime.decide = request => openWithAcknowledgement(request, '   ');
    await coordinator.receive(message('1'));
    expect(runtime.workers).toHaveLength(1);
    expect(acknowledgements(publisher)).toHaveLength(1);
    expect(acknowledgements(publisher)[0].message.text.trim().length).toBeGreaterThan(0);
    runtime.complete(0); await coordinator.drain(1000);
  });

  it('does not replace an acknowledgement already awaiting its platform receipt', async () => {
    const published = new MemoryPublisher();
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const { coordinator, runtime, store } = fixture({ send: async (message, key) => {
      if (key.startsWith('ack:')) await blocked;
      return published.send(message, key);
    } });
    cleanup.push(async () => { release(); });
    const first = coordinator.receive(message('1'));
    await until(() => store.outbox('sending').length === 1);
    runtime.decide = request => appendTo(store.threads()[0].id, request);
    await coordinator.receive(message('2', '再补充一个条件'));
    expect(store.outbox().filter(row => row.kind === 'acknowledgement')).toHaveLength(1);
    release(); await first;
    runtime.complete(0, { coveredInputSeq: 2, basedOnRevision: 2 }); await coordinator.drain(1000);
    expect(acknowledgements(published)).toHaveLength(1);
    expect(answers(published)).toHaveLength(1);
  });

  it.each(['active', 'completed', 'cancelled'] as const)('handles a definitively failed old acknowledgement after a correction while the task is %s', async outcome => {
    const published = new MemoryPublisher();
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const attempts: string[] = [];
    const { coordinator, runtime, store } = fixture({ send: async (message, key) => {
      if (key.startsWith('ack:')) {
        attempts.push(key);
        if (attempts.length === 1) { await blocked; return { status: 'failed', reason: 'platform rejected send' }; }
      }
      return published.send(message, key);
    } });
    cleanup.push(async () => { release(); });
    runtime.decide = request => openWithAcknowledgement(request, '我先核对Node 20 配置。');
    const first = coordinator.receive(message('1', '查 Node 20 配置'));
    await until(() => store.outbox('sending').length === 1);
    const thread = store.threads()[0], oldKey = `ack:${thread.id}:1`, latestKey = `ack:${thread.id}:2`;
    runtime.decide = request => appendTo(thread.id, request);
    await coordinator.receive(message('2', '改查 Node 22 配置'));
    expect(store.outbox().filter(row => row.kind === 'acknowledgement')).toHaveLength(1);
    expect(attempts).toEqual([oldKey]);
    if (outcome === 'completed') {
      runtime.complete(0, { coveredInputSeq: 2, basedOnRevision: 2 });
      await until(() => store.thread(thread.id)?.status === 'idle', coordinator);
    } else if (outcome === 'cancelled') {
      runtime.decide = request => [{ action: 'request_cancel', sourceMessageIds: request.messages.map(m => m.id), threadId: thread.id }];
      await coordinator.receive(message('3', '取消'));
    }
    release(); await first;
    // Expire only the delivery backoff so this state-machine test does not sleep.
    for (const row of store.outbox('pending')) { row.dueAt = Date.now(); store.saveOutbox(row); }
    await coordinator.tick();
    expect(store.outbox('stale').map(row => row.id)).toContain(oldKey);
    if (outcome === 'active') {
      expect(attempts).toEqual([oldKey, latestKey]);
      const ack = acknowledgements(published);
      expect(ack).toHaveLength(1);
      expect(ack[0]).toMatchObject({ dedupeKey: latestKey, message: { replyToMessageId: '2' } });
      expect(ack[0].message.text.trim().length).toBeGreaterThan(0);
      expect(ack[0].message.text).not.toContain('Node 20');
      runtime.complete(0, { coveredInputSeq: 2, basedOnRevision: 2 });
    } else {
      expect(attempts).toEqual([oldKey]);
      expect(acknowledgements(published)).toHaveLength(0);
      expect(store.outbox().filter(row => row.kind === 'acknowledgement')).toHaveLength(1);
    }
    await coordinator.drain(1000);
    expect(answers(published)).toHaveLength(1);
  });

  it.each(['pending', 'sent', 'sending'] as const)('recovers a %s acknowledgement across database reopen without duplicating it', async status => {
    const directory = mkdtempSync(join(tmpdir(), 'boe2-ack-reopen-'));
    const file = join(directory, 'state.sqlite');
    const config = loadConfig(directory, { botCallNames:['助手'], apiKey: '', stateDir: join(directory, 'work'), routerBatchWindowMs: 0 });
    const previous = new Store(file), question = message('persisted');
    previous.ingest(question); previous.messageStatus(question.id, 'routed');
    const thread = previous.createThread(question, 'persistent task', true);
    thread.status = 'running'; thread.epoch = 1; thread.activeRunId = 'old-run'; previous.saveThread(thread);
    const id = `ack:${thread.id}:1`;
    previous.enqueue({ roomId: 'room', replyToMessageId: question.messageId, text: '我来核对一下。' },
      { id, kind: 'acknowledgement', threadId: thread.id, revision: 1, status, ...(status === 'sent' ? { sentAt: Date.now(), platformMessageId: 'previous-ack' } : {}) });
    previous.close();
    const store = new Store(file), runtime = new ControlledRuntime(), publisher = new MemoryPublisher();
    const coordinator = new Coordinator(config, store, runtime, publisher);
    cleanup.push(async () => { await coordinator.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
    await coordinator.start(); await coordinator.receive(question);
    expect(runtime.workers).toHaveLength(1); expect(runtime.workers[0].thread.epoch).toBeGreaterThan(1);
    expect(acknowledgements(publisher)).toHaveLength(status === 'pending' ? 1 : 0);
    expect(store.outbox().find(row => row.id === id)?.status).toBe(status === 'sending' ? 'unknown' : 'sent');
    runtime.complete(0); await coordinator.drain(1000);
    expect(store.outbox().filter(row => row.kind === 'acknowledgement')).toHaveLength(1);
    expect(answers(publisher)).toHaveLength(1);
  });
});

describe('durable Thread execution', () => {
  it.each(['ready', 'needs_input', 'failed'] as const)('quotes the latest covered follow-up for a %s report', async status => {
    const { coordinator, store, runtime, publisher } = fixture();
    await coordinator.receive(message('first', '服务请求一直超时'));
    runtime.complete(0, { shortAnswer: '初次回答' }); await coordinator.drain(1000);
    const thread = store.threads()[0];
    const originalReply = store.outbox('sent').find(row => row.resultId)!;
    runtime.decide = request => request.messages[0]?.messageId === 'chatter'
      ? [{ action: 'silence', sourceMessageIds: request.messages.map(item => item.id) }]
      : appendTo(thread.id, request);
    await coordinator.receive(message('follow-up', '日志里在哪看具体响应时间？', { replyToMessageId: originalReply.platformMessageId }));
    await coordinator.receive(message('chatter', '另一个群友的闲聊', { authorId: 'B', isMentioned: false }));
    runtime.complete(1, { status, shortAnswer: '对响应时间追问的回复' }); await coordinator.drain(1000);
    expect(answers(publisher).map(item => item.message.replyToMessageId)).toEqual(['first', 'follow-up']);
    expect(store.outbox('sent').find(row => row.message.text === '对响应时间追问的回复')?.message.replyToMessageId).toBe('follow-up');
    expect(store.thread(thread.id)?.sourceMessageId).toBe('first');
  });

  it('quotes the current follow-up when Worker retries are exhausted', async () => {
    const { coordinator, store, runtime, publisher } = fixture();
    await coordinator.receive(message('first')); runtime.complete(0); await coordinator.drain(1000);
    const thread = store.threads()[0];
    runtime.decide = request => appendTo(thread.id, request);
    await coordinator.receive(message('follow-up', '继续核对这条新条件'));
    runtime.fail(1); await until(() => runtime.workers.length === 3, coordinator);
    runtime.fail(2); await coordinator.drain(1000);
    const failure = publisher.messages.find(item => item.dedupeKey.startsWith('worker-failed:'));
    expect(failure?.message.replyToMessageId).toBe('follow-up');
    expect(store.thread(thread.id)?.status).toBe('failed');
  });

  it('persists image replies with text and suppresses images from a superseded Worker result', async () => {
    const { coordinator, store, runtime, publisher } = fixture();
    await coordinator.receive(message('image-1', '请截图给我'));
    const thread = store.threads()[0];
    runtime.decide = request => appendTo(thread.id, request);
    await coordinator.receive(message('image-2', '改看另一个页面'));
    const oldImage = { kind: 'image' as const, artifactId: 'old-image', file: '/test/old.png', mimeType: 'image/png' as const, bytes: 100, sha256: 'a'.repeat(64) };
    runtime.complete(0, { shortAnswer: '旧图', images: ['old-image'], attachments: [oldImage] });
    await until(() => runtime.workers.length === 2, coordinator);
    expect(publisher.messages.some(item => item.message.attachments?.length)).toBe(false);
    const newImage = { ...oldImage, artifactId: 'new-image', file: '/test/new.png', sha256: 'b'.repeat(64) };
    runtime.complete(1, { shortAnswer: '这是新页面', images: ['new-image'], attachments: [newImage] });
    await coordinator.drain(1000);
    const imageReplies = publisher.messages.filter(item => item.message.attachments?.length);
    expect(imageReplies).toHaveLength(1);
    expect(imageReplies[0].message).toMatchObject({ replyToMessageId: 'image-2', text: '这是新页面', attachments: [newImage] });
    expect(store.outbox('sent').find(row => row.resultId)?.message.attachments).toEqual([newImage]);
    expect(JSON.stringify(store.db.prepare("SELECT data FROM results WHERE status='queued'").all())).toContain('new-image');
  });
  it('deduplicates concurrent intake, steers corrections, suppresses old answer and runs uncovered input', async () => {
    const { coordinator, store, runtime, publisher } = fixture();
    const first = message('1');
    await Promise.all([coordinator.receive(first), coordinator.receive(first)]);
    expect(runtime.workers).toHaveLength(1); expect(store.threads()).toHaveLength(1); expect(store.decisions()).toHaveLength(1);
    const thread = store.threads()[0];
    runtime.decide = request => appendTo(thread.id, request);
    await coordinator.receive(message('2', '预算改成 5 元'));
    expect(runtime.steers).toHaveLength(1); expect(runtime.steers[0].input.seq).toBe(2);
    runtime.complete(0, { shortAnswer: '过期的 20元 答案' });
    await until(() => runtime.workers.length === 2, coordinator);
    expect(answers(publisher)).toHaveLength(0);
    expect(runtime.workers[1].inputs.map(input => input.message.text)).toContain('预算改成 5 元');
    runtime.complete(1, { shortAnswer: '按 5 元 计算的答案' }); await coordinator.drain(1000);
    expect(answers(publisher).map(x => x.message.text)).toEqual(['按 5 元 计算的答案']);
    expect(acknowledgements(publisher)).toHaveLength(1);
    expect(store.thread(thread.id)?.status).toBe('idle');
  });

  it('accepts a running Worker report that consumed steer without redundant execution', async () => {
    const { coordinator, store, runtime, publisher } = fixture();
    await coordinator.receive(message('1'));
    runtime.decide = request => appendTo(store.threads()[0].id, request);
    await coordinator.receive(message('2', '保留原始编号'));
    runtime.complete(0, { coveredInputSeq: 2, basedOnRevision: 2, shortAnswer: '已考虑保留原始编号' });
    await coordinator.drain(1000);
    expect(runtime.workers).toHaveLength(1); expect(answers(publisher)[0].message.text).toBe('已考虑保留原始编号');
    expect(answers(publisher)[0].message.replyToMessageId).toBe('2');
  });

  it('resumes the same Thread and session after a needs_input answer', async () => {
    const { coordinator, store, runtime, publisher } = fixture();
    await coordinator.receive(message('1', '这个文档怎么做'));
    runtime.complete(0, { status: 'needs_input', shortAnswer: '请发一下文档参数。', openQuestions: ['文档参数'] });
    await coordinator.drain(1000);
    const first = store.threads()[0];
    expect(first.status).toBe('needs_input'); expect(answers(publisher)).toHaveLength(1);
    runtime.decide = request => appendTo(first.id, request);
    await coordinator.receive(message('2', '这是完整的物品文本……'));
    expect(runtime.workers).toHaveLength(2); expect(runtime.workers[1].thread.sessionId).toBe(first.sessionId);
    runtime.complete(1, { shortAnswer: '根据补充参数的路线' }); await coordinator.drain(1000);
    expect(store.threads()).toHaveLength(1); expect(answers(publisher)).toHaveLength(2);
    expect(acknowledgements(publisher)).toHaveLength(2);
  });

  it('keeps two players in independent concurrent Workers', async () => {
    const { coordinator, runtime, publisher } = fixture();
    await coordinator.receive(message('1', 'A 的方案怎么改'));
    await coordinator.receive(message('2', 'B 的另一个方案怎么改', { authorId: 'B' }));
    expect(runtime.workers).toHaveLength(2);
    expect(new Set(runtime.workers.map(w => w.thread.sessionId)).size).toBe(2);
    runtime.complete(1, { shortAnswer: 'B 的答案' }); runtime.complete(0, { shortAnswer: 'A 的答案' });
    await coordinator.drain(1000);
    expect(publisher.messages.find(x => x.message.text === 'B 的答案')?.message.replyToMessageId).toBe('2');
    expect(publisher.messages.find(x => x.message.text === 'A 的答案')?.message.replyToMessageId).toBe('1');
  });
  it('runs five independent topics and starts a queued sixth only after a slot is released', async () => {
    const { coordinator, runtime, store, config } = fixture();
    config.concurrency = 5;
    for (let i = 1; i <= 6; i++) await coordinator.receive(message(String(i), `方案 ${i}`, { authorId: `player-${i}` }));
    expect(runtime.workers).toHaveLength(5);
    expect(new Set(runtime.workers.map(w => w.thread.sessionId)).size).toBe(5);
    expect(store.threads().filter(t => t.status === 'queued')).toHaveLength(1);
    runtime.complete(2);
    await until(() => runtime.workers.length === 6, coordinator);
    expect(runtime.workers[5].inputs[0].message.authorId).toBe('player-6');
    for (const i of [0, 1, 3, 4, 5]) runtime.complete(i);
    await coordinator.drain(1000);
    expect(store.threads().every(t => t.status === 'idle')).toBe(true);
  });
});

describe('routing and task authority', () => {
  it.each(['append_thread', 'request_cancel'] as const)('rejects cross-room %s even after two invalid Router decisions', async action => {
    const { coordinator, store, runtime } = fixture();
    const foreign = store.createThread(message('secret', 'private condition', { roomId: 'foreign', id: 'foreign:secret' }), 'foreign', true);
    foreign.status = 'idle'; store.saveThread(foreign);
    runtime.decide = request => [{ action, sourceMessageIds: [request.messages[0].id], threadId: foreign.id }];
    await coordinator.receive(message('attack', 'change another room'));
    const current = store.thread(foreign.id)!;
    expect(current.status).toBe('idle'); expect(current.latestInputSeq).toBe(1);
    expect(runtime.workers).toHaveLength(0); expect(runtime.cancellations).toHaveLength(0);
    expect(store.decisions()).toHaveLength(0);
  });

  it('rejects invented source IDs without publishing the invalid direct answer', async () => {
    const { coordinator, runtime, publisher } = fixture();
    runtime.decide = () => [{ action: 'reply_direct', sourceMessageIds: ['other:message'], text: 'should not send' }];
    await coordinator.receive(message('1'));
    expect(publisher.messages.some(x => x.message.text === 'should not send')).toBe(false);
  });

  it('denies another player cancellation, permits owner, and prevents old Worker publication', async () => {
    const { coordinator, store, runtime, publisher } = fixture();
    await coordinator.receive(message('1'));
    const thread = store.threads()[0];
    runtime.decide = request => [{ action: 'request_cancel', sourceMessageIds: [request.messages[0].id], threadId: thread.id }];
    await coordinator.receive(message('2', '取消', { authorId: 'B' }));
    expect(store.thread(thread.id)?.status).toBe('running'); expect(runtime.cancellations).toHaveLength(0);
    await coordinator.receive(message('3', '取消'));
    await coordinator.drain(1000);
    expect(store.thread(thread.id)?.status).toBe('cancelled'); expect(runtime.cancellations).toEqual([thread.id]);
    expect(publisher.messages.some(x => x.message.text.includes('只有提问者'))).toBe(true);
    expect(publisher.messages.some(x => x.message.text.startsWith('answer'))).toBe(false);
  });
});

describe('publication and restart', () => {
  it('rechecks a queued answer against a correction received while another send is in flight', async () => {
    const published = new MemoryPublisher();
    let release!: () => void;
    let sendingFirst = false;
    const hold = new Promise<void>(resolve => { release = resolve; });
    const { coordinator, store, runtime } = fixture({ send: async (message, key) => {
      if (!sendingFirst) { sendingFirst = true; await hold; }
      return published.send(message, key);
    } });
    runtime.decide = request => request.result ? [{ action: 'publish_result', resultId: request.result.id }]
      : [{ action: 'reply_direct', sourceMessageIds: [request.messages[0].id], text: 'hello' }];
    const firstSend = coordinator.receive(message('hello', '你好'));
    await until(() => sendingFirst);
    runtime.decide = request => request.result ? [{ action: 'publish_result', resultId: request.result.id }]
      : [{ action: 'open_thread', sourceMessageIds: [request.messages[0].id], subject: 'Document organization' }];
    await coordinator.receive(message('1', '20元 整理'));
    runtime.complete(0, { shortAnswer: 'outdated answer' });
    await until(() => store.outbox('pending').filter(row => !row.id.startsWith('ack:')).length === 1, coordinator);
    const thread = store.threads()[0];
    runtime.decide = request => appendTo(thread.id, request);
    await coordinator.receive(message('2', '改成 5 元'));
    await until(() => runtime.workers.length === 2, coordinator);
    release(); await firstSend;
    runtime.complete(1, { shortAnswer: 'revised answer' }); await coordinator.drain(1000);
    expect(answers(published).map(x => x.message.text)).toEqual(['hello', 'revised answer']);
    expect(answers(published).map(x => x.message.replyToMessageId)).toEqual(['hello', '2']);
    expect(store.outbox('stale').filter(row => !row.id.startsWith('ack:'))).toHaveLength(1);
  });

  it('re-evaluates deferrals on timer events and eventually publishes an explicit result', async () => {
    const { coordinator, runtime, publisher } = fixture();
    await coordinator.receive(message('1'));
    runtime.decide = request => [{ action: 'defer_result', resultId: request.result!.id, delayMs: 100 }];
    runtime.complete(0); await coordinator.drain(1500);
    expect(runtime.routes.filter(r => r.event === 'worker_result')).toHaveLength(1);
    expect(runtime.routes.filter(r => r.event === 'timer')).toHaveLength(2);
    expect(answers(publisher)).toHaveLength(1);
  });

  it('keeps unknown delivery durable and never retries automatically', async () => {
    let sends = 0;
    const { coordinator, store, runtime } = fixture({ send: async (_message, key) => {
      if (key.startsWith('ack:')) return { status: 'sent', platformMessageId: 'confirmed-ack' };
      sends++; return { status: 'unknown', reason: 'timeout' };
    } });
    await coordinator.receive(message('1')); runtime.complete(0); await coordinator.drain(1000);
    expect(store.outbox('unknown')).toHaveLength(1);
    await coordinator.tick(); await coordinator.tick();
    expect(sends).toBe(1);
  });

  it('recovers interrupted work, fences old results, and preserves uncertain sends after restart', async () => {
    const { coordinator, store, runtime, publisher } = fixture();
    const question = message('1'); store.ingest(question); store.messageStatus(question.id, 'routed');
    const thread = store.createThread(question, 'recover me', true);
    thread.status = 'running'; thread.epoch = 1; thread.activeRunId = 'old-run'; store.saveThread(thread);
    store.saveRun('old-run', thread.id, 'running', { epoch: 1 });
    store.saveResult({ id: 'stale-result', threadId: thread.id, roomId: thread.roomId, epoch: 1,
      report: { threadId: thread.id, runId: 'old-run', coveredInputSeq: 1, basedOnRevision: 1, status: 'ready', shortAnswer: 'old result', assumptions: [], evidenceRefs: [], openQuestions: [] },
      status: 'pending', dueAt: Date.now(), deferrals: 0 });
    store.enqueue({ roomId: 'room', text: 'uncertain existing send' }, { id: 'old-send', status: 'sending' });
    await coordinator.start();
    expect(runtime.workers).toHaveLength(1); expect(runtime.workers[0].thread.epoch).toBeGreaterThan(1);
    expect(runtime.workers[0].inputs[0].message.id).toBe(question.id);
    expect(store.outbox('unknown')).toHaveLength(1);
    runtime.complete(0, { shortAnswer: 'recovered answer' }); await coordinator.drain(1000);
    expect(publisher.messages.map(x => x.message.text)).toEqual(['recovered answer']);
    expect(store.results('stale')).toHaveLength(1);
  });

  it('routes an interrupted pending message exactly once on startup', async () => {
    const { coordinator, store, runtime } = fixture();
    const question = message('pending'); store.ingest(question); store.messageStatus(question.id, 'processing');
    await coordinator.start(); expect(runtime.workers).toHaveLength(1);
    await coordinator.receive(question); expect(runtime.workers).toHaveLength(1);
    runtime.complete(0); await coordinator.drain(1000);
    expect(store.decisions().filter(x => (x as { event?: string }).event === 'messages')).toHaveLength(1);
  });

  it('restores durable queued inputs and unknown publication across actual database reopen', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'boe2-reopen-'));
    const path = join(directory, 'state.sqlite');
    const config = loadConfig(directory, { botCallNames:['助手'], apiKey: '', stateDir: join(directory, 'work'), routerBatchWindowMs: 0 });
    const previous = new Store(path);
    const question = message('persisted');
    previous.ingest(question); previous.messageStatus(question.id, 'routed');
    const thread = previous.createThread(question, 'persistent question', true);
    thread.status = 'running'; thread.epoch = 1; thread.activeRunId = 'interrupted'; previous.saveThread(thread);
    previous.append(thread, message('correction', 'new budget'), 'correction');
    previous.enqueue({ roomId: 'room', text: 'uncertain send' }, { id: 'inflight-send', status: 'sending' });
    previous.close();
    const reopened = new Store(path), runtime = new ControlledRuntime(), publisher = new MemoryPublisher();
    const coordinator = new Coordinator(config, reopened, runtime, publisher);
    cleanup.push(async () => { await coordinator.close(); reopened.close(); rmSync(directory, { recursive: true, force: true }); });
    await coordinator.start();
    expect(runtime.workers[0].thread.id).toBe(thread.id);
    expect(runtime.workers[0].inputs.map(x => x.message.text)).toEqual(['请解释 HTTP 缓存机制', 'new budget']);
    expect(reopened.outbox('unknown')).toHaveLength(1);
    runtime.complete(0, { shortAnswer: 'after reopen' }); await coordinator.drain(1000);
    expect(publisher.messages.map(x => x.message.text)).toEqual(['after reopen']);
    expect(publisher.messages[0].message.replyToMessageId).toBe('correction');
  });
});

describe('host-confirmed Router addressing', () => {
  const silence = (request: RouterRequest): RouteAction[] => [{ action: 'silence', sourceMessageIds: request.messages.map(item => item.id) }];

  it('describes other mentions and decision time while preserving original message data', async () => {
    const { coordinator, config, runtime, store } = fixture();
    config.qq.selfId = 'bot'; runtime.decide = silence;
    const incoming = message('addressed', '@friend @bot 你知道这个参数吗？', { isMentioned: true, mentions: ['friend', 'all', 'friend', 'bot'], timestamp: 0 });
    const before = structuredClone(incoming), started = Date.now();
    await coordinator.receive(incoming);
    const request = runtime.routes[0];
    expect(request.botUserId).toBe('bot');
    expect(request.currentTime).toBeGreaterThanOrEqual(started);
    expect(request.currentTime).toBeLessThanOrEqual(Date.now());
    expect(request.addressing).toEqual({ 'room:addressed': { mentionsOthers: ['friend'] } });
    expect(incoming).toEqual(before); expect(store.message(incoming.id)).toEqual(before);
  });

  it('identifies a confirmed bot quote outside the recent reply window and preserves its existing room thread', async () => {
    const { coordinator, config, runtime, store } = fixture();
    config.qq.selfId = 'bot'; runtime.decide = silence;
    const thread = store.createThread(message('old-question'), '旧问题', true);
    thread.status = 'idle'; store.saveThread(thread);
    const now = Date.now();
    store.enqueue({ roomId: 'room', text: '较早的答复' }, { id: 'bot-old', status: 'sent', platformMessageId: 'bot-old', sentAt: now - 100, threadId: thread.id });
    for (let i = 0; i < 9; i++) store.enqueue({ roomId: 'room', text: '后续回复' }, { id: `bot-${i}`, status: 'sent', platformMessageId: `bot-${i}`, sentAt: now - 90 + i });
    await coordinator.receive(message('question', '助手，再解释一下', { replyToMessageId: 'bot-old', timestamp: 0, isMentioned: false }));
    const request = runtime.routes[0];
    expect(request.recentReplies?.some(reply => reply.messageId === 'bot-old'&&reply.text==='较早的答复')).toBe(true);
    expect(request.recentReplies?.every(reply=>reply.messageId==='bot-old'||/^bot-[0-8]$/.test(reply.messageId??''))).toBe(true);
    expect(request.recentReplies?.every(reply=>reply.sentAt<=request.currentTime!)).toBe(true);
    expect(request.addressing?.['room:question']).toEqual({ mentionsOthers: [], replyTo: { kind: 'bot', authorId: 'bot', threadId: thread.id } });
  });

  it('identifies a same-batch member quote but does not resolve that member for an earlier message', async () => {
    const { coordinator, config, runtime } = fixture();
    config.routerBatchWindowMs = 15; runtime.decide = silence;
    await Promise.all([
      coordinator.receive(message('before', '尚未发出的引用', { replyToMessageId: 'member' })),
      coordinator.receive(message('member', '我的文档说明', { authorId: 'friend' })),
      coordinator.receive(message('after', '是这个参数吗？', { replyToMessageId: 'member' })),
    ]);
    expect(runtime.routes).toHaveLength(2);
    expect(Object.assign({},...runtime.routes.map(request=>request.addressing))).toEqual({
      'room:before': { mentionsOthers: [], replyTo: { kind: 'unknown' } },
      'room:member': { mentionsOthers: [] },
      'room:after': { mentionsOthers: [], replyTo: { kind: 'member', authorId: 'friend' } },
    });
  });

  it('does not invent reply identities for other rooms, missing IDs, unsent replies, or future confirmations', async () => {
    const { coordinator, config, runtime, store } = fixture();
    config.routerBatchWindowMs = 15; runtime.decide = silence;
    store.ingest(message('foreign-member', '其他群', { id: 'other:foreign-member', roomId: 'other', authorId: 'foreign' }));
    const now = Date.now();
    store.enqueue({ roomId: 'other', text: '其他群答复' }, { status: 'sent', platformMessageId: 'foreign-bot', sentAt: now - 1 });
    store.enqueue({ roomId: 'room', text: '发送结果未知' }, { status: 'unknown', platformMessageId: 'uncertain-bot', sentAt: now - 1 });
    store.enqueue({ roomId: 'room', text: '尚未确认的未来答复' }, { status: 'sent', platformMessageId: 'future-bot', sentAt: now + 60_000 });
    const ids = ['foreign-member', 'foreign-bot', 'uncertain-bot', 'future-bot', 'missing'];
    await Promise.all(ids.map((id, index) => coordinator.receive(message(`quote-${index}`, '引用', { replyToMessageId: id }))));
    expect(runtime.routes).toHaveLength(1);
    for (let index = 0; index < ids.length; index++) expect(runtime.routes[0].addressing?.[`room:quote-${index}`]?.replyTo).toEqual({ kind: 'unknown' });
  });

  it('omits nonexistent or other-room thread bindings while retaining a confirmed bot identity', async () => {
    const { coordinator, config, runtime, store } = fixture();
    config.qq.selfId = 'bot'; config.routerBatchWindowMs = 15; runtime.decide = silence;
    const foreignThread = store.createThread(message('foreign', '其他群问题', { id: 'other:foreign', roomId: 'other' }), '其他群任务', true);
    foreignThread.status = 'idle'; store.saveThread(foreignThread);
    for (const [platformMessageId, threadId] of [['bot-missing', 'nonexistent'], ['bot-foreign', foreignThread.id]]) {
      store.enqueue({ roomId: 'room', text: '已确认机器人答复' }, { status: 'sent', platformMessageId, sentAt: Date.now() - 1, threadId });
    }
    await Promise.all(['bot-missing', 'bot-foreign'].map((id, index) => coordinator.receive(message(`question-${index}`, '引用', { replyToMessageId: id }))));
    for (let index = 0; index < 2; index++) expect(runtime.routes[0].addressing?.[`room:question-${index}`]?.replyTo).toEqual({ kind: 'bot', authorId: 'bot' });
  });
});

describe('confirmed robot reply context', () => {
  it('carries a sent clarification into later same-room message and result routes, never another room', async () => {
    const { coordinator, runtime, store } = fixture();
    runtime.decide = request => request.result ? [{ action: 'publish_result', resultId: request.result.id }]
      : request.roomId === 'other' ? [{ action: 'silence', sourceMessageIds: request.messages.map(m => m.id) }]
      : request.messages[0].messageId === 'question' ? [{ action: 'clarify', sourceMessageIds: [request.messages[0].id], text: '你想比较哪两把电脑？发一下物品文本。' }]
      : [{ action: 'open_thread', sourceMessageIds: [request.messages[0].id], subject: '对比刚刚补充的两把电脑' }];
    await coordinator.receive(message('question', '这两把电脑哪把好？'));
    const sent = store.outbox('sent')[0];
    expect(sent.sentAt).toBeTypeOf('number');
    expect(sent.platformMessageId).toBe('local-1');
    expect(runtime.routes[0].recentReplies).toEqual([]);
    await coordinator.receive(message('unrelated', '另一个群的问题', { id: 'other:unrelated', roomId: 'other' }));
    expect(runtime.routes[1].recentReplies).toEqual([]);
    // A late-arriving user event can have an older source timestamp than the bot send.
    await coordinator.receive(message('materials', '第一把是完整物品文本 A，第二把是完整物品文本 B', { timestamp: 0, replyToMessageId: sent.platformMessageId }));
    const expected = [{ messageId: 'local-1', replyToMessageId: 'question', text: sent.message.text, sentAt: sent.sentAt }];
    expect(runtime.routes[2].recentReplies).toEqual(expected);
    expect(runtime.routes[2].messages.map(m => m.id)).toEqual(['room:materials']);
    runtime.complete(0); await coordinator.drain(1000);
    const resultRequest = runtime.routes.find(request => request.event === 'worker_result')!;
    expect(resultRequest.currentTime).toBeTypeOf('number');
    expect(resultRequest.currentTime).toBeLessThanOrEqual(Date.now());
    const ack = store.outbox('sent').find(row => row.id.startsWith('ack:'))!;
    expect(resultRequest.recentReplies).toEqual([...expected, { messageId: ack.platformMessageId, replyToMessageId: ack.message.replyToMessageId, text: ack.message.text, sentAt: ack.sentAt }]);
    expect(resultRequest.recentReplies?.some(reply => reply.text === 'answer 0')).toBe(false);
  });

  it('does not expose a slow send as delivered before its platform acknowledgement', async () => {
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const { coordinator, runtime, store } = fixture({ send: async () => { await blocked; return { status: 'sent', platformMessageId: 'confirmed-later' }; } });
    runtime.decide = request => request.messages[0].messageId === 'first'
      ? [{ action: 'clarify', sourceMessageIds: [request.messages[0].id], text: '请补充地图参数。' }]
      : [{ action: 'silence', sourceMessageIds: request.messages.map(m => m.id) }];
    const first = coordinator.receive(message('first', '这张图能打吗？'));
    await until(() => store.outbox('sending').length === 1);
    await coordinator.receive(message('before-ack', '补充一下情况'));
    expect(runtime.routes[1].recentReplies).toEqual([]);
    release(); await first;
    await coordinator.receive(message('after-ack', '收到你的问题了'));
    expect(runtime.routes[2].recentReplies?.map(reply => reply.messageId)).toEqual(['confirmed-later']);
    // Earlier request objects remain snapshots even after acknowledgement.
    expect(runtime.routes[1].recentReplies).toEqual([]);
  });

  it('rejects robot reply IDs as action sources even when they appear in recent context', async () => {
    const { coordinator, runtime, store } = fixture();
    store.enqueue({ roomId: 'room', text: '之前已发送的澄清' }, { status: 'sent', platformMessageId: 'bot-visible', sentAt: Date.now() - 1 });
    runtime.decide = () => [{ action: 'open_thread', sourceMessageIds: ['bot-visible'], subject: 'invalid source' }];
    await coordinator.receive(message('human', '我的补充条件'));
    expect(runtime.routes).toHaveLength(2);
    expect(runtime.routes[0].recentReplies?.[0].messageId).toBe('bot-visible');
    expect(runtime.workers).toHaveLength(0);
    expect(store.db.prepare('SELECT status FROM messages WHERE id=?').get('room:human')?.status).toBe('failed');
  });
});

describe('durable per-room microbatches', () => {
  it('routes a burst once and turns combined sources into one ordered Thread before starting a Worker', async () => {
    const { coordinator, config, runtime, store } = fixture();
    config.routerBatchWindowMs = 20;
    runtime.decide = request => request.result ? [{ action: 'publish_result', resultId: request.result.id }]
      : [{ action: 'open_thread', sourceMessageIds: request.messages.map(m => m.id).reverse(), subject: '文档整理与补充' }];
    const events = [message('1', '帮我整理文档'), message('2', '预算 10 元'), message('3', '保留章节标题')];
    const receives = events.map(event => coordinator.receive(event));
    expect(store.pendingMessages().map(m => m.id)).toEqual(events.map(m => m.id));
    expect(runtime.routes).toHaveLength(0);
    await Promise.all(receives);
    expect(runtime.routes).toHaveLength(1); expect(runtime.routes[0].messages).toHaveLength(3);
    expect(store.threads()).toHaveLength(1); expect(runtime.workers).toHaveLength(1);
    expect(runtime.workers[0].inputs.map(input => [input.seq, input.message.id])).toEqual(events.map((m, i) => [i + 1, m.id]));
    expect(store.threads()[0].ownerId).toBe('A');
    runtime.complete(0); await coordinator.drain(1000);
  });

  it('collects arrivals during a slow Router, limits batches to eight, and excludes future messages from history', async () => {
    const { coordinator, runtime, store, config } = fixture();
    config.routerBatchSize = 8;
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    runtime.decide = async request => {
      if (request.messages[0].messageId === '1') await blocked;
      return [{ action: 'silence', sourceMessageIds: request.messages.map(m => m.id) }];
    };
    const first = coordinator.receive(message('1', 'first', { timestamp: 9999 }));
    await until(() => runtime.routes.length === 1);
    const later = Array.from({ length: 15 }, (_, i) => coordinator.receive(message(String(i + 2), `later ${i}`, { timestamp: 1 })));
    expect(store.pendingMessages()).toHaveLength(15);
    release(); await Promise.all([first, ...later]);
    expect(runtime.routes.map(request => request.messages.length)).toEqual([1, 8, 7]);
    expect(runtime.routes[0].recentMessages).toHaveLength(0);
    expect(runtime.routes[1].recentMessages.map(m => m.messageId)).toEqual(['1']);
    expect(runtime.routes[2].recentMessages.map(m => m.messageId)).toEqual(Array.from({ length: 9 }, (_, i) => String(i + 1)));
    expect(store.pendingMessages()).toHaveLength(0);
    expect(store.decisions()).toHaveLength(3);
  });

  it('permits other rooms to route while one room waits for its model', async () => {
    const { coordinator, runtime } = fixture();
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    runtime.decide = async request => {
      if (request.roomId === 'room') await blocked;
      return [{ action: 'silence', sourceMessageIds: request.messages.map(m => m.id) }];
    };
    const first = coordinator.receive(message('1'));
    await until(() => runtime.routes.length === 1);
    await coordinator.receive(message('other', 'hello', { id: 'other:1', roomId: 'other' }));
    expect(runtime.routes.map(request => request.roomId)).toEqual(['room', 'other']);
    release(); await first;
  });

  it('applies every grouped supplement once and steers a running Worker in intake order', async () => {
    const { coordinator, config, runtime, store, publisher } = fixture();
    await coordinator.receive(message('1', '整理问题'));
    config.routerBatchWindowMs = 20;
    const thread = store.threads()[0];
    runtime.decide = request => request.result ? [{ action: 'publish_result', resultId: request.result.id }]
      : [{ action: 'append_thread', sourceMessageIds: request.messages.map(m => m.id).reverse(), threadId: thread.id, kind: 'correction' }];
    await Promise.all([coordinator.receive(message('2', '预算 5 元')), coordinator.receive(message('3', '保留原始目录'))]);
    expect(runtime.steers.map(x => [x.input.seq, x.input.message.messageId])).toEqual([[2, '2'], [3, '3']]);
    expect(store.inputs(thread.id)).toHaveLength(3);
    runtime.complete(0, { coveredInputSeq: 3, basedOnRevision: 3 }); await coordinator.drain(1000);
    expect(runtime.workers).toHaveLength(1);
    expect(answers(publisher)[0].message.replyToMessageId).toBe('3');
  });

  it('checks each author in a grouped cancellation rather than inheriting another source permission', async () => {
    const { coordinator, config, runtime, store, publisher } = fixture();
    await coordinator.receive(message('1'));
    config.routerBatchWindowMs = 20;
    const thread = store.threads()[0];
    runtime.decide = request => [{ action: 'request_cancel', sourceMessageIds: request.messages.map(m => m.id).reverse(), threadId: thread.id }];
    await Promise.all([coordinator.receive(message('2', '取消', { authorId: 'B' })), coordinator.receive(message('3', '取消', { authorId: 'A' }))]);
    await coordinator.drain(1000);
    expect(runtime.cancellations).toEqual([thread.id]);
    expect(publisher.messages.find(x => x.message.replyToMessageId === '2')?.message.text).toContain('只有提问者');
    expect(publisher.messages.find(x => x.message.replyToMessageId === '3')?.message.text).toBe('已停止这个问题的处理。');
  });

  it('rejects incomplete or duplicate source coverage for the whole batch', async () => {
    const { coordinator, config, runtime, store } = fixture();
    config.routerBatchWindowMs = 20;
    let calls = 0;
    runtime.decide = request => {
      calls++;
      return [{ action: 'open_thread', sourceMessageIds: calls === 1
        ? [request.messages[0].id]
        : [request.messages[0].id, request.messages[0].id, request.messages[1].id], subject: 'invalid' }];
    };
    await Promise.all([coordinator.receive(message('1')), coordinator.receive(message('2'))]);
    expect(calls).toBe(2); expect(runtime.workers).toHaveLength(0); expect(store.threads()).toHaveLength(0);
    expect(store.db.prepare('SELECT status FROM messages ORDER BY rowid').all().map(row => row.status)).toEqual(['failed', 'failed']);
  });

  it('applies mixed per-source actions and publishes combined reply once to the first trusted source', async () => {
    const { coordinator, runtime, config, publisher } = fixture();
    config.routerBatchWindowMs = 20;
    runtime.decide = request => [
      { action: 'reply_direct', sourceMessageIds: [request.messages[2].id, request.messages[1].id], text: '合计十个' },
      { action: 'silence', sourceMessageIds: [request.messages[0].id] },
    ];
    await Promise.all([coordinator.receive(message('1', '早')), coordinator.receive(message('2', '每份两个')), coordinator.receive(message('3', '五份多少'))]);
    expect(publisher.messages).toHaveLength(1); expect(publisher.messages[0].message.replyToMessageId).toBe('2');
  });

  it('includes explicit old references outside the recent window only within the same room', async () => {
    const { coordinator, config, runtime, store } = fixture();
    config.recentMessageLimit = 1;
    for (const event of [message('old', '我的旧文档'), message('newer', '闲聊'), message('foreign', '其他群秘密', { id: 'foreign:old', roomId: 'foreign', messageId: 'old' })]) {
      store.ingest(event); store.messageStatus(event.id, 'routed');
    }
    runtime.decide = request => [{ action: 'silence', sourceMessageIds: request.messages.map(m => m.id) }];
    await coordinator.receive(message('question', '这个呢', { replyToMessageId: 'old' }));
    expect(runtime.routes[0].recentMessages.map(m => m.text)).toEqual(['我的旧文档', '闲聊']);
    expect(runtime.routes[0].recentMessages.every(m=>m.roomId==='room')).toBe(true);
  });

  it('settles queued receive promises on shutdown and leaves every unsent batch message durable', async () => {
    const { coordinator, config, store, runtime } = fixture();
    config.routerBatchWindowMs = 10_000;
    const receives = [coordinator.receive(message('1')), coordinator.receive(message('2'))];
    await coordinator.close(); await Promise.all(receives);
    expect(runtime.routes).toHaveLength(0);
    expect(store.pendingMessages().map(m => m.messageId)).toEqual(['1', '2']);
  });

  it('closes an in-flight Router and buffered input without orphaned promises or lost durable messages', async () => {
    const { coordinator, store, runtime } = fixture();
    let reject!: (error: Error) => void;
    runtime.decide = () => new Promise<RouteAction[]>((_resolve, fail) => { reject = fail; });
    runtime.close = async () => { reject(new Error('runtime closed')); };
    const first = coordinator.receive(message('1'));
    await until(() => runtime.routes.length === 1);
    const second = coordinator.receive(message('2'));
    await coordinator.close(); await Promise.all([first, second]);
    expect(runtime.routes).toHaveLength(1);
    expect(store.pendingMessages().map(m => m.messageId)).toEqual(['1', '2']);
    expect(store.decisions()).toHaveLength(0);
  });

  it('recovers pending messages as chronological room batches rather than one call per message', async () => {
    const { coordinator, store, runtime, config } = fixture();
    config.routerBatchWindowMs = 5;
    for (let i = 1; i <= 11; i++) store.ingest(message(String(i), `queued ${i}`, { timestamp: 100 - i }));
    runtime.decide = request => [{ action: 'silence', sourceMessageIds: request.messages.map(m => m.id) }];
    await coordinator.start();
    expect(runtime.routes.map(request => request.messages.length)).toEqual([8, 3]);
    expect(runtime.routes.flatMap(request => request.messages.map(m => m.messageId))).toEqual(Array.from({ length: 11 }, (_, i) => String(i + 1)));
    expect(store.pendingMessages()).toHaveLength(0);
  });
});

describe('scheduling beyond visible history and in-flight delivery', () => {
  function seedHistory(store: Store): void {
    store.transaction(() => {
      for (let i = 0; i < 1005; i++) {
        const thread = store.createThread(message(`history-${i}`), `history ${i}`, false);
        thread.status = 'idle'; store.saveThread(thread);
      }
    });
  }

  it('schedules an old queued Thread even with more than 1000 newer completed Threads', async () => {
    const { coordinator, store, runtime } = fixture();
    const older = store.createThread(message('older-queued'), 'queued', true);
    seedHistory(store);
    await coordinator.tick();
    expect(runtime.workers).toHaveLength(1);
    expect(runtime.workers[0].thread.id).toBe(older.id);
    runtime.complete(0); await coordinator.drain(1000);
    expect(store.thread(older.id)?.status).toBe('idle');
  });

  it('recovers an old interrupted Worker beyond the 1000-card history window', async () => {
    const { coordinator, store, runtime } = fixture();
    const older = store.createThread(message('older-running'), 'running', true);
    older.status = 'running'; older.epoch = 9; older.activeRunId = 'old-run'; store.saveThread(older);
    seedHistory(store);
    await coordinator.start();
    expect(runtime.workers).toHaveLength(1);
    expect(runtime.workers[0].thread.id).toBe(older.id);
    expect(runtime.workers[0].thread.epoch).toBeGreaterThan(9);
    runtime.complete(0); await coordinator.drain(1000);
  });

  it('does not declare drain complete while a platform send is awaiting its receipt', async () => {
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const { coordinator, store } = fixture({ send: async () => { await blocked; return { status: 'sent', platformMessageId: 'confirmed' }; } });
    store.enqueue({ roomId: 'room', text: 'still sending' });
    const dispatch = coordinator.tick();
    await until(() => store.outbox('sending').length === 1);
    let drained = false;
    const draining = coordinator.drain(1000).then(() => { drained = true; });
    await new Promise(resolve => setTimeout(resolve, 40));
    expect(drained).toBe(false);
    release(); await dispatch; await draining;
    expect(store.outbox('sent')).toHaveLength(1);
  });
});

describe('host-enforced quoted thread and context handoff',()=>{
  function seed(store:Store,id:string,status:'idle'|'cancelled'='idle'){
    const original=message(id,`原问题 ${id}`);store.ingest(original);store.messageStatus(original.id,'routed');
    const thread=store.createThread(original,`任务 ${id}`,true);thread.status=status;store.saveThread(thread);return {original,thread};
  }
  it('omits expired topics from messages and results but resumes an explicitly quoted old task',async()=>{
    const {store,runtime,coordinator,config}=fixture();
    const old=seed(store,'expired-target'),unrelated=seed(store,'expired-unrelated'),recent=seed(store,'recent');
    for(const {thread} of [old,unrelated]){
      thread.updatedAt=Date.now()-config.threadIdleTtlMs-1000;
      store.db.prepare('UPDATE threads SET updated=?,data=? WHERE id=?').run(thread.updatedAt,JSON.stringify(thread),thread.id);
    }
    runtime.decide=request=>[{action:'silence',sourceMessageIds:request.messages.map(m=>m.id)}];
    await coordinator.receive(message('chat','助手，谢谢',{isMentioned:false}));
    expect(runtime.routes[0].threads.map(t=>t.id)).toEqual([recent.thread.id]);
    expect(store.threads()).toHaveLength(3);expect(runtime.workers).toHaveLength(0);
    runtime.decide=request=>appendTo(old.thread.id,request);
    await coordinator.receive(message('resume','继续解释原问题',{replyToMessageId:old.original.messageId}));
    expect(runtime.routes[1].threads.map(t=>t.id)).toContain(old.thread.id);
    expect(runtime.routes[1].threads.map(t=>t.id)).not.toContain(unrelated.thread.id);
    expect(runtime.workers).toHaveLength(1);expect(runtime.workers[0].thread.id).toBe(old.thread.id);
    runtime.complete(0);await coordinator.drain(1000);
    const resultRequest=runtime.routes.find(r=>r.event==='worker_result')!;
    expect(resultRequest.threads.map(t=>t.id)).toContain(old.thread.id);
    expect(resultRequest.threads.map(t=>t.id)).not.toContain(unrelated.thread.id);
    expect(store.thread(unrelated.thread.id)?.status).toBe('idle');
  });
  it('pins an old cross-author quote, overrides a wrong open and persists its text and interpretation',async()=>{
    const {store,runtime,coordinator,config,directory}=fixture();config.threadCardLimit=1;
    const {original,thread}=seed(store,'old');seed(store,'new');
    runtime.decide=request=>request.result?[{action:'publish_result',resultId:request.result.id}]:[{
      action:'open_thread',sourceMessageIds:[request.messages[0].id],subject:'错误的新任务',resolvedRequest:'第4项的部署说明',
      correctionTarget:'不要把部署说明理解成开发说明',
    }];
    await coordinator.receive(message('follow','第4项是哪份说明',{authorId:'B',replyToMessageId:original.messageId}));
    expect(store.threads()).toHaveLength(2);expect(runtime.routes[0].threads.map(t=>t.id)).toEqual([thread.id]);
    const input=store.inputs(thread.id).at(-1)!;
    expect(input).toMatchObject({message:{authorId:'B'},contextMessages:[original],routingContext:{resolvedRequest:'第4项的部署说明',correctionTarget:'不要把部署说明理解成开发说明'}});
    expect(store.thread(thread.id)).toMatchObject({ownerId:'A',participants:['A','B'],latestInputSeq:2});
    const reopened=new Store(join(directory,'state.sqlite'));
    try{expect(reopened.inputs(thread.id).at(-1)).toEqual(input);}finally{reopened.close();}
    runtime.complete(0);await coordinator.drain(1000);
  });
  it('keeps silence bound and resolves a later quote of that silence without running work',async()=>{
    const {store,runtime,coordinator}=fixture();const {original,thread}=seed(store,'old');
    runtime.decide=request=>[{action:'silence',sourceMessageIds:request.messages.map(m=>m.id)}];
    await coordinator.receive(message('thanks','谢谢',{replyToMessageId:original.messageId}));
    const follow=message('emoji','哈哈',{replyToMessageId:'thanks'});await coordinator.receive(follow);
    expect(store.resolveReference(follow)).toMatchObject({status:'resolved',threadId:thread.id});
    expect(runtime.workers).toHaveLength(0);expect(store.inputs(thread.id)).toHaveLength(1);
  });
  it('splits one grouped action across two quoted tasks and rebinds same-batch earlier sources',async()=>{
    const {store,runtime,coordinator,config}=fixture();config.routerBatchWindowMs=20;
    const a=seed(store,'a'),b=seed(store,'b');
    runtime.decide=request=>request.result?[{action:'publish_result',resultId:request.result.id}]:[{
      action:'open_thread',sourceMessageIds:request.messages.map(m=>m.id).reverse(),subject:'不应合并',
    }];
    await Promise.all([coordinator.receive(message('fa','继续a',{replyToMessageId:'a'})),coordinator.receive(message('fb','继续b',{replyToMessageId:'b'}))]);
    expect(store.inputs(a.thread.id).at(-1)!.message.messageId).toBe('fa');
    expect(store.inputs(b.thread.id).at(-1)!.message.messageId).toBe('fb');expect(store.threads()).toHaveLength(2);
    runtime.complete(0);runtime.complete(1);await coordinator.drain(1000);
    runtime.decide=request=>request.result?[{action:'publish_result',resultId:request.result.id}]:request.messages.map(m=>({action:'open_thread',sourceMessageIds:[m.id],subject:m.text}));
    await Promise.all([coordinator.receive(message('fresh')),coordinator.receive(message('fresh-follow','继续',{replyToMessageId:'fresh'}))]);
    expect(store.threads()).toHaveLength(3);const fresh=store.threads().find(t=>t.sourceMessageId==='fresh')!;
    expect(store.inputs(fresh.id).map(input=>input.message.messageId)).toEqual(['fresh','fresh-follow']);
    runtime.complete(2,{coveredInputSeq:2,basedOnRevision:2});await coordinator.drain(1000);
  });
  it('inherits sent control replies and transmits quoted bot text even outside recent history',async()=>{
    const {store,runtime,coordinator,publisher,config}=fixture();config.recentMessageLimit=1;
    const {thread}=seed(store,'original');const other=seed(store,'other');
    runtime.decide=request=>[{action:'request_status',sourceMessageIds:[request.messages[0].id],threadId:other.thread.id}];
    await coordinator.receive(message('status','进度',{replyToMessageId:'original'}));
    const row=store.outbox('sent').find(row=>row.id==='control:room:status')!;
    expect(row.associationThreadId).toBe(thread.id);expect(row.threadId).toBeUndefined();
    expect(publisher.messages.some(sent=>sent.dedupeKey===row.id)).toBe(true);
    const quote=message('follow','继续帮我解释',{replyToMessageId:row.platformMessageId});
    runtime.decide=request=>request.result?[{action:'publish_result',resultId:request.result.id}]:[{action:'open_thread',sourceMessageIds:[request.messages[0].id],subject:'新任务'}];
    await coordinator.receive(quote);
    expect(store.inputs(thread.id).at(-1)?.contextReplies?.[0].text).toContain('当前状态');
    expect(store.threads()).toHaveLength(2);runtime.complete(0);await coordinator.drain(1000);
  });
  it('revives a cancelled quoted task only for its owner or an administrator',async()=>{
    const {store,runtime,coordinator}=fixture();const {thread}=seed(store,'cancelled','cancelled');
    await coordinator.receive(message('outsider','继续处理',{authorId:'B',replyToMessageId:'cancelled'}));
    expect(store.thread(thread.id)?.status).toBe('cancelled');expect(runtime.workers).toHaveLength(0);expect(store.threads()).toHaveLength(1);
    await coordinator.receive(message('owner','继续处理',{replyToMessageId:'cancelled'}));
    expect(store.inputs(thread.id)).toHaveLength(2);expect(runtime.workers).toHaveLength(1);expect(store.thread(thread.id)?.epoch).toBeGreaterThan(thread.epoch);
    runtime.complete(0);await coordinator.drain(1000);
  });
});

it('splits oversized quote snapshots without retrying the identical batch or losing sources',async()=>{
 const {runtime,coordinator,config,store}=fixture();config.routerBatchWindowMs=20;
 runtime.decide=request=>{
  if(request.messages.length>2)throw Object.assign(new Error('oversized'),{code:'ROUTER_PAYLOAD_OVERSIZED'});
  return [{action:'silence',sourceMessageIds:request.messages.map(m=>m.id)}];
 };
 await Promise.all(Array.from({length:4},(_,i)=>coordinator.receive(message(`size-${i}`))));
 expect(runtime.routes.map(request=>request.messages.length)).toEqual([4,2,2]);
 expect(store.decisions().flatMap(decision=>decision.actions.flatMap((action:RouteAction)=>'sourceMessageIds'in action?action.sourceMessageIds:[]))).toEqual(['room:size-0','room:size-1','room:size-2','room:size-3']);
});
it('separates direct replies to different quoted tasks and persists each reply association',async()=>{
 const {runtime,coordinator,config,store}=fixture();config.routerBatchWindowMs=20;
 const seeds=['first','second'].map(id=>{const original=message(id);store.ingest(original);const thread=store.createThread(original,id,true);thread.status='idle';store.saveThread(thread);return thread;});
 runtime.decide=request=>[{action:'reply_direct',sourceMessageIds:request.messages.map(m=>m.id),text:'收到这条补充。'}];
 await Promise.all(seeds.map((thread,i)=>coordinator.receive(message(`direct-${i}`,'补充',{replyToMessageId:thread.sourceMessageId}))));
 const rows=store.outbox('sent');expect(rows).toHaveLength(2);
 for(const [i,row]of rows.entries())expect(row.associationThreadId).toBe(seeds[i].id);
});
it('routes a same-intake status quote only after its target has acquired a thread',async()=>{
 const {runtime,coordinator,config,store}=fixture();config.routerBatchWindowMs=20;
 runtime.decide=request=>request.result?[{action:'publish_result',resultId:request.result.id}]:request.messages[0].messageId==='origin'
  ?[{action:'open_thread',sourceMessageIds:[request.messages[0].id],subject:'原任务'}]
  :[{action:'request_status',sourceMessageIds:[request.messages[0].id],threadId:request.references![request.messages[0].id].threadId!}];
 await Promise.all([coordinator.receive(message('origin')),coordinator.receive(message('status','进度如何',{replyToMessageId:'origin'}))]);
 expect(runtime.routes).toHaveLength(2);expect(store.threads()).toHaveLength(1);
 expect(store.outbox('sent').find(row=>row.id==='control:room:status')?.associationThreadId).toBe(store.threads()[0].id);
 runtime.complete(0);await coordinator.drain(1000);
});

it('does not choose an arbitrary quoted original when platform IDs conflict',async()=>{
 const {store,runtime,coordinator}=fixture();
 store.ingest(message('first-original','第一份原文',{messageId:'collision'}));
 store.ingest(message('second-original','另一份原文',{messageId:'collision'}));
 await coordinator.receive(message('quote-collision','请解释我引用的内容',{replyToMessageId:'collision'}));
 expect(runtime.routes[0].references?.['room:quote-collision'].status).toBe('ambiguous');
 expect(runtime.workers[0].inputs[0].contextMessages).toBeUndefined();
 runtime.complete(0);await coordinator.drain(1000);
});

it.each(['STEP_LIMIT','TIMEOUT','CONTEXT_LIMIT','STRUCTURED_OUTPUT_INVALID'])('does not replay an exhausted or deterministic %s failure',async code=>{
 const {coordinator,runtime,store,publisher}=fixture();await coordinator.receive(message('failure'));
 runtime.fail(0,Object.assign(new Error('controlled failure'),{code,workerProgress:{steps:12}}));await coordinator.drain(1000);
 expect(runtime.workers).toHaveLength(1);expect(store.threads()[0]).toMatchObject({status:'failed',lastFailure:{code,steps:12,retryable:false}});
 expect(publisher.messages.some(item=>item.message.text.includes('已停止自动重试'))).toBe(true);
 const rows=store.db.prepare("SELECT data FROM telemetry WHERE kind='run_failed'").all();expect(rows).toHaveLength(1);
 expect(JSON.parse(String(rows[0].data))).toMatchObject({threadId:store.threads()[0].id,runId:runtime.workers[0].runId,code});
});
it('shares time and remaining steps across an infrastructure retry',async()=>{
 const {coordinator,runtime}=fixture();await coordinator.receive(message('retry-budget'));
 const budget=runtime.workers[0].budget!;
 runtime.fail(0,Object.assign(new Error('temporary infrastructure failure'),{workerProgress:{steps:11}}));
 await until(()=>runtime.workers.length===2,coordinator);
 expect(runtime.workers[1].budget).toEqual({remainingSteps:budget.remainingSteps-11,deadlineAt:budget.deadlineAt});
 runtime.complete(1);await coordinator.drain(1000);
});
it('still processes a newer correction after the superseded run exhausts its budget',async()=>{
 const {coordinator,runtime,store}=fixture();await coordinator.receive(message('old'));
 runtime.decide=request=>appendTo(store.threads()[0].id,request);
 await coordinator.receive(message('new','改为新的条件'));
 runtime.fail(0,Object.assign(new Error('limit'),{code:'STEP_LIMIT',workerProgress:{steps:96}}));
 await until(()=>runtime.workers.length===2,coordinator);expect(runtime.workers[1].budget?.remainingSteps).toBe(96);
 runtime.complete(1);await coordinator.drain(1000);
});
