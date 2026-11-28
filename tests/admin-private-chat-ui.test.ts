import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { parseHTML } from 'linkedom';

const script = readFileSync(new URL('../src/admin/app.js', import.meta.url), 'utf8').replace(/initialize\(\); setInterval\([\s\S]*$/, '');
const html = readFileSync(new URL('../src/admin/index.html', import.meta.url), 'utf8');
const state = (extra = {}) => ({ settings: { enabled: true, allowedUserIds: ['901'], maxMessagesPerMinute: 30, replyMode: 'plain' }, revision: 'revision-1', digest: 'digest-1', running: true, error: null, applied: { digest: 'digest-1', appliedAt: 1000 }, ...extra });
type Call = { path: string; method: string; body?: any; signal?: AbortSignal; query: URLSearchParams };
type Reply = { value: any; ok?: boolean; status?: number };
function setup(respond?: (call: Call) => Reply | Promise<Reply> | undefined) {
  const { document } = parseHTML(html), calls: Call[] = [];
  const dialog = document.getElementById('detail') as any;
  dialog.close = () => { dialog.open = false; };
  class BrowserFormData {
    values = new Map<string, string>();
    constructor(form: any) {
      for (const field of form.querySelectorAll('[name]')) {
        if (field.disabled || field.type === 'checkbox' && !field.hasAttribute('checked')) continue;
        this.values.set(field.name, field.type === 'checkbox' ? 'on' : field.value);
      }
    }
    get(key: string) { return this.values.get(key) ?? null; }
  }
  const sandbox = createContext({ document, window: { addEventListener() {}, matchMedia() { return { matches: false }; } }, location: { search: '' }, URL, URLSearchParams, AbortController, FormData: BrowserFormData, console, setTimeout, clearTimeout,
    fetch: async (path: string, options: any = {}) => {
      const url = new URL(path, 'http://localhost');
      const call = { path: url.pathname, query: url.searchParams, method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : undefined, signal: options.signal };
      calls.push(call); const reply = await respond?.(call);
      const value = reply?.value ?? (call.path === '/api/config' ? { privateChatStatus: state() } : call.path === '/api/overview' ? { threads: [], outbox: [], metrics: [], errors: [] } : []);
      return { ok: reply?.ok ?? true, status: reply?.status ?? 200, text: async () => JSON.stringify(value) };
    },
  });
  runInContext(script, sandbox);
  const run = (code: string) => runInContext(code, sandbox);
  return { document, calls, run, render: () => run("view='private'; render()"), form: () => document.querySelector('[data-private-chat-config]') as any,
    feedback: () => document.querySelector('.private-chat-feedback')!.textContent!, save: () => run("savePrivateChat(document.querySelector('[data-private-chat-config]'))") };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('private settings feedback and navigation', () => {
  it('follows a successful save through delayed application without replacing a newer draft', async () => {
    const saved = state({ revision: 'revision-2', digest: 'digest-2', applied: { digest: 'digest-1' } });
    let persisted = false;
    const app = setup(call => {
      if (call.method === 'POST') { persisted = true; return { value: saved }; }
      if (persisted) return { value: { privateChatStatus: { ...saved, applied: { digest: 'digest-2', appliedAt: 2000 } } } };
    });
    await app.render(); await app.save();
    expect(app.feedback()).toContain('配置已保存，正在等待');
    expect(app.feedback()).not.toContain('失败');
    expect(app.calls.filter(c => c.method === 'POST')[0].body).toEqual({ revision: 'revision-1', settings: state().settings });
    const form = app.form(); form.querySelector('[name=users]').value = '902';
    await vi.advanceTimersByTimeAsync(1500);
    expect(app.feedback()).toContain('已保存的配置已生效');
    expect(app.form()).toBe(form); expect(form.querySelector('[name=users]').value).toBe('902');
    expect(form.dataset.revision).toBe('revision-2');
    const requests = app.calls.length; await vi.advanceTimersByTimeAsync(6000); expect(app.calls).toHaveLength(requests);
  });

  it('distinguishes application failure and offline service from save rejection', async () => {
    const app = setup(call => call.method === 'POST' ? { value: state({ error: { code: 'private_config_apply_failed' } }) } : undefined);
    await app.render(); await app.save();
    expect(app.feedback()).toContain('运行服务应用失败'); expect(app.feedback()).toContain('private_config_apply_failed');
    expect(app.form().querySelector('.form-message').textContent).toBe('');
    expect(app.run("privateChatFeedback({running:false, digest:'new'})")).toContain('服务离线');
  });

  it('preserves the draft and revision when saving is rejected', async () => {
    const app = setup(call => call.method === 'POST' ? { ok: false, status: 409, value: { error: '配置已变化' } } : undefined);
    await app.render(); app.form().querySelector('[name=users]').value = '903'; await app.save();
    expect(app.form().querySelector('.form-message').textContent).toBe('保存失败：配置已变化');
    expect(app.form().querySelector('[name=users]').value).toBe('903'); expect(app.form().dataset.revision).toBe('revision-1');
    expect(app.form().querySelector('button').disabled).toBe(false);
  });

  it('does not silently rebase an edited form when another operator changes the saved settings', async () => {
    let reads = 0;
    const app = setup(() => ({ value: { privateChatStatus: ++reads === 1 ? state({ applied: null }) : state({ digest: 'external', revision: 'external' }) } }));
    await app.render(); app.form().querySelector('[name=users]').value = '904'; await vi.advanceTimersByTimeAsync(1500);
    expect(app.feedback()).toContain('配置已被其他操作修改'); expect(app.form().dataset.revision).toBe('revision-1');
    expect(app.form().querySelector('[name=users]').value).toBe('904');
  });

  it('cancels obsolete page reads, shows loading immediately, and ignores their late result', async () => {
    let finish!: (reply: Reply) => void;
    const app = setup(call => call.path === '/api/overview' ? new Promise(resolve => { finish = resolve; }) : undefined);
    const previous = app.run('render()');
    app.run("navigate('private')");
    expect(app.document.getElementById('title')!.textContent).toBe('私聊');
    expect(app.document.getElementById('content')!.textContent).toContain('正在加载');
    expect(app.calls.find(c => c.path === '/api/overview')!.signal!.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(0); expect(app.form()).not.toBeNull();
    finish({ value: { threads: [], outbox: [], metrics: [], errors: [] } }); await previous;
    expect(app.form()).not.toBeNull(); expect(app.document.getElementById('notice')!.textContent).toBe('');
    expect(app.calls.find(c => c.path === '/api/threads')!.query.get('limit')).toBe('6');
  });

  it('does not restart a still-loading overview during automatic refresh', async () => {
    let finish!: (reply: Reply) => void;
    const app = setup(call => call.path === '/api/overview' ? new Promise(resolve => { finish = resolve; }) : undefined);
    const pending = app.run('render()'); await app.run('render({silent:true})');
    expect(app.calls.filter(c => c.path === '/api/overview')).toHaveLength(1);
    finish({ value: { threads: [], outbox: [], metrics: [], errors: [] } }); await pending;
  });

  it('does not poll after leaving private settings or discard a draft when clicking its active tab', async () => {
    const app = setup(call => call.path === '/api/config' ? { value: { privateChatStatus: state({ applied: null }) } } : undefined);
    await app.render(); const form = app.form(); form.querySelector('[name=users]').value = '905';
    app.run("navigate('private')"); expect(app.form()).toBe(form); expect(form.querySelector('[name=users]').value).toBe('905');
    app.run("navigate('messages')"); await vi.advanceTimersByTimeAsync(4500);
    expect(app.calls.filter(c => c.path === '/api/config')).toHaveLength(1); expect(app.form()).toBeNull();
  });
});
