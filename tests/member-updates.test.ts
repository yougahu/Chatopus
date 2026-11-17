import { describe, expect, it } from 'vitest';
import {
  MEMBER_MEMORY_KEYS, memberMemoryDocumentSchema, memberMemoryUpdateSchema,
  type MemberMemoryDocument, type MemberMemorySource, type MemberMemoryUpdate,
} from '../src/memory/types.js';
import { bindMemberMemoryUpdates, materializeMemberMemory, projectMemberMemory } from '../src/memory/member-updates.js';

const source = (id: string, sourceOrder: number, memberId = 'alice'): MemberMemorySource => ({ id, sourceOrder, memberId });
const update = (sourceMessageId: string, changes: MemberMemoryUpdate['changes']): MemberMemoryUpdate => ({ kind: 'member', sourceMessageId, changes });
const name = (id: string, value: string) => update(id, [{ key: 'preferredName', op: 'set', value }]);
function apply(current: MemberMemoryDocument | null, changes: MemberMemoryUpdate[], messages: MemberMemorySource[], commitId = 'c1', now = 100) {
  const bound = bindMemberMemoryUpdates(changes, { actionSourceMessageIds: messages.map(message => message.id), messages });
  return materializeMemberMemory(current, bound, { memberId: 'alice', commitId, now });
}

describe('member memory proposal schema', () => {
  it('accepts the full field whitelist while constraining scalar and list values', () => {
    for (const key of MEMBER_MEMORY_KEYS) expect(memberMemoryUpdateSchema.safeParse(update('m1', [{ key, op: 'set', value: 'explicit value' }])).success).toBe(true);
    expect(memberMemoryUpdateSchema.parse(update('m1', [{ key: 'interests', op: 'set', value: ['文档', '写作'] }])).changes[0]).toMatchObject({ value: ['文档', '写作'] });
    expect(memberMemoryUpdateSchema.safeParse(update('m1', [{ key: 'preferredName', op: 'set', value: ['alice'] }])).success).toBe(false);
    expect(memberMemoryUpdateSchema.safeParse(name('m1', 'x'.repeat(81))).success).toBe(false);
    expect(memberMemoryUpdateSchema.safeParse(name('m1', '  ')).success).toBe(false);
    expect(memberMemoryUpdateSchema.safeParse(name('m1', 'alice\nnew instruction')).success).toBe(false);
  });

  it('rejects arbitrary system keys, commands, target identities and clear values', () => {
    expect(memberMemoryUpdateSchema.safeParse({ ...name('m1', 'A'), memberId: 'bob' }).success).toBe(false);
    expect(memberMemoryUpdateSchema.safeParse({ ...name('m1', 'A'), command: 'execute' }).success).toBe(false);
    expect(memberMemoryUpdateSchema.safeParse({ kind: 'member', sourceMessageId: 'm1', changes: [{ key: 'systemPrompt', op: 'set', value: 'override' }] }).success).toBe(false);
    expect(memberMemoryUpdateSchema.safeParse({ kind: 'member', sourceMessageId: 'm1', changes: [{ key: 'language', op: 'clear', value: 'zh' }] }).success).toBe(false);
    expect(memberMemoryUpdateSchema.safeParse(update('m1', [{ key: 'language', op: 'clear' }])).success).toBe(true);
  });

  it('rejects repeated fields inside a proposal and duplicate list items', () => {
    expect(memberMemoryUpdateSchema.safeParse(update('m1', [{ key: 'language', op: 'clear' }, { key: 'language', op: 'set', value: 'zh' }])).success).toBe(false);
    expect(memberMemoryUpdateSchema.safeParse(update('m1', [{ key: 'interests', op: 'set', value: ['文档', '文档'] }])).success).toBe(false);
  });
});

