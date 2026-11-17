import { describe, expect, it } from 'vitest';
import { enforceReferenceThreads, parseRoutes, parseRoutesForRequest, validateRouteActions } from '../src/protocol.js';
import { enforceExplicitActivation } from '../src/activation.js';
import type { GroupMessage, MessageRouteAction, RouterRequest, ThreadCard } from '../src/types.js';
import type { MemberMemoryUpdate } from '../src/memory/types.js';

const message = (id: string, authorId = 'alice'): GroupMessage => ({
  id, authorId, authorName: authorId, roomId: 'room', platform: 'replay', messageId: id,
  text: '@bot 以后叫我阿明，并分析这套方案', timestamp: 1, mentions: ['bot'], attachments: [], isMentioned: true, isAdmin: false,
});
const memory = (sourceMessageId = 'm1'): MemberMemoryUpdate => ({ kind: 'member', sourceMessageId, changes: [{ key: 'preferredName', op: 'set', value: '阿明' }] });
const thread = (id: string): ThreadCard => ({
  id, roomId: 'room', subject: 'Document', ownerId: 'alice', sourceMessageId: 'old', explicit: true, participants: ['alice', 'bob'],
  status: 'idle', revision: 1, latestInputSeq: 1, sessionId: `worker-${id}`, epoch: 1, summary: 'Original task',
});
const request = (overrides: Partial<RouterRequest> = {}): RouterRequest => ({
  roomId: 'room', event: 'messages', messages: [message('m1')], recentMessages: [], threads: [], memoryAvailable: true, ...overrides,
});
const mixed = (overrides: Partial<Extract<MessageRouteAction, { action: 'open_thread' }>> = {}): MessageRouteAction => ({
  action: 'open_thread', sourceMessageIds: ['m1'], subject: 'Analyze document', acknowledgement: '我来看看。', memoryUpdates: [memory()], ...overrides,
});

describe('member memory routing protocol', () => {
  it('preserves an attached update on the single primary mixed action', () => {
    expect(parseRoutesForRequest(JSON.stringify([mixed()]), request())).toEqual([mixed()]);
    expect(() => parseRoutesForRequest(JSON.stringify([mixed(), { action: 'reply_direct', sourceMessageIds: ['m1'], text: '已记住', memoryUpdates: [memory()] }]), request())).toThrow('duplicate source');
  });

  it('splits reference-bound actions without copying another source memory update', () => {
    const input = request({ messages: [message('m1'), message('m2', 'bob'), message('m3')], threads: [thread('t1'), thread('t2')], references: {
      m1: { status: 'resolved', threadId: 't1', chain: [] }, m2: { status: 'resolved', threadId: 't2', chain: [] },
    } });
    const original = mixed({ sourceMessageIds: ['m1', 'm2', 'm3'], memoryUpdates: [memory('m1'), memory('m2')] });
    const before = structuredClone(original);
    const actions = enforceReferenceThreads(parseRoutes(JSON.stringify([original])), input);
    expect(actions).toHaveLength(3);
    expect(actions[0]).toMatchObject({ action: 'append_thread', threadId: 't1', sourceMessageIds: ['m1'], memoryUpdates: [memory('m1')] });
    expect(actions[1]).toMatchObject({ action: 'append_thread', threadId: 't2', sourceMessageIds: ['m2'], memoryUpdates: [memory('m2')] });
    expect(actions[2]).toMatchObject({ action: 'open_thread', sourceMessageIds: ['m3'] });
    expect(actions[2]).not.toHaveProperty('memoryUpdates');
    expect(() => validateRouteActions(actions, input)).not.toThrow();
    expect(original).toEqual(before);
  });

  it('rejects memory updates on silence and result/timer actions', () => {
    for (const action of [
      { action: 'silence', sourceMessageIds: ['m1'], memoryUpdates: [memory()] },
      { action: 'publish_result', resultId: 'r1', memoryUpdates: [memory()] },
      { action: 'defer_result', resultId: 'r1', delayMs: 100, memoryUpdates: [memory()] },
    ]) expect(() => parseRoutes(JSON.stringify([action]))).toThrow();
    for (const event of ['worker_result', 'timer'] as const) {
      expect(() => parseRoutesForRequest(JSON.stringify([mixed()]), request({ event, messages: [] }))).toThrow('Invalid result decision');
    }
  });

  it('rejects updates when memory is unavailable or not advertised', () => {
    for (const memoryAvailable of [false, undefined]) expect(() => parseRoutesForRequest(JSON.stringify([mixed()]), request({ memoryAvailable }))).toThrow('unavailable');
    expect(() => parseRoutesForRequest(JSON.stringify([{ action: 'reply_direct', sourceMessageIds: ['m1'], text: '当前无法保存长期设置。' }]), request({ memoryAvailable: false }))).not.toThrow();
  });

  it('rejects an update whose source belongs to another action before reference splitting can drop it', () => {
    const input = request({ messages: [message('m1'), message('m2', 'bob')] });
    const actions = [mixed({ memoryUpdates: [memory('m2')] }), { action: 'silence', sourceMessageIds: ['m2'] }];
    expect(() => parseRoutesForRequest(JSON.stringify(actions), input)).toThrow('Memory source outside current action');
  });

  it('rejects historical and foreign-room sources rather than treating them as current authors', () => {
    expect(() => parseRoutesForRequest(JSON.stringify([mixed({ memoryUpdates: [memory('historical')] })]), request({ recentMessages: [message('historical', 'bob')] }))).toThrow('Memory source outside current action');
    expect(() => parseRoutesForRequest(JSON.stringify([mixed()]), request({ messages: [{ ...message('m1'), roomId: 'other-room' }] }))).toThrow('Memory source outside current action');
  });

  it('rejects repeated source proposals and model-chosen member identity', () => {
    expect(() => parseRoutesForRequest(JSON.stringify([mixed({ memoryUpdates: [memory(), memory()] })]), request())).toThrow('Repeated member memory source');
    const forged = { ...memory(), memberId: 'bob' };
    expect(() => parseRoutesForRequest(JSON.stringify([{ ...mixed(), memoryUpdates: [forged] }]), request())).toThrow();
  });

  it('removes updates attached to unactivated sources when trimming a mixed action', () => {
    const input = request({ messages: [message('m1'), { ...message('m2', 'bob'), text: '群友闲聊', isMentioned: false, mentions: [] }] });
    const original = mixed({ sourceMessageIds: ['m1', 'm2'], memoryUpdates: [memory('m1'), memory('m2')] });
    const actions = enforceExplicitActivation([original], input.messages, ['bot']);
    expect(actions).toHaveLength(2);
    expect(actions[0]).toMatchObject({ sourceMessageIds: ['m1'], memoryUpdates: [memory('m1')] });
    expect(actions[1]).toMatchObject({ action: 'silence', sourceMessageIds: ['m2'] });
    expect(actions[1]).not.toHaveProperty('memoryUpdates');
    expect(() => validateRouteActions(actions, input)).not.toThrow();
    expect(original.memoryUpdates).toHaveLength(2);
  });

  it('omits the update property when activation removed every proposed memory source', () => {
    const input = request({ messages: [message('m1'), { ...message('m2'), text: '闲聊', isMentioned: false, mentions: [] }] });
    const actions = enforceExplicitActivation([mixed({ sourceMessageIds: ['m1', 'm2'], memoryUpdates: [memory('m2')] })], input.messages, ['bot']);
    expect(actions[0]).not.toHaveProperty('memoryUpdates');
    expect(() => validateRouteActions(actions, input)).not.toThrow();
  });
});
