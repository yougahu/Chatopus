import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { businessPrompt, businessRevision, DEFAULT_BUSINESS_SETTINGS, resolveBusinessProfile, validateBusinessSettings } from '../src/business-config.js';
import { businessHistory, previewBusinessSettings, readBusinessSettings, rollbackBusinessSettings, saveBusinessSettings } from '../src/admin/business-config.js';
import { AdminServer } from '../src/admin/server.js';
import { loadConfig } from '../src/config.js';

const clean: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const fn of clean.splice(0).reverse()) await fn(); });
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'business-config-')); clean.push(() => rmSync(root, { recursive: true, force: true }));
  const stateDir = join(root, 'state'); mkdirSync(join(root, 'personas'));
  writeFileSync(join(root, 'personas/default.md'), '# 通用人格\n清晰自然。');
  writeFileSync(join(root, 'config.local.json'), JSON.stringify({ concurrency: 7, memory: { namespace: 'existing-identity', fields: [{ key: 'documents.preference', label: '文档偏好', type: 'text', maxLength: 200 }] }, skills: [{ id: 'document-reader', path: './skills/reader' }], plugins: [{ module: 'fixture-module', options: { retained: true } }] }));
  return { root, stateDir };
}
function fixture() {
  const settings = structuredClone(DEFAULT_BUSINESS_SETTINGS);
  settings.profiles.documents = { name: '文档助手', commonInstructions: '依据提供的文档作答。', routerInstructions: '文档对照任务交 Worker。', workerInstructions: '给出段落依据。', skillIds: ['document-reader'], extensionIds: [], memoryFields: ['documents.preference'] };
  settings.roomProfiles['qq:1:2'] = 'documents'; return settings;
}
describe('business profiles', () => {
  it('hydrates a legacy persona for editing and saves inline content without modifying its source file', () => {
    const { root, stateDir } = setup(), file = join(root, 'config.local.json');
    const settings = fixture(); settings.profiles.documents.personaFile = 'personas/default.md';
    const initial = saveBusinessSettings(root, stateDir, { settings, revision: readBusinessSettings(root).revision });
    const source = readFileSync(join(root, 'personas/default.md'), 'utf8');
    expect(initial.settings.profiles.documents.personaText).toBe(source);
    expect(initial.revision).toBe(businessRevision(settings));
    expect(initial.personaLoadErrors).toEqual({});
    const migrated = saveBusinessSettings(root, stateDir, { settings: initial.settings, revision: initial.revision });
    expect(migrated.settings.profiles.documents.personaText).toBe(source);
    expect(migrated.settings.profiles.documents).not.toHaveProperty('personaFile');
    expect(JSON.parse(readFileSync(file, 'utf8')).business.profiles.documents).toMatchObject({ personaText: source });
    expect(readFileSync(join(root, 'personas/default.md'), 'utf8')).toBe(source);
    rmSync(join(root, 'personas/default.md'));
    const edited = structuredClone(migrated.settings); edited.profiles.documents.personaText = '# 新的正文\n简洁作答。';
    const changed = saveBusinessSettings(root, stateDir, { settings: edited, revision: migrated.revision });
    const restored = rollbackBusinessSettings(root, stateDir, { targetRevision: migrated.revision, revision: changed.revision });
    expect(restored.settings.profiles.documents.personaText).toBe(source);
    const preview = previewBusinessSettings(root, { settings: restored.settings, profileId: 'documents' });
    expect(preview.personaError).toBeUndefined(); expect(preview.router).toContain(source); expect(preview.worker).toContain(source);
  });
  it('rejects stale file hydration while allowing deliberate inline replacement', () => {
    const { root, stateDir } = setup();
    const settings = fixture(); settings.profiles.documents.personaFile = 'personas/default.md';
    const loaded = saveBusinessSettings(root, stateDir, { settings, revision: readBusinessSettings(root).revision });
    writeFileSync(join(root, 'personas/default.md'), '# 并发更改\n新的文件正文。');
    const before = readFileSync(join(root, 'config.local.json'), 'utf8'), history = businessHistory(stateDir);
    expect(() => saveBusinessSettings(root, stateDir, { settings: loaded.settings, revision: loaded.revision })).toThrow('原人格内容已变化');
    expect(readFileSync(join(root, 'config.local.json'), 'utf8')).toBe(before); expect(businessHistory(stateDir)).toEqual(history);
    delete loaded.settings.profiles.documents.personaFile;
    loaded.settings.profiles.documents.personaText = '明确填写的新正文';
    expect(saveBusinessSettings(root, stateDir, { settings: loaded.settings, revision: loaded.revision }).settings.profiles.documents.personaText).toBe('明确填写的新正文');
  });
  it('keeps unreadable legacy sources visible as errors until replaced or explicitly cleared', () => {
    const { root, stateDir } = setup(), file = join(root, 'config.local.json');
    const settings = fixture(); settings.profiles.documents.personaFile = 'personas/missing.md';
    const disk = JSON.parse(readFileSync(file, 'utf8')); writeFileSync(file, JSON.stringify({ ...disk, business: settings }));
    const current = readBusinessSettings(root);
    expect(current.personaLoadErrors.documents).toContain('原人格文件无法读取');
    expect(current.personaLoadErrors.documents).not.toContain(root);
    expect(current.settings.profiles.documents).not.toHaveProperty('personaText');
    current.settings.profiles.documents.commonInstructions = '修改其他业务内容';
    const before = readFileSync(file, 'utf8');
    expect(() => saveBusinessSettings(root, stateDir, { settings: current.settings, revision: current.revision })).toThrow('人格文件无法使用');
    expect(readFileSync(file, 'utf8')).toBe(before);
    delete current.settings.profiles.documents.personaFile;
    current.settings.profiles.documents.personaText = '';
    const saved = saveBusinessSettings(root, stateDir, { settings: current.settings, revision: current.revision });
    expect(saved.settings.profiles.documents.personaText).toBe(''); expect(saved.personaLoadErrors).toEqual({});
    expect(previewBusinessSettings(root, { settings: saved.settings, profileId: 'documents' }).worker).not.toContain('<operator-persona>');
  });
  it('validates inline text limits and previews unsaved text without saving it', () => {
    const { root, stateDir } = setup(), before = readBusinessSettings(root), settings = fixture();
    settings.profiles.documents.personaText = '🙂'.repeat(8000);
    expect(() => validateBusinessSettings(settings)).not.toThrow();
    settings.profiles.documents.personaText += '🙂';
    expect(() => saveBusinessSettings(root, stateDir, { settings, revision: before.revision })).toThrow('8000');
    settings.profiles.documents.personaText = '# 预览正文\n明快直接。';
    const preview = previewBusinessSettings(root, { settings, profileId: 'documents' });
    expect(preview.router).toContain('预览正文'); expect(preview.worker).toContain('明快直接');
    expect(readBusinessSettings(root).revision).toBe(before.revision); expect(businessHistory(stateDir)).toEqual([]);
  });
  it('stores persona only in each business and previews blank profiles without extra style', () => {
    const { root, stateDir } = setup(), file = join(root, 'config.local.json');
    const disk = JSON.parse(readFileSync(file, 'utf8')), current = readBusinessSettings(root);
    const settings = fixture(); settings.profiles.documents.personaFile = 'personas/default.md';
    const saved = saveBusinessSettings(root, stateDir, { settings, revision: current.revision });
    expect(saved.settings.profiles.documents.personaFile).toBe('personas/default.md');
    expect(saved).not.toHaveProperty('personaDefault'); expect(saved).not.toHaveProperty('personaInheritance');
    const { business: _business, ...deployment } = JSON.parse(readFileSync(file, 'utf8'));
    expect(deployment).toEqual(disk);
    const styled = previewBusinessSettings(root, { settings, profileId: 'documents' });
    const plain = previewBusinessSettings(root, { settings, profileId: 'default' });
    expect(styled.router).toContain('通用人格'); expect(styled.worker).toContain('通用人格');
    expect(plain.router).not.toContain('<operator-persona>'); expect(plain.worker).not.toContain('<operator-persona>');
    expect(plain.personaError).toBeUndefined();
  });

  it.each([false, true])('serves an empty catalogue from a clean root with example config=%s', async withExample => {
    const root = mkdtempSync(join(tmpdir(), 'public-business-')); clean.push(() => rmSync(root, { recursive: true, force: true }));
    if (withExample) writeFileSync(join(root, 'config.local.json'), readFileSync(new URL('../config.example.json', import.meta.url)));
    const config = loadConfig(root), server = new AdminServer(config, 0);
    clean.push(() => server.close());
    const address = await server.start();
    const response = await fetch(new URL('/api/business-config', address));
    expect(response.status).toBe(200);
    const result = await response.json() as ReturnType<typeof readBusinessSettings>;
    expect(result.catalog.skills).toEqual([]); expect(result.catalog.extensions).toEqual([]);
    expect(result.catalog.memoryFields.length).toBeGreaterThan(0);
    expect(result.catalog.memoryFields.every(field => field.core)).toBe(true);
    expect(Object.keys(result.settings.profiles)).toEqual(['default']);
    expect(result).not.toHaveProperty('personaDefault');
    const profile = resolveBusinessProfile(config, 'unbound-room');
    expect(profile.skillIds).toEqual([]); expect(profile.extensionIds).toEqual([]);
    expect(profile.memoryFields ?? []).toEqual([]);
    expect(businessPrompt(profile, 'router')).toBe(''); expect(businessPrompt(profile, 'worker')).toBe('');
    expect(config.business?.profiles.default.personaFile).toBeUndefined();
    expect(config.memory?.enabled).toBe(false); expect(config.qq.enabled).toBe(false);
  });

  it('defaults to empty capabilities and isolates exact room overrides and role instructions', () => {
    expect(resolveBusinessProfile({}, 'room').skillIds).toEqual([]);
    const settings = fixture(), selected = resolveBusinessProfile({ business: settings }, 'qq:1:2');
    expect(selected.id).toBe('documents'); expect(resolveBusinessProfile({ business: settings }, 'qq:1:20').id).toBe('default');
    expect(businessPrompt(selected, 'router')).toContain('文档对照'); expect(businessPrompt(selected, 'router')).not.toContain('给出段落依据');
    selected.skillIds.push('changed'); expect(settings.profiles.documents.skillIds).toEqual(['document-reader']);
    expect(businessPrompt(resolveBusinessProfile({}, ''), 'worker')).toBe('');
  });
  it('rejects unknown configuration keys, invalid bindings, duplicate references and oversized prompts', () => {
    for (const change of [
      (s: any) => { s.profiles.documents.apiKey = 'not-allowed'; },
      (s: any) => { s.roomProfiles.r = 'missing'; },
      (s: any) => { s.defaultProfile = 'missing'; },
      (s: any) => { s.profiles.documents.skillIds = ['duplicate', 'duplicate']; },
      (s: any) => { s.profiles.documents.workerInstructions = 'x'.repeat(16001); },
    ]) { const settings = fixture(); change(settings); expect(() => validateBusinessSettings(settings)).toThrow(); }
    const settings = fixture(); expect(businessRevision(settings)).toBe(businessRevision({ profiles: settings.profiles, roomProfiles: settings.roomProfiles, defaultProfile: settings.defaultProfile }));
  });
  it('describes registered capabilities without exposing paths, executable modules, options or skill bodies', () => {
    const { root, stateDir } = setup(), file = join(root, 'config.local.json');
    const disk = JSON.parse(readFileSync(file, 'utf8'));
    mkdirSync(join(root, 'skills/reader'), { recursive: true });
    writeFileSync(join(root, 'skills/reader/SKILL.md'), '---\nname: 文档阅读\ndescription: >-\n  读取并比较文档，\n  给出引用依据。\nprivate: header-secret\n---\nprivate-body-instructions');
    disk.apiKey = 'credential-secret';
    disk.extensions = [
      { id: 'document-tools', module: 'must-not-import-this-module', options: { apiKey: 'extension-secret' } },
      { id: 'disabled-tools', module: './not-loaded.js', enabled: false },
    ];
    disk.memory.fields[0].scopeKeys = ['document'];
    writeFileSync(file, JSON.stringify(disk));
    const result = readBusinessSettings(root);
    expect(result.catalog.skills).toEqual([{ id: 'document-reader', name: '文档阅读', description: '读取并比较文档， 给出引用依据。' }]);
    expect(result.catalog.extensions).toEqual([{ id: 'document-tools', enabled: true }, { id: 'disabled-tools', enabled: false }]);
    expect(result.catalog.memoryFields).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'preferredName', label: '称呼', core: true }),
      { id: 'documents.preference', label: '文档偏好', core: false, description: '记录一段文字；在启用此字段的业务中使用。' },
    ]));
    expect(result).not.toHaveProperty('personaDefault');
    const json = JSON.stringify(result);
    for (const privateValue of ['credential-secret', 'extension-secret', 'must-not-import', 'not-loaded.js', './skills/reader', 'header-secret', 'private-body-instructions']) expect(json).not.toContain(privateValue);
    const saved = saveBusinessSettings(root, stateDir, { settings: fixture(), revision: result.revision });
    expect(saved.catalog).toEqual(result.catalog);
    expect(rollbackBusinessSettings(root, stateDir, { targetRevision: result.revision, revision: saved.revision }).catalog).toEqual(result.catalog);
  });
  it('keeps the capability catalogue usable for absent, malformed or oversized skill metadata', () => {
    const { root } = setup(), file = join(root, 'config.local.json');
    const disk = JSON.parse(readFileSync(file, 'utf8'));
    const headers = {
      described: '---\nname: Friendly name\ndescription: File description\n---\nbody',
      malformed: '---\nname: [unclosed\n---\nbody',
      oversized: '---\ndescription: ' + 'x'.repeat(20_000) + '\n---\nbody',
      typed: '---\nname: [not, text]\ndescription: {unexpected: mapping}\n---\nbody',
      aliases: '---\nname: &shared name\ndescription: *shared\n---\nbody',
    };
    for (const [id, header] of Object.entries(headers)) {
      mkdirSync(join(root, id)); writeFileSync(join(root, id, 'SKILL.md'), header);
    }
    disk.skills = [
      { id: 'described', path: join(root, 'described'), description: '显式配置优先' },
      ...['missing', 'malformed', 'oversized', 'typed', 'aliases'].map(id => ({ id, path: './' + id })),
    ];
    writeFileSync(file, JSON.stringify(disk));
    expect(readBusinessSettings(root).catalog.skills).toEqual([
      { id: 'described', name: 'Friendly name', description: '显式配置优先' },
      ...['missing', 'malformed', 'oversized', 'typed', 'aliases'].map(id => ({ id })),
    ]);
  });
  it('uses bounded admin display labels without changing registered capabilities or exposing extra metadata', () => {
    const { root, stateDir } = setup(), file = join(root, 'config.local.json');
    const disk = JSON.parse(readFileSync(file, 'utf8'));
    disk.skills[0].description = 'Runtime skill description';
    disk.extensions = [{ id: 'document-tools', module: 'fixture-module', enabled: false, options: { secret: 'private-option' } }];
    writeFileSync(file, JSON.stringify(disk));
    const before = readBusinessSettings(root), runtime = loadConfig(root);
    disk.admin = { capabilityLabels: {
      skills: { 'document-reader': { name: ' 文档\n 阅读 ', description: ' 根据提供的资料\u0000 给出引用。 ', id: 'fake-id', path: 'private-path', options: { secret: 'private-label' } }, 'not-registered': { name: '不可注册能力' } },
      extensions: { 'document-tools': { name: '文档工具', description: '查找并校验文档。', enabled: true, module: 'private-module' } },
    } };
    writeFileSync(file, JSON.stringify(disk));
    const result = readBusinessSettings(root);
    expect(result.revision).toBe(before.revision);
    expect(result.catalog.skills).toEqual([{ id: 'document-reader', name: '文档 阅读', description: '根据提供的资料 给出引用。' }]);
    expect(result.catalog.extensions).toEqual([{ id: 'document-tools', enabled: false, name: '文档工具', description: '查找并校验文档。' }]);
    expect(loadConfig(root).skills).toEqual(runtime.skills); expect(loadConfig(root).extensions).toEqual(runtime.extensions);
    const saved = saveBusinessSettings(root, stateDir, { settings: fixture(), revision: result.revision });
    const after = JSON.parse(readFileSync(file, 'utf8'));
    expect(after.skills).toEqual(disk.skills); expect(after.extensions).toEqual(disk.extensions); expect(after.admin).toEqual(disk.admin);
    expect(saved.catalog).toEqual(result.catalog);
    for (const privateValue of ['fake-id', 'private-path', 'private-label', 'private-option', 'private-module', '不可注册能力']) expect(JSON.stringify(result)).not.toContain(privateValue);
  });
  it('ignores malformed admin labels and bounds valid display strings', () => {
    const { root } = setup(), file = join(root, 'config.local.json'), disk = JSON.parse(readFileSync(file, 'utf8'));
    disk.skills[0].description = 'Runtime description';
    disk.extensions = [{ id: 'document-tools', module: 'fixture-module' }];
    const expectedSkills = [{ id: 'document-reader', description: 'Runtime description' }];
    for (const capabilityLabels of [null, [], 'invalid', { skills: [], extensions: true },
      { skills: { 'document-reader': 'invalid' }, extensions: { 'document-tools': [] } },
      { skills: { 'document-reader': { name: {}, description: [] } }, extensions: { 'document-tools': { name: '  ', description: '\n' } } },
    ]) {
      disk.admin = { capabilityLabels }; writeFileSync(file, JSON.stringify(disk));
      expect(readBusinessSettings(root).catalog.skills).toEqual(expectedSkills);
      expect(readBusinessSettings(root).catalog.extensions).toEqual([{ id: 'document-tools', enabled: true }]);
    }
    disk.admin = { capabilityLabels: { skills: { 'document-reader': { name: '名'.repeat(121), description: '述'.repeat(2_001) } } } };
    writeFileSync(file, JSON.stringify(disk));
    expect(readBusinessSettings(root).catalog.skills).toEqual([{ id: 'document-reader', name: '名'.repeat(120), description: '述'.repeat(2_000) }]);
  });
  it('saves and rolls back only business settings, preserving unrelated fields and rejecting stale edits', () => {
    const { root, stateDir } = setup(), before = readBusinessSettings(root), oldDisk = JSON.parse(readFileSync(join(root, 'config.local.json'), 'utf8'));
    const result = saveBusinessSettings(root, stateDir, { settings: fixture(), revision: before.revision });
    expect(result.saved).toBe(true); expect(result.revision).not.toBe(before.revision);
    expect(JSON.parse(readFileSync(join(root, 'config.local.json'), 'utf8'))).toMatchObject(oldDisk);
    expect(() => saveBusinessSettings(root, stateDir, { settings: fixture(), revision: before.revision })).toThrow('已被更新');
    expect(businessHistory(stateDir)).toHaveLength(2);
    const restored = rollbackBusinessSettings(root, stateDir, { targetRevision: before.revision, revision: result.revision });
    expect(restored.settings).toEqual(DEFAULT_BUSINESS_SETTINGS); expect(restored.revision).toBe(before.revision);
    expect(() => rollbackBusinessSettings(root, stateDir, { targetRevision: '../config.local', revision: restored.revision })).toThrow();
  });
  it('rejects unregistered or disabled capabilities before saving or previewing', () => {
    const { root, stateDir } = setup(), current = readBusinessSettings(root), settings = fixture();
    settings.profiles.documents.extensionIds = ['missing'];
    expect(() => saveBusinessSettings(root, stateDir, { settings, revision: current.revision })).toThrow('扩展未注册');
    settings.profiles.documents.extensionIds = []; settings.profiles.documents.skillIds = ['missing'];
    expect(() => previewBusinessSettings(root, { settings })).toThrow('未注册的 Skill');
    expect(readBusinessSettings(root).revision).toBe(current.revision);
  });
  it('rejects unusable explicit persona files without modifying configuration or history', () => {
    const { root, stateDir } = setup(), file = join(root, 'config.local.json'), before = readFileSync(file, 'utf8');
    writeFileSync(join(root, 'personas/empty.md'), '  \n');
    writeFileSync(join(root, 'personas/oversized.md'), 'x'.repeat(8_001));
    const current = readBusinessSettings(root);
    for (const personaFile of ['personas/missing.md', 'personas/empty.md', 'personas/oversized.md', 'personas']) {
      const settings = fixture(); settings.profiles.documents.personaFile = personaFile;
      expect(() => saveBusinessSettings(root, stateDir, { settings, revision: current.revision })).toThrow('业务“文档助手”（documents）的人格文件无法使用');
      expect(readFileSync(file, 'utf8')).toBe(before);
      expect(businessHistory(stateDir)).toEqual([]);
    }
    const settings = fixture(); settings.profiles.documents.personaFile = 'personas/missing.md';
    expect(previewBusinessSettings(root, { settings, profileId: 'documents' }).personaError).toContain('人格文件不可用');
  });
  it('saves optional business personas and validates configured files again on rollback', () => {
    const { root, stateDir } = setup(), file = join(root, 'config.local.json');
    const plain = saveBusinessSettings(root, stateDir, { settings: fixture(), revision: readBusinessSettings(root).revision });
    const settings = fixture(); settings.profiles.documents.personaFile = 'personas/default.md';
    const explicit = saveBusinessSettings(root, stateDir, { settings, revision: plain.revision });
    expect(explicit.settings.profiles.documents.personaFile).toBe('personas/default.md');
    const restored = rollbackBusinessSettings(root, stateDir, { targetRevision: plain.revision, revision: explicit.revision });
    expect(restored.settings.profiles.documents.personaFile).toBeUndefined();
    rmSync(join(root, 'personas/default.md'));
    const before = readFileSync(file, 'utf8');
    expect(() => rollbackBusinessSettings(root, stateDir, { targetRevision: explicit.revision, revision: restored.revision })).toThrow('业务“文档助手”（documents）的人格文件无法使用');
    expect(readFileSync(file, 'utf8')).toBe(before);
  });
  it('previews unsaved role prompts and persona without changing files or invoking a model', () => {
    const { root } = setup(), before = readFileSync(join(root, 'config.local.json'), 'utf8');
    const settings = fixture(); settings.profiles.documents.personaFile = 'personas/default.md';
    const preview = previewBusinessSettings(root, { settings, roomId: 'qq:1:2' });
    expect(preview.profileId).toBe('documents'); expect(preview.router).toContain('文档对照任务'); expect(preview.worker).toContain('给出段落依据');
    expect(preview.worker).toContain('通用人格'); expect(preview.worker).toContain('QQ纯文本');
    expect(preview.router).not.toContain('给出段落依据'); expect(readFileSync(join(root, 'config.local.json'), 'utf8')).toBe(before);
  });
  it('exposes read, preview, save and history endpoints with same-origin and revision checks', async () => {
    const { root, stateDir } = setup(); const server = new AdminServer(loadConfig(root, { stateDir }), 0); const url = await server.start(); clean.push(() => server.close());
    const current = await (await fetch(url + '/api/business-config')).json();
    const post = (path: string, body: unknown) => fetch(url + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const preview = await post('/api/business-config/preview', { settings: fixture(), profileId: 'documents' }); expect(preview.status).toBe(200);
    expect((await post('/api/business-config', { settings: fixture(), revision: current.revision })).status).toBe(200);
    expect((await post('/api/business-config', { settings: fixture(), revision: current.revision })).status).toBe(409);
    expect(await (await fetch(url + '/api/business-config/history')).json()).toHaveLength(2);
    expect((await fetch(url + '/api/business-config', { headers: { Origin: 'https://foreign.invalid' } })).status).toBe(403);
    expect((await fetch(url + '/api/business-config', { method: 'POST', body: '{}' })).status).toBe(415);
  });
});