describe('binding member memory to host sources', () => {
  it('requires a current action source, even when a referenced source is available', () => {
    expect(() => bindMemberMemoryUpdates([name('quoted', 'A')], {
      actionSourceMessageIds: ['current'], messages: [source('current', 2), source('quoted', 1, 'bob')],
    })).toThrow('outside the current action');
    expect(() => bindMemberMemoryUpdates([name('missing', 'A')], { actionSourceMessageIds: ['missing'], messages: [] })).toThrow('outside the current action');
  });

  it('binds real source authors and rejects cross-member materialization', () => {
    const messages = [source('a', 1), source('b', 2, 'bob')];
    const bound = bindMemberMemoryUpdates([name('b', 'B'), name('a', 'A')], { actionSourceMessageIds: ['a', 'b'], messages });
    expect(bound.map(item => item.memberId)).toEqual(['alice', 'bob']);
    expect(() => bindMemberMemoryUpdates([name('b', 'B')], { actionSourceMessageIds: ['b'], messages, expectedMemberId: 'alice' })).toThrow('another member');
    expect(() => materializeMemberMemory(null, bound, { memberId: 'alice', commitId: 'c1', now: 100 })).toThrow('another member');
  });

  it('deduplicates identical source changes and refuses conflicting duplicate proposals', () => {
    const context = { actionSourceMessageIds: ['a'], messages: [source('a', 1)] };
    expect(bindMemberMemoryUpdates([name('a', 'A'), name('a', 'A')], context)).toHaveLength(1);
    expect(() => bindMemberMemoryUpdates([name('a', 'A'), name('a', 'B')], context)).toThrow('Conflicting changes');
    expect(() => bindMemberMemoryUpdates([name('a', 'A'), update('a', [{ key: 'preferredName', op: 'clear' }])], context)).toThrow('Conflicting changes');
  });

  it('rejects ambiguous host ordering and duplicated host source records', () => {
    expect(() => bindMemberMemoryUpdates([name('a', 'A')], { actionSourceMessageIds: ['a'], messages: [source('a', 1), source('b', 1)] })).toThrow('Ambiguous');
    expect(() => bindMemberMemoryUpdates([name('a', 'A')], { actionSourceMessageIds: ['a'], messages: [source('a', 1), source('a', 2)] })).toThrow('Duplicate host');
  });
});

describe('materializing member documents', () => {
  it('uses host order despite reversed model order and advances one document revision', () => {
    const result = apply(null, [name('new', 'New'), name('old', 'Old'), update('new', [{ key: 'language', op: 'set', value: '中文' }])], [source('old', 1), source('new', 2)]);
    expect(result.document.revision).toBe(1);
    expect(result.document.fields.preferredName).toMatchObject({ state: 'set', value: 'New', sourceMessageId: 'new', sourceOrder: 2 });
    expect(result.document.fields.language).toMatchObject({ value: '中文', sourceOrder: 2 });
    expect(result.changedKeys).toEqual(['preferredName', 'language']);
    expect(result.appliedSourceMessageIds).toEqual(['old', 'new']);
  });

  it('makes retries no-ops and prevents older sources overwriting fields', () => {
    const initial = apply(null, [name('new', 'New')], [source('new', 4)]).document;
    const retry = apply(initial, [name('new', 'New')], [source('new', 4)], 'another-attempt', 200);
    expect(retry.changed).toBe(false);
    expect(retry.document).toEqual(initial);
    expect(apply(initial, [name('old', 'Old')], [source('old', 1)], 'c2').document).toEqual(initial);
    expect(() => apply(initial, [name('new', 'Changed')], [source('new', 4)], 'c2')).toThrow('same source order');
    expect(() => apply(initial, [name('other', 'Changed')], [source('other', 4)], 'c2')).toThrow('same source order');
  });

  it('does not mutate the current document when any update conflicts', () => {
    const initial = apply(null, [name('m1', 'A')], [source('m1', 2)]).document;
    const before = JSON.stringify(initial);
    expect(() => apply(initial, [update('old', [{ key: 'language', op: 'set', value: '中文' }]), name('m1', 'B')], [source('old', 1), source('m1', 2)], 'c2')).toThrow();
    expect(JSON.stringify(initial)).toBe(before);
    expect(initial.fields.language).toBeUndefined();
  });

  it('prevents changing the content of an already used commit identity', () => {
    const initial = apply(null, [name('m1', 'A')], [source('m1', 1)]).document;
    expect(() => apply(initial, [name('m2', 'B')], [source('m2', 2)], 'c1')).toThrow('intent cannot be changed');
  });

  it('clears every current field through ordinary changes and prevents resurrection', () => {
    const initial = apply(null, [name('m1', 'A'), update('m1', [{ key: 'language', op: 'set', value: '中文' }])], [source('m1', 1)]).document;
    const cleared = apply(initial, [update('m2', Object.keys(initial.fields).map(key => ({ key: key as keyof typeof initial.fields, op: 'clear' as const })))], [source('m2', 2)], 'c2', 200).document;
    expect(cleared.revision).toBe(2);
    expect(cleared.fields.preferredName).toEqual({ state: 'cleared', sourceMessageId: 'm2', sourceOrder: 2, updatedAt: 200 });
    expect(cleared.fields.language?.state).toBe('cleared');
    expect(apply(cleared, [name('m1', 'A')], [source('m1', 1)], 'c3').changed).toBe(false);
    expect(apply(cleared, [name('m3', 'New')], [source('m3', 3)], 'c3').document.fields.preferredName).toMatchObject({ state: 'set', value: 'New' });
  });

  it('validates persisted documents and cross-member identity before merging', () => {
    const initial = apply(null, [name('m1', 'A')], [source('m1', 1)]).document;
    expect(() => apply({ ...initial, memberId: 'bob' }, [], [], 'c2')).toThrow('another member');
    expect(memberMemoryDocumentSchema.safeParse({ ...initial, fields: { systemPrompt: initial.fields.preferredName } }).success).toBe(false);
    expect(memberMemoryDocumentSchema.safeParse({ ...initial, fields: { preferredName: { ...initial.fields.preferredName, state: 'cleared' } } }).success).toBe(false);
  });
});

