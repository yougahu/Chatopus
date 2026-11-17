import { describe, expect, it } from 'vitest';
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createContext, runInContext } from 'node:vm';
import { parseHTML } from 'linkedom';
import { readBusinessSettings } from '../src/admin/business-config.js';

const script = readFileSync(new URL('../src/admin/app.js', import.meta.url), 'utf8').replace(/initialize\(\); setInterval\([\s\S]*$/, '');
const html = readFileSync(new URL('../src/admin/index.html', import.meta.url), 'utf8');
function profile(name: string) { return { name, commonInstructions: '', routerInstructions: '', workerInstructions: '', skillIds: [], extensionIds: [] }; }
type ApiResult = { ok: boolean; value: any };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function settle() { for (let index = 0; index < 12; index++) await Promise.resolve(); }
function setup(respond?: (path: string, body: any) => ApiResult | undefined | Promise<ApiResult | undefined>) {
  const { document, Event, window } = parseHTML(html), calls: Array<{ path: string; body: any }> = [];
  const settings = { defaultProfile: 'default', roomProfiles: {}, profiles: { default: profile('通用'), documents: profile('文档') } };
  let persistedSettings = structuredClone(settings);
  const catalog = {
    skills: [{ id: 'reader', name: '资料读取', description: '读取任务资料。' }, { id: 'writer', name: '文档写作', description: '生成文档。' }],
    extensions: [{ id: 'document-tools', enabled: true }],
    memoryFields: [{ id: 'preferred_language', label: '语言偏好', description: '通用成员偏好。', core: true }, { id: 'document_format', label: '文档格式', description: '记录领域偏好。', core: false }],
  };
  // Install browser semantics on prototypes so controls created by every rerender also work.
  Object.defineProperty(window.HTMLSelectElement.prototype, 'value', {
    configurable: true,
    get() { return this.querySelector('option[selected]')?.getAttribute('value') ?? this.querySelector('option')?.getAttribute('value') ?? ''; },
    set(value) { for (const option of this.querySelectorAll('option')) { if (option.getAttribute('value') === value) option.setAttribute('selected', ''); else option.removeAttribute('selected'); } },
  });
  const checkedStates = new WeakMap<object, boolean>();
  Object.defineProperty(window.HTMLInputElement.prototype, 'checked', {
    configurable: true,
    get() { return checkedStates.get(this) ?? this.hasAttribute('checked'); },
    set(value) { checkedStates.set(this, Boolean(value)); },
  });
  Object.assign(window.HTMLElement.prototype, {
    showModal(this: any) { this.open = true; this.setAttribute('open', ''); },
    close(this: any) { this.open = false; this.removeAttribute('open'); this.dispatchEvent(new Event('close')); },
    scrollIntoView() {},
    focus() {},
  });
  window.matchMedia = () => ({ matches: false }) as any;
  const sandbox = createContext({ document, window, location: { search: '' }, URL, URLSearchParams, AbortController, structuredClone, console, setTimeout, clearTimeout,
    fetch: async (path: string, options: any) => {
      const body = options?.body ? JSON.parse(options.body) : undefined; calls.push({ path, body });
      const defaultValue = path.startsWith('/api/business-config') ? { settings: body?.settings ?? persistedSettings, catalog, revision: 'new-revision', saved: true } : [];
      const result = await respond?.(path, body) ?? { ok: true, value: defaultValue };
      if (result.ok && path === '/api/business-config' && body?.settings) persistedSettings = structuredClone(result.value.settings);
      return { ok: result.ok, status: result.ok ? 200 : 409, text: async () => JSON.stringify(result.value) };
    },
  });
  runInContext(script, sandbox);
  runInContext(`view = 'business'; businessState = ${JSON.stringify({ settings, catalog, revision: 'old-revision', selected: 'default' })}; document.getElementById('content').innerHTML = businessPage();`, sandbox);
  const input = (id: string) => document.getElementById(id) as any;
  const dispatch = (element: any, type: string) => element.dispatchEvent(new Event(type, { bubbles: true, cancelable: true }));
  const change = (id: string, value: string) => { input(id).value = value; dispatch(input(id), 'change'); };
  const edit = (id: string, value: string) => { input(id).value = value; dispatch(input(id), 'input'); };
  const click = (selector: string) => dispatch(document.querySelector(selector), 'click');
  const submit = (selector: string) => dispatch(document.querySelector(selector), 'submit');
  return { document, Event, window, calls, sandbox, input, change, edit, click, submit,
    run: (code: string) => runInContext(code, sandbox), save: () => runInContext("saveBusiness(document.querySelector('[data-business-config]'))", sandbox) };
}

describe('business settings UI', () => {
  it('edits only the selected business persona and clears it without inheritance', async () => {
    const app = setup();
    app.click('[data-business-tab="memory"]');
    const pane = app.document.querySelector('#business-pane-memory')!;
    expect(pane.hasAttribute('hidden')).toBe(false);
    expect(pane.textContent).toContain('业务专属人格');
    expect(pane.textContent).toContain('留空时不加载额外人格');
    for (const text of ['全局默认', '群专属人格', '继承来源']) expect(pane.textContent).not.toContain(text);
    expect(app.document.querySelectorAll('#business-persona')).toHaveLength(1);
    expect(app.input('business-persona').tagName).toBe('TEXTAREA');
    expect(pane.textContent).not.toContain('人格文件路径');
    app.edit('business-persona', '# 简洁风格\n先给结论，再说明依据。'); await app.save();
    const saved = app.calls.find(call => call.path === '/api/business-config' && call.body)!;
    expect(Object.keys(saved.body).sort()).toEqual(['revision', 'settings']);
    expect(saved.body.settings.profiles.default.personaText).toBe('# 简洁风格\n先给结论，再说明依据。');
    expect(saved.body.settings.profiles.default.personaFile).toBeUndefined();
    expect(saved.body.settings.profiles.documents.personaText).toBeUndefined();
    app.edit('business-persona', ''); await app.save();
    expect(app.run('businessState.settings.profiles.default.personaText')).toBe('');
    expect(app.run('businessState.settings.profiles.default.personaFile')).toBeUndefined();
  });

  it('shows hydrated legacy content without a path editor or a navigation-only dirty state', () => {
    const app = setup();
    app.run(`businessState.settings.profiles.default.personaFile = 'personas/legacy.md'; businessState.settings.profiles.default.personaText = ${JSON.stringify('# 现有人格\n简洁地回答。')}; businessState.baseline = JSON.stringify(businessState.settings); document.getElementById('content').innerHTML = businessPage();`);
    expect(app.input('business-persona').value).toBe('# 现有人格\n简洁地回答。');
    expect(app.document.querySelector('.business-persona-section')!.textContent).not.toContain('personas/legacy.md');
    app.click('[data-business-tab="memory"]'); app.change('business-selected', 'documents'); app.change('business-selected', 'default');
    expect(app.run('businessState.dirty')).toBe(false);
    app.edit('business-persona', '新的表达风格'); app.run('collectBusinessDraft()');
    expect(app.run('businessState.settings.profiles.default.personaText')).toBe('新的表达风格');
    expect(app.run('businessState.settings.profiles.default.personaFile')).toBeUndefined();
  });

  it('preserves a failed legacy reference on unrelated edits until explicitly replaced or cleared', async () => {
    const app = setup();
    app.run(`businessState.settings.profiles.default.personaFile = 'personas/missing.md'; businessState.personaLoadErrors = {default:'人格内容读取失败'}; businessState.baseline = JSON.stringify(businessState.settings); document.getElementById('content').innerHTML = businessPage();`);
    expect(app.document.querySelector('[data-business-persona-error]')!.textContent).toContain('人格内容读取失败');
    app.edit('business-common', '无关业务修改'); app.change('business-selected', 'documents'); app.change('business-selected', 'default');
    expect(app.run('businessState.settings.profiles.default.personaFile')).toBe('personas/missing.md');
    expect(app.run('businessState.settings.profiles.default.personaText')).toBeUndefined();
    app.click('[data-business-persona-clear]'); await app.save();
    const saved = app.calls.find(call => call.body?.settings)!;
    expect(saved.body.settings.profiles.default.personaText).toBe('');
    expect(saved.body.settings.profiles.default.personaFile).toBeUndefined();
    expect(app.document.querySelector('[data-business-persona-error]')).toBeNull();
  });

  it('escapes persona Markdown and keeps its text across profile and page changes', async () => {
    const app = setup(); const value = '# 自定义人格\n保留多行内容，简洁作答。';
    app.edit('business-persona', value); app.change('business-selected', 'documents'); app.change('business-selected', 'default');
    expect(app.input('business-persona').value).toBe(value); expect(app.document.querySelector('img')).toBeNull();
    app.click('nav [data-view="threads"]'); await settle(); app.click('nav [data-view="business"]'); await settle();
    expect(app.input('business-persona').value).toBe(value); expect(app.document.querySelector('img')).toBeNull();
    await app.save(); expect(app.calls.find(call => call.body?.settings)!.body.settings.profiles.default.personaText).toBe(value);
    app.run(`businessState.settings.profiles.default.personaText = '</textarea><img src=x onerror=evil()>'; document.getElementById('content').innerHTML = businessPage();`);
    expect(app.document.querySelector('img')).toBeNull(); expect(app.input('business-persona').innerHTML).toContain('&lt;/textarea&gt;');
  });

  it('counts persona Unicode characters and prevents oversized drafts from being submitted', async () => {
    const app = setup(); app.edit('business-persona', '😀'.repeat(8000));
    expect(app.document.querySelector('[data-business-count="business-persona"]')!.textContent).toBe('8,000 / 8,000');
    await app.save(); expect(app.calls.filter(call => call.body?.settings)).toHaveLength(1);
    app.edit('business-persona', '😀'.repeat(8001)); await app.save();
    expect(app.calls.filter(call => call.body?.settings)).toHaveLength(1);
    expect(app.run('businessState.tab')).toBe('memory');
    expect(app.document.querySelector('.business-savebar .form-message')!.textContent).toContain('8,000');
    expect(app.input('business-persona').value).toBe('😀'.repeat(8001));
  });

  it('keeps the model page focused on models and counts only configured extra plugins', () => {
    const app = setup();
    app.run(`document.getElementById('content').innerHTML = configPage({plugins:[]}, {});`);
    const pluginCard = app.document.querySelector('.plugins-card')!;
    expect(pluginCard.querySelector('.count-chip')!.textContent).toBe('0');
    expect(pluginCard.textContent).toContain('尚未配置额外插件');
    expect(pluginCard.querySelectorAll('.plugin-item')).toHaveLength(0);
    expect([...app.document.querySelectorAll('#content h2')].some(node => node.textContent!.includes('人格'))).toBe(false);
    expect(app.document.querySelector('[data-view="config"]')!.textContent).toContain('模型 · 插件');
    app.run(`document.getElementById('content').innerHTML = configPage({plugins:[{module:'./support-tools.js',scope:'both',enabled:false}]}, {});`);
    expect(app.document.querySelector('.plugins-card .count-chip')!.textContent).toBe('1');
    expect(app.document.querySelector('.plugins-card .plugin-item')!.textContent).toContain('support-tools.js');
    expect(app.document.querySelector('.plugins-card .plugin-item')!.textContent).toContain('已停用');
  });

  it.each([false, true])('renders the real clean deployment catalogue with example config=%s', withExample => {
    const root = mkdtempSync(join(tmpdir(), 'public-admin-'));
    try {
      if (withExample) copyFileSync(new URL('../config.example.json', import.meta.url), join(root, 'config.local.json'));
      const state = readBusinessSettings(root), app = setup();
      app.run(`businessState = ${JSON.stringify({ ...state, selected: state.settings.defaultProfile })}; document.getElementById('content').innerHTML = businessPage();`);
      expect(app.document.querySelectorAll('[data-business-capability]')).toHaveLength(0);
      expect(app.document.querySelectorAll('.business-empty')).toHaveLength(4);
      expect(app.input('business-selected').querySelectorAll('option')).toHaveLength(1);
      expect(app.input('business-persona').value).toBe('');
      expect(app.document.querySelector('#business-pane-memory')!.textContent).toContain('留空时不加载额外人格');
      expect(app.document.querySelectorAll('.business-core-fields span').length).toBeGreaterThan(0);
      for (const field of ['business-common', 'business-router', 'business-worker', 'business-skills', 'business-extensions', 'business-memory']) {
        expect(app.input(field).value, field).toBe('');
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('opens creation from the actual button and creates an explicitly unsaved profile through submit', async () => {
    const app = setup(); app.click('[data-business-add]');
    expect(app.input('business-create-dialog').open).toBe(true);
    app.edit('business-new-name', '客户支持'); app.edit('business-new-id', 'support'); app.change('business-copy-source', '');
    app.submit('[data-business-create]');
    expect(app.input('business-create-dialog')?.open ?? false).toBe(false);
    expect(app.run('businessState.selected')).toBe('support');
    expect(app.input('business-name').value).toBe('客户支持');
    expect(app.run('businessState.settings.profiles.support')).toMatchObject({ commonInstructions: '', routerInstructions: '', workerInstructions: '', skillIds: [], extensionIds: [] });
    expect(app.run('businessState.dirty')).toBe(true);
    expect(app.document.querySelector('[data-business-config]')!.textContent).toContain('未保存');
    expect(app.calls).toHaveLength(0);
    await app.save(); await app.run('render()');
    expect(app.run('businessState.settings.profiles.support.name')).toBe('客户支持');
    expect(app.run('businessState.dirty ?? false')).toBe(false);
  });

  it.each(['', 'default', '__proto__', 'bad id'])('shows creation errors inside the open dialog for ID %j', id => {
    const app = setup(); app.click('[data-business-add]');
    app.edit('business-new-name', '客户支持'); app.edit('business-new-id', id);
    app.submit('[data-business-create]');
    expect(app.input('business-create-dialog').open).toBe(true);
    expect(app.document.querySelector('[data-business-create] .form-message')!.textContent!.trim()).not.toBe('');
    expect(app.run('Object.keys(businessState.settings.profiles)')).toEqual(['default', 'documents']);
    expect(app.calls).toHaveLength(0);
  });

  it('copies the latest source draft and keeps subsequent profile edits independent', () => {
    const app = setup();
    app.edit('business-common', '共享领域背景'); app.edit('business-worker', '先核对来源');
    app.input('business-skills').value = 'reader'; app.input('business-extensions').value = 'document-tools';
    app.click('[data-business-add]');
    app.edit('business-new-name', '客服副本'); app.edit('business-new-id', 'support-copy'); app.change('business-copy-source', 'default');
    app.submit('[data-business-create]');
    expect(app.input('business-common').value).toBe('共享领域背景');
    expect(app.input('business-worker').value).toBe('先核对来源');
    expect(app.input('business-skills').value).toBe('reader');
    expect(app.run('businessState.settings.profiles.default.skillIds === businessState.settings.profiles["support-copy"].skillIds')).toBe(false);
    app.edit('business-worker', '只交付摘要'); app.input('business-skills').value = 'writer';
    app.change('business-selected', 'default');
    expect(app.input('business-worker').value).toBe('先核对来源'); expect(app.input('business-skills').value).toBe('reader');
    app.change('business-selected', 'support-copy');
    expect(app.input('business-worker').value).toBe('只交付摘要'); expect(app.input('business-skills').value).toBe('writer');
  });

  it('preserves every role, capability and scope draft through actual profile changes', () => {
    const app = setup();
    const fields = { 'business-name': '资料助手', 'business-common': '共享背景', 'business-router': '路由规则', 'business-worker': '处理要求',
      'business-skills': 'reader\nwriter', 'business-extensions': 'document-tools', 'business-persona': '# 风格\n语气简洁自然。', 'business-memory': 'document_format', 'business-rooms': 'qq:1:2 = documents' };
    for (const [id, value] of Object.entries(fields)) app.edit(id, value);
    app.change('business-default', 'documents');
    app.change('business-selected', 'documents'); expect(app.input('business-router').value).toBe('');
    app.change('business-selected', 'default');
    for (const [id, value] of Object.entries(fields)) expect(app.input(id).value, id).toBe(value);
    expect(app.input('business-default').value).toBe('documents');
    expect(app.run('businessState.dirty')).toBe(true);
  });

  it('keeps unsaved configuration and invalid room text across tabs, refresh and navigation', async () => {
    const app = setup(); app.edit('business-router', '待保存的路由'); app.edit('business-rooms', '待完善的群绑定');
    app.run("setBusinessTab('scope')"); app.run("setBusinessTab('prompts')");
    app.change('business-selected', 'documents'); app.change('business-selected', 'default');
    await app.run('render()');
    expect(app.input('business-router').value).toBe('待保存的路由'); expect(app.input('business-rooms').value).toBe('待完善的群绑定');
    app.click('nav [data-view="threads"]'); await settle();
    expect(app.run('view')).toBe('threads');
    app.click('nav [data-view="business"]'); await settle();
    expect(app.input('business-router').value).toBe('待保存的路由'); expect(app.input('business-rooms').value).toBe('待完善的群绑定');
    expect(app.run('businessState.dirty')).toBe(true);
    await app.save();
    expect(app.calls.filter(call => call.body?.settings)).toHaveLength(0);
    expect(app.document.querySelector('[data-business-config] .form-message')!.textContent).not.toBe('');
  });

  it('keeps edits made while a previously requested clean refresh is still loading', async () => {
    const response = deferred<ApiResult>(); const app = setup(path => path.startsWith('/api/business-config?') ? response.promise : undefined);
    const savedSettings = structuredClone(app.run('businessState.settings'));
    const refresh = app.run('render()'); app.edit('business-router', '刷新等待期间的新规则');
    response.resolve({ ok: true, value: { settings: savedSettings, revision: 'remote-revision' } }); await refresh;
    expect(app.input('business-router').value).toBe('刷新等待期间的新规则');
    expect(app.run('businessState.dirty')).toBe(true);
    expect(app.run('businessState.revision')).toBe('old-revision');
  });

  it('keeps a successful save when an older clean refresh responds afterward', async () => {
    const response = deferred<ApiResult>(); const app = setup(path => path.startsWith('/api/business-config?') ? response.promise : undefined);
    const oldSettings = structuredClone(app.run('businessState.settings'));
    const refresh = app.run('render()');
    app.edit('business-router', '已经保存的新路由规则'); await app.save();
    expect(app.run('businessState.dirty')).toBe(false); expect(app.run('businessState.revision')).toBe('new-revision');
    response.resolve({ ok: true, value: { settings: oldSettings, revision: 'old-revision' } }); await refresh;
    expect(app.input('business-router').value).toBe('已经保存的新路由规则');
    expect(app.run('businessState.settings.profiles.default.routerInstructions')).toBe('已经保存的新路由规则');
    expect(app.run('businessState.revision')).toBe('new-revision'); expect(app.run('businessState.dirty')).toBe(false);
    expect(app.document.querySelector('[data-business-config]')!.getAttribute('data-revision')).toBe('new-revision');
  });

  it('keeps a successful history rollback when an older clean refresh responds afterward', async () => {
    const response = deferred<ApiResult>(); let rollbackSettings: any;
    const app = setup(path => {
      if (path.startsWith('/api/business-config?')) return response.promise;
      if (path.startsWith('/api/business-config/history?')) return { ok: true, value: [{ revision: 'historical-revision', savedAt: '2026-11-01T00:00:00Z', profiles: ['文档'] }] };
      if (path === '/api/business-config/rollback') return { ok: true, value: { settings: rollbackSettings, revision: 'historical-revision' } };
      return undefined;
    });
    const oldSettings = structuredClone(app.run('businessState.settings'));
    rollbackSettings = structuredClone(oldSettings); rollbackSettings.defaultProfile = 'documents';
    rollbackSettings.profiles.documents.commonInstructions = '已恢复的历史业务背景';
    rollbackSettings.roomProfiles = { 'qq:1:2': 'documents' };
    const refresh = app.run('render()');
    app.click('[data-business-history]'); await settle();
    app.click('[data-business-rollback="historical-revision"]'); await settle();
    expect(app.run('businessState.revision')).toBe('historical-revision');
    expect(app.calls.find(call => call.path === '/api/business-config/rollback')!.body).toEqual({ targetRevision: 'historical-revision', revision: 'old-revision' });
    response.resolve({ ok: true, value: { settings: oldSettings, revision: 'old-revision' } }); await refresh;
    expect(app.input('business-common').value).toBe('已恢复的历史业务背景');
    expect(app.input('business-selected').value).toBe('documents'); expect(app.input('business-default').value).toBe('documents');
    expect(app.run('businessState.settings.roomProfiles')).toEqual({ 'qq:1:2': 'documents' });
    expect(app.run('businessState.revision')).toBe('historical-revision'); expect(app.run('businessState.dirty ?? false')).toBe(false);
  });

  it('adds, edits and removes room bindings through the visible row controls', async () => {
    const app = setup(); app.click('[data-business-tab="scope"]'); app.click('[data-business-room-add]');
    expect(app.document.querySelectorAll('.business-room-row')).toHaveLength(1);
    const room = app.document.querySelector('[data-business-room]')!;
    const target = app.document.querySelector('[data-business-room-profile]')!;
    app.edit(room.id, 'qq:1:2'); app.change(target.id, 'documents');
    expect(app.input('business-rooms').value).toBe('qq:1:2 = documents');
    app.change('business-selected', 'documents'); app.change('business-selected', 'default');
    expect((app.document.querySelector('[data-business-room]') as any).value).toBe('qq:1:2');
    expect((app.document.querySelector('[data-business-room-profile]') as any).value).toBe('documents');
    await app.save(); expect(app.calls.at(-1)!.body.settings.roomProfiles).toEqual({ 'qq:1:2': 'documents' });
    app.click('[data-business-room-remove]'); await app.save();
    expect(app.document.querySelectorAll('.business-room-row')).toHaveLength(0);
    expect(app.calls.at(-1)!.body.settings.roomProfiles).toEqual({});
  });

  it('discards drafts only after the explicit confirmation and reloads saved values', async () => {
    const app = setup(); app.edit('business-router', '将被放弃的草稿'); app.click('[data-business-discard]');
    expect(app.input('detail').open).toBe(true); expect(app.input('business-router').value).toBe('将被放弃的草稿'); expect(app.calls).toHaveLength(0);
    app.click('[data-business-discard-confirm]'); await settle();
    expect(app.input('business-router').value).toBe(''); expect(app.run('businessState.dirty ?? false')).toBe(false);
    expect(app.input('detail').open).toBe(false);
  });

  it('serializes capability checkbox changes and retains unselected items across profile switches', async () => {
    const app = setup();
    for (const [kind, id, field] of [['skills', 'reader', 'business-skills'], ['extensions', 'document-tools', 'business-extensions'], ['memory', 'document_format', 'business-memory']]) {
      const checkbox = app.document.querySelector(`[data-business-capability="${kind}"][value="${id}"]`) as any;
      expect(checkbox, kind).not.toBeNull(); checkbox.checked = true; checkbox.dispatchEvent(new app.Event('change', { bubbles: true }));
      expect(app.input(field).value).toBe(id);
    }
    app.change('business-selected', 'documents'); app.change('business-selected', 'default');
    const reader = app.document.querySelector('[data-business-capability="skills"][value="reader"]') as any;
    expect(reader.checked).toBe(true); reader.checked = false; reader.dispatchEvent(new app.Event('change', { bubbles: true }));
    expect(app.input('business-skills').value).toBe('');
    await app.save();
    expect(app.calls.at(-1)!.body.settings.profiles.default).toMatchObject({ skillIds: [], extensionIds: ['document-tools'], memoryFields: ['document_format'] });
  });

  it('saves all profiles, room bindings and capability references through the form event', async () => {
    const app = setup(); app.edit('business-router', '查证交 Worker'); app.input('business-skills').value = 'reader\nreader,writer'; app.input('business-rooms').value = 'qq:1:2 = documents';
    app.submit('form[data-business-config]'); await settle();
    expect(app.calls).toHaveLength(1); expect(app.calls[0].path).toBe('/api/business-config'); expect(app.calls[0].body.revision).toBe('old-revision');
    expect(app.calls[0].body.settings.profiles.default).toMatchObject({ routerInstructions: '查证交 Worker', skillIds: ['reader', 'writer'] });
    expect(app.calls[0].body.settings.roomProfiles).toEqual({ 'qq:1:2': 'documents' });
    expect(app.run('businessState.dirty')).toBe(false); expect(app.run('businessState.revision')).toBe('new-revision');
    await app.run('render()');
    expect(app.calls.filter(call => !call.body)).toHaveLength(1);
  });

  it('keeps rejected edits editable and dirty without overwriting the revision on conflict', async () => {
    const app = setup(async () => ({ ok: false, value: { error: '业务配置已被更新' } })); app.edit('business-common', '未保存的草稿'); await app.save();
    expect(app.input('business-common').value).toBe('未保存的草稿'); expect(app.input('business-common').disabled).toBe(false);
    expect(app.run('businessState.revision')).toBe('old-revision'); expect(app.run('businessState.dirty')).toBe(true);
    expect(app.document.querySelector('[data-business-config] .form-message')!.textContent).toContain('已被更新');
  });

  it('updates the profile heading and every profile selector after a saved rename', async () => {
    const app = setup(); app.click('[data-business-room-add]');
    app.edit(app.document.querySelector('[data-business-room]')!.id, 'qq:1:2');
    app.edit('business-name', '资料核验助手'); await app.save();
    expect(app.document.querySelector('.business-heading h2')!.textContent).toBe('资料核验助手');
    for (const option of app.document.querySelectorAll('option[value="default"]')) expect(option.textContent).toContain('资料核验助手');
    expect(app.input('business-selected').value).toBe('default');
    expect(app.input('business-name').disabled).toBe(false);
    expect(app.run('businessState.dirty')).toBe(false);
  });

  it('prevents duplicate saves and navigation from replacing a form while its save is in flight', async () => {
    const response = deferred<ApiResult>(); const app = setup(() => response.promise);
    app.edit('business-common', '保存中的草稿');
    const saving = app.save(); app.submit('[data-business-config]'); app.click('nav [data-view="threads"]');
    expect(app.calls).toHaveLength(1); expect(app.run('view')).toBe('business'); expect(app.input('business-common').disabled).toBe(true);
    response.resolve({ ok: true, value: { settings: app.calls[0].body.settings, revision: 'saved-revision', saved: true } }); await saving;
    expect(app.input('business-common').disabled).toBe(false); expect(app.run('businessState.dirty')).toBe(false);
    expect(app.run('businessState.revision')).toBe('saved-revision');
  });

  it('warns on unloading unsaved work and removes the warning after a successful save', async () => {
    const app = setup(); app.edit('business-worker', '尚未保存');
    const dirtyUnload = new app.Event('beforeunload', { cancelable: true }); app.window.dispatchEvent(dirtyUnload);
    expect(dirtyUnload.defaultPrevented).toBe(true);
    await app.save();
    const cleanUnload = new app.Event('beforeunload', { cancelable: true }); app.window.dispatchEvent(cleanUnload);
    expect(cleanUnload.defaultPrevented).toBe(false);
  });

  it('rejects duplicate room bindings locally and renders instructions as text', async () => {
    const app = setup(); app.input('business-rooms').value = 'qq:1:2 = default\nqq:1:2 = documents'; await app.save(); expect(app.calls).toHaveLength(0);
    app.run("businessState.settings.profiles.default.commonInstructions = '</textarea><img src=x onerror=evil()>'; document.getElementById('content').innerHTML = businessPage();");
    expect(app.document.querySelector('img')).toBeNull(); expect(app.document.querySelector('[data-business-config]')!.innerHTML).toContain('&lt;/textarea&gt;');
  });

  it('previews the unsaved selected profile and escapes returned prompt text', async () => {
    const app = setup(async () => ({ ok: true, value: { router: '<img src=x>', worker: '当前 Worker', note: '包含当前草稿' } }));
    app.edit('business-worker', '当前草稿'); app.edit('business-persona', '# 当前人格\n用清晰、克制的语气。'); app.click('[data-business-preview]'); await settle();
    expect(app.calls[0].body.profileId).toBe('default'); expect(app.calls[0].body.settings.profiles.default.workerInstructions).toBe('当前草稿');
    expect(app.calls[0].body.settings.profiles.default.personaText).toBe('# 当前人格\n用清晰、克制的语气。');
    expect(app.calls[0].body.settings.profiles.default.personaFile).toBeUndefined();
    expect(app.document.querySelector('#detail-body img')).toBeNull(); expect(app.document.getElementById('detail-body')!.textContent).toContain('<img src=x>');
    expect(app.input('detail').open).toBe(true);
  });

  it.each(['profile change', 'leave and return'])('discards a delayed preview after %s', async action => {
    const response = deferred<ApiResult>(); const app = setup(path => path.endsWith('/preview') ? response.promise : undefined);
    const preview = app.run('previewBusiness()');
    if (action === 'profile change') app.change('business-selected', 'documents');
    else { app.click('nav [data-view="threads"]'); await settle(); app.click('nav [data-view="business"]'); await settle(); }
    response.resolve({ ok: true, value: { router: '过时的 Router', worker: '过时的 Worker', note: '过时预览' } }); await preview;
    expect(app.input('detail').open ?? false).toBe(false);
    expect(app.document.getElementById('detail-body')!.textContent).not.toContain('过时');
  });

  it('opens the actual Worker trace after configuration changes and supports older records', async () => {
    let actualSessions: string[] = ['logical-session-cfg-profile-revision'];
    const app = setup(async () => ({ ok: true, value: { thread: { status: 'ready', data: { subject: '资料核查', sessionId: 'logical-session' } }, inputs: [], runs: [], results: [], outbox: [], workerSessionIds: actualSessions } }));
    await app.run("showThread('topic')");
    expect(app.document.querySelector('[data-session]')!.getAttribute('data-session')).toBe(actualSessions[0]);
    actualSessions = [];
    await app.run("showThread('topic')");
    expect(app.document.querySelector('[data-session]')!.getAttribute('data-session')).toBe('logical-session');
  });
});

// Exercise the rendered audit rather than matching frontend source strings.
it('renders distinct call, item, repetition and recovery counts in the thread audit', () => {
  const app = setup();
  const markup = app.run(`domainAudit({domainSummary:[{tool:'reader',category:'batch',calls:4,errors:1,partial:1,itemsTotal:9,itemsOk:5,itemsErrors:3,itemsEmpty:1,repeated:2,recoveredRetries:1,elapsedMs:10,responseCharacters:100}],domainEvents:[]})`);
  const { document } = parseHTML(markup); const text = document.textContent || document.querySelector('section')!.textContent;
  expect(text).toContain('错误 1 次 · 部分失败 1 次');
  expect(text).toContain('批内条目 9 条：成功 5 · 失败 3 · 空 1');
  expect(text).toContain('同轮重复请求 2 次 · 同参数重试恢复 1 次');
  expect(text).toContain('更改参数后的恢复需查看明细');
  expect(document.querySelectorAll('tbody tr')).toHaveLength(1);
});

it('shows separate task input/output totals and distinguishes missing records from zero', () => {
  const app = setup();
  const usage = { inputTokens: 1500, uncachedInputTokens: 1000, outputTokens: 250, cacheReadTokens: 400, cacheWriteTokens: 100, recordCount: 2, missingRuns: 1, runs: [
    { runId: 'run-one', status: 'succeeded', inputTokens: 1500, outputTokens: 250, recordCount: 2 },
    { runId: 'run-two', status: 'running', inputTokens: 0, outputTokens: 0, recordCount: 0 },
  ] };
  const { document } = parseHTML(app.run(`taskTokenDetails(${JSON.stringify(usage)})`));
  expect([...document.querySelectorAll('.token-totals strong')].map(node => node.textContent)).toEqual(['1,500', '250']);
  expect(document.querySelector('.table-sub')!.textContent).toContain('缓存读取 400 · 缓存写入 100');
  expect(document.querySelector('section')!.textContent).toContain('累计可能不完整');
  expect(document.querySelectorAll('tbody tr')[1].textContent).toContain('未记录未记录');
  expect(app.run('taskTokenCell({recordCount:0,inputTokens:0,outputTokens:0})')).toContain('未记录');
  expect(app.run('taskTokenCell({recordCount:1,inputTokens:0,outputTokens:0})')).toContain('输入 0');
  expect(app.run('taskTokenDetails(undefined)')).toContain('尚无已记录用量');
});

it('includes cache in overview input totals using the same definition as task totals', () => {
  const app = setup();
  const markup = app.run(`overview({metrics:[{data:{inputTokens:10,outputTokens:4,cacheReadTokens:20,cacheWriteTokens:3}}]}, [])`);
  const { document } = parseHTML(markup);
  expect([...document.querySelectorAll('.usage-legend strong')].map(node => node.textContent)).toEqual(['33', '4']);
  expect(document.querySelector('.usage-total')!.textContent).toContain('37');
});
