import { z } from 'zod';
import {
  CORE_MEMORY_FIELDS, isValidMemoryFieldValue, memberMemoryKeySchema, memberMemoryDocumentSchema, memberMemoryIdSchema, memberMemoryOrderSchema,
  memberMemoryScopeSchema, memberMemoryTimeSchema, memberMemoryUpdateSchema,
  type BoundMemberMemoryUpdate, type MemberMemoryDocument, type MemberMemoryField,
  type MemberMemoryKey, type MemberMemoryScope, type MemberMemorySource, type MemoryFieldDefinition,
} from './types.js';

const sourceSchema = z.object({
  id: memberMemoryIdSchema, memberId: memberMemoryIdSchema, sourceOrder: memberMemoryOrderSchema,
  scope: memberMemoryScopeSchema.optional(), expiresAt: memberMemoryTimeSchema.optional(),
}).strict();

export interface MemberMemoryBindingContext {
  actionSourceMessageIds: readonly string[];
  messages: readonly MemberMemorySource[];
  expectedMemberId?: string;
}

/** Identity validation cannot establish whether prose is a quotation, joke, or lasting preference. */
export function bindMemberMemoryUpdates(updates: unknown, context: MemberMemoryBindingContext): BoundMemberMemoryUpdate[] {
  const parsed = z.array(memberMemoryUpdateSchema).max(20).parse(updates);
  const actionIds = new Set(context.actionSourceMessageIds.map(id => memberMemoryIdSchema.parse(id)));
  const expectedMemberId = context.expectedMemberId === undefined ? undefined : memberMemoryIdSchema.parse(context.expectedMemberId);
  const sources = new Map<string, MemberMemorySource>();
  const orders = new Map<number, string>();
  for (const raw of context.messages) {
    const source = sourceSchema.parse(raw);
    if (sources.has(source.id)) throw new Error('Duplicate host memory source');
    if (orders.has(source.sourceOrder)) throw new Error('Ambiguous host memory source order');
    sources.set(source.id, source); orders.set(source.sourceOrder, source.id);
  }
  const result: BoundMemberMemoryUpdate[] = [];
  const seen = new Map<string, string>();
  for (const update of parsed) {
    const source = sources.get(update.sourceMessageId);
    if (!source || !actionIds.has(source.id)) throw new Error('Memory source is outside the current action');
    if (expectedMemberId !== undefined && source.memberId !== expectedMemberId)
      throw new Error('Memory source belongs to another member');
    const changes = update.changes.filter(change => {
      const id = JSON.stringify([source.id, change.key]);
      const fingerprint = JSON.stringify(change);
      if (seen.has(id)) {
        if (seen.get(id) !== fingerprint) throw new Error('Conflicting changes for one source and member field');
        return false;
      }
      seen.set(id, fingerprint); return true;
    });
    if (changes.length) result.push({ ...update, changes, memberId: source.memberId, sourceOrder: source.sourceOrder,
      ...(source.scope ? { scope: source.scope } : {}), ...(source.expiresAt !== undefined ? { expiresAt: source.expiresAt } : {}) });
  }
  return result.sort((a, b) => a.sourceOrder - b.sourceOrder);
}

export interface MemberMemoryMaterialization {
  document: MemberMemoryDocument;
  changed: boolean;
  changedKeys: MemberMemoryKey[];
  appliedSourceMessageIds: string[];
}

function fieldIdentity(field: MemberMemoryField): string {
  return JSON.stringify([
    field.state, field.state === 'set' ? field.value : null, field.sourceMessageId,
    field.sourceOrder, field.scope ? Object.entries(field.scope).sort(([a],[b]) => a.localeCompare(b)) : null, field.expiresAt ?? null,
  ]);
}