describe('projecting current member memory', () => {
  it('automatically includes only expression fields and includes other fields when relevant', () => {
    const document = apply(null, [name('m1', 'A'), update('m1', [{ key: 'interests', op: 'set', value: ['文档'] }])], [source('m1', 1)]).document;
    expect(projectMemberMemory(document, { now: 100 }).fields).toEqual({ preferredName: { state: 'set', value: 'A' } });
    expect(projectMemberMemory(document, { now: 100, relevantKeys: ['interests'] }).fields.interests).toEqual({ state: 'set', value: ['文档'] });
  });

  it('exposes expiry and mismatched scopes without leaking the old value', () => {
    const document = apply(null, [name('m1', 'Scoped'), update('m2', [{ key: 'language', op: 'set', value: '中文' }])], [
      { ...source('m1', 1), scope: { project: 'P1', document: 'D1' } }, { ...source('m2', 2), expiresAt: 200 },
    ]).document;
    expect(projectMemberMemory(document, { now: 200 }).fields).toEqual({ preferredName: { state: 'out_of_scope' }, language: { state: 'expired' } });
    const valid = projectMemberMemory(document, { now: 199, scope: { project: 'P1', document: 'D1' } });
    expect(valid.fields.preferredName).toMatchObject({ state: 'set', value: 'Scoped' });
    expect(valid.fields.language).toMatchObject({ state: 'set', value: '中文', expiresAt: 200 });
  });

  it('preserves cleared markers at tiny budgets and omits whole active fields', () => {
    const document = apply(null, [update('m1', [{ key: 'preferredName', op: 'clear' }, { key: 'language', op: 'set', value: '中文' }])], [{ ...source('m1', 1), expiresAt: 50 }]).document;
    expect(projectMemberMemory(document, { now: 100, maxChars: 0 }).fields).toEqual({ preferredName: { state: 'cleared' }, language: { state: 'expired' } });
    const active = apply(null, [name('m1', 'A')], [source('m1', 1)]).document;
    expect(projectMemberMemory(active, { now: 100, maxChars: 0 })).toMatchObject({ fields: {}, omittedKeys: ['preferredName'] });
  });
});
