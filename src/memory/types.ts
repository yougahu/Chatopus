import { z } from 'zod';

/** Core keys describe conversation preferences; business fields are configured separately. */
export const MEMBER_MEMORY_KEYS = [
  'preferredName', 'language', 'responseDetail', 'formatPreference', 'terminology',
  'interests', 'experience', 'learningGoals',
] as const;
const forbiddenKeys = new Set(['__proto__', 'prototype', 'constructor', 'systemPrompt', 'apiKey', 'permissions', 'command']);
export const memberMemoryKeySchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,79}$/)
  .refine(key => !forbiddenKeys.has(key), 'Reserved member field');
export type MemberMemoryKey = string;
export type MemberMemoryValue = string | string[];
export const MAX_MEMBER_MEMORY_FIELDS = 64;

const text = (max: number) => z.string().trim().min(1).max(max)
  .refine(value => !/[\u0000-\u001f\u007f]/u.test(value), 'Member values must be single-line text');
export const memberMemoryIdSchema = text(256);
export const memberMemoryOrderSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const memberMemoryTimeSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
/** Scope dimensions are opaque host-supplied identifiers, never model-selected identities. */
export const memberMemoryScopeSchema = z.record(memberMemoryKeySchema, text(120))
  .refine(scope => Object.keys(scope).length > 0 && Object.keys(scope).length <= 8, 'Memory scope requires 1 to 8 dimensions');
export type MemberMemoryScope = z.infer<typeof memberMemoryScopeSchema>;

export const memoryFieldDefinitionSchema = z.object({
  key: memberMemoryKeySchema, label: text(80),
  type: z.enum(['text', 'text-list', 'text-or-list']),
  maxLength: z.number().int().min(1).max(400),
  scopeKeys: z.array(memberMemoryKeySchema).max(8).optional(),
}).strict().refine(value => !value.scopeKeys || new Set(value.scopeKeys).size === value.scopeKeys.length, 'Duplicate scope dimension');
export type MemoryFieldDefinition = z.infer<typeof memoryFieldDefinitionSchema>;
export const CORE_MEMORY_FIELDS: readonly MemoryFieldDefinition[] = [
  {key:'preferredName',label:'称呼',type:'text',maxLength:80},
  {key:'language',label:'语言',type:'text',maxLength:80},
  {key:'responseDetail',label:'回答详略',type:'text',maxLength:120},
  {key:'formatPreference',label:'输出格式',type:'text',maxLength:200},
  {key:'terminology',label:'术语偏好',type:'text',maxLength:250},
  {key:'interests',label:'兴趣',type:'text-or-list',maxLength:400},
  {key:'experience',label:'经验',type:'text',maxLength:400},
  {key:'learningGoals',label:'学习目标',type:'text-or-list',maxLength:400},
];
export function validateMemoryFieldDefinitions(value: unknown): asserts value is MemoryFieldDefinition[] {
  const fields = z.array(memoryFieldDefinitionSchema).max(MAX_MEMBER_MEMORY_FIELDS - CORE_MEMORY_FIELDS.length).parse(value);
  const keys = new Set<string>(MEMBER_MEMORY_KEYS);
  for (const field of fields) {
    if (keys.has(field.key)) throw new Error('Duplicate or reserved memory field: ' + field.key);
    keys.add(field.key);
  }
}
export function isValidMemoryFieldValue(definition:MemoryFieldDefinition,value:MemberMemoryValue):boolean {
  if (Array.isArray(value)) return definition.type !== 'text' && value.length >= 1 && value.length <= 8
    && value.every(item => typeof item === 'string' && item.length <= Math.min(120,definition.maxLength));
  return definition.type !== 'text-list' && typeof value === 'string' && value.length <= definition.maxLength;
}
const list = z.array(text(120)).min(1).max(8)
  .refine(values => new Set(values).size === values.length, 'Duplicate member values');
const genericValue = z.union([text(400), list]);

/** Persisted unknown fields remain readable; writes are checked against the active registry. */
export function isValidMemberMemoryValue(key: MemberMemoryKey, value: MemberMemoryValue): boolean {
  const definition = CORE_MEMORY_FIELDS.find(field => field.key === key);
  return !definition || isValidMemoryFieldValue(definition,value);
}

export const memberMemoryChangeSchema = z.discriminatedUnion('op', [
  z.object({ key: memberMemoryKeySchema, op: z.literal('set'), value: genericValue }).strict(),
  z.object({ key: memberMemoryKeySchema, op: z.literal('clear') }).strict(),
]).superRefine((change, ctx) => {
  if (change.op === 'set' && !isValidMemberMemoryValue(change.key, change.value))
    ctx.addIssue({ code: 'custom', path: ['value'], message: 'Invalid value type or length for member field' });
});
export const memberMemoryUpdateSchema = z.object({
  kind: z.literal('member'), sourceMessageId: memberMemoryIdSchema,
  changes: z.array(memberMemoryChangeSchema).min(1).max(MAX_MEMBER_MEMORY_FIELDS),
}).strict().superRefine((update, ctx) => {
  if (new Set(update.changes.map(change => change.key)).size !== update.changes.length)
    ctx.addIssue({ code: 'custom', path: ['changes'], message: 'Each member field may change once per source update' });
});
export type MemberMemoryUpdate = z.infer<typeof memberMemoryUpdateSchema>;
export type MemberMemoryChange = z.infer<typeof memberMemoryChangeSchema>;

const fieldMetadata = {
  sourceMessageId: memberMemoryIdSchema, sourceOrder: memberMemoryOrderSchema,
  scope: memberMemoryScopeSchema.optional(), expiresAt: memberMemoryTimeSchema.optional(),
  updatedAt: memberMemoryTimeSchema,
};
export const memberMemoryFieldSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('set'), value: genericValue, ...fieldMetadata }).strict(),
  z.object({ state: z.literal('cleared'), ...fieldMetadata }).strict(),
]);
export type MemberMemoryField = z.infer<typeof memberMemoryFieldSchema>;
export const memberMemoryDocumentSchema = z.object({
  schemaVersion: z.literal(1), memberId: memberMemoryIdSchema,
  revision: memberMemoryOrderSchema, commitId: memberMemoryIdSchema,
  updatedAt: memberMemoryTimeSchema,
  fields: z.record(memberMemoryKeySchema, memberMemoryFieldSchema).refine(fields => Object.keys(fields).length <= MAX_MEMBER_MEMORY_FIELDS, 'Too many member fields'),
}).strict().superRefine((document, ctx) => {
  for (const key of Object.keys(document.fields)) {
    const field = document.fields[key];
    if (field?.state === 'set' && !isValidMemberMemoryValue(key, field.value))
      ctx.addIssue({ code: 'custom', path: ['fields', key, 'value'], message: 'Invalid value type or length for member field' });
  }
});
export type MemberMemoryDocument = z.infer<typeof memberMemoryDocumentSchema>;

/** The host supplies the real author and durable arrival order, not quoted/referenced messages. */
export interface MemberMemorySource {
  id: string;
  memberId: string;
  sourceOrder: number;
  scope?: MemberMemoryScope;
  expiresAt?: number;
}
export type BoundMemberMemoryUpdate = MemberMemoryUpdate & {
  memberId: string;
  sourceOrder: number;
  scope?: MemberMemoryScope;
  expiresAt?: number;
};