/** Pure whole-document update. Storage CAS and durable confirmation belong to the host. */
export function materializeMemberMemory(
  current: MemberMemoryDocument | null,
  updates: readonly BoundMemberMemoryUpdate[],
  options: { memberId: string; commitId: string; now: number; definitions?: readonly MemoryFieldDefinition[] },
): MemberMemoryMaterialization {
  const memberId = memberMemoryIdSchema.parse(options.memberId);
  const commitId = memberMemoryIdSchema.parse(options.commitId);
  const now = memberMemoryTimeSchema.parse(options.now);
  const document = current === null ? {
    schemaVersion: 1 as const, memberId, revision: 0, commitId, updatedAt: now, fields: {},
  } : memberMemoryDocumentSchema.parse(current);
  if (document.memberId !== memberId) throw new Error('Member document belongs to another member');

  // Validate the complete batch before modifying the cloned document.
  const sources: MemberMemorySource[] = [];
  const sourceById = new Map<string, MemberMemorySource>();
  for (const update of updates) {
    const source = sourceSchema.parse({ id: update.sourceMessageId, memberId: update.memberId,
      sourceOrder: update.sourceOrder, scope: update.scope, expiresAt: update.expiresAt });
    const existing = sourceById.get(source.id);
    if (existing && JSON.stringify(existing) !== JSON.stringify(source)) throw new Error('Conflicting host memory source');
    if (!existing) { sourceById.set(source.id, source); sources.push(source); }
  }
  const bound = bindMemberMemoryUpdates(updates.map(({ kind, sourceMessageId, changes }) => ({ kind, sourceMessageId, changes })), {
    actionSourceMessageIds: sources.map(source => source.id), messages: sources, expectedMemberId: memberId,
  });
  const definitions = new Map((options.definitions ?? CORE_MEMORY_FIELDS).map(field => [field.key,field]));
  for (const update of bound) for (const change of update.changes) {
    const definition = definitions.get(change.key);
    if (!definition) throw new Error('Unregistered member field: ' + change.key);
    if (change.op === 'set' && !isValidMemoryFieldValue(definition,change.value)) throw new Error('Invalid value for member field: ' + change.key);
    if (definition.scopeKeys && update.scope && Object.keys(update.scope).some(key => !definition.scopeKeys!.includes(key)))
      throw new Error('Unregistered scope dimension for member field: ' + change.key);
  }
  const fields: MemberMemoryDocument['fields'] = { ...document.fields };
  const changedKeys = new Set<MemberMemoryKey>();
  const appliedSourceMessageIds = new Set<string>();
  for (const update of bound) {
    for (const change of update.changes) {
      const old = fields[change.key];
      const next: MemberMemoryField = {
        ...(change.op === 'set' ? { state: 'set' as const, value: change.value } : { state: 'cleared' as const }),
        sourceMessageId: update.sourceMessageId, sourceOrder: update.sourceOrder, updatedAt: now,
        ...(update.scope ? { scope: update.scope } : {}),
        ...(update.expiresAt !== undefined ? { expiresAt: update.expiresAt } : {}),
      };
      if (old && old.sourceOrder > next.sourceOrder) continue;
      if (old && old.sourceOrder === next.sourceOrder) {
        if (fieldIdentity(old) !== fieldIdentity(next)) throw new Error('Conflicting member field at the same source order');
        continue;
      }
      fields[change.key] = next; changedKeys.add(change.key); appliedSourceMessageIds.add(update.sourceMessageId);
    }
  }
  if (!changedKeys.size) return { document, changed: false, changedKeys: [], appliedSourceMessageIds: [] };
  if (document.commitId === commitId && current !== null) throw new Error('Committed memory intent cannot be changed');
  const nextDocument = memberMemoryDocumentSchema.parse({ ...document, fields, revision: document.revision + 1, commitId, updatedAt: now });
  return { document: nextDocument, changed: true, changedKeys: [...changedKeys], appliedSourceMessageIds: [...appliedSourceMessageIds] };
}

const DEFAULT_PROJECTION_KEYS: readonly MemberMemoryKey[] = ['preferredName', 'language', 'responseDetail', 'formatPreference', 'terminology'];
export type ProjectedMemberMemoryField =
  | { state: 'set'; value: string | string[]; scope?: MemberMemoryScope; expiresAt?: number }
  | { state: 'cleared' | 'expired' | 'out_of_scope' };
export interface MemberMemoryProjection {
  memberId: string;
  revision: number;
  fields: Partial<Record<MemberMemoryKey, ProjectedMemberMemoryField>>;
  omittedKeys: MemberMemoryKey[];
}

/** Inactive values are explicit, so previous session text cannot silently restore them. */
export function projectMemberMemory(
  raw: MemberMemoryDocument,
  options: { now: number; relevantKeys?: readonly MemberMemoryKey[]; scope?: MemberMemoryScope; maxChars?: number; definitions?: readonly MemoryFieldDefinition[] },
): MemberMemoryProjection {
  const document = memberMemoryDocumentSchema.parse(raw);
  const now = memberMemoryTimeSchema.parse(options.now);
  const scope = options.scope === undefined ? undefined : memberMemoryScopeSchema.parse(options.scope);
  const maxChars = z.number().int().min(0).max(64_000).parse(options.maxChars ?? 1200);
  const definitions = new Map((options.definitions ?? CORE_MEMORY_FIELDS).map(field => [field.key,field]));
  const requested = new Set<MemberMemoryKey>([...DEFAULT_PROJECTION_KEYS.filter(key => definitions.has(key)), ...(options.relevantKeys ?? [])]);
  for (const key of requested) if (!definitions.has(memberMemoryKeySchema.parse(key))) throw new Error('Unknown member projection key');
  const fields: MemberMemoryProjection['fields'] = {};
  const omittedKeys: MemberMemoryKey[] = [];
  const active: Array<[MemberMemoryKey, Extract<ProjectedMemberMemoryField, { state: 'set' }>]> = [];
  for (const key of definitions.keys()) {
    if (!requested.has(key)) continue;
    const field = document.fields[key];
    if (!field) continue;
    if (field.state === 'cleared') fields[key] = { state: 'cleared' };
    else if (field.expiresAt !== undefined && field.expiresAt <= now) fields[key] = { state: 'expired' };
    else if (field.scope && Object.entries(field.scope).some(([dimension,value]) => scope?.[dimension] !== value)) fields[key] = { state: 'out_of_scope' };
    else if (!isValidMemoryFieldValue(definitions.get(key)!,field.value)) continue;
    else active.push([key, { state: 'set', value: field.value,
      ...(field.scope ? { scope: field.scope } : {}), ...(field.expiresAt !== undefined ? { expiresAt: field.expiresAt } : {}) }]);
  }
  // The budget covers the fields JSON. Small invalidation markers are mandatory even at zero budget.
  for (const [key, value] of active) {
    const candidate = { ...fields, [key]: value };
    if (JSON.stringify(candidate).length > maxChars) omittedKeys.push(key);
    else fields[key] = value;
  }
  return { memberId: document.memberId, revision: document.revision, fields, omittedKeys };
}
