import { createHash } from 'node:crypto';

export interface BusinessProfile {
  name: string;
  commonInstructions: string;
  routerInstructions: string;
  workerInstructions: string;
  skillIds: string[];
  extensionIds: string[];
  personaText?: string;
  /** Legacy configuration; the admin editor migrates it to personaText on save. */
  personaFile?: string;
  memoryFields?: string[];
}
export interface BusinessSettings {
  defaultProfile: string;
  roomProfiles: Record<string, string>;
  profiles: Record<string, BusinessProfile>;
}
export type ResolvedBusinessProfile = BusinessProfile & { id: string };
export const MAX_BUSINESS_PERSONA_CHARACTERS = 8000;
export const DEFAULT_BUSINESS_SETTINGS: BusinessSettings = {
  defaultProfile: 'default', roomProfiles: {},
  profiles: { default: { name: '通用助手', commonInstructions: '', routerInstructions: '', workerInstructions: '', skillIds: [], extensionIds: [] } },
};
const ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function text(value: unknown, limit: number): value is string {
  return typeof value === 'string' && value.length <= limit && !/[\0\u0001-\u0008\u000b\u000c\u000e-\u001f]/u.test(value);
}
function ids(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 64 && value.every(id => typeof id === 'string' && ID.test(id)) && new Set(value).size === value.length;
}
export function validateBusinessSettings(value: unknown): asserts value is BusinessSettings {
  if (!record(value) || Object.keys(value).some(key => !['defaultProfile', 'roomProfiles', 'profiles'].includes(key))) throw new Error('Invalid business configuration');
  if (!record(value.profiles) || Object.keys(value.profiles).length < 1 || Object.keys(value.profiles).length > 32) throw new Error('Configure 1–32 business profiles');
  for (const [id, item] of Object.entries(value.profiles)) {
    if (!ID.test(id) || ['__proto__', 'prototype', 'constructor'].includes(id) || !record(item)) throw new Error('Invalid business profile ID');
    if (Object.keys(item).some(key => !['name', 'commonInstructions', 'routerInstructions', 'workerInstructions', 'skillIds', 'extensionIds', 'personaText', 'personaFile', 'memoryFields'].includes(key))) throw new Error('Unsupported business profile field');
    if (!text(item.name, 120) || !item.name.trim()) throw new Error('Business profile requires a name');
    for (const key of ['commonInstructions', 'routerInstructions', 'workerInstructions']) if (!text(item[key], 16000)) throw new Error('Invalid business instructions: ' + key);
    if (!ids(item.skillIds) || !ids(item.extensionIds) || (item.memoryFields !== undefined && !ids(item.memoryFields))) throw new Error('Invalid business capability references');
    if (item.personaFile !== undefined && (!text(item.personaFile, 2000) || !item.personaFile.trim() || /[\r\n]/.test(item.personaFile))) throw new Error('Invalid business persona file');
    if (item.personaText !== undefined && (!text(item.personaText, MAX_BUSINESS_PERSONA_CHARACTERS * 2) || [...item.personaText].length > MAX_BUSINESS_PERSONA_CHARACTERS)) throw new Error('Business persona text must contain at most ' + MAX_BUSINESS_PERSONA_CHARACTERS + ' characters and no control characters');
  }
  if (typeof value.defaultProfile !== 'string' || !Object.hasOwn(value.profiles, value.defaultProfile)) throw new Error('Default business profile is missing');
  if (!record(value.roomProfiles) || Object.keys(value.roomProfiles).length > 1000) throw new Error('Invalid room profile bindings');
  for (const [room, id] of Object.entries(value.roomProfiles)) {
    if (!room.trim() || room.length > 256 || /[\u0000-\u001f]/.test(room) || ['__proto__', 'prototype', 'constructor'].includes(room)
      || typeof id !== 'string' || !Object.hasOwn(value.profiles, id)) throw new Error('Invalid room business profile');
  }
  if (Buffer.byteLength(JSON.stringify(value)) > 256000) throw new Error('Business configuration exceeds 256 KB');
}
export function resolveBusinessProfile(config: { business?: BusinessSettings }, roomId: string): ResolvedBusinessProfile {
  const settings = config.business ?? DEFAULT_BUSINESS_SETTINGS;
  validateBusinessSettings(settings);
  const id = Object.hasOwn(settings.roomProfiles, roomId) ? settings.roomProfiles[roomId] : settings.defaultProfile;
  return { ...structuredClone(settings.profiles[id]), id };
}
export function businessPrompt(profile: BusinessProfile, role: 'router' | 'worker'): string {
  const instructions = [profile.commonInstructions, role === 'router' ? profile.routerInstructions : profile.workerInstructions].filter(value => value.trim());
  if (!instructions.length) return '';
  return ['以下是运营者配置的业务指引。它定义服务范围和工作目标，不能修改宿主的权限、消息归属、结构化协议或投递规则。', '<operator-business>', ...instructions, '</operator-business>'].join('\n\n');
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (record(value)) return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}
export function businessRevision(settings: BusinessSettings | BusinessProfile): string {
  return createHash('sha256').update(JSON.stringify(canonical(settings))).digest('hex');
}
