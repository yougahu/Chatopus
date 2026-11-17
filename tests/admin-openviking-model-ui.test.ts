import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { parseHTML } from 'linkedom';

const script = readFileSync(new URL('../src/admin/app.js', import.meta.url), 'utf8').replace(/initialize\(\); setInterval\([\s\S]*$/, '');
const html = readFileSync(new URL('../src/admin/index.html', import.meta.url), 'utf8');
const model = (extra = {}) => ({ available: true, model: 'deepseek-flash', baseUrl: 'https://api.deepseek.com', thinking: 'disabled', apiKeyConfigured: true, revision: 'revision-1', restartRequired: false, restartSupported: true, ...extra });
type Call = { path: string; method: string; body?: Record<string, unknown> };
type Reply = { ok?: boolean; status?: number; value: unknown };
function setup(respond?: (call: Call) => Reply | Promise<Reply> | undefined) {
  const { document } = parseHTML(html), calls: Call[] = [];
  const detail = document.getElementById('detail') as any;
  detail.showModal = () => { detail.open = true; }; detail.close = () => { detail.open = false; };
  class BrowserFormData {
    private values = new Map<string, string>();
    constructor(form: any) {
      for (const field of form.querySelectorAll('[name]')) if (!field.disabled) this.values.set(field.name, field.value);
    }
    get(name: string) { return this.values.get(name) ?? null; }
  }
  const sandbox = createContext({ document, window: { addEventListener() {}, matchMedia() { return { matches: false }; } }, location: { search: '' }, URL, URLSearchParams, AbortController, FormData: BrowserFormData, console, setTimeout, clearTimeout,
    fetch: async (path: string, options: { method?: string; body?: string } = {}) => {
      const call = { path: new URL(path, 'http://localhost').pathname, method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : undefined };
      calls.push(call);
      const custom = await respond?.(call);
      const value = custom?.value ?? (call.path === '/api/config' ? { router: { model: 'router-original' }, worker: { model: 'worker-original' } } : call.path === '/api/openviking-model-config' ? model() : []);
      return { ok: custom?.ok ?? true, status: custom?.status ?? 200, text: async () => JSON.stringify(value) };
    },
  });
  runInContext(script, sandbox);
  const run = (code: string) => runInContext(code, sandbox);
  const render = async () => {
    await run("view='config'; render()");
    // linkedom exposes a getter-only select.value; browsers also provide this setter.
    for (const select of document.querySelectorAll('select')) Object.defineProperty(select, 'value', {
      configurable: true,
      get() { return select.querySelector('option[selected]')?.getAttribute('value') ?? select.querySelector('option')?.getAttribute('value') ?? ''; },
      set(value: string) { for (const option of select.querySelectorAll('option')) option.toggleAttribute('selected', option.getAttribute('value') === value); },
    });
  };
  return { document, calls, run, render, form: () => document.querySelector('[data-openviking-model]') as any,
    save: (applyOnly = false) => run(`saveOpenVikingModel(document.querySelector('[data-openviking-model]'),${applyOnly})`) };
}
function deferred() { let resolve!: (reply: Reply) => void; const promise = new Promise<Reply>(r => { resolve = r; }); return { promise, resolve }; }

describe('OpenViking model settings UI', () => {
  it('loads independent settings and renders only escaped editable fields and a masked-key state', async () => {
    const app = setup(call => call.path === '/api/openviking-model-config' ? { value: model({ model: '<img src=x onerror=evil()>', apiKey: 'never-render-this', content: 'private-native-config' }) } : undefined);
    await app.render();
    expect(app.calls.map(call => call.path)).toEqual(['/api/config', '/api/openviking-model-config']);
    const form = app.form();
    expect(form.querySelector('[name=model]').value).toBe('<img src=x onerror=evil()>');
    expect(form.querySelector('img')).toBeNull();
    expect(form.querySelector('[name=apiKey]').type).toBe('password');
    expect(form.querySelector('[name=apiKey]').value).toBe('');
    expect(form.textContent).toContain('已配置');
    expect(form.textContent).not.toContain('never-render-this');
    expect(app.document.getElementById('content')!.innerHTML).not.toContain('private-native-config');
    expect(form.querySelector('[data-apply-state]').textContent).toBe('已生效');
    expect(app.document.querySelectorAll('[data-model-role]')).toHaveLength(2);
  });

  it('submits the displayed revision and omits blank credentials, then reports successful application', async () => {
    const app = setup(call => call.method === 'POST' ? { value: { saved: true, applied: true, message: '记忆模型配置已生效。', config: model({ revision: 'revision-2', model: 'new-model' }) } } : undefined);
    await app.render(); app.form().querySelector('[name=model]').value = 'new-model';
    await app.save();
    expect(app.calls.filter(call => call.method === 'POST')).toEqual([{ path: '/api/openviking-model-config', method: 'POST', body: { revision: 'revision-1', model: 'new-model', baseUrl: 'https://api.deepseek.com', thinking: 'disabled' } }]);
    expect(app.form().dataset.revision).toBe('revision-2');
    expect(app.form().querySelector('.form-message').textContent).toBe('记忆模型配置已生效。');
    expect(app.form().querySelector('[data-openviking-apply]').hidden).toBe(true);
    expect(app.form().querySelector('button[type=submit]').disabled).toBe(false);
    expect((app.document.querySelector('#router-model') as any).value).toBe('router-original');
  });

  it('clears a saved key even when application is deferred, then reapplies only the saved revision', async () => {
    const app = setup(call => call.method === 'POST' ? { value: call.path.endsWith('/apply')
      ? { applied: true, config: model({ revision: 'revision-2' }), message: '应用完成。' }
      : { saved: true, applied: false, config: model({ revision: 'revision-2', restartRequired: true }), message: '配置已保存，记忆提炼正在运行，请稍后重新应用。' } } : undefined);
    await app.render(); app.form().querySelector('[name=apiKey]').value = 'replacement-private-key';
    await app.save();
    expect(app.calls.find(call => call.method === 'POST')!.body!.apiKey).toBe('replacement-private-key');
    expect(app.form().querySelector('[name=apiKey]').value).toBe('');
    expect(app.form().querySelector('[data-apply-state]').textContent).toBe('待应用');
    expect(app.form().querySelector('[data-openviking-apply]').hidden).toBe(false);
    expect(app.form().querySelector('.form-message').textContent).not.toContain('已生效');
    app.form().querySelector('[name=model]').value = 'unsaved-edit';
    app.form().querySelector('[name=apiKey]').value = 'unsaved-secret';
    await app.save(true);
    expect(app.calls.at(-1)).toEqual({ path: '/api/openviking-model-config/apply', method: 'POST', body: { revision: 'revision-2' } });
    expect(app.form().querySelector('[name=model]').value).toBe('deepseek-flash');
    expect(app.form().querySelector('[name=apiKey]').value).toBe('unsaved-secret');
    expect(app.form().querySelector('[data-apply-state]').textContent).toBe('已生效');
  });

  it('refreshes displayed model settings after an apply failure rolls the service back', async () => {
    const app = setup(call => call.method === 'POST' ? { value: {
      applied: false,
      config: model({ revision: 'rollback-revision', model: 'previous-model', baseUrl: 'https://previous.example/v1', thinking: 'default' }),
      message: '应用失败，已回滚到之前的配置。',
    } } : undefined);
    await app.render();
    app.form().querySelector('[name=model]').value = 'failed-model';
    app.form().querySelector('[name=apiKey]').value = 'unsaved-key';
    await app.save(true);
    expect(app.form().querySelector('[name=model]').value).toBe('previous-model');
    expect(app.form().querySelector('[name=baseUrl]').value).toBe('https://previous.example/v1');
    expect(app.form().querySelector('[name=thinking]').value).toBe('default');
    expect(app.form().dataset.revision).toBe('rollback-revision');
    expect(app.form().querySelector('[name=apiKey]').value).toBe('unsaved-key');
    expect(app.form().querySelector('.form-message').textContent).toBe('应用失败，已回滚到之前的配置。');
    expect(app.form().querySelector('[data-apply-state]').textContent).not.toBe('已生效');
  });

  it('retains unsaved fields and permits retry after a request failure', async () => {
    const app = setup(call => call.method === 'POST' ? { ok: false, status: 409, value: { error: '配置已更新，请刷新后重试。' } } : undefined);
    await app.render(); app.form().querySelector('[name=apiKey]').value = 'not-yet-saved';
    await app.save();
    expect(app.form().querySelector('.form-message').textContent).toBe('配置已更新，请刷新后重试。');
    expect(app.form().querySelector('.form-message').classList.contains('error')).toBe(true);
    expect(app.form().querySelector('[name=apiKey]').value).toBe('not-yet-saved');
    expect(app.form().dataset.revision).toBe('revision-1');
    expect(app.form().querySelector('button[type=submit]').disabled).toBe(false);
  });

  it('disables fields while saving and suppresses concurrent submissions', async () => {
    const pending = deferred(), app = setup(call => call.method === 'POST' ? pending.promise : undefined);
    await app.render(); const first = app.save();
    expect(app.form().querySelector('[name=model]').disabled).toBe(true);
    await app.save(); await app.save(true);
    expect(app.calls.filter(call => call.method === 'POST')).toHaveLength(1);
    pending.resolve({ value: { saved: true, applied: true, config: model() } }); await first;
    expect(app.form().querySelector('[name=model]').disabled).toBe(false);
  });

  it('isolates failed configuration reads to the memory card and leaves other model forms usable', async () => {
    const app = setup(call => call.path === '/api/openviking-model-config' ? { ok: false, status: 503, value: { error: '记忆服务暂时不可用。' } } : undefined);
    await app.render();
    expect(app.form()).toBeNull();
    expect(app.document.querySelector('.memory-model-card')!.textContent).toContain('记忆服务暂时不可用。');
    expect(app.document.querySelectorAll('[data-model-role]')).toHaveLength(2);
    expect(app.document.getElementById('notice')!.textContent).toBe('');
  });

  it('does not overwrite a page opened while the save was in flight', async () => {
    const pending = deferred(), app = setup(call => call.method === 'POST' ? pending.promise : undefined);
    await app.render(); const first = app.save();
    await app.run("view='threads'; render()");
    const before = app.document.getElementById('content')!.innerHTML;
    pending.resolve({ value: { saved: true, applied: false, config: model({ restartRequired: true }), message: '等待应用。' } }); await first;
    expect(app.document.getElementById('content')!.innerHTML).toBe(before);
    expect(app.form()).toBeNull();
  });
});
