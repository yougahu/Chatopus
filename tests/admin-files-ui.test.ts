import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { parseHTML } from 'linkedom';

const html = readFileSync(new URL('../src/admin/index.html', import.meta.url), 'utf8');
const script = readFileSync(new URL('../src/admin/app.js', import.meta.url), 'utf8').replace(/initialize\(\); setInterval\([\s\S]*$/, '');
function fixture() {
  return { id: 'reply-1', room: 'qq:bot:room', status: 'failed', data: { attempts: 2,
    message: { roomId: 'qq:bot:room', text: '', files: [
      { kind: 'file', artifactId: 'file-1', name: '资料摘要.md', file: '/private/task-artifacts/first.md', bytes: 2048, sha256: 'hash-1' },
      { kind: 'file', artifactId: 'file-2', name: '结果表.csv', file: '/private/task-artifacts/second.csv', bytes: 2 * 1024 * 1024, sha256: 'hash-2' },
    ] },
    fileDeliveries: [
      { artifactId: 'file-1', status: 'sent', attempts: 1, platformFileId: 'qq-file-1', sentAt: 1000 },
      { artifactId: 'file-2', status: 'failed', attempts: 2, reason: 'action_failed' },
    ],
  } };
}
function setup(row: any = fixture()) {
  const { document, window, Event } = parseHTML(html), calls: string[] = [];
  Object.defineProperty(window.HTMLSelectElement.prototype, 'value', {
    configurable: true,
    get() { return this.querySelector('option[selected]')?.getAttribute('value') ?? this.querySelector('option')?.getAttribute('value') ?? ''; },
    set(value) { for (const option of this.querySelectorAll('option')) if (option.getAttribute('value') === value) option.setAttribute('selected', ''); else option.removeAttribute('selected'); },
  });
  Object.assign(window.HTMLElement.prototype, { showModal(this: any) { this.open = true; }, close(this: any) { this.open = false; this.dispatchEvent(new Event('close')); }, focus() {} });
  window.matchMedia = () => ({ matches: false }) as any;
  const schedule = { id: 's-test', title: '资料整理', content: '核对今日记录', authority: 'system', ownerId: null, roomId: row.room, version: 1, status: 'active', timezone: 'Asia/Shanghai', scheduleSpec: { kind: 'interval', anchorAt: 1000, intervalMs: 3600000 } };
  const context = createContext({ document, window, location: { search: '' }, URL, URLSearchParams, AbortController, structuredClone, console, setTimeout, clearTimeout,
    fetch: async (path: string) => {
      calls.push(path);
      const value = path.includes('/threads/') ? { thread: { status: 'idle', data: { roomId: row.room, subject: '资料任务', revision: 1, latestInputSeq: 1 } }, inputs: [], runs: [], results: [{ data: { report: { shortAnswer: '整理完成', fileAttachments: row.data.message.files } } }], decisions: [], outbox: [row] }
        : path.includes('/runs?') ? { items: [{ id: 'run-1', status: 'succeeded', scheduledAt: 1000, outbox: [row] }], total: 1, hasMore: false }
          : path.includes('/schedules/s-test') ? { schedule, audits: [] } : [row];
      return { ok: true, status: 200, text: async () => JSON.stringify(value) };
    },
  });
  runInContext(script, context);
  return { document, calls, run: (code: string) => runInContext(code, context), text: (selector: string) => document.querySelector(selector)?.textContent || '' };
}

describe('admin group file delivery', () => {
  it('shows file-only replies and keeps confirmed uploads distinct from a failed reply', async () => {
    const app = setup(); await app.run("view='outbox'; render()");
    expect(app.text('#content')).toContain('文件回复'); expect(app.text('#content')).toContain('2 个文件 · 已上传 1/2');
    expect(app.text('#content')).not.toContain('张图片');
    await app.run('showDetail(0)');
    const files = [...app.document.querySelectorAll('.reply-file')];
    expect(files).toHaveLength(2); expect(files[0].textContent).toContain('资料摘要.md'); expect(files[0].textContent).toContain('2 KiB'); expect(files[0].textContent).toContain('已上传');
    expect(files[1].textContent).toContain('结果表.csv'); expect(files[1].textContent).toContain('2 MiB'); expect(files[1].textContent).toContain('上传失败'); expect(files[1].textContent).toContain('已尝试 2 次'); expect(files[1].textContent).toContain('群文件权限及桥接支持');
    expect(app.text('#detail-body')).toContain('action_failed'); expect(app.text('#detail-body')).toContain('qq-file-1');
    expect(app.text('#detail-body')).not.toContain('/private/task-artifacts'); expect(app.document.querySelector('.reply-files a')).toBeNull();
    expect(app.calls.every(path => !path.includes('/files/'))).toBe(true);
  });

  it('preserves image previews alongside file upload details', async () => {
    const row: any = fixture(); row.data.message.attachments = [{ kind: 'image', artifactId: 'image-1', mimeType: 'image/png', bytes: 1024 }];
    const app = setup(row); await app.run("view='outbox'; render()"); await app.run('showDetail(0)');
    expect(app.text('#content')).toContain('1 张图片'); expect(app.text('#content')).toContain('2 个文件');
    expect(app.document.querySelector('[data-image-id="reply-1"][data-image-index="0"]')).not.toBeNull();
    expect(app.document.querySelectorAll('.reply-file')).toHaveLength(2);
  });

  it('shows active uploads and reports failures that happen before file receipts exist', async () => {
    const row: any = fixture(); row.status = 'sending'; row.data.fileDeliveries = [{ artifactId: 'file-1', status: 'sending', attempts: 1 }];
    const active = setup(row); await active.run("view='outbox'; render()"); await active.run('showDetail(0)');
    expect(active.text('.reply-files')).toContain('上传中'); expect(active.text('.reply-files')).toContain('待上传');
    row.status = 'failed'; row.data.reason = 'file_upload_unavailable'; delete row.data.fileDeliveries;
    const unavailable = setup(row); await unavailable.run("view='outbox'; render()"); await unavailable.run('showDetail(0)');
    expect(unavailable.text('.reply-files')).toContain('未上传'); expect(unavailable.text('.reply-files')).toContain('当前平台尚未提供群文件上传能力');
    expect(unavailable.text('.reply-files')).toContain('已上传 0 / 2');
  });

  it('distinguishes unknown uploads and unattempted files, and explains cancellation', async () => {
    const row: any = fixture(); row.status = 'unknown'; row.data.fileDeliveries = [{ artifactId: 'file-1', status: 'unknown', attempts: 1, reason: 'missing_file_id' }];
    const app = setup(row); await app.run("view='outbox'; render()"); await app.run('showDetail(0)');
    expect(app.text('.reply-files')).toContain('已上传 0 / 2'); expect(app.text('.reply-files')).toContain('上传结果未知'); expect(app.text('.reply-files')).toContain('未上传'); expect(app.text('.reply-files')).toContain('不会自动重传');
    expect(app.text('.reply-files')).toContain('平台未返回文件标识');
    row.status = 'stale'; row.data.fileDeliveries = [{ artifactId: 'file-1', status: 'sent', attempts: 1 }];
    const cancelled = setup(row); await cancelled.run("view='outbox'; render()"); await cancelled.run('showDetail(0)');
    expect(cancelled.text('.reply-files')).toContain('已上传 1 / 2'); expect(cancelled.text('.reply-files')).toContain('未上传'); expect(cancelled.text('.reply-files')).toContain('后续上传已停止');
  });

  it('shows the same file receipts in thread and scheduled execution details', async () => {
    const app = setup(); await app.run("showThread('thread-1')");
    expect(app.document.querySelectorAll('.reply-file')).toHaveLength(2); expect(app.text('#detail-body')).toContain('上传失败'); expect(app.text('#detail-body')).not.toContain('/private/task-artifacts');
    await app.run("view='schedules'; showSchedule('s-test')");
    expect(app.text('.schedule-run')).toContain('已完成'); expect(app.text('.schedule-run')).toContain('失败');
    expect(app.document.querySelectorAll('.schedule-run .reply-file')).toHaveLength(2); expect(app.text('.schedule-run')).toContain('资料摘要.md'); expect(app.text('.schedule-run')).not.toContain('/private/task-artifacts');
  });

  it('escapes filenames and audit reasons without creating markup', async () => {
    const row = fixture(); row.data.message.files[0].name = '"><img src=x onerror=attack()>'; row.data.fileDeliveries[1].reason = '<script>attack()</script>';
    const app = setup(row); await app.run("view='outbox'; render()"); await app.run('showDetail(0)');
    expect(app.document.querySelector('#detail-body img')).toBeNull(); expect(app.document.querySelector('#detail-body script')).toBeNull();
    expect(app.text('.reply-files')).toContain('"><img src=x onerror=attack()>'); expect(app.text('.reply-files')).toContain('请查看审计记录'); expect(app.text('#detail-body')).not.toContain('/private/task-artifacts');
  });
});
