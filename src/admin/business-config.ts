import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { parse } from 'yaml';
import { businessPrompt, businessRevision, DEFAULT_BUSINESS_SETTINGS, resolveBusinessProfile, validateBusinessSettings, type BusinessSettings } from '../business-config.js';
import { CORE_MEMORY_FIELDS, type MemoryFieldDefinition } from '../memory/types.js';
import { loadPersona, loadPersonaFile, MAX_PERSONA_CHARACTERS } from '../persona.js';
import { ROUTER_PROMPT, WORKER_PROMPT } from '../protocol.js';
import { QQ_TEXT_FORMAT } from '../platform/text-format.js';

export class BusinessConfigError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}
function readDisk(root: string): Record<string, unknown> {
  const file = join(root, 'config.local.json');
  const disk = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  if (!disk || typeof disk !== 'object' || Array.isArray(disk)) throw new BusinessConfigError('配置文件必须是对象。');
  return disk;
}
function settingsFrom(disk: Record<string, unknown>): BusinessSettings {
  const settings = disk.business ?? DEFAULT_BUSINESS_SETTINGS;
  validateBusinessSettings(settings); return structuredClone(settings);
}
function validateReferences(settings: BusinessSettings, disk: Record<string, any>) {
  const skills = new Set((disk.skills ?? []).map((item: any) => item.id));
  const extensions = new Set((disk.extensions ?? []).filter((item: any) => item.enabled !== false).map((item: any) => item.id));
  const fields = new Set([...CORE_MEMORY_FIELDS, ...(disk.memory?.fields ?? [])].map((item: any) => item.key));
  for (const profile of Object.values(settings.profiles)) {
    for (const id of profile.skillIds) if (!skills.has(id)) throw new BusinessConfigError('未注册的 Skill ID：' + id);
    for (const id of profile.extensionIds) if (!extensions.has(id)) throw new BusinessConfigError('扩展未注册或已停用：' + id);
    for (const id of profile.memoryFields ?? []) if (!fields.has(id)) throw new BusinessConfigError('未注册的成员字段：' + id);
  }
}
function validateBusinessPersonas(root: string, settings: BusinessSettings) {
  for (const [id, profile] of Object.entries(settings.profiles)) {
    if (profile.personaText !== undefined || !profile.personaFile) continue;
    try { loadPersonaFile(root, profile.personaFile); }
    catch { throw new BusinessConfigError('业务“' + profile.name + '”（' + id + '）的人格文件无法使用。请直接填写替代正文或明确清空人格；正文最多 ' + MAX_PERSONA_CHARACTERS.toLocaleString('zh-CN') + ' 个字符。'); }
  }
}
function catalogText(value: unknown, limit: number): string | undefined {
  return typeof value === 'string' ? value.replace(/[\s\u0000-\u001f\u007f]+/gu, ' ').trim().slice(0, limit) : undefined;
}
function skillMetadata(root: string, path: unknown): { name?: string; description?: string } {
  if (typeof path !== 'string') return {};
  let descriptor: number | undefined;
  try {
    const directory = path.startsWith('~/') ? join(homedir(), path.slice(2)) : resolve(root, path);
    descriptor = openSync(join(directory, 'SKILL.md'), 'r');
    if (!fstatSync(descriptor).isFile()) return {};
    // The catalogue needs only a small frontmatter header, never full skill instructions.
    const buffer = Buffer.alloc(16_384), length = readSync(descriptor, buffer, 0, buffer.length, 0);
    const header = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(buffer.toString('utf8', 0, length));
    if (!header) return {};
    const value: unknown = parse(header[1], { maxAliasCount: 0 });
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const metadata = value as Record<string, unknown>;
    return { name: catalogText(metadata.name, 120), description: catalogText(metadata.description, 2_000) };
  } catch { return {}; }
  finally { if (descriptor !== undefined) closeSync(descriptor); }
}
function capabilityLabel(disk: Record<string, any>, kind: 'skills' | 'extensions', id: string): { name?: string; description?: string } {
  const labels = disk.admin?.capabilityLabels?.[kind];
  if (!labels || typeof labels !== 'object' || Array.isArray(labels) || !Object.hasOwn(labels, id)) return {};
  const label = labels[id];
  if (!label || typeof label !== 'object' || Array.isArray(label)) return {};
  const name = catalogText(label.name, 120), description = catalogText(label.description, 2_000);
  return { ...(name ? { name } : {}), ...(description ? { description } : {}) };
}
function capabilityCatalog(root: string, disk: Record<string, any>) {
  const skills = (disk.skills ?? []).map((skill: any) => {
    const metadata = skillMetadata(root, skill.path);
    return { id: skill.id, ...metadata, description: catalogText(skill.description, 2_000) ?? metadata.description,
      ...capabilityLabel(disk, 'skills', skill.id) };
  });
  // Use only registry metadata: importing an extension just to describe it would execute code.
  const extensions = (disk.extensions ?? []).map((extension: any) => ({ id: extension.id, enabled: extension.enabled !== false,
    ...capabilityLabel(disk, 'extensions', extension.id) }));
  const describeField = (field: MemoryFieldDefinition, core: boolean) => ({
    id: field.key, label: field.label, core,
    description: (field.type === 'text-list' ? '记录多项内容' : field.type === 'text-or-list' ? '记录一段文字或多项内容' : '记录一段文字')
      + (core ? '；所有业务默认可用。' : '；在启用此字段的业务中使用。'),
  });
  return { skills, extensions, memoryFields: [
    ...CORE_MEMORY_FIELDS.map(field => describeField(field, true)),
    ...(disk.memory?.fields ?? []).map((field: MemoryFieldDefinition) => describeField(field, false)),
  ] };
}
export function readBusinessSettings(root: string) {
  const disk = readDisk(root), settings = settingsFrom(disk);
  // Keep the optimistic concurrency token tied to persisted settings. Hydration
  // is read-only; saving the returned text explicitly migrates a legacy file.
  const revision = businessRevision(settings), personaLoadErrors: Record<string, string> = {};
  for (const [id, profile] of Object.entries(settings.profiles)) {
    if (profile.personaText !== undefined || !profile.personaFile) continue;
    try { profile.personaText = loadPersonaFile(root, profile.personaFile)!.content; }
    catch { personaLoadErrors[id] = '原人格文件无法读取或内容无效。请直接填写替代正文，或明确清空人格；未处理前不会覆盖原配置。'; }
  }
  return { settings, revision, appliesTo: 'new-calls', catalog: capabilityCatalog(root, disk), personaLoadErrors };
}
function atomicWrite(file: string, value: unknown) {
  const temporary = file + '.' + randomUUID() + '.tmp';
  try { writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); renameSync(temporary, file); }
  finally { if (existsSync(temporary)) unlinkSync(temporary); }
}
function historyDirectory(stateDir: string) { return join(stateDir, 'business-config-history'); }
function preserve(stateDir: string, settings: BusinessSettings) {
  const dir = historyDirectory(stateDir); mkdirSync(dir, { recursive: true, mode: 0o700 });
  const revision = businessRevision(settings), file = join(dir, revision + '.json');
  if (!existsSync(file)) atomicWrite(file, { revision, savedAt: Date.now(), settings });
}
export function saveBusinessSettings(root: string, stateDir: string, value: unknown) {
  const input = value as { settings?: unknown; revision?: unknown };
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['settings', 'revision'].includes(key))) throw new BusinessConfigError('业务配置请求无效。');
  validateBusinessSettings(input.settings);
  const settings = structuredClone(input.settings);
  const disk = readDisk(root), previous = settingsFrom(disk);
  validateReferences(settings, disk);
  if (input.revision !== businessRevision(previous)) throw new BusinessConfigError('业务配置已被更新，请刷新后再保存。', 409);
  for (const [id, profile] of Object.entries(settings.profiles)) {
    if (profile.personaText === undefined) continue;
    // An untouched editor sends both the hydrated text and its legacy source.
    // Reject a stale hydration instead of overwriting a concurrent file edit.
    // A deliberate text replacement drops personaFile in the editor.
    if (profile.personaFile && previous.profiles[id]?.personaText === undefined && previous.profiles[id]?.personaFile === profile.personaFile) {
      let current: string | undefined;
      try { current = loadPersonaFile(root, profile.personaFile)?.content; } catch { /* Report a revision conflict without exposing the source path. */ }
      if (current !== profile.personaText) throw new BusinessConfigError('原人格内容已变化或无法读取，请刷新后再保存；也可明确填写新的正文。', 409);
    }
    delete profile.personaFile;
  }
  validateBusinessPersonas(root, settings);
  // Both history and live configuration are bounded settings only: no credentials are copied.
  preserve(stateDir, previous); preserve(stateDir, settings);
  atomicWrite(join(root, 'config.local.json'), { ...disk, business: settings });
  return { saved: true, ...readBusinessSettings(root) };
}
export function businessHistory(stateDir: string) {
  const dir = historyDirectory(stateDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(name => /^[a-f0-9]{64}\.json$/.test(name)).map(name => {
    const value = JSON.parse(readFileSync(join(dir, name), 'utf8'));
    validateBusinessSettings(value.settings);
    if (value.revision !== businessRevision(value.settings)) throw new BusinessConfigError('业务配置历史校验失败。');
    return { revision: value.revision, savedAt: value.savedAt, profiles: Object.values(value.settings.profiles).map((profile: any) => profile.name) };
  }).sort((a, b) => b.savedAt - a.savedAt).slice(0, 100);
}
export function rollbackBusinessSettings(root: string, stateDir: string, input: unknown) {
  const value = input as { targetRevision?: unknown; revision?: unknown };
  if (!value || Object.keys(value).some(key => !['targetRevision', 'revision'].includes(key)) || typeof value.targetRevision !== 'string' || !/^[a-f0-9]{64}$/.test(value.targetRevision)) throw new BusinessConfigError('无效的历史版本。');
  const file = join(historyDirectory(stateDir), value.targetRevision + '.json');
  if (!existsSync(file)) throw new BusinessConfigError('找不到该历史版本。', 404);
  const target = JSON.parse(readFileSync(file, 'utf8'));
  validateBusinessSettings(target.settings);
  if (businessRevision(target.settings) !== value.targetRevision) throw new BusinessConfigError('业务配置历史校验失败。');
  return saveBusinessSettings(root, stateDir, { settings: target.settings, revision: value.revision });
}
export function previewBusinessSettings(root: string, value: unknown) {
  const input = value as { settings?: unknown; roomId?: unknown; profileId?: unknown };
  if (!input || typeof input !== 'object' || Object.keys(input).some(key => !['settings', 'roomId', 'profileId'].includes(key))) throw new BusinessConfigError('预览请求无效。');
  validateBusinessSettings(input.settings);
  if (input.roomId !== undefined && (typeof input.roomId !== 'string' || input.roomId.length > 256)) throw new BusinessConfigError('无效的群作用域。');
  const roomId = String(input.roomId ?? '');
  validateReferences(input.settings, readDisk(root));
  const business = structuredClone(input.settings);
  if (input.profileId !== undefined) {
    if (typeof input.profileId !== 'string' || !Object.hasOwn(business.profiles, input.profileId)) throw new BusinessConfigError('业务配置不存在。');
    business.defaultProfile = input.profileId; business.roomProfiles = {};
  }
  const profile = resolveBusinessProfile({ business }, roomId);
  let persona = '', personaError: string | undefined;
  try { persona = loadPersona({ root, business }, roomId)?.prompt ?? ''; } catch { personaError = '原人格文件不可用，请直接填写替代正文或清空人格。'; }
  const channel = !roomId || roomId.startsWith('qq:') ? QQ_TEXT_FORMAT : '';
  return { profileId: profile.id, revision: businessRevision(input.settings),
    router: [ROUTER_PROMPT, channel, businessPrompt(profile, 'router'), persona].filter(Boolean).join('\n\n'),
    worker: [WORKER_PROMPT, channel, businessPrompt(profile, 'worker'), persona].filter(Boolean).join('\n\n'),
    skillIds: profile.skillIds, extensionIds: profile.extensionIds, memoryFields: profile.memoryFields ?? [], personaError,
    note: '预览包含基础规则、渠道格式、业务指引和人格；当前称呼、成员字段、工具说明及任务上下文在实际调用时按配置注入。' };
}
