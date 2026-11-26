const $ = id => document.getElementById(id);
const titles = { overview: '运行概览', threads: '任务话题', messages: '群消息', decisions: '路由决策', outbox: '回复投递', sessions: '模型与工具轨迹', memory: '记忆', private: '私聊', business: '业务 · 提示词', config: '模型 · 插件' };
const subtitles = { overview: '关注正在发生的事，随时追溯每一次回答。', threads: '每个任务请求，都有独立、可追溯的处理链路。', messages: '查看群聊输入，以及消息进入系统后的处理状态。', decisions: '了解 Router 如何判断、关联和分配每一次对话。', outbox: '从回答生成到发送确认，查看每条回复的送达状态。', sessions: '以可读时间线，回看模型调用与工具使用过程。', memory: '按群查看成员画像、记忆内容、来源消息与写入状态。', private: '管理好友私聊开关、访问名单与回复方式。', business: '管理业务范围、角色指引和不同群的配置。', config: '为日常接话和任务处理，选择各自合适的模型。' };
const names = { running: '处理中', queued: '等待执行', needs_input: '等待补充', idle: '已完成', cancelled: '已取消', failed: '失败', unknown: '发送结果待确认', pending: '待发送', sent: '已发送', sending: '发送中', routed: '已路由', received: '已接收', ignored: '已忽略', processing: '处理中', new: '新消息', done: '已完成', succeeded: '已完成', success: '成功', aborted: '已中止', stale: '已被更新', superseded: '已被更新', reply: '直接回复', silence: '保持安静', spawn: '启动任务', start: '启动任务', append: '补充到话题', cancel: '取消任务', resume: '继续话题', react: '简短回应', publish: '发布答案' };
Object.assign(names, { reply_direct: '直接回复', clarify: '追问澄清', open_thread: '启动任务', append_thread: '补充到话题', request_handoff: '查看交接', request_status: '查询进度', request_cancel: '取消任务', publish_result: '发布回答', defer_result: '延后回复', ready: '答案已就绪' });
const statusOptions = { threads: ['running', 'queued', 'needs_input', 'idle', 'cancelled', 'failed'], messages: ['received', 'routed', 'ignored', 'failed'], outbox: ['pending', 'sending', 'sent', 'failed', 'unknown'] };
let view = 'overview', source = new URLSearchParams(location.search).get('source') || 'main', offset = 0, rows = [], renderSequence = 0;
const memoryState = { room: '', member: '', profileOpen: false, memberQuery: '', memberItems: [], memberNextOffset: null, memberLoading: false, memberError: '', memberSequence: 0, query: '', results: [], searchDone: false, profileSequence: 0, searchSequence: 0 };
const MEMORY_MEMBER_PAGE_SIZE = 50;
let memberSearchTimer;
let viewRequest, privateStatusTimer, privateStatusRequest;
const esc = x => String(x ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const short = (x, length = 150) => String(x ?? '').length > length ? String(x).slice(0, length) + '…' : String(x ?? '');
const number = x => Number(x || 0).toLocaleString('zh-CN');
const label = x => names[x] || x || '—';
const time = x => { if (!x) return '—'; const d = new Date(typeof x === 'string' && !/^\d+(\.\d+)?$/.test(x) ? x : Number(x)); return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }); };
// Keep current router actions and their historical names visually consistent.
const actionBadgeClasses = new Map([
  ['silence', 'action-silence'],
  ['reply_direct', 'action-reply'], ['reply', 'action-reply'],
  ['clarify', 'action-clarify'],
  ['open_thread', 'action-open'], ['spawn', 'action-open'], ['start', 'action-open'],
  ['append_thread', 'action-append'], ['append', 'action-append'], ['resume', 'action-append'],
  ['request_status', 'action-status'], ['request_handoff', 'action-status'],
  ['request_cancel', 'action-cancel'], ['cancel', 'action-cancel'],
  ['publish_result', 'action-publish'], ['publish', 'action-publish'],
  ['defer_result', 'action-defer'],
  ['react', 'action-react'],
]);
const badge = s => `<span class="badge ${actionBadgeClasses.get(s) ?? (['failed', 'unknown', 'blocked'].includes(s) ? 'fail' : ['queued', 'pending', 'needs_input', 'running', 'sending', 'paused'].includes(s) ? 'warn' : ['idle', 'sent', 'routed', 'success', 'succeeded', 'active'].includes(s) ? '' : s === 'completed' ? 'info' : 'neutral')}">${esc(label(s))}</span>`;
const raw = (value, title = '查看原始记录') => `<details class="technical"><summary>${esc(title)}</summary><pre>${esc(JSON.stringify(value, (key, item) => item?.kind === 'file' && item.artifactId ? Object.fromEntries(Object.entries(item).filter(([field]) => field !== 'file')) : item, 2))}</pre></details>`;
const count = (items, status) => Number((items || []).find(x => x.status === status)?.n || 0);
function empty(title = '这里还没有记录', body = '接入群聊或完成一次终端验证后，记录会显示在这里。') { return `<div class="empty"><div class="empty-icon">▤</div><strong>${esc(title)}</strong><span>${esc(body)}</span></div>`; }
function panel(title, body, subtitle = '') { return `<section class="panel"><div class="panel-head"><div><h2>${esc(title)}</h2>${subtitle ? `<p class="panel-description">${esc(subtitle)}</p>` : ''}</div></div>${body}</section>`; }
function table(headers, data, fn) { if (!data.length) return panel('记录列表', empty('没有符合条件的记录', '可以尝试更换数据源、群作用域或状态筛选。')); return `<section class="panel table-panel"><div class="table-wrap"><table><thead><tr>${headers.map(x => `<th>${esc(x)}</th>`).join('')}</tr></thead><tbody>${data.map((r, i) => '<tr>' + fn(r, i).map(x => `<td>${x}</td>`).join('') + '</tr>').join('')}</tbody></table></div></section>`; }
function detailButton(i, text = '查看') { return `<button class="button small" data-detail="${i}">${esc(text)}</button>`; }
const imageUrls = new Set(), imageRequests = new Set();
let imageGeneration = 0, detailSequence = 0;
function clearImages() {
  imageGeneration++;
  for (const controller of imageRequests) controller.abort();
  imageRequests.clear();
  for (const url of imageUrls) URL.revokeObjectURL(url);
  imageUrls.clear();
}
function replyImages(row) {
  const attachments = row.data?.message?.attachments || [];
  if (!attachments.length) return '';
  return `<div class="reply-images" aria-label="回复图片">${attachments.map((image, index) => `<figure class="reply-image"><figcaption>图片 ${index + 1}<span>${esc(image.mimeType || '')} · ${number(Math.ceil((image.bytes || 0) / 1024))} KB</span></figcaption><button class="button small" data-image-id="${esc(row.id)}" data-image-index="${index}" data-image-source="${esc(source)}">查看图片 ${index + 1}</button><span class="image-error" role="status"></span></figure>`).join('')}</div>`;
}
function replyText(message, fallback = '') {
  return message?.text || (message?.files?.length ? '文件回复' : message?.attachments?.length ? '图片回复' : fallback);
}
function fileSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '大小未记录';
  const unit = bytes >= 1024 * 1024 ? 'MiB' : bytes >= 1024 ? 'KiB' : 'B';
  return (bytes / (unit === 'MiB' ? 1024 * 1024 : unit === 'KiB' ? 1024 : 1)).toLocaleString('zh-CN', { maximumFractionDigits: 1 }) + ' ' + unit;
}
function fileDeliveryReason(reason) {
  return ({ invalid_room_scope: '目标群已不在允许的发送范围。', unsupported_output: '文件上传配置不可用。', invalid_output_file: '文件缺失、被修改或超出大小限制。', dedupe_key_conflict: '文件与已登记的投递内容不一致。', missing_file_id: '平台未返回文件标识，无法确认上传结果。', action_failed: '平台拒绝上传，请检查群文件权限及桥接支持。', not_connected: '机器人尚未连接，等待恢复后继续。', too_many_pending_actions: '平台请求繁忙，等待稍后继续。', timeout: '等待平台回执超时，上传结果尚未确认。', disconnected: '连接中断，上传结果尚未确认。', connection_replaced: '连接已切换，上传结果尚未确认。', closed: '连接已关闭，上传结果尚未确认。', write_failed: '发送请求时连接异常，上传结果尚未确认。', pending: '平台尚未确认上传结果。', invalid_response: '平台返回的上传回执无效。', upload_error: '上传结果尚未确认，请查看审计记录。', upload_result_unknown: '平台处理上传时发生异常，文件可能已收到，请人工核对。', interrupted_delivery: '服务在上传期间中断，结果未知，不会自动重传。', file_upload_unavailable: '当前平台尚未提供群文件上传能力。', file_delivery_mismatch: '文件与保存的上传记录不一致，请查看审计记录。', file_delivery_unknown: '文件上传结果未知，不会自动重传。', file_upload_error: '文件上传发生异常，结果未知，不会自动重传。', service_stopping: '服务正在停止，等待恢复后继续。' })[reason] || '文件未完成确认，请查看审计记录。';
}
function replyFiles(row) {
  const files = row.data?.message?.files || [];
  if (!files.length) return '';
  const deliveries = row.data?.fileDeliveries || [], parentStatus = row.status || row.data?.status;
  const uploaded = files.filter(file => deliveries.some(item => item.artifactId === file.artifactId && item.status === 'sent')).length;
  const uncertain = files.some(file => deliveries.some(item => item.artifactId === file.artifactId && item.status === 'unknown'));
  const stopped = ['stale', 'cancelled'].includes(parentStatus);
  const note = uncertain ? '上传结果未知的文件不会自动重传，后续投递已停止。' : stopped ? '后续上传已停止；已经上传的文件不会撤回。' : '文件上传到群文件；全部确认后再发送回复正文。';
  return `<section class="reply-files" aria-label="回复文件"><div class="reply-files-heading"><strong>群文件</strong><span>已上传 ${number(uploaded)} / ${number(files.length)}</span></div><ul>${files.map((file, index) => {
    const delivery = deliveries.find(item => item.artifactId === file.artifactId), status = delivery?.status || 'pending';
    const waiting = ['failed', 'unknown', 'stale', 'cancelled'].includes(parentStatus);
    const statusText = ({ sent: '已上传', sending: '上传中', failed: '上传失败', unknown: '上传结果未知', pending: waiting ? '未上传' : '待上传' })[status] || '状态未记录';
    const style = ['failed', 'unknown'].includes(status) ? 'fail' : status === 'sent' ? '' : status === 'sending' || status === 'pending' && !waiting ? 'warn' : 'neutral';
    const name = String(file.name || '文件 ' + (index + 1)).split(/[\\/]/).pop();
    const reason = delivery?.reason || (['failed', 'unknown'].includes(parentStatus) ? row.data?.reason : undefined);
    return `<li class="reply-file"><span class="reply-file-icon" aria-hidden="true">▤</span><div class="reply-file-body"><div class="reply-file-heading"><strong>${esc(name)}</strong><span class="badge ${style}">${statusText}</span></div><div class="reply-file-meta"><span>${esc(fileSize(file.bytes))}</span>${delivery?.attempts ? `<span>已尝试 ${number(delivery.attempts)} 次</span>` : ''}${status === 'sent' && delivery.sentAt ? `<span>${time(delivery.sentAt)}</span>` : ''}</div>${reason && status !== 'sent' ? `<p class="reply-file-reason">${esc(fileDeliveryReason(reason))}</p>` : ''}</div></li>`;
  }).join('')}</ul><p class="reply-files-note">${note}</p></section>`;
}
function replyAttachmentSummary(row) {
  const message = row.data?.message || {}, parts = [];
  if (message.attachments?.length) parts.push(number(message.attachments.length) + ' 张图片');
  if (message.files?.length) {
    const uploaded = message.files.filter(file => (row.data?.fileDeliveries || []).some(item => item.artifactId === file.artifactId && item.status === 'sent')).length;
    parts.push(number(message.files.length) + ' 个文件 · 已上传 ' + number(uploaded) + '/' + number(message.files.length));
  }
  return parts.length ? `<div class="table-sub">${parts.join(' · ')}</div>` : '';
}
async function loadReplyImage(button) {
  if (button.disabled || button.dataset.imageSource !== source) return;
  const generation = imageGeneration, requestedSource = source, controller = new AbortController();
  const figure = button.closest('figure'), error = figure.querySelector('.image-error');
  button.disabled = true; button.textContent = '正在加载…'; error.textContent = ''; imageRequests.add(controller);
  try {
    const url = '/api/outbox/' + encodeURIComponent(button.dataset.imageId) + '/images/' + button.dataset.imageIndex + '?source=' + encodeURIComponent(requestedSource);
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error('图片不存在或已不可用。');
    const blob = await response.blob();
    if (generation !== imageGeneration || source !== requestedSource || !button.isConnected || !$('detail').open) return;
    const objectUrl = URL.createObjectURL(blob); imageUrls.add(objectUrl);
    const img = document.createElement('img'); img.src = objectUrl; img.alt = '回复图片 ' + (Number(button.dataset.imageIndex) + 1);
    const link = document.createElement('a'); link.href = objectUrl; link.target = '_blank'; link.rel = 'noopener'; link.title = '查看原图'; link.append(img);
    button.replaceWith(link);
  } catch (e) {
    if (generation !== imageGeneration || controller.signal.aborted) return;
    error.textContent = e.message; button.disabled = false; button.textContent = '重新加载图片';
  } finally { imageRequests.delete(controller); }
}
function notice(message = '', success = false) { $('notice').textContent = message; $('notice').classList.toggle('success', success); }
async function api(path, options = {}) {
  const query = new URLSearchParams(path === 'memory' || path.startsWith('memory/') ? { source, ...options.query } : { source, offset: String(offset), room: $('room').value, kind: $('conversation-kind')?.value || '', status: $('status').value, ...options.query });
  const response = await fetch('/api/' + path + (options.method ? '' : '?' + query), { method: options.method || 'GET', ...(options.signal ? { signal: options.signal } : {}), ...(options.body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(options.body) } : {}) });
  const text = await response.text(); let data; try { data = JSON.parse(text); } catch { throw new Error('请求未完成（HTTP ' + response.status + '），请检查本地服务。'); }
  if (!response.ok) throw new Error(data.error || '读取失败，请稍后重试。');
  return data;
}
function configureView() {
  $('title').textContent = titles[view]; $('breadcrumb-view').textContent = titles[view]; $('subtitle').textContent = subtitles[view];
  $('source').hidden = view === 'business' || view === 'private';
  document.querySelector('main').classList.toggle('schedules-view', view === 'schedules');
  $('filters').hidden = view === 'schedules' || !statusOptions[view]; $('pager').hidden = !['threads', 'messages', 'decisions', 'outbox', 'schedules'].includes(view);
  $('refresh-note').hidden = view !== 'overview'; $('page').textContent = '第 ' + (offset / 100 + 1) + ' 页'; $('prev').disabled = !offset;
  if ($('status').dataset.view !== view) { $('status').dataset.view = view; $('status').innerHTML = '<option value="">全部状态</option>' + (statusOptions[view] || []).map(s => `<option value="${s}">${esc(label(s))}</option>`).join(''); }
  // The API currently supports group filtering for threads and messages.
  $('room').closest('.filter-input').hidden = !['threads', 'messages', 'outbox', 'schedules'].includes(view);
  document.querySelectorAll('nav button').forEach(b => { b.classList.toggle('active', b.dataset.view === view); if (b.dataset.view === view) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
  keepNavigationVisible();
}
function keepNavigationVisible() {
  if (!window.matchMedia('(max-width: 700px)').matches) return;
  const nav = document.querySelector('nav'), active = nav.querySelector('.active');
  if (active) nav.scrollLeft += active.getBoundingClientRect().left - nav.getBoundingClientRect().left - 12;
}
window.addEventListener('resize', keepNavigationVisible);
function metric(title, value, suffix, foot, icon, warning = false) { return `<section class="metric ${warning ? 'warning' : ''}"><div class="metric-top"><span>${esc(title)}</span><span class="metric-icon">${icon}</span></div><div class="metric-value">${esc(value)}${suffix ? `<span class="unit">${esc(suffix)}</span>` : ''}</div><div class="metric-foot">${esc(foot)}</div></section>`; }
function taskTokenCell(usage) {
  if (!usage?.recordCount) return '<span class="muted">未记录</span>';
  return `<div class="token-usage-inline"><span>输入 ${usage.unknownRecords === usage.recordCount ? '未知' : number(usage.inputTokens)}</span><span>输出 ${usage.unknownRecords === usage.recordCount ? '未知' : number(usage.outputTokens)}</span></div>${usage.missingRuns || usage.incompleteRecords ? '<div class="table-sub">用量记录不完整</div>' : ''}`;
}
function taskTokenDetails(usage) {
  const totals = usage?.recordCount ? `<div class="token-totals"><div><span>输入 token</span><strong>${usage.unknownRecords === usage.recordCount ? '未知' : number(usage.inputTokens)}</strong></div><div><span>输出 token</span><strong>${usage.unknownRecords === usage.recordCount ? '未知' : number(usage.outputTokens)}</strong></div></div><p class="table-sub">输入中：未缓存 ${number(usage.uncachedInputTokens)} · 缓存读取 ${number(usage.cacheReadTokens)} · 缓存写入 ${number(usage.cacheWriteTokens)}</p>` : '<p class="muted">尚无已记录用量。</p>';
  const runs = usage?.runs?.length ? `<details class="technical"><summary>按执行查看 · ${number(usage.runs.length)} 组</summary><div class="table-wrap"><table><thead><tr><th>执行</th><th>状态</th><th>输入 token</th><th>输出 token</th></tr></thead><tbody>${usage.runs.map(run => `<tr><td class="mono">${esc(run.runId || '早期记录（无执行编号）')}</td><td>${run.status ? badge(run.status) : '<span class="muted">—</span>'}</td><td>${run.unknownRecords === run.recordCount ? '未知' : run.recordCount ? number(run.inputTokens)+(run.incompleteRecords?'（部分）':'') : '未记录'}</td><td>${run.unknownRecords === run.recordCount ? '未知' : run.recordCount ? number(run.outputTokens)+(run.incompleteRecords?'（部分）':'') : '未记录'}</td></tr>`).join('')}</tbody></table></div></details>` : '';
  return `<section class="detail-section"><h3>任务 token 用量</h3>${totals}${usage?.incompleteRecords ? `<p class="panel-description">${number(usage.incompleteRecords)} 条记录有模型未返回用量，已知累计不等于实际总量。</p>` : ''}${usage?.missingRuns ? `<p class="panel-description">有 ${number(usage.missingRuns)} 次执行尚无用量记录，当前累计可能不完整。</p>` : ''}<p class="panel-description">累计本任务已记录的 Worker 用量，含多次执行、格式修复及上下文摘要。输入包含缓存读取和写入；共享的 Router 与独立记忆调用不计入。包含失败、重试和中止时已报告的用量；未返回用量的调用标为未知，显示的累计是已知部分。运行中本轮结束后更新。</p>${runs}</section>`;
}
function overview(data, recent) {
  const active = count(data.threads, 'running'), queued = count(data.threads, 'queued'), needsInput = count(data.threads, 'needs_input');
  const problem = count(data.outbox, 'failed') + count(data.outbox, 'unknown') + count(data.threads, 'failed');
  const metrics = (data.metrics || []).map(x => x.data || {}), routerCalls = metrics.filter(x => x.role === 'router' && Number.isFinite(x.elapsedMs));
  const sortedLatency = routerCalls.map(x => x.elapsedMs).sort((a, b) => a - b);
  const latency = sortedLatency.length ? ((sortedLatency[Math.floor((sortedLatency.length - 1) / 2)] + sortedLatency[Math.ceil((sortedLatency.length - 1) / 2)]) / 2000).toFixed(1) : '—';
  const input = metrics.reduce((sum, x) => sum + (x.inputTokens || 0) + (x.cacheReadTokens || 0) + (x.cacheWriteTokens || 0), 0), output = metrics.reduce((sum, x) => sum + (x.outputTokens || 0), 0);
  const total = (data.threads || []).reduce((sum, x) => sum + Number(x.n), 0), completed = count(data.threads, 'idle');
  const archived = source !== 'main', state = data.running ? '服务在线' : archived ? '历史验证记录' : '服务未运行';
  const title = data.running ? active ? `${active} 个任务正在处理中` : '已就绪，等待下一个好问题' : archived ? '一次对话的完整运行记录' : '你的群聊工作台';
  const description = data.running ? 'Router 负责自然接话，Worker 按技能调用工具。所有处理过程都可在这里追溯。' : archived ? '当前展示已保存的终端验证。切换到「当前服务」，可查看群聊机器人的实时运行情况。' : '后台已连接。启动群聊机器人后，消息、任务进度与任务回答会在这里实时更新。';
  const tasks = recent.length ? `<div class="task-list">${recent.slice(0, 6).map((row, i) => `<div class="task-row"><div class="task-symbol">${row.status === 'running' ? '↻' : String(i + 1).padStart(2, '0')}</div><div class="task-body"><div class="task-name">${esc(row.data?.subject || '未命名话题')}</div><div class="task-meta"><span>${esc(row.room)}</span><span>·</span><span>${time(row.updated)}</span></div></div><div class="task-actions">${badge(row.status)}<button class="button small" data-thread-id="${esc(row.id)}">追踪</button></div></div>`).join('')}</div>` : empty('尚未启动任务', '有需要查证或工具处理的问题时，Worker 会在这里开始工作。');
  const alerts = (data.errors || []).length ? data.errors.slice(0, 4).map(item => `<div class="alert-item"><p><strong>${esc(errorName(item.kind))}</strong><br>${esc(short(item.data?.error || item.data?.message || item.data?.reason || item.data?.code || '请展开记录查看详情。', 180))}</p><time>${time(item.at)}</time>${raw(item)}</div>`).join('') : '<div class="all-good"><div class="check-circle">✓</div><div><strong>一切平稳</strong><p>没有已记录的异常。</p></div></div>';
  const routing = data.router;
  const routerHealth = routing ? `<section class="panel"><div class="panel-head"><div><h2>消息路由恢复</h2><p class="panel-description">等待 ${number(routing.waiting?.count || 0)} 条 · 最久 ${routing.waiting?.oldestAt ? Math.max(0, Math.round((Date.now()-routing.waiting.oldestAt)/1000)) : 0} 秒</p></div></div><div class="task-list">${(routing.turns || []).slice(0,5).map(turn=>`<div class="router-turn"><div class="task-body"><div class="task-name">${esc(turn.room)}</div><div class="task-meta">模型 ${number(turn.model_calls)} 次 · 摘要 ${number(turn.summary_calls)} 次 · 重建 ${number(turn.rebuilds)} 次 · ${esc(turn.state)}${turn.error?' · '+esc(short(turn.error,160)):''}</div></div>${raw(turn)}</div>`).join('')}</div><div class="callout">最近 ${number((routing.calls || []).length)} 次底层调用包含失败尝试；摘要失败原因和用量保留在轨迹中。</div></section>` : '';
  return `<section class="hero"><div><div class="hero-overline"><span class="status-light ${data.running ? '' : 'offline'}"></span>${state}<span class="pill">LOCAL</span></div><h2>${esc(title)}</h2><p>${esc(description)}</p></div><div class="hero-side"><small>当前活跃任务</small><strong>${active}<span>个</span></strong><span>${queued} 个排队 · ${needsInput} 个等待补充</span></div></section>
    <div class="metrics-grid">${metric('已接收消息', number(data.messages), '', '当前数据源累计', '▱')}${metric('成功回复', number(count(data.outbox, 'sent')), '', '已确认发送的消息', '↗')}${metric('Router 响应中位数', latency, latency === '—' ? '' : 's', `最近 ${routerCalls.length} 次调用 · P50`, '◷')}${metric('需要处理', number(problem), '', problem ? '任务失败或投递异常' : '没有待检查的失败记录', '!', problem > 0)}</div>
    ${routerHealth}<div class="dashboard-grid"><div><section class="panel"><div class="panel-head"><div><div class="section-kicker">RECENT ACTIVITY</div><h2>最近任务话题</h2></div><button class="button subtle small" data-go="threads">查看全部 →</button></div>${tasks}</section><section class="panel"><div class="panel-head"><div><h2>运行提醒</h2><p class="panel-description">最近的异常与需要关注的事件</p></div><span class="count-chip">${(data.errors || []).length}</span></div>${alerts}</section></div>
    <div class="dashboard-side"><section class="panel"><div class="panel-head"><div><div class="section-kicker">TASK HEALTH</div><h2>任务状态</h2></div><span class="count-chip">共 ${total} 个</span></div><div class="status-list"><div class="status-row"><span class="status-label"><i class="status-dot"></i>正在处理</span><strong>${active}</strong></div><div class="status-row"><span class="status-label"><i class="status-dot amber"></i>排队等待</span><strong>${queued}</strong></div><div class="status-row"><span class="status-label"><i class="status-dot gray"></i>等待补充</span><strong>${needsInput}</strong></div><div class="status-row"><span class="status-label"><i class="status-dot gray"></i>已完成</span><strong>${completed}</strong></div></div><div class="health-divider"></div><div class="info-line"><span>已完成话题</span><strong>${completed} / ${total}</strong></div><progress class="progress" value="${completed}" max="${Math.max(total, 1)}" aria-label="已完成话题"></progress><p class="panel-description">每个话题保留输入、模型会话和回复记录。</p></section>
    <section class="panel"><div class="panel-head"><div><div class="section-kicker">MODEL USAGE</div><h2>模型用量</h2></div></div><div class="usage-total">${number(input + output)}<small>tokens</small></div><div class="usage-legend"><span>输入 <strong>${number(input)}</strong></span><span>输出 <strong>${number(output)}</strong></span></div><div class="callout">最近 ${metrics.length} 条用量记录<br>输入包含缓存，由模型返回的用量汇总，不含费用估算。</div></section></div></div>`;
}
function errorName(kind) { return ({ image_input: '图片未能传入模型', tick: '调度检查异常', batch_tick: '批量调度异常', batch_failed: '批量消息处理失败', router_attempt: '路由调用重试', steer: '任务补充异常', cancel: '任务取消异常', worker: '任务异常', result: '结果处理异常', run_failed: '任务执行失败', result_router: '结果路由异常', platform: '群聊连接事件', worker_error: '任务执行异常', router_error: '消息路由异常', delivery_error: '回复投递异常', outbox_error: '回复投递异常', reconnect: '连接状态更新', error: '运行异常' })[kind] || kind || '运行事件'; }
function modelForm(data, role) {
  const selection = data[role] || {}, provider = data.providers?.[selection.provider] || {}, isRouter = role === 'router';
  const configured = data[role + 'ApiKeyConfigured'] ?? data.apiKeyConfigured ?? false;
  const protocol = selection.api || provider.api || 'openai-responses';
  const choices = [{ id: 'openai-responses', label: 'OpenAI Responses' }, { id: 'openai-completions', label: 'OpenAI Chat Completions' }, { id: 'anthropic-messages', label: 'Anthropic Messages' }];
  return `<section class="panel model-card"><div class="model-role"><div class="role-mark ${isRouter ? '' : 'worker'}">${isRouter ? 'R' : 'W'}</div><div><h2>${isRouter ? 'Router · 日常接话' : 'Worker · 任务处理'}</h2><p class="panel-description">${isRouter ? '快速识别群消息，决定回应与任务分配。' : '按技能查证资料、使用工具并给出回答。'}</p></div></div><form data-model-role="${role}"><div class="form-grid"><div class="form-field wide"><label for="${role}-model">模型名称</label><input id="${role}-model" name="model" value="${esc(selection.model)}" placeholder="供应商提供的 model ID" required maxlength="160" autocomplete="off"></div><div class="form-field wide"><label for="${role}-baseUrl">API Endpoint</label><input id="${role}-baseUrl" name="baseUrl" type="url" value="${esc(selection.baseUrl || provider.baseURL || data.baseUrl || '')}" placeholder="https://api.example.com/v1" required autocomplete="off"><span class="field-help">填写 API 基础地址，无需附加 /responses 等接口路径。</span></div><div class="form-field"><label for="${role}-api">API 协议</label><select id="${role}-api" name="api">${choices.map(x => `<option value="${x.id}" ${x.id === protocol ? 'selected' : ''}>${x.label}</option>`).join('')}</select></div><div class="form-field"><label for="${role}-reasoning">推理强度</label><select id="${role}-reasoning" name="reasoningEffort">${['off', 'low', 'medium', 'high', 'xhigh', 'max'].map(x => `<option value="${x}" ${x === selection.reasoningEffort ? 'selected' : ''}>${({ off: '关闭 · Off', low: '低 · Low', medium: '中 · Medium', high: '高 · High', xhigh: '极高 · XHigh', max: '最大 · Max' })[x]}</option>`).join('')}</select></div><div class="form-field wide"><div class="key-label"><label for="${role}-apiKey">独立 API Key</label><span class="badge ${configured ? '' : 'neutral'}" data-key-state>${configured ? '已配置' : '未配置'}</span></div><input id="${role}-apiKey" name="apiKey" type="password" placeholder="${configured ? '已配置，留空保持不变' : '输入该角色使用的 API Key'}" autocomplete="new-password" spellcheck="false"><span class="field-help">凭据不会回显。留空保留当前 Key，保存后下一次调用生效。</span></div></div><div class="form-actions"><span class="form-message" role="status"></span><button class="button primary" type="submit">保存 ${isRouter ? 'Router' : 'Worker'}</button></div></form></section>`;
}
function openVikingModelForm(data = {}) {
  const header = '<div class="model-role"><div class="role-mark memory-role">M</div><div><h2>OpenViking · 记忆提炼</h2><p class="panel-description">从群聊中整理长期记忆与成员画像。</p></div></div>';
  if (!data.available) return '<section class="panel model-card memory-model-card">' + header + '<p class="form-message error" role="status">' + esc(data.reason || '暂时无法读取记忆模型配置，请稍后刷新。') + '</p></section>';
  const state = data.restarting ? '正在应用' : data.restartRequired ? '待应用' : '已生效';
  const options = [{ value: 'default', text: '跟随模型默认' }, { value: 'disabled', text: '关闭' }, { value: 'enabled', text: '开启' }];
  return `<section class="panel model-card memory-model-card">${header}<form data-openviking-model data-revision="${esc(data.revision)}" data-restart-supported="${Boolean(data.restartSupported)}" data-restarting="${Boolean(data.restarting)}"><div class="form-grid"><div class="form-field"><label for="openviking-model">模型名称</label><input id="openviking-model" name="model" value="${esc(data.model)}" placeholder="供应商提供的 model ID" required maxlength="160" autocomplete="off"></div><div class="form-field"><label for="openviking-baseUrl">API Endpoint</label><input id="openviking-baseUrl" name="baseUrl" type="url" value="${esc(data.baseUrl)}" placeholder="https://api.example.com/v1" required autocomplete="off"><span class="field-help">填写 API 基础地址，无需附加 /chat/completions。</span></div><div class="form-field"><label for="openviking-api">API 协议</label><input id="openviking-api" value="OpenAI Chat Completions" readonly></div><div class="form-field"><label for="openviking-thinking">思考模式</label><select id="openviking-thinking" name="thinking">${options.map(option => `<option value="${option.value}"${option.value === data.thinking ? ' selected' : ''}>${option.text}</option>`).join('')}</select><span class="field-help">开启或关闭需模型支持 thinking 参数，否则选择跟随模型默认。</span></div><div class="form-field wide"><div class="key-label"><label for="openviking-apiKey">独立 API Key</label><span class="badge ${data.apiKeyConfigured ? '' : 'neutral'}" data-key-state>${data.apiKeyConfigured ? '已配置' : '未配置'}</span></div><input id="openviking-apiKey" name="apiKey" type="password" placeholder="${data.apiKeyConfigured ? '已配置，留空保持不变' : '输入记忆提炼使用的 API Key'}" autocomplete="new-password" spellcheck="false"><span class="field-help">凭据不会回显。留空保留当前 Key。</span></div></div><p class="panel-description memory-model-help">配置作用于当前记忆服务。应用时会自动重启记忆服务，期间记忆读写可能短暂不可用。</p>${!data.restartSupported ? '<p class="form-message error">当前记忆服务不支持自动应用，保存后需由部署端重启。</p>' : ''}<div class="form-actions"><div><span class="badge ${data.restartRequired || data.restarting ? 'warn' : ''}" data-apply-state>${state}</span><span class="form-message" role="status" aria-live="polite"></span></div><div class="model-action-buttons"><button class="button" type="button" data-openviking-apply${data.restartRequired ? '' : ' hidden'}${!data.restartSupported || data.restarting ? ' disabled' : ''}>重新应用</button><button class="button primary" type="submit"${data.restarting ? ' disabled' : ''}>保存并应用</button></div></div></form></section>`;
}
function activationForm(data) {
  return `<section class="panel activation-card"><div class="panel-head"><div><h2>唤起关键字</h2><p class="panel-description">设置群友可以直接呼唤机器人的称呼，适用于所有群。</p></div><span class="badge warn">重启机器人后生效</span></div><form data-activation-config><div class="form-field"><label for="bot-call-names">机器人称呼 / 关键字</label><textarea id="bot-call-names" name="botCallNames" rows="5" aria-describedby="activation-help activation-behavior" placeholder="例如：助手&#10;机器人" spellcheck="false">${esc((data.botCallNames || []).join('\n'))}</textarea><span id="activation-help" class="field-help">每行一个，也可用中英文逗号分隔；最多 32 个，每个最多 80 个字符。保存时自动去重，英文不区分大小写。</span></div><p id="activation-behavior" class="panel-description activation-help">@ 机器人始终可以唤起；清空关键字后仅通过 @ 唤起。消息中出现关键字后，仍会判断是否在直接呼唤机器人，普通提及或转述不会自动回应。</p><div class="form-actions"><span class="form-message" role="status">当前显示已保存的关键字；修改后需重启机器人生效。</span><button class="button primary" type="submit">保存唤起关键字</button></div></form></section>`;
}
let businessState, businessSequence = 0;
const businessIds = text => [...new Set(String(text || '').split(/[\s,，]+/u).map(value => value.trim()).filter(Boolean))];
const businessRoomText = rooms => Object.entries(rooms).map(([room, id]) => room + ' = ' + id).join('\n');
const businessTabs = { prompts: '业务提示词', capabilities: '技能与工具', memory: '记忆与风格', scope: '群与默认配置' };
function businessChoices(chosen) {
  return Object.entries(businessState.settings.profiles).map(([id, item]) => `<option value="${esc(id)}"${id === chosen ? ' selected' : ''}>${esc(item.name)} · ${esc(id)}</option>`).join('');
}
function businessCapabilities(kind, selected, items = []) {
  const known = new Set(items.map(item => item.id));
  const entries = [...items.filter(item => !item.core), ...selected.filter(id => !known.has(id)).map(id => ({ id, unavailable: true }))];
  return `<div class="business-options">${entries.length ? entries.map(item => {
    const unavailable = item.unavailable || item.enabled === false, checked = selected.includes(item.id);
    return `<label class="business-option${unavailable ? ' unavailable' : ''}"><input type="checkbox" data-business-capability="${kind}" value="${esc(item.id)}"${checked ? ' checked' : ''}${unavailable && !checked ? ' disabled' : ''}><span><span class="business-option-name">${esc(item.label || item.name || item.id)}${unavailable ? '<span class="badge warn">当前不可用</span>' : ''}</span>${item.label || item.name && item.name !== item.id ? `<code>${esc(item.id)}</code>` : ''}<span class="business-option-description">${esc(unavailable ? '未注册或已停用。请取消选择，或先在部署配置中恢复此能力。' : item.description || (kind === 'extensions' ? '为 Worker 提供专用工具、运行指引与执行处理。' : '由 Worker 按任务需要读取使用。'))}</span></span></label>`;
  }).join('') : '<p class="business-empty">还没有注册可选项。先在部署配置中注册，刷新后即可选择。</p>'}</div>`;
}
function businessRoomRow(room = '', id = businessState.selected, index = 0) {
  return `<div class="business-room-row"><div class="form-field"><label for="business-room-${index}">完整群作用域</label><input id="business-room-${index}" data-business-room value="${esc(room)}" placeholder="qq:机器人账号:群号" maxlength="256" autocomplete="off"></div><div class="form-field"><label for="business-room-profile-${index}">使用的业务</label><select id="business-room-profile-${index}" data-business-room-profile>${businessChoices(id)}</select></div><button class="button small" type="button" data-business-room-remove aria-label="移除此会话绑定">移除</button></div>`;
}
function businessPersona(profile) {
  const text = profile.personaText || '';
  const loadError = profile.personaFile && typeof profile.personaText !== 'string' ? businessState.personaLoadErrors?.[businessState.selected] || '现有人格内容无法载入。' : '';
  return `<section class="business-section business-persona-section" aria-labelledby="business-persona-heading">
    <div class="business-section-heading"><div><h3 id="business-persona-heading">业务专属人格</h3><p>为当前业务设置语气、称呼和表达风格，Router 和 Worker 共用。服务范围和任务要求由业务提示词与技能决定。</p></div></div>
    <div class="business-prompt-card"><div class="business-field-heading"><div><label for="business-persona">人格与表达风格 <span class="business-term">可选</span></label><p id="business-persona-help">直接填写人格内容，支持 Markdown。留空时不加载额外人格。</p></div><span class="badge neutral">两个角色共用</span></div>
    <div class="business-example">例如：表达简洁自然，先给结论再补充解释；称呼用户为“你”，避免夸张和反复寒暄。</div>
    ${loadError ? `<div class="business-persona-error" role="alert" data-business-persona-error>${esc(loadError)} 请在下方填写替代内容，或点击“清空人格”后保存。</div>` : ''}
    <textarea id="business-persona" rows="12" data-business-limit="8000" placeholder="写下希望它采用的语气、称呼、表达习惯与回复风格。" aria-describedby="business-persona-help">${esc(text)}</textarea>
    <div class="business-editor-foot"><span>随“保存全部配置”保存，新调用生效。</span><span data-business-count="business-persona">${[...text].length.toLocaleString()} / 8,000</span></div></div>
    <div class="business-persona-actions"><span class="field-help">使用同一业务的群采用相同人格。</span><button class="button small subtle" type="button" data-business-persona-clear>清空人格</button></div>
  </section>`;
}
function updateBusinessPersonaEditor() {
  const field = $('business-persona'); field.dataset.edited = 'true';
  document.querySelector('[data-business-persona-error]')?.setAttribute('hidden', '');
  const count = document.querySelector('[data-business-count="business-persona"]');
  if (count) { count.textContent = [...field.value].length.toLocaleString() + ' / 8,000'; count.classList.toggle('over-limit', [...field.value].length > 8000); }
}
function clearBusinessPersona() {
  if (businessState.saving) return;
  $('business-persona').value = ''; updateBusinessPersonaEditor(); businessDirty(); $('business-persona').focus();
}
function businessPage() {
  const settings = businessState.settings, selected = businessState.selected, profile = settings.profiles[selected], catalog = businessState.catalog || {};
  businessState.baseline ??= JSON.stringify(settings); businessState.tab ??= 'prompts'; businessState.roomDraft ??= businessRoomText(settings.roomProfiles);
  const tabs = Object.entries(businessTabs).map(([id, label], index) => `<button type="button" id="business-tab-${id}" role="tab" aria-selected="${businessState.tab === id}" aria-controls="business-pane-${id}" tabindex="${businessState.tab === id ? '0' : '-1'}" data-business-tab="${id}"><span>${String(index + 1).padStart(2, '0')}</span>${label}</button>`).join('');
  const pane = id => `id="business-pane-${id}" role="tabpanel" aria-labelledby="business-tab-${id}"${businessState.tab === id ? '' : ' hidden'}`;
  const rooms = businessState.roomDraft.split('\n').filter(line => line.trim()).map((line, index) => { const parts = line.split('='); return businessRoomRow(parts[0]?.trim() || '', parts[1]?.trim() || selected, index); }).join('');
  return `<div class="business-workspace">
    <section class="business-profile-bar"><div class="form-field"><label for="business-selected">正在编辑的业务</label><select id="business-selected">${businessChoices(selected)}</select></div><div class="business-profile-meta"><span class="badge neutral">${Object.keys(settings.profiles).length} 个业务配置</span><span>独立定义服务范围与可用能力</span></div><button class="button" type="button" data-business-add>＋ 新增业务配置</button></section>
    <form data-business-config data-revision="${esc(businessState.revision)}" novalidate>
      <section class="panel business-panel">
        <div class="business-heading"><div><div class="section-kicker">BUSINESS PROFILE</div><h2>${esc(profile.name)}</h2><p><code>${esc(selected)}</code><span>${profile.skillIds.length} 项技能 · ${profile.extensionIds.length} 个工具扩展</span></p></div><span class="badge${businessState.dirty ? ' warn' : ''}" data-business-state>${businessState.dirty ? '有未保存更改' : '已保存'}</span></div>
        <div class="business-tabs" role="tablist" aria-label="业务配置分类">${tabs}</div>
        <div class="business-pane" ${pane('prompts')}>
          <div class="business-section-intro"><h3>定义它做什么，以及如何分工</h3><p>共同背景会同时提供给两个角色。Router 判断如何回应，Worker 负责查证和执行任务。</p></div>
          <div class="form-field business-name-field"><label for="business-name">业务名称</label><input id="business-name" value="${esc(profile.name)}" maxlength="120" placeholder="给这个业务取一个容易辨认的名字"><span class="field-help">用于后台识别和选择，不会作为指令发送给模型。</span></div>
          <div class="business-prompt-card"><div class="business-field-heading"><div><label for="business-common">共同业务背景</label><p>交代服务对象、领域范围与默认条件。Router 和 Worker 都会收到。</p></div><span class="badge neutral">两个角色共用</span></div><textarea id="business-common" rows="5" maxlength="16000" placeholder="例如：主要服务哪些用户、处理哪些领域的问题、采用哪些默认前提。">${esc(profile.commonInstructions)}</textarea><div class="business-editor-foot"><span>流程细节和资料放在技能里，背景中保留共同前提即可。</span><span data-business-count="business-common">${profile.commonInstructions.length.toLocaleString()} / 16,000</span></div></div>
          <div class="business-prompt-card"><div class="business-field-heading"><div class="business-role-title"><span class="role-mark">R</span><div><label for="business-router">Router · 接话与任务分发</label><p>决定直接回答、追问澄清，还是交给 Worker。</p></div></div></div><div class="business-example">适合写：哪些问题能直接答、哪些需要查资料或工具，以及何时追问缺失条件。</div><textarea id="business-router" rows="10" maxlength="16000" placeholder="写清可以直接处理的请求，以及必须启动任务的条件。">${esc(profile.routerInstructions)}</textarea><div class="business-editor-foot"><span>只发给 Router · 分发标准由这里配置</span><span data-business-count="business-router">${profile.routerInstructions.length.toLocaleString()} / 16,000</span></div></div>
          <div class="business-prompt-card"><div class="business-field-heading"><div class="business-role-title"><span class="role-mark worker">W</span><div><label for="business-worker">Worker · 执行与交付要求</label><p>明确任务的目标、证据要求和答案标准。</p></div></div></div><div class="business-example">适合写：需要核实什么、如何使用证据、结果应包含什么，以及何时说明不确定性。</div><textarea id="business-worker" rows="10" maxlength="16000" placeholder="定义任务完成标准；详细知识、脚本用法和操作步骤放进技能。">${esc(profile.workerInstructions)}</textarea><div class="business-editor-foot"><span>只发给 Worker · 与所选技能和工具扩展配合使用</span><span data-business-count="business-worker">${profile.workerInstructions.length.toLocaleString()} / 16,000</span></div></div>
        </div>
        <div class="business-pane" ${pane('capabilities')}>
          <div class="business-section-intro"><h3>为任务选择能力</h3><p>选择本配置可用的技能和工具。Worker 按需使用技能和工具，部分扩展还会为 Router 补充分发任务所需的信息。</p></div>
          <section class="business-section"><div class="business-section-heading"><div><h3>技能 <span class="business-term">Skills</span></h3><p>提供知识、数据与操作步骤。Worker 先看到技能目录，处理相关任务时再读取技能内容。</p></div><span class="badge neutral" data-business-selected-count="skills">已选 ${profile.skillIds.length}</span></div>${businessCapabilities('skills', profile.skillIds, catalog.skills)}</section>
          <section class="business-section"><div class="business-section-heading"><div><h3>工具扩展 <span class="business-term">Extensions</span></h3><p>启动 Worker 时自动装配专用工具和运行指引，也可处理任务输入、校验输出。扩展与技能可配合使用。</p></div><span class="badge neutral" data-business-selected-count="extensions">已选 ${profile.extensionIds.length}</span></div>${businessCapabilities('extensions', profile.extensionIds, catalog.extensions)}</section>
          <p class="business-callout">取消勾选后，新任务将不再获得对应能力。列表和勾选状态来自当前部署配置，项目不预装或预选领域能力；添加新技能或扩展需先完成部署注册。</p>
        </div>
        <div class="business-pane" ${pane('memory')}>
          <div class="business-section-intro"><h3>记住什么，以什么风格交流</h3><p>成员字段补充个性化背景；人格内容控制表达方式。两者都独立于业务提示词。</p></div>
          <section class="business-section"><div class="business-section-heading"><div><h3>自定义成员字段</h3><p>这些字段由当前部署注册，项目默认不附带自定义字段。选择本配置需要记住的成员信息。Router 可记录成员明确表达的这些资料，Router 和 Worker 在后续回答中按需使用。</p></div><span class="badge neutral" data-business-selected-count="memory">已选 ${(profile.memoryFields || []).length}</span></div>${businessCapabilities('memory', profile.memoryFields || [], catalog.memoryFields)}<div class="business-core-fields"><strong>通用偏好始终可用</strong><p>${(catalog.memoryFields || []).filter(item => item.core).map(item => `<span>${esc(item.label)}</span>`).join('') || '称呼、语言、回答风格等通用成员信息，无需在这里重复选择。'}</p></div></section>
          ${businessPersona(profile)}
        </div>
        <div class="business-pane" ${pane('scope')}>
          <div class="business-section-intro"><h3>决定各个群使用哪个业务</h3><p>这一页设置影响全部业务。未单独指定的群使用默认业务；会话绑定优先于默认值。</p></div>
          <section class="business-section"><div class="form-field business-default-field"><label for="business-default">默认业务</label><select id="business-default">${businessChoices(settings.defaultProfile)}</select><span class="field-help">适用于所有未在下方单独绑定的群。切换上方“正在编辑的业务”不会改变默认业务。</span></div></section>
          <section class="business-section"><div class="business-section-heading"><div><h3>群专属业务</h3><p>群作用域由平台、机器人账号、群号共同组成。例如 qq:123456:987654。</p></div><button class="button small" type="button" data-business-room-add>＋ 添加会话绑定</button></div><div id="business-room-rows">${rooms}</div><p class="business-empty" id="business-rooms-empty"${rooms ? ' hidden' : ''}>还没有单独绑定的群，所有群使用默认业务。</p></section>
          <p class="business-callout">保存后，新调用使用新配置；已在处理中的任务继续使用启动时的配置。</p>
        </div>
      </section>
      <textarea id="business-skills" hidden>${esc(profile.skillIds.join('\n'))}</textarea><textarea id="business-extensions" hidden>${esc(profile.extensionIds.join('\n'))}</textarea><textarea id="business-memory" hidden>${esc((profile.memoryFields || []).join('\n'))}</textarea><textarea id="business-rooms" hidden>${esc(businessState.roomDraft)}</textarea>
      <div class="business-savebar"><div class="business-save-info"><strong data-business-save-label>${businessState.dirty ? '有未保存的更改' : '配置已保存'}</strong><span class="form-message" role="status" aria-live="polite">${businessState.dirty ? '保存全部配置后生效；切换页面会保留当前草稿。' : '新调用生效，在途任务保持原配置。'}</span></div><div class="business-save-actions"><button class="button subtle" type="button" data-business-discard${businessState.dirty ? '' : ' hidden'}>放弃草稿</button><button class="button" type="button" data-business-history>版本记录</button><button class="button" type="button" data-business-preview>预览提示词</button><button class="button primary" type="submit">保存全部配置</button></div></div>
    </form>
    <dialog id="business-create-dialog" class="business-create-dialog" aria-labelledby="business-create-title"><form data-business-create novalidate><div class="business-create-head"><div class="section-kicker">NEW PROFILE</div><h2 id="business-create-title">新增业务配置</h2><p>为另一种业务单独配置提示词、技能与工具。</p></div><div class="business-create-fields"><div class="form-field"><label for="business-new-name">业务名称</label><input id="business-new-name" maxlength="120" placeholder="例如：文档助手" autocomplete="off"></div><div class="form-field"><label for="business-new-id">配置 ID</label><input id="business-new-id" maxlength="128" autocomplete="off" aria-describedby="business-new-id-help"><span class="field-help" id="business-new-id-help">用于内部关联，创建后保持不变。可使用字母、数字、点、横线、下划线或冒号。</span></div><div class="form-field"><label for="business-copy-source">初始内容</label><select id="business-copy-source"><option value="">从空白配置开始</option>${businessChoices('')}</select><span class="field-help">复制已有业务会带入其提示词与能力，之后可以独立编辑；不会复制会话绑定。</span></div><p class="form-message" role="alert"></p></div><div class="business-create-actions"><button class="button" type="button" data-business-create-cancel>取消</button><button class="button primary" type="submit">创建草稿</button></div></form></dialog>
  </div>`;
}
function setBusinessTab(id, focus = false) {
  if (!Object.hasOwn(businessTabs, id)) return;
  businessState.tab = id;
  document.querySelectorAll('[data-business-tab]').forEach(button => { const active = button.dataset.businessTab === id; button.setAttribute('aria-selected', String(active)); button.tabIndex = active ? 0 : -1; });
  for (const key of Object.keys(businessTabs)) $('business-pane-' + key).hidden = key !== id;
  if (focus) $('business-tab-' + id).focus();
}
function businessDirty() {
  if (!businessState) return;
  businessState.dirty = true; businessSequence++;
  updateBusinessStatus();
}
function updateBusinessStatus(message) {
  const dirty = businessState.dirty, badge = document.querySelector('[data-business-state]'), label = document.querySelector('[data-business-save-label]');
  if (badge) { badge.textContent = dirty ? '有未保存更改' : '已保存'; badge.classList.toggle('warn', Boolean(dirty)); }
  if (label) label.textContent = dirty ? '有未保存的更改' : '配置已保存';
  const discard = document.querySelector('[data-business-discard]'); if (discard) discard.hidden = !dirty;
  const status = document.querySelector('[data-business-config] .form-message');
  if (status) { status.classList.remove('error'); status.textContent = message || (dirty ? '保存全部配置后生效；切换页面会保留当前草稿。' : '新调用生效，在途任务保持原配置。'); }
}
function collectBusinessDraft(validate = false) {
  const current = businessState.settings.profiles[businessState.selected];
  const profile = { ...current, name: $('business-name').value.trim(), commonInstructions: $('business-common').value, routerInstructions: $('business-router').value, workerInstructions: $('business-worker').value,
    skillIds: businessIds($('business-skills').value), extensionIds: businessIds($('business-extensions').value) };
  const fields = businessIds($('business-memory').value); if (fields.length || current.memoryFields) profile.memoryFields = fields;
  const personaField = $('business-persona'), personaText = personaField.value;
  const personaEdited = personaField.dataset.edited === 'true' || personaText !== (current.personaText || '');
  if (typeof current.personaText === 'string' || personaEdited) profile.personaText = personaText;
  if (personaEdited) delete profile.personaFile;
  businessState.roomDraft = $('business-rooms').value;
  const roomProfiles = {}; let roomError = '';
  for (const [index, raw] of businessState.roomDraft.split('\n').entries()) {
    if (!raw.trim()) continue;
    const match = /^\s*(\S+)\s*=\s*(\S+)\s*$/.exec(raw);
    if (!match || ['__proto__', 'constructor', 'prototype'].includes(match[1])) { roomError = `第 ${index + 1} 条会话绑定缺少有效的群作用域或业务配置。`; break; }
    if (Object.hasOwn(roomProfiles, match[1])) { roomError = `第 ${index + 1} 条会话绑定重复：同一群只能使用一个业务配置。`; break; }
    if (!Object.hasOwn(businessState.settings.profiles, match[2])) { roomError = `第 ${index + 1} 条会话绑定指向不存在的业务配置。`; break; }
    roomProfiles[match[1]] = match[2];
  }
  businessState.settings = { ...businessState.settings, defaultProfile: $('business-default').value,
    roomProfiles: roomError ? businessState.settings.roomProfiles : roomProfiles, profiles: { ...businessState.settings.profiles, [businessState.selected]: profile } };
  businessState.dirty = Boolean(roomError || JSON.stringify(businessState.settings) !== businessState.baseline);
  if (validate && roomError) { setBusinessTab('scope'); $('business-room-rows').querySelector('input')?.focus(); throw new Error(roomError); }
  if (validate) for (const [id, item] of Object.entries(businessState.settings.profiles)) {
    if (!item.name) { if (id !== businessState.selected) changeBusinessProfile(id); setBusinessTab('prompts'); $('business-name').focus(); throw new Error('请填写业务名称。'); }
    if ([...(item.personaText || '')].length > 8000) { if (id !== businessState.selected) changeBusinessProfile(id); setBusinessTab('memory'); $('business-persona').focus(); throw new Error('人格内容最多 8,000 个字符，请精简后保存。'); }
  }
  return businessState.settings;
}
function businessError(error) { const message = document.querySelector('[data-business-config] .form-message'); if (message) { message.classList.add('error'); message.textContent = error.message; } }
function changeBusinessProfile(id) {
  if (businessState.saving || !Object.hasOwn(businessState.settings.profiles, id)) return;
  collectBusinessDraft(); businessSequence++; businessState.selected = id; $('content').innerHTML = businessPage();
}
function openBusinessCreate() {
  if (businessState.saving) return;
  businessSequence++;
  const dialog = $('business-create-dialog'), form = dialog.querySelector('form');
  form.querySelector('.form-message').textContent = ''; form.querySelectorAll('[aria-invalid]').forEach(field => field.removeAttribute('aria-invalid')); $('business-new-name').value = ''; $('business-copy-source').value = '';
  let index = Object.keys(businessState.settings.profiles).length + 1; while (Object.hasOwn(businessState.settings.profiles, 'business-' + index)) index++;
  $('business-new-id').value = 'business-' + index;
  dialog.showModal(); $('business-new-name').focus();
}
function addBusinessProfile() {
  const form = document.querySelector('[data-business-create]'), message = form.querySelector('.form-message');
  const fail = (text, field) => { message.classList.add('error'); message.textContent = text; $(field).setAttribute('aria-invalid', 'true'); $(field).focus(); };
  const name = $('business-new-name').value.trim(), id = $('business-new-id').value.trim(), copy = $('business-copy-source').value;
  form.querySelectorAll('[aria-invalid]').forEach(field => field.removeAttribute('aria-invalid'));
  if (!name) return fail('请先填写业务名称。', 'business-new-name');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(id) || ['__proto__', 'constructor', 'prototype'].includes(id)) return fail('ID 需以字母或数字开头，只能包含字母、数字、点、横线、下划线或冒号。', 'business-new-id');
  if (Object.hasOwn(businessState.settings.profiles, id)) return fail('这个 ID 已被使用，请换一个。', 'business-new-id');
  if (Object.keys(businessState.settings.profiles).length >= 32) return fail('最多支持 32 个业务配置。', 'business-new-id');
  collectBusinessDraft();
  const base = copy && businessState.settings.profiles[copy];
  businessState.settings.profiles[id] = base ? { ...JSON.parse(JSON.stringify(base)), name } : { name, commonInstructions: '', routerInstructions: '', workerInstructions: '', skillIds: [], extensionIds: [] };
  $('business-create-dialog').close(); businessState.selected = id; businessState.tab = 'prompts'; businessState.dirty = true; businessSequence++;
  $('content').innerHTML = businessPage(); updateBusinessStatus('已创建“' + name + '”草稿。点击“保存全部配置”后才会生效。'); $('business-name').focus();
}
function syncBusinessRooms() {
  $('business-rooms').value = [...document.querySelectorAll('.business-room-row')].map(row => row.querySelector('[data-business-room]').value.trim() + ' = ' + row.querySelector('[data-business-room-profile]').value).join('\n');
  $('business-rooms-empty').hidden = Boolean(document.querySelector('.business-room-row')); businessDirty();
}
function addBusinessRoom() {
  const rows = $('business-room-rows'), index = Math.max(-1, ...[...rows.querySelectorAll('[data-business-room]')].map(input => Number(input.id.split('-').pop()))) + 1;
  rows.insertAdjacentHTML('beforeend', businessRoomRow('', businessState.selected, index)); syncBusinessRooms(); rows.lastElementChild.querySelector('input').focus();
}
function requestBusinessDiscard() {
  $('detail-title').textContent = '放弃未保存的更改？';
  $('detail').querySelector('.section-kicker').textContent = '草稿管理';
  $('detail-body').innerHTML = '<p>将重新读取已保存的全部业务配置。当前新增的配置、提示词修改和会话绑定草稿都会被放弃。</p><div class="form-actions"><span class="form-message" role="status"></span><button class="button" data-business-discard-confirm>放弃草稿并重新读取</button></div>'; $('detail').showModal();
}
async function discardBusinessDraft(button) {
  const state = businessState, sequence = ++businessSequence; renderSequence++; button.disabled = true;
  try { const result = await api('business-config'); if (view !== 'business' || businessState !== state || sequence !== businessSequence) return;
    businessState = { ...result, selected: result.settings.profiles[state.selected] ? state.selected : result.settings.defaultProfile, tab: state.tab }; $('detail').close(); $('content').innerHTML = businessPage();
  } catch(error) { if (button.isConnected) { button.closest('.form-actions').querySelector('.form-message').textContent = error.message; button.disabled = false; } }
}
async function saveBusiness(form) {
  if (businessState.saving) return;
  const state = businessState, message = form.querySelector('.form-message'), controls = [...form.querySelectorAll('input,textarea,select,button'), ...document.querySelectorAll('#business-selected,[data-business-add]')], disabled = controls.map(control => control.disabled);
  try {
    const settings = collectBusinessDraft(true); renderSequence++; businessSequence++; state.saving = true; form.dataset.saving = 'true'; controls.forEach(control => { control.disabled = true; }); message.classList.remove('error'); message.textContent = '正在保存全部配置…';
    const result = await api('business-config', { method: 'POST', body: { settings, revision: state.revision } });
    if (businessState !== state || !form.isConnected) return;
    Object.assign(state, result, { dirty: false, baseline: JSON.stringify(result.settings), roomDraft: businessRoomText(result.settings.roomProfiles) }); form.dataset.revision = result.revision;
    $('content').innerHTML = businessPage(); updateBusinessStatus('已保存全部配置。新调用生效，在途任务保持原配置。');
  } catch(error) { if (businessState === state && view === 'business') businessError(error); }
  finally { state.saving = false; form.dataset.saving = 'false'; controls.forEach((control, index) => { control.disabled = disabled[index]; }); }
}
async function previewBusiness() {
  const sequence = ++businessSequence;
  try {
    const settings = collectBusinessDraft(true), profileId = businessState.selected;
    const result = await api('business-config/preview', { method: 'POST', body: { settings, profileId } });
    if (sequence !== businessSequence || view !== 'business') return;
    $('detail-title').textContent = '提示词预览 · ' + profileId;
    $('detail').querySelector('.section-kicker').textContent = '当前配置预览';
    $('detail-body').innerHTML = '<p class="panel-description">' + esc(result.note) + '</p>' + (result.personaError ? '<p class="form-message error">' + esc(result.personaError) + '</p>' : '') + '<section class="detail-section"><h3>Router</h3><pre class="business-preview">' + esc(result.router) + '</pre></section><section class="detail-section"><h3>Worker</h3><pre class="business-preview">' + esc(result.worker) + '</pre></section>';
    $('detail').showModal();
  } catch(error) { businessError(error); }
}
async function showBusinessHistory() {
  const sequence = ++businessSequence;
  try {
    const history = await api('business-config/history');
    if (sequence !== businessSequence || view !== 'business') return;
    $('detail-title').textContent = '业务配置版本';
    $('detail').querySelector('.section-kicker').textContent = '版本记录';
    $('detail-body').innerHTML = '<p class="panel-description">回退将替换全部业务配置及会话绑定。其他设置不受影响；尚未保存的编辑不会保留。</p>' + (history.length ? history.map(item => '<article class="alert-item"><strong>' + esc(item.profiles.join('、')) + '</strong><p class="table-sub">' + time(item.savedAt) + ' · ' + esc(item.revision.slice(0, 12)) + '</p><button class="button small" data-business-rollback="' + esc(item.revision) + '"' + (item.revision === businessState.revision ? ' disabled' : '') + '>' + (item.revision === businessState.revision ? '当前版本' : '回退到此版本') + '</button></article>').join('') : empty('尚无历史版本', '首次保存后可查看历史和回退。'));
    $('detail').showModal();
  } catch(error) { businessError(error); }
}
async function rollbackBusiness(button) {
  if (button.disabled || businessState.saving) return;
  const state = businessState; renderSequence++; businessSequence++; state.saving = true; button.disabled = true;
  try {
    const result = await api('business-config/rollback', { method: 'POST', body: { targetRevision: button.dataset.businessRollback, revision: state.revision } });
    if (view !== 'business' || businessState !== state) return;
    businessState = { ...result, selected: result.settings.defaultProfile }; $('detail').close(); $('content').innerHTML = businessPage(); notice('已回退业务配置，新调用生效。', true);
  } catch(error) { notice(error.message); button.disabled = false; }
  finally { state.saving = false; }
}

function privateChatApplied(value) { return value.running && !value.error && value.applied?.digest === value.digest; }
function privateChatFeedback(value) {
  const current = privateChatApplied(value), applied = value.applied;
  const text = value.error ? '配置已保存，但运行服务应用失败。错误：' + (value.error.code || value.error)
    : !value.running ? '配置已保存，服务离线；启动后自动应用。'
    : current ? '已保存的配置已生效。' : '配置已保存，正在等待运行服务应用…';
  return `<p class="notice${current && !value.restartRequired ? ' success' : ''}" role="status">${esc(text)}${applied ? ' 最近应用：' + time(applied.appliedAt) : ''}${value.restartRequired ? ' QQ 身份、连接或文件桥接设置已变化，需要重启服务。' : ''}</p>${value.attachmentStorage ? '<p class="panel-description">受管附件：' + number(value.attachmentStorage.files) + ' 个，' + number(value.attachmentStorage.bytes) + ' 字节；有效引用释放后保留 ' + number(value.attachmentStorage.retentionDays || 7) + ' 天。文件到期后需要重传。</p>' : ''}`;
}
function stopPrivateStatusRefresh() {
  clearTimeout(privateStatusTimer); privateStatusRequest?.abort(); privateStatusRequest = undefined;
}
function queuePrivateStatusRefresh(form, value) {
  clearTimeout(privateStatusTimer);
  if (view !== 'private' || !form?.isConnected || form.dataset.saving === 'true' || privateChatApplied(value)) return;
  privateStatusTimer = setTimeout(() => refreshPrivateChatStatus(form), 1500);
}
async function refreshPrivateChatStatus(form) {
  if (view !== 'private' || !form?.isConnected || form.dataset.saving === 'true') return;
  const request = new AbortController(), revision = form.dataset.revision;
  privateStatusRequest?.abort(); privateStatusRequest = request;
  const current = () => view === 'private' && form.isConnected && form.dataset.revision === revision && !request.signal.aborted;
  let value;
  try {
    value = (await api('config', { signal: request.signal })).privateChatStatus;
    if (!current()) return;
    if (value.digest !== form.dataset.digest) {
      form.querySelector('.private-chat-feedback').innerHTML = '<p class="notice" role="status">配置已被其他操作修改，请刷新后再保存。</p>'; return;
    }
    // Refresh feedback only: preserve fields being edited and the version used for conflict detection.
    form.querySelector('.private-chat-feedback').innerHTML = privateChatFeedback(value);
  } catch (error) {
    if (!current()) return;
    form.querySelector('.private-chat-feedback').innerHTML = '<p class="notice" role="status">暂时无法查询生效状态，正在自动重试。' + esc(error.message) + '</p>';
  } finally {
    if (privateStatusRequest === request) privateStatusRequest = undefined;
  }
  if (current()) queuePrivateStatusRefresh(form, value || {});
}
function privateChatForm(value) {
  if (!value?.settings) return panel('QQ 好友私聊', '<p class="notice">' + esc(value?.error || '无法读取私聊配置') + '</p>');
  const s = value.settings;
  return panel('QQ 好友私聊', `<form class="private-chat-form" data-private-chat-config data-revision="${esc(value.revision)}" data-digest="${esc(value.digest)}">
    <p class="panel-description">只接收白名单内好友的一对一消息，拒绝临时会话。业务可在「业务 · 提示词」中绑定。</p>
    <div class="private-chat-toggle-row">
      <div><label id="private-chat-enabled-label" for="private-chat-enabled">启用私聊</label><p id="private-chat-enabled-help">保存后自动应用，无需重启服务。</p></div>
      <label class="private-chat-switch"><input id="private-chat-enabled" name="enabled" type="checkbox" role="switch" aria-labelledby="private-chat-enabled-label" aria-describedby="private-chat-enabled-help"${s.enabled ? ' checked' : ''}><span aria-hidden="true"></span></label>
    </div>
    <div class="private-chat-fields">
      <div class="form-field wide"><label for="private-chat-users">允许的好友 QQ 号</label><textarea id="private-chat-users" name="users" rows="4" placeholder="每行填写一个 QQ 号" aria-describedby="private-chat-users-help">${esc(s.allowedUserIds.join('\n'))}</textarea><p id="private-chat-users-help" class="field-help">每行一个，仅名单内好友可发起私聊。</p></div>
      <div class="form-field"><label for="private-chat-limit">每分钟普通消息上限</label><input id="private-chat-limit" name="limit" type="number" min="1" max="600" value="${s.maxMessagesPerMinute}"></div>
      <div class="form-field"><label for="private-chat-reply-mode">回复显示</label><select id="private-chat-reply-mode" name="replyMode"><option value="plain"${s.replyMode === 'plain' ? ' selected' : ''}>普通回复</option><option value="quote"${s.replyMode === 'quote' ? ' selected' : ''}>引用原消息</option></select></div>
    </div>
    <div class="private-chat-feedback">${privateChatFeedback(value)}</div>
    <div class="form-actions"><span class="form-message" role="status"></span><button class="button primary" type="submit">保存私聊配置</button></div>
  </form>`);
}
function deliveryResolutionPanel(row) {
  const data = row.data || row, parts = row.deliveryParts || [];
  if (!parts.length) return '';
  const labels = { confirmed_received: '人工确认收到', abandoned: '已放弃', resent: '补发已完成' };
  return '<h3>逐项投递与结案</h3><p class="panel-description">结案保留原始平台回执。后续计划需要单独恢复。</p>' + parts.map(part => `<section class="alert-item"><strong>${esc(part.name)}</strong> ${badge(part.status)}<p>${part.resolution ? esc(labels[part.resolution.reason] || part.resolution.reason) + ' · ' + esc(part.resolution.actor.kind === 'admin' ? '后台' : '本人') + ' · ' + time(part.resolution.resolvedAt) : '尚未人工结案'}</p>${source === 'main' && !data.resendOf && data.status !== 'sending' && !part.resolution && part.status !== 'sent' ? `<div class="form-actions">${part.status === 'unknown' ? `<button class="button small" data-delivery-decision="received" data-outbox="${esc(data.id)}" data-part="${esc(part.id)}" data-version="${data.resolutionVersion || 0}">确认收到</button>` : ''}<button class="button small" data-delivery-decision="abandon" data-outbox="${esc(data.id)}" data-part="${esc(part.id)}" data-version="${data.resolutionVersion || 0}">放弃本项</button></div>` : ''}</section>`).join('');
}
async function savePrivateChat(form) {
  if (form.dataset.saving === 'true') return;
  stopPrivateStatusRefresh(); form.dataset.saving = 'true';
  const button = form.querySelector('button'), status = form.querySelector('.form-message'); button.disabled = true;
  status.classList.remove('error'); status.textContent = '正在保存…';
  let saved;
  try {
    const fields = new FormData(form), settings = {enabled: fields.get('enabled') === 'on',allowedUserIds: String(fields.get('users')).split(/\s+/).filter(Boolean),maxMessagesPerMinute:Number(fields.get('limit')),replyMode:fields.get('replyMode')};
    saved = await api('config',{method:'POST',body:{settings,revision:form.dataset.revision}});
    if (!form.isConnected) return;
    form.dataset.revision = saved.revision; form.dataset.digest = saved.digest;
    form.querySelector('.private-chat-feedback').innerHTML = privateChatFeedback(saved); status.textContent = '';
  } catch (error) {status.textContent = '保存失败：' + error.message;status.classList.add('error');}
  finally {form.dataset.saving = 'false';button.disabled = false;if (saved) queuePrivateStatusRefresh(form, saved);}
}
document.addEventListener('submit', event => {
  const form = event.target.closest('[data-private-chat-config]'); if (!form) return; event.preventDefault(); void savePrivateChat(form);
});
document.addEventListener('click', async event => {
  const button = event.target.closest('[data-delivery-decision]');if (!button) return;button.disabled = true;
  try {await api('deliveries/resolve',{method:'POST',body:{outboxId:button.dataset.outbox,partIds:[button.dataset.part],decision:button.dataset.deliveryDecision,expectedResolutionVersion:Number(button.dataset.version),key:crypto.randomUUID()}});$('detail').close();await render();}
  catch(error){notice(error.message);}finally{button.disabled=false;}
});
function configPage(data, memoryModel) {
  const plugins = data.plugins || [];
  return `${activationForm(data)}<div class="info-banner"><span>↻</span><div><strong>按用途独立配置模型</strong><span>Router、Worker 与记忆提炼可使用各自的模型和 API Key。Router 与 Worker 保存后下一次调用生效；记忆提炼保存后应用到记忆服务。</span></div></div><div class="config-grid">${modelForm(data, 'router')}${modelForm(data, 'worker')}${openVikingModelForm(memoryModel)}
    <section class="panel plugins-card"><div class="panel-head"><div><div class="section-kicker">PLUGINS</div><h2>额外插件</h2></div><span class="count-chip">${plugins.length}</span></div>${plugins.length ? plugins.map(p => `<div class="plugin-item"><div class="plugin-icon">⌘</div><div><strong>${esc(String(p.module).split('/').pop())}</strong><p class="table-sub">${p.scope === 'router' ? '仅 Router' : p.scope === 'both' ? 'Router + Worker' : '仅 Worker'}</p></div><span class="badge ${p.enabled === false ? 'neutral' : ''}">${p.enabled === false ? '已停用' : '已启用'}</span></div>`).join('') : '<p class="panel-description">尚未配置额外插件。</p>'}<p class="panel-description">额外插件通过本地配置加载，可独立扩展角色的能力。</p>${raw(plugins, '查看插件配置')}</section></div><section class="panel"><details class="technical"><summary>运行配置（凭据已隐藏）</summary><pre>${esc(JSON.stringify(data, null, 2))}</pre></details></section>`;
}
function resetMemory(room = '') {
  clearTimeout(memberSearchTimer);
  Object.assign(memoryState, { room, member: '', profileOpen: false, memberQuery: '', memberItems: [], memberNextOffset: null, memberLoading: false, memberError: '', query: '', results: [], searchDone: false });
  memoryState.memberSequence++;
  memoryState.profileSequence++; memoryState.searchSequence++;
}
function memoryContext() {
  const room = memoryState.room, requestedSource = source, generation = renderSequence;
  return { room, source: requestedSource, current: () => view === 'memory' && source === requestedSource && memoryState.room === room && generation === renderSequence };
}
function memoryError(error) { return '<p class="form-message error" role="status">' + esc(error.message) + '</p>'; }
function memoryMemberButtons(members) {
  return members.map(member => '<button class="memory-member' + (member.id === memoryState.member ? ' active' : '') + '" aria-pressed="' + (member.id === memoryState.member) + '" data-memory-member="' + esc(member.id) + '"><span class="memory-avatar">' + esc(String(member.name || member.id).slice(0, 1)) + '</span><span><strong>' + esc(member.name || member.id) + '</strong><small>' + esc(member.id) + ' · ' + time(member.lastSeen) + '</small></span></button>').join('');
}
function memoryMemberFooter() {
  if (memoryState.memberLoading) return '正在加载成员…';
  if (memoryState.memberError) return '<span class="form-message error">' + esc(memoryState.memberError) + '</span><button class="button small" data-memory-retry>重试</button>';
  if (!memoryState.memberItems.length) return memoryState.memberQuery ? '没有匹配的成员' : '暂无已记录成员';
  return memoryState.memberNextOffset !== null ? '继续下拉加载更多' : '已显示全部' + (memoryState.memberQuery ? '匹配' : '') + '成员';
}
function memoryMembers() {
  return '<div id="memory-member-list" class="memory-member-list" tabindex="0" aria-label="成员列表"><div id="memory-member-items" class="memory-member-items">' + memoryMemberButtons(memoryState.memberItems) + '</div><div id="memory-member-footer" class="memory-member-footer" role="status">' + memoryMemberFooter() + '</div></div>';
}
async function loadMemoryMembers(reset = false) {
  if (view !== 'memory' || source !== 'main' || memoryState.memberLoading || (!reset && memoryState.memberNextOffset === null)) return;
  const context = memoryContext(), sequence = ++memoryState.memberSequence, query = memoryState.memberQuery;
  const offset = reset ? 0 : memoryState.memberNextOffset, list = $('memory-member-list'), items = $('memory-member-items'), footer = $('memory-member-footer');
  if (!list || !items || !footer) return;
  const current = () => context.current() && sequence === memoryState.memberSequence && query === memoryState.memberQuery && list.isConnected;
  if (reset) { memoryState.memberItems = []; items.innerHTML = ''; list.scrollTop = 0; }
  memoryState.memberLoading = true; memoryState.memberError = ''; footer.innerHTML = memoryMemberFooter();
  try {
    const data = await api('memory/members', { query: { room: context.room, q: query, offset: String(offset), limit: String(MEMORY_MEMBER_PAGE_SIZE) } });
    if (!current()) return;
    const known = new Set(memoryState.memberItems.map(member => member.id)), added = data.members.filter(member => { if (known.has(member.id)) return false; known.add(member.id); return true; });
    memoryState.memberItems.push(...added); items.insertAdjacentHTML('beforeend', memoryMemberButtons(added));
    memoryState.memberNextOffset = data.hasMore && data.nextOffset > offset ? data.nextOffset : null;
  } catch (error) { if (current()) { memoryState.memberError = error.message; memoryState.memberNextOffset = offset; } }
  finally { if (current()) { memoryState.memberLoading = false; footer.innerHTML = memoryMemberFooter(); } }
}
function searchMemoryMembers(value) {
  clearTimeout(memberSearchTimer);
  memoryState.memberQuery = value.trim(); memoryState.memberSequence++; memoryState.memberLoading = false;
  memoryState.memberItems = []; memoryState.memberNextOffset = null; memoryState.memberError = '';
  const items = $('memory-member-items'), footer = $('memory-member-footer');
  if (!items || !footer) return;
  items.innerHTML = ''; footer.textContent = '正在搜索成员…';
  const context = memoryContext();
  memberSearchTimer = setTimeout(() => { if (context.current()) loadMemoryMembers(true); }, 200);
}
const memoryFieldNames = { preferredName: '称呼', language: '语言', responseDetail: '回答详略', formatPreference: '输出格式', terminology: '术语偏好', interests: '兴趣', experience: '经验', learningGoals: '学习目标' };
function profileText(profile) {
  if (!profile) return empty('选择一位成员', '查看当前画像和每条字段的来源消息。');
  const title = '<div class="memory-profile-head"><strong>' + esc(profile.member) + '</strong><span class="table-sub">' + (profile.exists ? '明确画像第 ' + number(profile.revision) + ' 版 · ' + time(profile.updatedAt) : '尚无明确画像') + '</span></div>';
  const confirmed = '<section class="memory-profile-section" aria-label="成员明确表达"><h3>成员明确表达</h3><p class="table-sub">当前有效字段优先于自动提炼内容。</p>' + (profile.fields.length ? '<div class="memory-fields">' + profile.fields.map(field => {
    const cleared = field.state === 'cleared', state = cleared ? '已清除' : field.expired ? '已过期' : '已保存';
    const value = cleared ? '该字段已清除，不再作为当前偏好使用。' : Array.isArray(field.value) ? field.value.join('、') : field.value;
    return '<article class="memory-field"><div class="event-top"><strong>' + esc(field.label || memoryFieldNames[field.key] || field.key) + '</strong><span class="badge ' + (cleared || field.expired ? 'neutral' : '') + '">' + state + '</span></div><p class="answer-body">' + esc(value) + '</p><p class="table-sub">更新于 ' + time(field.updatedAt) + (field.scope ? ' · 适用范围：' + esc(Object.values(field.scope).join(' / ')) : '') + (field.expiresAt ? ' · 到期：' + time(field.expiresAt) : '') + '</p>' + (field.sourceAvailable ? '<button class="button small" data-memory-source="' + esc(field.sourceMessageId) + '">查看来源消息</button>' : '<span class="table-sub">来源消息当前不可用</span>') + '</article>';
  }).join('') + '</div>' : '<p class="muted">尚未保存该成员明确表达的画像字段。</p>') + '</section>';
  const automatic = profile.automatic;
  let extracted = '<p class="muted">尚无该成员的自动画像条目。</p>';
  if (automatic?.unavailable) extracted = '<p class="form-message error">自动提炼内容暂不可用，请稍后刷新；明确画像仍可查看。</p>';
  else if (automatic?.entries?.length) extracted = '<div class="memory-fields">' + automatic.entries.map(entry => {
    const verified = entry.verification === 'source_verified', sources = entry.sources || [];
    const sourceDate = verified && Number.isFinite(entry.sourceCreatedAt) ? new Date(entry.sourceCreatedAt) : null;
    const sourceTime = sourceDate && Number.isFinite(sourceDate.getTime()) ? sourceDate.toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
    return '<article class="memory-field memory-automatic-field"><div class="event-top"><strong>' + esc(entry.uri.split('/').filter(Boolean).pop() || (entry.type === 'profile' ? '画像' : '偏好')) + '</strong><span class="badge ' + (verified ? 'neutral' : 'warn') + '">' + (verified ? '来源已核对' : '待核对') + '</span></div>' + (sourceTime ? '<p class="table-sub memory-source-time">来源记录时间：' + esc(sourceTime) + '</p>' : '') + '<p class="answer-body">' + esc(entry.text) + '</p>' + (entry.truncated ? '<p class="table-sub">内容较长，当前展示已截断。</p>' : '') + '<div class="memory-source-actions"><button class="button small" data-memory-uri="' + esc(entry.uri) + '">查看记忆原文</button>' + sources.filter(item => item.available).map((item, index) => '<button class="button small" data-memory-source="' + esc(item.id) + '">来源消息 ' + (index + 1) + '</button>').join('') + '</div>' + (!sources.some(item => item.available) ? '<p class="table-sub">暂无可核对的当前成员来源消息。</p>' : sources.some(item => !item.available) ? '<p class="table-sub">部分来源消息当前不可用。</p>' : '') + '</article>';
  }).join('') + '</div>';
  return title + confirmed + '<section class="memory-profile-section" aria-label="自动提炼"><h3>自动提炼</h3><p class="table-sub">历史自述可能已变化，以本轮表达和明确画像为准；来源核对不代表成员已确认。</p>' + extracted + (automatic?.truncated ? '<p class="table-sub">当前展示部分条目，可通过群记忆检索查看其他内容。</p>' : '') + '</section>';
}
function ingestionStatus(data) {
  if (!data.tracked || !data.lanes.length) return '<p class="muted">该群尚无记忆摄取进度。</p>';
  const phaseNames = { prepared: '批次已准备', creating: '正在建立会话', appending: '正在追加消息', appended: '消息已追加', committing: '正在提交提取', archived: '正在核验归档' };
  return data.lanes.map(lane => '<article class="memory-lane"><div class="event-top"><strong>' + (lane.mode === 'sample' ? '抽样摄取' : '实时摄取') + '</strong><span class="badge ' + (lane.blocked ? 'fail' : lane.pending == null ? 'neutral' : lane.pending ? 'warn' : '') + '">' + (lane.blocked ? '需要检查' : lane.pending == null ? '进度未知' : lane.pending ? '有待处理记录' : '已覆盖目标') + '</span></div><div class="info-line"><span>已覆盖 / 目标序号</span><strong>' + number(lane.covered) + ' / ' + number(lane.target) + '</strong></div><div class="info-line"><span>待处理记录</span><strong>' + (lane.pending == null ? '—' : number(lane.pending)) + '</strong></div>' + (lane.batchPhase ? '<p class="table-sub">' + esc(phaseNames[lane.batchPhase] || lane.batchPhase) + '</p>' : '') + (lane.failures ? '<p class="table-sub">失败 ' + number(lane.failures) + ' 次' + (lane.retryAt ? ' · 重试时间 ' + time(lane.retryAt) : '') + '</p>' : '') + (lane.lastError ? '<p class="form-message error">' + esc(lane.lastError) + '</p>' : '') + '</article>').join('');
}
async function memoryPage(data) {
  if (source !== 'main') return panel('历史数据源', empty('历史数据源不提供在线记忆', '切换到「当前服务」查看持久记忆。'));
  if (!data.available) return panel('记忆状态', empty(data.enabled ? '记忆暂不可用' : '持久记忆未启用', data.reason || '完成记忆配置后刷新页面。'));
  if (!data.rooms.length) { resetMemory(); return panel('记忆状态', empty('尚无群记录', '收到群消息后可选择群作用域查看记忆。')); }
  if (!data.rooms.some(room => room.id === memoryState.room)) resetMemory(data.rooms[0].id);
  const context = memoryContext(), room = data.rooms.find(item => item.id === context.room);
  const results = await Promise.allSettled([
    api('memory/members', { query: { room: context.room, q: memoryState.memberQuery, offset: '0', limit: String(MEMORY_MEMBER_PAGE_SIZE) } }),
    api('memory/status', { query: { room: context.room } }),
    memoryState.member ? api('memory/profile', { query: { room: context.room, member: memoryState.member } }) : Promise.resolve(null),
  ]);
  if (!context.current()) return '';
  const [members, status, profile] = results;
  memoryState.memberLoading = false; memoryState.memberError = members.status === 'rejected' ? members.reason.message : '';
  memoryState.memberItems = members.status === 'fulfilled' ? members.value.members : [];
  memoryState.memberNextOffset = members.status === 'fulfilled' ? (members.value.hasMore ? members.value.nextOffset : null) : 0;
  const ingestionIssue = status.status === 'rejected' || status.value.lanes.some(lane => lane.blocked || lane.failures || lane.lastError);
  return `<section class="panel memory-toolbar">
    <label class="memory-room-field"><span>选择群</span><select id="memory-room">${data.rooms.map(item => '<option value="' + esc(item.id) + '"' + (item.id === context.room ? ' selected' : '') + '>' + esc(item.name || item.id) + '</option>').join('')}</select></label>
    <div class="memory-scope-note"><span class="count-chip">${number(room.memberCount)} 名成员</span><span>只读查看</span></div>
    ${data.roomsTruncated ? '<p class="table-sub">最多展示 500 个群作用域。</p>' : ''}
  </section>
  <div id="memory-workspace" class="memory-workspace${memoryState.profileOpen ? ' has-selection' : ''}">
    <section class="panel memory-members-panel" aria-label="群成员">
      <div class="panel-head"><div><h2>群成员</h2><p class="panel-description">选择成员，查看已保存画像。</p></div></div>
      <label class="memory-member-search"><span class="sr-only">搜索 QQ 号或群昵称</span><input id="memory-member-query" type="search" maxlength="100" placeholder="搜索 QQ 号或群昵称" value="${esc(memoryState.memberQuery)}" autocomplete="off"></label>
      <div class="memory-members-body">${memoryMembers()}</div>
    </section>
    <section class="panel memory-profile-panel" aria-labelledby="memory-profile-title">
      <div class="panel-head"><h2 id="memory-profile-title" tabindex="-1">当前成员画像</h2><button class="button small memory-back" data-memory-back>← 返回成员</button></div>
      <div id="memory-profile" class="memory-profile-scroll" aria-live="polite">${profile.status === 'fulfilled' ? profileText(profile.value) : memoryError(profile.reason)}</div>
    </section>
  </div>
  <section class="panel"><div class="panel-head"><div><h2>检索群记忆</h2><p class="panel-description">每次最多显示 8 条匹配；历史可能包含旧偏好，当前偏好以成员明确表达的有效字段为准。</p></div></div><form id="memory-search" class="memory-search-form"><label class="sr-only" for="memory-query">搜索群记忆</label><input id="memory-query" maxlength="500" placeholder="搜索称呼、偏好或讨论过的事实" value="${esc(memoryState.query)}" required><button class="button primary" type="submit">搜索</button></form><div id="memory-results">${memoryResults(memoryState.results)}</div></section>
  <details class="panel memory-ingestion"><summary>摄取进度${ingestionIssue ? ' <span class="badge warn">需要检查</span>' : ''}</summary><p class="panel-description">来自本地记录，展开查看批次与重试状态。</p>${status.status === 'fulfilled' ? ingestionStatus(status.value) : memoryError(status.reason)}</details>`;
}
function memoryResults(results) {
  if (!results.length) return '<p class="muted">' + (memoryState.searchDone ? '没有匹配的记忆。' : '输入关键词或问题开始搜索。') + '</p>';
  return '<div class="memory-results">' + results.map((hit, index) => '<article class="memory-result"><div><strong>' + esc(hit.uri.split('/').filter(Boolean).pop() || '记忆条目') + '</strong><p>' + esc(short(hit.text, 600)) + '</p><span class="table-sub mono">' + esc(hit.uri) + (Number.isFinite(hit.score) ? ' · 相关度 ' + hit.score.toFixed(3) : '') + '</span></div><button class="button small" data-memory-hit="' + index + '">查看内容</button></article>').join('') + '</div>';
}
async function selectMemoryMember(member) {
  if (source !== 'main' || view !== 'memory') return;
  memoryState.member = member; memoryState.profileOpen = true;
  $('memory-workspace')?.classList.add('has-selection');
  if (window.matchMedia('(max-width: 700px)').matches) $('memory-profile-title')?.focus({ preventScroll: true });
  const context = memoryContext(), sequence = ++memoryState.profileSequence, target = $('memory-profile');
  if (!target) return;
  const current = () => context.current() && sequence === memoryState.profileSequence && target.isConnected;
  target.innerHTML = '<p class="muted">正在读取成员画像…</p>'; target.scrollTop = 0;
  document.querySelectorAll('[data-memory-member]').forEach(button => { const active = button.dataset.memoryMember === member; button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active)); });
  try { const profile = await api('memory/profile', { query: { room: context.room, member } }); if (current()) target.innerHTML = profileText(profile); }
  catch (error) { if (current()) target.innerHTML = memoryError(error); }
}
function showMemoryMembers() {
  memoryState.profileOpen = false;
  $('memory-workspace')?.classList.remove('has-selection');
  const selected = [...document.querySelectorAll('[data-memory-member]')].find(button => button.dataset.memoryMember === memoryState.member);
  selected?.focus({ preventScroll: true });
}
async function searchMemory(event) {
  event.preventDefault();
  const input = $('memory-query'); if (!input || !memoryState.room || source !== 'main' || view !== 'memory') return;
  memoryState.query = input.value.trim(); if (!memoryState.query) return;
  const context = memoryContext(), sequence = ++memoryState.searchSequence, target = $('memory-results'), button = event.target.querySelector('button[type="submit"]');
  const current = () => context.current() && sequence === memoryState.searchSequence && target.isConnected;
  memoryState.results = []; memoryState.searchDone = false; target.innerHTML = '<p class="muted">正在检索记忆…</p>';
  button.disabled = true; button.textContent = '搜索中…';
  try {
    const data = await api('memory/search', { query: { room: context.room, q: memoryState.query, limit: '8' } });
    if (!current()) return;
    memoryState.results = data.hits; memoryState.searchDone = true; target.innerHTML = memoryResults(data.hits);
  } catch (error) { if (current()) target.innerHTML = memoryError(error); }
  finally { if (current()) { button.disabled = false; button.textContent = '搜索'; } }
}
async function memoryDetail(title, endpoint, query, body) {
  if (source !== 'main' || view !== 'memory') return;
  const context = memoryContext(), sequence = ++detailSequence; clearImages();
  $('detail-title').textContent = title; $('detail-body').innerHTML = '<p class="muted">正在读取…</p>'; if (!$('detail').open) $('detail').showModal();
  const current = () => context.current() && sequence === detailSequence && $('detail').open;
  try { const data = await api('memory/' + endpoint, { query: { room: context.room, ...query } }); if (current()) $('detail-body').innerHTML = body(data); }
  catch (error) { if (current()) $('detail-body').innerHTML = memoryError(error); }
}
async function showMemoryContent(index, contentOffset = 0) {
  const hit = memoryState.results[index]; if (!hit) return;
  await showMemoryUri(hit.uri, contentOffset);
}
async function showMemoryUri(uri, contentOffset = 0) {
  await memoryDetail('记忆内容', 'content', { uri, offset: String(contentOffset) }, data => '<p class="mono">' + esc(data.uri) + '</p><p class="table-sub">字符 ' + number(data.text.length ? data.offset + 1 : data.offset) + '–' + number(data.offset + data.text.length) + ' / ' + number(data.totalCharacters) + '</p><pre>' + esc(data.text || '（空内容）') + '</pre><div class="memory-pager"><button class="button small" data-memory-content-uri="' + esc(uri) + '" data-memory-content-offset="0"' + (data.offset ? '' : ' disabled') + '>回到开头</button>' + (data.nextOffset !== null ? '<button class="button small" data-memory-content-uri="' + esc(uri) + '" data-memory-content-offset="' + Number(data.nextOffset) + '">下一段 →</button>' : '') + '</div>');
}
async function showMemorySource(id) {
  await memoryDetail('记忆来源消息', 'source', { id }, data => '<div class="detail-summary"><span class="badge">' + (data.kind === 'reply' ? '已确认回复' : '群消息') + '</span><span>' + esc(data.authorName || data.authorId || '机器人') + '</span><span>' + time(data.timestamp) + '</span></div><p class="answer-body">' + esc(data.text || '附件消息') + '</p>' + (data.truncated ? '<p class="table-sub">来源消息较长，当前展示已截断。</p>' : '') + '<p class="mono">' + esc(data.id) + '</p>');
}
async function render({ silent = false } = {}) {
  if (silent && viewRequest) return;
  viewRequest?.abort(); viewRequest = undefined; stopPrivateStatusRefresh();
  if (view === 'schedules') { const sequence = ++renderSequence; configureView(); if (!silent) notice(); try { await renderSchedules(sequence); } catch (error) { if (sequence === renderSequence) notice(error.message); } return; }
  if (view === 'business' && businessState?.saving) return;
  if (view === 'business' && document.querySelector('[data-business-config]')) collectBusinessDraft();
  if (view === 'business' && businessState?.dirty) { renderSequence++; configureView(); if (!document.querySelector('[data-business-config]')) $('content').innerHTML = businessPage(); updateBusinessStatus('未保存的草稿已保留。保存后生效，或选择“放弃草稿”读取已保存版本。'); return; }
  const sequence = ++renderSequence, requestedView = view; configureView(); if (!silent) notice();
  const request = new AbortController(); viewRequest = request;
  if (view === 'memory') $('content').innerHTML = panel('记忆', '<p class="muted">正在读取记忆状态…</p>');
  try {
    const [data, recent, memoryModel] = await Promise.all([api(view === 'business' ? 'business-config' : view === 'private' ? 'config' : view, { signal: request.signal }), view === 'overview' ? api('threads', { signal: request.signal, query: { offset: '0', room: '', status: '', limit: '6' } }) : Promise.resolve([]), view === 'config' ? api('openviking-model-config', { signal: request.signal }).catch(error => ({ available: false, reason: error.message })) : Promise.resolve(undefined)]);
    if (sequence !== renderSequence || requestedView !== view) return;
    if (view === 'business' && document.querySelector('[data-business-config]')) {
      if (businessState?.saving) return;
      collectBusinessDraft();
      if (businessState.dirty) { updateBusinessStatus('刷新期间的修改已保留，保存全部配置后生效。'); return; }
    }
    rows = Array.isArray(data) ? data : []; let html = '';
    if (view === 'overview') html = overview(data, recent);
    else if (view === 'threads') html = table(['话题 / 会话', '状态', '输入进度', 'Token 用量', '最近更新', ''], data, (r, i) => [`<div class="table-primary">${esc(r.data?.subject || '未命名话题')}</div><div class="table-sub mono">${esc(r.room)}</div>`, badge(r.status), `${number(r.data?.latestInputSeq)} 条输入<div class="table-sub">第 ${number(r.data?.revision)} 版</div>`, taskTokenCell(r.tokenUsage), `<span class="nowrap">${time(r.updated)}</span>`, detailButton(i, '追踪')]) + '<p class="panel-description">Token 用量累计本任务已记录的 Worker 输入与输出，输入包含缓存。</p>';
    else if (view === 'messages') html = table(['发送者 / 群', '消息内容', '处理状态', '接收时间', ''], data, (r, i) => [`<div class="table-primary">${esc(r.data?.authorName || r.data?.authorId || '未知发送者')}</div><div class="table-sub mono">${esc(r.room)}</div>`, esc(short(r.data?.text)) + (r.data?.attachments?.length ? `<div class="table-sub">▧ ${r.data.attachments.length} 个附件</div>` : ''), badge(r.status), `<span class="nowrap">${time(r.at)}</span>`, detailButton(i)]);
    else if (view === 'decisions') html = table(['触发事件', '路由动作', '关联消息', '决策时间', ''], data, (r, i) => [esc(eventName(r.event)), (Array.isArray(r.data) ? r.data : []).map(x => badge(x.action)).join(' '), `<span class="mono">${esc(short(r.message_id || 'Worker 执行结果', 36))}</span>`, `<span class="nowrap">${time(r.at)}</span>`, detailButton(i)]);
    else if (view === 'outbox') html = table(['回复目标', '回复内容', '投递状态', '发送尝试', ''], data, (r, i) => [`<div class="mono">${esc(r.room || r.data?.message?.roomId)}</div>`, (r.data?.kind === 'acknowledgement' ? '<div class="table-sub">接收确认</div>' : '') + esc(short(replyText(r.data?.message))) + replyAttachmentSummary(r), badge(r.status), number(r.data?.attempts), detailButton(i)]);
    else if (view === 'sessions') html = table(['模型会话', '记录大小', '最后更新', ''], data, (r, i) => [`<div class="table-primary mono">${esc(r.id)}</div><div class="table-sub">输入 → 推理 → 工具 → 结果</div>`, (r.bytes / 1024).toFixed(1) + ' KB', `<span class="nowrap">${time(r.updated)}</span>`, detailButton(i, '工具轨迹')]);
    else if (view === 'memory') html = await memoryPage(data);
    else if (view === 'business') { businessState = { ...data, tab: businessState?.tab, selected: businessState?.selected && data.settings.profiles[businessState.selected] ? businessState.selected : data.settings.defaultProfile }; html = businessPage(); }
    else if (view === 'private') html = privateChatForm(data.privateChatStatus);
    else if (view === 'config') html = configPage(data, memoryModel);
    if (sequence !== renderSequence || requestedView !== view) return;
    $('content').innerHTML = html; $('updated').textContent = '最近更新 ' + new Date().toLocaleTimeString('zh-CN'); $('next').disabled = rows.length < 100;
    if (view === 'private') queuePrivateStatusRefresh(document.querySelector('[data-private-chat-config]'), data.privateChatStatus);
  } catch (error) { if (sequence === renderSequence && !request.signal.aborted) notice(error.message); }
  finally { if (viewRequest === request) viewRequest = undefined; }
}
function eventName(type) { return ({ 'input_committed':'保存任务输入', 'run_started':'绑定输入并启动', 'run_supersede_requested':'请求旧运行退出', 'run_superseded':'旧运行已退出', 'worker_cleanup_blocked':'等待旧运行退出', 'handoff_reply_queued':'即时回执已入队', 'delivery_attempt_started':'开始投递', 'delivery_attempt_settled':'投递回执', 'session': '建立模型会话', 'model/selection': '选择模型', 'turn/start': '开始处理', 'turn/end': '本轮处理结束', 'turn/abort': '本轮已中止', 'user/message': '收到任务输入', 'assistant/message': '模型回应', 'tool/result': '工具返回结果', 'tool/call': '调用工具', 'message': '群消息', 'messages': '收到群消息', 'timer': '定时检查', 'request/header': '准备模型请求', 'request/context': '整理模型上下文', 'compaction/start': '开始压缩上下文', 'compaction/summary': '生成历史摘要', 'compaction/end': '上下文压缩结束', 'compaction/prune': '裁剪过长工具结果', 'worker_result': '任务返回', 'worker-result': '任务返回', 'error': '调用异常' })[type] || label(type); }
const toolNames = {};
function deliveryReason(reason) { return reason === 'related_input_unresolved' ? '关联消息尚未完成路由，暂缓发送。请先检查该消息的路由失败记录；旧结论不会自动越过这条消息。' : reason; }
function lifecycleAudit(events) {
  if (!events.length) return '';
  return `<div class="timeline">${events.map(item => { const d = item.data || {}; return `<article><div class="event-top"><strong>${esc(eventName(item.kind))}</strong><time>${time(item.at)}</time>${d.status ? badge(d.status) : ''}</div><p class="table-sub">${esc([d.fromRevision !== undefined ? '版本 ' + d.fromRevision + ' → ' + d.toRevision : '', d.throughInputSeq !== undefined ? '绑定到输入 ' + d.throughInputSeq : '', d.reason ? deliveryReason(d.reason) : '', d.platformCode !== undefined ? '平台代码 ' + d.platformCode : '', d.retryable === false ? '不自动重试' : ''].filter(Boolean).join(' · '))}</p>${raw(item, '查看审计详情')}</article>`; }).join('')}</div>`;
}
function domainAudit(data) {
  const summary=data.domainSummary||[],events=data.domainEvents||[];
  if(!summary.length)return '';
  const categories={skill:'技能指引',reference:'参考说明',data:'实体资料',knowledge:'知识笔记',csv:'数值表',catalogue:'资源目录',discovery:'文件检索',external:'外部资料',terminology:'术语',schema:'工具说明',browser:'浏览器',artifact:'任务资料',batch:'批量读取'};
  const sum=key=>summary.reduce((n,r)=>n+Number(r[key]||0),0);
  return `<section class="detail-section"><h3>本地资料与工具使用</h3><div class="detail-summary"><span>调用 ${number(sum('calls'))} 次</span><span>错误 ${number(sum('errors'))} 次 · 部分失败 ${number(sum('partial'))} 次</span><span>空结果 ${number(sum('empty'))} 次 · 截断/覆盖不完整 ${number(sum('truncated'))} 次</span><span>批内条目 ${number(sum('itemsTotal'))} 条：成功 ${number(sum('itemsOk'))} · 失败 ${number(sum('itemsErrors'))} · 空 ${number(sum('itemsEmpty'))}</span><span>同轮重复请求 ${number(sum('repeated'))} 次 · 同参数重试恢复 ${number(sum('recoveredRetries'))} 次</span></div><p class="table-sub">统计该话题启用审计后的全部调用，失败调用和批内失败条目分别计数。恢复仅指同一运行及版本中，同工具、同参数上次失败或部分失败后成功；更改参数后的恢复需查看明细。重复请求不等于无效请求，工具返回也不等于结论已验证。</p><div class="table-wrap"><table><thead><tr><th>工具 / 类型</th><th>调用</th><th>失败条目</th><th>重试恢复</th><th>工具耗时</th><th>返回字符</th></tr></thead><tbody>${summary.map(r=>`<tr><td>${esc(r.displayName||toolNames[r.tool]||r.tool)} · ${esc(r.categoryLabel||categories[r.category]||r.category)}</td><td>${number(r.calls)}</td><td>${number(r.itemsErrors)}</td><td>${number(r.recoveredRetries)}</td><td>${number(r.elapsedMs)} ms</td><td>${number(r.responseCharacters)}</td></tr>`).join('')}</tbody></table></div>${raw(events, '展开最近 200 条资源调用记录')}</section>`;
}
function contentText(content) { if (typeof content === 'string') return content; if (!Array.isArray(content)) return ''; return content.filter(x => x.type === 'text').map(x => x.text || '').join('\n'); }
function tryJson(text) { try { return JSON.parse(text); } catch { return null; } }
function readableText(value, limit = 600) {
  if (typeof value === 'string') { const parsed = tryJson(value); return parsed ? readableText(parsed, limit) : short(value, limit); }
  if (!value || typeof value !== 'object') return String(value ?? '');
  if (Array.isArray(value)) return value.slice(0, 6).map(x => readableText(x, limit / 3)).filter(Boolean).join('\n');
  for (const key of ['shortAnswer', 'answer', 'summary', 'text', 'message', 'error', 'description']) if (typeof value[key] === 'string') return short(value[key], limit);
  if (value.report) return readableText(value.report, limit);
  if (value.inputs) return readableText(value.inputs.map(x => x.message || x), limit);
  if (value.messages) return readableText(value.messages, limit);
  if (value.content) return readableText(contentText(value.content), limit);
  if (value.rows) return `${value.rows.length} 行结构化数据${value.columns ? ' · ' + value.columns.join('、') : ''}`;
  if (value.skills) return `${value.skills.length} 项技能`;
  if (value.tools) return `${value.tools.length} 个可用工具`;
  if (value.url) return value.url;
  if (value.path || value.file) return String(value.path || value.file);
  if (value.id) return String(value.id);
  if (value.reason) return String(value.reason);
  const keys = Object.keys(value).filter(k => !['type', 'role', 'provider', 'timestamp'].includes(k));
  return keys.length ? '记录字段：' + keys.slice(0, 8).join('、') : '已记录';
}
function eventDescription(event) {
  const data = event.data || {}, message = data.message || data, content = message.content || data.content;
  if (event.type === 'session') return '会话已保存，可持续追踪同一话题。';
  if (event.type === 'model/selection') return [data.provider, data.model?.id || data.model].filter(x => typeof x === 'string').join(' · ') || '使用当前角色配置的模型。';
  if (event.type === 'request/header') return '准备向当前模型发送请求。';
  if (event.type === 'request/context') return '已整理本轮任务所需的对话上下文。';
  if (event.type === 'compaction/start') return '正在将较早历史整理为摘要；原始记录仍保留在会话日志中。';
  if (event.type === 'compaction/summary') {
    const summary = contentText(data.summary), model = [data.provider, data.model].filter(Boolean).join(' / ');
    const stats = `${number(data.shadowedSeqs?.length)} 条历史 · 被替换历史估算 ${number(data.shadowedTokenCount)} tokens`;
    const usage = data.usage ? `摘要调用用量：输入 ${number(data.usage.inputTokens)} / 输出 ${number(data.usage.outputTokens)} tokens` : '';
    return [stats, model ? '摘要模型：' + model : '', usage, summary ? '\n' + short(summary, 2500) : '摘要已记录。'].filter(Boolean).join('\n');
  }
  if (event.type === 'compaction/end') return data.error ? '压缩未完成：' + readableText(data.error, 600) : '压缩已完成，后续模型请求将使用摘要后的上下文。';
  if (event.type === 'compaction/prune') return `已裁剪 ${number(data.shadowedSeqs?.length)} 条过长工具结果；原内容估算 ${number(data.shadowedTokenCount)} tokens。保留首尾文本，完整结果仍在原始日志中。`;
  if (event.type === 'tool/call') return (data.displayName || toolNames[data.name] || data.name || '调用工具') + (data.arguments ? '\n' + readableText(data.arguments, 300) : '');
  if (event.type === 'turn/start') return '开始读取上下文并执行当前任务。';
  if (event.type === 'turn/end') return '本轮处理已结束' + (data.reason ? ' · ' + data.reason : '');
  if (event.type === 'assistant/message') {
    const calls = Array.isArray(content) ? content.filter(x => ['tool-call', 'toolCall'].includes(x.type)) : [];
    const text = readableText(contentText(content));
    return [text, ...calls.map(x => '→ ' + (x.displayName || toolNames[x.name || x.toolName] || x.name || x.toolName || '调用工具') + (x.arguments || x.input ? ' · ' + short(readableText(x.arguments || x.input), 160) : ''))].filter(Boolean).join('\n') || '模型已生成响应，详细内容见原始记录。';
  }
  if (event.type === 'tool/result') {
    const parsed = tryJson(contentText(content)), text = parsed ? readableText(parsed) : readableText(contentText(content));
    return (message.isError || data.isError ? '工具返回错误：' : '') + (text || '工具执行完成，结果已返回模型。');
  }
  if (event.type === 'user/message') return readableText(contentText(content)) || '收到包含附件或结构化上下文的任务。';
  return readableText(data);
}
async function showThread(id) {
  const sequence = ++detailSequence, requestedSource = source; clearImages();
  try {
    const data = await api('threads/' + encodeURIComponent(id));
    if (sequence !== detailSequence || requestedSource !== source) return;
    if (!data.thread) throw new Error('没有找到该话题。');
    const thread = data.thread.data; $('detail-title').textContent = thread.subject || '任务话题';
    const inputTimeline = data.inputs.length ? `<div class="timeline">${data.inputs.map(item => `<article><div class="event-top"><strong class="event-title">${esc(item.data?.message?.authorName || item.data?.message?.authorId || '群成员')}<span class="event-sub"> · 输入 ${item.seq}</span></strong><span class="event-time">${time(item.data?.message?.at || item.data?.message?.timestamp)}</span></div><p class="answer-body">${esc(item.data?.message?.text || '附件消息')}</p>${item.data?.message?.attachments?.length ? `<span class="event-sub">包含 ${item.data.message.attachments.length} 个附件</span>` : ''}${item.data?.routingContext ? '<p class="table-sub">已保存的交接解释 · 版本 ' + number(item.data.revision) + '</p><p class="answer-body">' + esc(item.data.routingContext.resolvedRequest) + (item.data.routingContext.correctionTarget ? '\n更正内容：' + esc(item.data.routingContext.correctionTarget) : '') + '</p>' : ''}${raw(item)}</article>`).join('')}</div>` : empty('暂无输入记录', '该话题尚未接收到输入。');
    const imageEvents = data.imageEvents || [], imageInputs = imageEvents.filter(item => item.kind === 'image_input');
    const imageAudit = imageEvents.length ? `<section class="detail-section"><h3>图片接收与模型输入</h3><div class="detail-summary"><span>已加载 ${number(imageInputs.filter(item => item.data?.status === 'loaded').length)} 张次</span><span>加载失败 ${number(imageInputs.filter(item => item.data?.status === 'failed').length)} 张次</span><span>本轮省略 ${number(imageInputs.filter(item => item.data?.status === 'omitted').length)} 张次</span></div><p class="table-sub">按最近 ${number(imageEvents.length)} 条事件统计；下载回退、缓存与模型输入状态可在下方展开。</p>${raw(imageEvents, '展开图片接收审计')}</section>` : '';
    const lifecycle = (data.lifecycleEvents || []).filter(item => !item.kind.startsWith('delivery_'));
    const scheduling = thread.pendingInputs ? `<p class="notice">已保存到输入 ${number(thread.pendingInputs.throughInputSeq)}；最早可继续时间 ${time(thread.pendingInputs.readyAt)}。仍需等待旧运行退出及关联消息完成路由。</p>` : '';
    const runs = scheduling + lifecycleAudit(lifecycle) + domainAudit(data)+(data.runs || []).map(item => `<div class="plugin-item"><div class="plugin-icon">↻</div><div><strong>${esc(label(item.status))}</strong><p class="table-sub mono">${esc(item.id)}</p>${raw(item)}</div></div>`).join('');
    const results = (data.results || []).map(item => `<article class="alert-item"><p class="answer-body">${esc(readableText(item.data?.report || item.data, 5000))}</p>${raw(item, '查看完整执行结果')}</article>`).join('');
    const replies = data.outbox.length ? data.outbox.map(item => `<article class="alert-item"><div class="event-top">${badge(item.status)}<span class="event-sub">${item.data?.kind === 'acknowledgement' ? '接收确认 · ' : ''}尝试 ${number(item.data?.attempts)} 次</span></div><p class="answer-body">${esc(replyText(item.data?.message, '暂无回复文本'))}</p>${replyImages(item)}${replyFiles(item)}${raw(item)}</article>`).join('') : '<p class="muted">尚无关联回复。</p>';
    $('detail-body').innerHTML = `<div class="detail-summary">${badge(data.thread.status)}<span class="mono">${esc(thread.roomId || data.thread.room)}</span><span>第 ${number(thread.revision)} 版 · ${number(thread.latestInputSeq)} 条输入</span></div>${thread.summary ? `<p class="answer-body">${esc(thread.summary)}</p>` : ''}${taskTokenDetails(data.tokenUsage)}<section class="detail-section"><h3>01 · 群消息与补充</h3>${inputTimeline}</section>${imageAudit}<section class="detail-section"><h3>02 · 执行与任务结果</h3>${runs || '<p class="muted">尚未开始执行。</p>'}${results}${thread.sessionId ? `<button class="button primary" data-session="${esc(data.workerSessionIds?.[0] ?? thread.sessionId)}">查看该 Worker 的工具轨迹</button>` : ''}</section><section class="detail-section"><h3>03 · 回复投递</h3>${replies}${lifecycleAudit((data.lifecycleEvents || []).filter(item => item.kind.startsWith('delivery_')))}</section>${raw(data.decisions, '展开路由决策')}${raw(data.thread, '展开话题元数据')}`;
    if (!$('detail').open) $('detail').showModal();
  } catch (error) { notice(error.message); }
}
async function showSession(id) {
  const sequence = ++detailSequence, requestedSource = source; clearImages();
  try {
    const data = await api('sessions/' + encodeURIComponent(id));
    if (sequence !== detailSequence || requestedSource !== source) return;
    $('detail-title').textContent = '模型与工具轨迹';
    const toolCount = data.filter(x => x.type === 'tool/result').length;
    const compactions = data.filter(x => x.type === 'compaction/end'), prunes = data.filter(x => x.type === 'compaction/prune');
    const compactionInfo = compactions.length || prunes.length || data.some(x => x.type === 'compaction/start') ? `<div class="detail-summary"><span>上下文压缩</span><span class="badge">完成 ${compactions.filter(x => !x.data?.error).length} 次</span><span class="badge ${compactions.some(x => x.data?.error) ? 'fail' : 'neutral'}">失败 ${compactions.filter(x => x.data?.error).length} 次</span><span class="badge neutral">工具裁剪 ${prunes.length} 次</span><span class="event-sub">当前显示事件内统计</span></div>` : '';
    $('detail-body').innerHTML = `<div class="session-info"><span class="mono">${esc(id)}</span><span>最近 ${data.length} 个事件 · ${toolCount} 条工具结果记录（含裁剪替换）</span></div>${compactionInfo}<div class="timeline">${data.map(event => `<article><div class="event-top"><strong class="event-title">${esc(eventName(event.type))}</strong>${event.type === 'compaction/end' ? badge(event.data?.error ? 'failed' : 'success') : ''}<time class="event-time">${time(event.time || event.at)}</time></div><div class="event-sub mono">${esc(event.type)}</div><p class="answer-body">${esc(eventDescription(event))}</p>${raw(event, '展开审计事件')}</article>`).join('')}</div>${!data.length ? empty('暂无模型事件', '开始调用后，工具使用过程会出现在这里。') : ''}`;
    if (!$('detail').open) $('detail').showModal();
  } catch (error) { notice(error.message); }
}
async function showDetail(index) {
  const row = rows[index]; if (!row) return;
  if (view === 'threads') return showThread(row.id);
  if (view === 'sessions') return showSession(row.id);
  detailSequence++; clearImages();
  $('detail-title').textContent = titles[view] + ' · 记录';
  let summary = '';
  if (view === 'messages') summary = `<div class="detail-summary">${badge(row.status)}<span>${esc(row.data?.authorName || row.data?.authorId)}</span><span class="mono">${esc(row.room)}</span></div><p class="answer-body">${esc(row.data?.text || '附件消息')}</p>`;
  if (view === 'outbox') summary = `<div class="detail-summary">${badge(row.status)}${row.data?.kind === 'acknowledgement' ? '<span>接收确认</span>' : ''}<span class="mono">${esc(row.room || row.data?.message?.roomId)}</span></div><p class="answer-body">${esc(replyText(row.data?.message))}</p>${replyImages(row)}${replyFiles(row)}<p class="muted">已尝试 ${number(row.data?.attempts)} 次发送。</p>${row.data?.reason ? '<p class="notice">' + esc(deliveryReason(row.data.reason)) + '</p>' : ''}${lifecycleAudit(row.deliveryEvents || [])}${deliveryResolutionPanel(row)}`;
  if (view === 'decisions') summary = `<div class="detail-summary"><span>${esc(eventName(row.event))}</span><span>${time(row.at)}</span></div>${(Array.isArray(row.data) ? row.data : []).map(action => `<div class="alert-item">${badge(action.action)}<p class="answer-body">${esc(readableText(action, 1200))}</p></div>`).join('')}`;
  $('detail-body').innerHTML = summary + raw(row); $('detail').showModal();
}
async function saveActivation(form) {
  if (form.dataset.saving === 'true') return;
  const input = form.querySelector('[name=botCallNames]'), button = form.querySelector('button[type=submit]'), message = form.querySelector('.form-message');
  const names = input.value.split(/[\r\n,，]+/).map(name => name.trim()).filter(Boolean), seen = new Set();
  const botCallNames = names.filter(name => { const key = name.toLowerCase(); if (seen.has(key)) return false; seen.add(key); return true; });
  message.classList.remove('error');
  if (botCallNames.length > 32 || botCallNames.some(name => name.length > 80)) {
    message.classList.add('error'); message.textContent = '最多 32 个关键字，每个最多 80 个字符。'; return;
  }
  form.dataset.saving = 'true'; input.disabled = true; button.disabled = true; message.textContent = '正在保存…';
  try {
    const result = await api('activation-config', { method: 'POST', body: { botCallNames } });
    if (!form.isConnected) return;
    input.value = result.config.botCallNames.join('\n');
    message.textContent = result.config.botCallNames.length ? '已保存，重启机器人后生效。' : '已保存为空列表，重启机器人后仅通过 @ 唤起。';
  } catch (error) { if (form.isConnected) { message.classList.add('error'); message.textContent = error.message; } }
  finally { form.dataset.saving = 'false'; input.disabled = false; button.disabled = false; }
}
async function saveModel(form) {
  const role = form.dataset.modelRole, values = new FormData(form), button = form.querySelector('button[type=submit]'), message = form.querySelector('.form-message');
  const settings = { model: String(values.get('model')).trim(), baseUrl: String(values.get('baseUrl')).trim(), api: values.get('api'), reasoningEffort: values.get('reasoningEffort') };
  const key = String(values.get('apiKey') || '').trim(); if (key) settings.apiKey = key;
  button.disabled = true; message.classList.remove('error'); message.textContent = '正在保存…';
  try {
    const result = await api('model-config', { method: 'POST', body: { [role]: settings } });
    const keyConfigured = result.config?.[role + 'ApiKeyConfigured'] ?? Boolean(key || form.querySelector('[data-key-state]').textContent === '已配置');
    form.querySelector('[name=apiKey]').value = ''; form.querySelector('[name=apiKey]').placeholder = keyConfigured ? '已配置，留空保持不变' : '输入该角色使用的 API Key';
    form.querySelector('[data-key-state]').textContent = keyConfigured ? '已配置' : '未配置'; form.querySelector('[data-key-state]').classList.toggle('neutral', !keyConfigured);
    message.textContent = '已保存，下一次调用生效。';
  } catch (error) { message.classList.add('error'); message.textContent = error.message; }
  finally { button.disabled = false; }
}
async function saveOpenVikingModel(form, applyOnly = false) {
  if (form.dataset.saving === 'true' || form.dataset.restarting === 'true') return;
  const values = new FormData(form), message = form.querySelector('.form-message'), keyInput = form.querySelector('[name=apiKey]');
  const body = { revision: form.dataset.revision };
  if (!applyOnly) {
    Object.assign(body, { model: String(values.get('model') || '').trim(), baseUrl: String(values.get('baseUrl') || '').trim(), thinking: values.get('thinking') });
    const key = String(values.get('apiKey') || '').trim(); if (key) body.apiKey = key;
  }
  const controls = [...form.querySelectorAll('input,select,button')], disabled = controls.map(control => control.disabled);
  form.dataset.saving = 'true'; controls.forEach(control => { control.disabled = true; });
  message.classList.remove('error'); message.textContent = applyOnly ? '正在应用已保存配置…' : '正在保存并应用…';
  try {
    const result = await api('openviking-model-config' + (applyOnly ? '/apply' : ''), { method: 'POST', body });
    if (!form.isConnected) return;
    const config = result.config || {};
    if (config.revision) form.dataset.revision = config.revision;
    if (config.restartSupported !== undefined) form.dataset.restartSupported = String(config.restartSupported);
    form.dataset.restarting = String(Boolean(config.restarting));
    if (result.saved) keyInput.value = '';
    for (const name of ['model', 'baseUrl', 'thinking']) if (config[name] !== undefined) form.querySelector('[name=' + name + ']').value = config[name];
    if (config.apiKeyConfigured !== undefined) {
      keyInput.placeholder = config.apiKeyConfigured ? '已配置，留空保持不变' : '输入记忆提炼使用的 API Key';
      const badge = form.querySelector('[data-key-state]'); badge.textContent = config.apiKeyConfigured ? '已配置' : '未配置'; badge.classList.toggle('neutral', !config.apiKeyConfigured);
    }
    const state = form.querySelector('[data-apply-state]');
    state.textContent = result.applied ? '已生效' : config.restarting ? '正在应用' : '待应用';
    state.classList.toggle('warn', !result.applied);
    form.querySelector('[data-openviking-apply]').hidden = Boolean(result.applied || !config.restartRequired);
    message.textContent = result.message || (result.applied ? '记忆模型配置已生效。' : '配置已保存，尚未应用。');
    message.classList.toggle('error', !result.applied);
  } catch (error) {
    if (form.isConnected) { message.classList.add('error'); message.textContent = error.message; }
  } finally {
    form.dataset.saving = 'false';
    controls.forEach((control, index) => { control.disabled = disabled[index]; });
    form.querySelector('button[type=submit]').disabled = form.dataset.restarting === 'true';
    form.querySelector('[data-openviking-apply]').disabled = form.dataset.restartSupported !== 'true' || form.dataset.restarting === 'true';
  }
}
function navigate(next) { if (!titles[next] || next === view || scheduleState.saving) return; if (view === 'business' && businessState?.saving) { updateBusinessStatus('正在保存，请稍候…'); return; } if (view === 'business' && document.querySelector('[data-business-config]')) collectBusinessDraft(); businessSequence++; detailSequence++; clearImages(); $('detail').close(); $('detail').querySelector('.section-kicker').textContent = '完整处理链路'; view = next; offset = 0; $('content').innerHTML = panel(titles[next], '<p class="panel-description" role="status">正在加载…</p>'); render(); }
document.querySelector('nav').addEventListener('click', event => { const button = event.target.closest('[data-view]'); if (button) navigate(button.dataset.view); });
$('content').addEventListener('click', event => { const button = event.target.closest('button'); if (!button) return; if (button.hasAttribute('data-business-add')) openBusinessCreate(); else if (button.hasAttribute('data-business-create-cancel')) $('business-create-dialog').close(); else if (button.dataset.businessTab) setBusinessTab(button.dataset.businessTab); else if (button.hasAttribute('data-business-discard')) requestBusinessDiscard(); else if (button.hasAttribute('data-business-room-add')) addBusinessRoom(); else if (button.hasAttribute('data-business-room-remove')) { button.closest('.business-room-row').remove(); syncBusinessRooms(); } else if (button.hasAttribute('data-business-preview')) previewBusiness(); else if (button.hasAttribute('data-business-history')) showBusinessHistory(); else if (button.hasAttribute('data-business-persona-clear')) clearBusinessPersona(); else if (button.hasAttribute('data-openviking-apply')) saveOpenVikingModel(button.closest('[data-openviking-model]'), true); else if (button.dataset.memoryMember) selectMemoryMember(button.dataset.memoryMember); else if (button.hasAttribute('data-memory-back')) showMemoryMembers(); else if (button.dataset.memoryHit !== undefined) showMemoryContent(Number(button.dataset.memoryHit)); else if (button.dataset.memoryUri) showMemoryUri(button.dataset.memoryUri); else if (button.dataset.memorySource) showMemorySource(button.dataset.memorySource); else if (button.hasAttribute('data-memory-retry')) loadMemoryMembers(!memoryState.memberItems.length); else if (button.dataset.detail !== undefined) showDetail(Number(button.dataset.detail)); else if (button.dataset.threadId) showThread(button.dataset.threadId); else if (button.dataset.go) navigate(button.dataset.go); });
$('content').addEventListener('input', event => { if (event.target.closest('[data-business-config]')) { if (event.target.hasAttribute('data-business-room')) syncBusinessRooms(); else businessDirty(); if (event.target.id === 'business-persona') updateBusinessPersonaEditor(); const count = document.querySelector('[data-business-count="' + event.target.id + '"]'); if (count && event.target.id !== 'business-persona') count.textContent = event.target.value.length.toLocaleString() + ' / 16,000'; } if (event.target.id === 'memory-member-query' && !event.isComposing) searchMemoryMembers(event.target.value); });
$('content').addEventListener('compositionend', event => { if (event.target.id === 'memory-member-query') searchMemoryMembers(event.target.value); });
$('content').addEventListener('scroll', event => { const list = event.target; if (list.id === 'memory-member-list' && !memoryState.memberError && list.scrollHeight - list.scrollTop - list.clientHeight < 100) loadMemoryMembers(); }, true);
$('content').addEventListener('submit', event => { const activation = event.target.closest('[data-activation-config]'), memoryForm = event.target.closest('[data-openviking-model]'), form = event.target.closest('[data-model-role]'); if (event.target.closest('[data-business-create]')) { event.preventDefault(); addBusinessProfile(); } else if (event.target.closest('[data-business-config]')) { event.preventDefault(); saveBusiness(event.target.closest('[data-business-config]')); } else if (activation) { event.preventDefault(); saveActivation(activation); } else if (memoryForm) { event.preventDefault(); saveOpenVikingModel(memoryForm); } else if (form) { event.preventDefault(); saveModel(form); } else if (event.target.closest('#memory-search')) searchMemory(event); });
$('content').addEventListener('change', event => { if (event.target.id === 'business-selected') changeBusinessProfile(event.target.value); else if (event.target.dataset.businessCapability) { const kind = event.target.dataset.businessCapability; $('business-' + kind).value = [...document.querySelectorAll('[data-business-capability="' + kind + '"]')].filter(input => input.checked).map(input => input.value).join('\n'); document.querySelector('[data-business-selected-count="' + kind + '"]').textContent = '已选 ' + businessIds($('business-' + kind).value).length; businessDirty(); } else if (event.target.hasAttribute('data-business-room-profile')) syncBusinessRooms(); else if (event.target.closest('[data-business-config]')) businessDirty(); else if (event.target.id === 'memory-room') { resetMemory(event.target.value); detailSequence++; $('detail').close(); render(); } });
$('detail-body').addEventListener('click', event => { const button = event.target.closest('button'); if (button?.hasAttribute('data-business-discard-confirm')) discardBusinessDraft(button); else if (button?.dataset.businessRollback) rollbackBusiness(button); else if (button?.dataset.memoryContentUri) showMemoryUri(button.dataset.memoryContentUri, Number(button.dataset.memoryContentOffset)); else if (button?.dataset.session) showSession(button.dataset.session); else if (button?.dataset.imageId) loadReplyImage(button); });
$('close-detail').onclick = () => { if (!scheduleState.saving) $('detail').close(); };
$('detail').addEventListener('cancel', event => { if (scheduleState.saving) event.preventDefault(); });
$('detail').addEventListener('close', () => { businessSequence++; detailSequence++; clearImages(); });
window.addEventListener('beforeunload', event => { if (businessState?.dirty || businessState?.saving) { event.preventDefault(); event.returnValue = ''; } });
$('content').addEventListener('keydown', event => { const tab = event.target.closest('[data-business-tab]'); if (!tab || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return; event.preventDefault(); const ids = Object.keys(businessTabs), index = ids.indexOf(tab.dataset.businessTab); setBusinessTab(ids[event.key === 'Home' ? 0 : event.key === 'End' ? ids.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + ids.length) % ids.length], true); });
window.addEventListener('pagehide', clearImages);
$('detail').addEventListener('click', event => { if (event.target === $('detail') && !scheduleState.saving) { const r = $('detail').getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) $('detail').close(); } });
$('refresh').onclick = () => render(); $('filter').onclick = () => { offset = 0; render(); };
$('room').addEventListener('keydown', event => { if (event.key === 'Enter') { offset = 0; render(); } });
$('source').onchange = () => { if (scheduleState.saving) { $('source').value = source; notice('正在保存任务操作，请稍候…'); return; } detailSequence++; clearImages(); source = $('source').value; offset = 0; resetMemory(); $('detail').close(); render(); };
$('prev').onclick = () => { offset = Math.max(0, offset - 100); render(); }; $('next').onclick = () => { offset += 100; render(); };
async function initialize() { try { const sources = await api('sources'); $('source').innerHTML = sources.map(x => `<option value="${esc(x.id)}">${esc(x.label)}</option>`).join(''); if (!sources.some(x => x.id === source)) source = 'main'; $('source').value = source; await render(); } catch (error) { notice(error.message); } }
// Scheduled plans share durable APIs; management never starts a local scheduler.
const scheduleState = { data: null, policy: null, filter: { authority: '', ownerId: '', q: '', roomId: '', status: '' }, draft: null, current: null, saving: false, dirty: false, runsOffset: 0 };
Object.assign(titles, { schedules: '定时任务' });
Object.assign(subtitles, { schedules: '管理单次与循环计划，追踪每次执行和群消息投递。' });
Object.assign(names, { active: '已启用', paused: '已暂停', blocked: '已阻塞', completed: '已结束', skipped: '已跳过', proposed: '待提交', applied: '已生效', rejected: '已拒绝', archived: '已归档' });
statusOptions.schedules = ['active', 'paused', 'blocked', 'completed', 'cancelled'];
function scheduleKey() { return typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + '-' + Math.random().toString(36).slice(2); }
function scheduleTime(value, timezone) { if (!value) return '—'; try { return new Intl.DateTimeFormat('zh-CN', { timeZone: timezone, dateStyle: 'medium', timeStyle: 'medium' }).format(new Date(value)); } catch { return time(value); } }
function scheduleLocal(value, timezone) {
  if (!value) return '';
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(value));
  const p = Object.fromEntries(parts.map(part => [part.type, part.value])); return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}
function scheduleRule(item) { const s = item.scheduleSpec || {}; return s.kind === 'once' ? '单次 · ' + scheduleTime(s.at, item.timezone) : s.kind === 'interval' ? '每 ' + number(s.intervalMs / 60000) + ' 分钟' : '日历 · ' + (s.expression || ''); }
async function scheduleApi(path, options = {}) {
  if (options.method && source !== 'main') throw new Error('历史验证数据源只读，不能管理任务。');
  return api(path + (options.method ? '?source=' + encodeURIComponent(source) : ''), options);
}
function scheduleIcon(name) {
  const paths = {
    clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3 2"/>',
    shield: '<path d="m12 3 8 3v5c0 5-4 8-8 10-4-2-8-5-8-10V6Z"/><path d="m8.5 11.5 2.5 2.5 4.5-5"/>',
    calendar: '<rect x="4" y="5" width="16" height="16" rx="3"/><path d="M8 3v4m8-4v4M4 10h16m-11 5h2m3 0h2m-7 3h2"/>',
    search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    bell: '<path d="M6 9a6 6 0 0 1 12 0c0 7 2 7 2 8H4c0-1 2-1 2-8m5 11h2"/>',
  };
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.clock}</svg>`;
}
function scheduleReason(reason) {
  return ({ manual: '手动暂停', cancelled: '已取消计划', edited_completed: '已编辑，等待恢复', room_not_allowed: '目标群已不在允许列表', consecutive_failures: '连续执行失败', needs_input: '需要补充信息', delivery_unknown: '消息送达情况待确认', feature_disabled: '调度功能已停用', business_profile_changed: '业务配置已变更', capability_unavailable: '所需能力不可用', worker_not_configured: 'Worker 尚未配置', configuration_unavailable: '运行配置不可用', execution_config_changed: '执行配置已变更' })[reason] || reason;
}
function schedulePage(data, policy) {
  if (data.available === false) return panel('定时任务', empty('此数据源不提供任务管理', data.reason));
  const items = data.items || [], filter = scheduleState.filter;
  const filtered = Object.values(filter).some(Boolean);
  const rooms = [...new Set([...(data.allowedRoomIds || []), ...items.map(item => item.roomId), ...(filter.roomId ? [filter.roomId] : [])])];
  const serviceLabel = !data.enabled ? '调度未启用' : !data.running ? '机器人离线' : '机器人在线';
  const serviceNote = !data.enabled ? '计划可保存，启用调度后开始执行。' : !data.running ? '计划可保存，执行请求等待机器人恢复。' : '到期自动执行，结果发送到绑定群。';
  const roleOptions = [['group_admin', '群主／管理员', '管理本群用户任务'], ['member', '成员', '管理自己的任务']];
  const rowsHtml = items.map(r => {
    const cells = [
      `<div class="schedule-task"><span class="schedule-task-icon">${scheduleIcon(r.executionKind === 'reminder' ? 'bell' : 'calendar')}</span><div><div class="table-primary">${esc(r.title)}</div><div class="schedule-task-meta"><span class="schedule-authority ${r.authority === 'system' ? 'system' : ''}">${r.authority === 'system' ? '系统任务' : '用户任务'}</span><span>${r.authority === 'system' ? '仅后台管理' : esc(r.ownerId)}</span><span>群 ${esc(String(r.roomId).split(':').at(-1))}</span></div></div></div>`,
      `<div>${esc(scheduleRule(r))}</div><div class="table-sub">${r.executionKind === 'reminder' ? '文字提醒' : 'Worker 执行'} · ${esc(r.timezone)}</div>`,
      `<div class="schedule-status">${badge(r.status)}${r.archivedAt ? badge('archived') : ''}</div>${r.stateReason ? `<div class="table-sub">${esc(scheduleReason(r.stateReason))}</div>` : ''}`,
      `<span class="schedule-date">${esc(scheduleTime(r.nextRunAt, r.timezone))}</span>`,
      `${r.lastRun ? badge(r.lastRun.status) + '<div class="table-sub">' + esc(scheduleTime(r.lastRun.startedAt || r.lastRun.scheduledAt, r.timezone)) + '</div>' : '<span class="muted">尚未执行</span>'}${r.consecutiveFailures ? `<div class="schedule-failure">连续失败 ${number(r.consecutiveFailures)} 次</div>` : ''}`,
      `<button class="button small schedule-detail-button" data-schedule-id="${esc(r.id)}" aria-label="查看 ${esc(r.title)} 的详情">详情 <span aria-hidden="true">↗</span></button>`,
    ];
    return '<tr>' + cells.map((cell, i) => `<td data-label="${['任务', '执行规则', '状态', '下次执行', '最近执行', ''][i]}">${cell}</td>`).join('') + '</tr>';
  }).join('');
  const list = items.length ? `<div class="schedule-table-wrap"><table class="schedule-table"><thead><tr>${['任务 / 归属', '执行规则', '状态', '下次执行', '最近执行', ''].map(title => `<th>${title}</th>`).join('')}</tr></thead><tbody>${rowsHtml}</tbody></table></div>`
    : `<div class="schedule-empty"><div class="schedule-empty-symbol">${scheduleIcon(filtered ? 'search' : 'calendar')}</div><h3>${filtered ? '没有找到符合条件的任务' : '把下一次执行，交给计划'}</h3><p>${filtered ? '试试其他关键词，或清空筛选查看全部任务。' : '创建提醒或自动执行任务，到时间后将结果发送到会话聊。'}</p><button class="button ${filtered ? '' : 'primary'}" ${filtered ? 'data-schedule-reset' : 'data-schedule-new'}>${filtered ? '清空筛选' : '创建第一个任务'}</button>${!filtered ? '<span class="schedule-empty-note">支持单次定时与周期执行</span>' : ''}</div>`;
  return `<div class="schedule-service ${data.enabled && data.running ? 'online' : 'offline'}"><span class="schedule-service-icon">${scheduleIcon('clock')}</span><div class="schedule-service-copy"><strong><span class="schedule-online-dot"></span>${serviceLabel}</strong><span>${serviceNote}</span></div><div class="schedule-service-rule">周期执行<span>至少间隔 <strong>${number((data.minIntervalMs || 3600000) / 60000)} 分钟</strong></span></div></div>
  <section class="panel schedule-access"><div class="schedule-access-heading"><span class="schedule-section-icon">${scheduleIcon('shield')}</span><div><h2>群聊任务权限</h2><p>谁可以在群里登记和管理任务</p></div></div><form data-schedule-permissions data-version="${Number(policy.version)}"><div class="schedule-role-options">${roleOptions.map(([value, title, help]) => `<label><input type="checkbox" name="role" value="${value}"${policy.allowedRoleGroups.includes(value) ? ' checked' : ''}><span><strong>${title}</strong><small>${help}</small></span></label>`).join('')}</div><div class="schedule-permission-actions"><button class="button" type="submit">保存权限</button><span class="form-message" role="status"></span></div></form><p class="schedule-access-note">角色可多选；全不选即关闭群聊登记与管理，已有计划继续执行。<span>系统任务仅可在后台管理。</span></p></section>
  <section class="schedule-board"><div class="schedule-board-heading"><div><h2>任务计划 <span class="schedule-count">${number(data.total)}</span></h2><p>${filtered ? '当前筛选结果' : '统一查看计划，追踪每次执行与消息投递'}</p></div><div class="schedule-heading-actions">${scheduleState.draft ? '<button class="button" data-schedule-draft>继续未保存草稿</button>' : ''}<button class="button primary" data-schedule-new>${scheduleIcon('plus')}创建系统任务</button></div></div>
  <form class="schedule-filters" data-schedule-filters><label class="schedule-search"><span>搜索任务</span><div>${scheduleIcon('search')}<input id="schedule-query" value="${esc(filter.q)}" placeholder="标题或任务 ID"></div></label><label><span>群聊</span><select id="schedule-room"><option value="">全部群聊</option>${rooms.map(id => `<option value="${esc(id)}"${filter.roomId === id ? ' selected' : ''}>群 ${esc(String(id).split(':').at(-1))}</option>`).join('')}</select></label><label><span>任务级别</span><select id="schedule-authority"><option value="">全部级别</option><option value="system"${filter.authority === 'system' ? ' selected' : ''}>系统任务</option><option value="user"${filter.authority === 'user' ? ' selected' : ''}>用户任务</option></select></label><label><span>状态</span><select id="schedule-status"><option value="">全部状态</option>${statusOptions.schedules.map(status => `<option value="${status}"${filter.status === status ? ' selected' : ''}>${esc(label(status))}</option>`).join('')}</select></label><label><span>请求人</span><input id="schedule-owner" value="${esc(filter.ownerId)}" placeholder="成员 ID"></label><div class="schedule-filter-actions"><button class="button" type="submit" data-schedule-filter>筛选</button>${filtered ? '<button class="button subtle" type="button" data-schedule-reset>重置</button>' : ''}</div></form>
  ${list}</section>`;
}
function applyScheduleFilters(reset = false) {
  scheduleState.filter = reset ? { authority: '', ownerId: '', q: '', roomId: '', status: '' } : { authority: $('schedule-authority').value, ownerId: $('schedule-owner').value.trim(), q: $('schedule-query').value.trim(), roomId: $('schedule-room').value, status: $('schedule-status').value };
  offset = 0; render();
}
async function renderSchedules(sequence) {
  const requestedSource = source;
  const data = await scheduleApi('schedules', { query: { ...scheduleState.filter, room: scheduleState.filter.roomId || '', status: scheduleState.filter.status || '', includeEnded: 'true', limit: '100' } });
  const policy = data.available === false ? null : await scheduleApi('schedule-permissions');
  if (sequence !== renderSequence || view !== 'schedules' || requestedSource !== source) return;
  scheduleState.data = data; scheduleState.policy = policy; rows = data.items || [];
  $('content').innerHTML = schedulePage(data, policy); $('next').disabled = !data.hasMore;
  $('updated').textContent = '最近更新 ' + new Date().toLocaleTimeString('zh-CN');
}
async function saveSchedulePermissions(form) {
  if (form.dataset.saving) return; const message = form.querySelector('.form-message');
  const controls = [...form.querySelectorAll('input,button')];
  const roles = [...form.querySelectorAll('[name=role]')].filter(x => x.checked).map(x => x.value);
  form.dataset.saving = 'true'; controls.forEach(control => { control.disabled = true; });
  try { const result = await scheduleApi('schedule-permissions', { method: 'POST', body: { allowedRoleGroups: roles, expectedVersion: Number(form.dataset.version) } }); scheduleState.policy = result; form.dataset.version = String(result.version); message.textContent = roles.length ? '已保存，新的登记和管理操作立即生效。' : '已保存，群聊登记和管理已关闭。'; message.classList.remove('error'); }
  catch (error) { message.textContent = error.message; message.classList.add('error'); }
  finally { delete form.dataset.saving; controls.forEach(control => { control.disabled = false; }); }
}
function scheduleEditor(item) {
  const zone = item?.timezone || scheduleState.data?.defaultTimezone || 'Asia/Shanghai', spec = item?.scheduleSpec || { kind: 'once', at: Date.now() + 3600000 };
  const value = (name, fallback = '') => esc(item?.[name] ?? fallback);
  const fields = `<label class="form-field">任务标题<input name="title" required maxlength="200" value="${value('title')}"></label><label class="form-field">目标会话<select name="roomId" required${item?.id ? ' disabled' : ''}>${(scheduleState.data?.allowedRoomIds || [item?.roomId]).filter(Boolean).map(id => `<option value="${esc(id)}"${id === item?.roomId ? ' selected' : ''}>${esc(id)}</option>`).join('')}</select></label><label class="form-field">执行方式<select name="executionKind"><option value="worker"${item?.executionKind !== 'reminder' ? ' selected' : ''}>Worker 处理任务</option><option value="reminder"${item?.executionKind === 'reminder' ? ' selected' : ''}>固定文字提醒</option></select></label><label class="form-field">时区<input name="timezone" required value="${esc(zone)}" placeholder="Asia/Shanghai"></label><label class="form-field schedule-wide">收件人成员 ID（可选，可填写多个）<input name="recipientIds" value="${esc((item?.recipientIds || []).join(', '))}" placeholder="例如：301, 302"><span class="panel-description">QQ 群请填 QQ 号，多个 ID 用逗号或空格分隔；投递时逐个 @，私聊必须留空。</span></label><label class="form-field schedule-wide">执行说明 / 提醒文字<textarea name="content" rows="5" required maxlength="12000">${value('content')}</textarea></label><label class="form-field schedule-wide">绑定文件 ID（私聊 Worker，可选）<input name="attachmentIds" value="${esc((item?.attachmentIds || item?.attachmentRefs?.map(a => a.attachmentId) || []).join(', '))}"><span class="panel-description">填写同一会话已下载的附件 ID；文件版本固定，同名重传需重新选择。</span></label><label class="form-field">时间类型<select name="kind"><option value="once"${spec.kind === 'once' ? ' selected' : ''}>单次定时</option><option value="interval"${spec.kind === 'interval' ? ' selected' : ''}>固定间隔</option><option value="cron"${spec.kind === 'cron' ? ' selected' : ''}>日历循环（cron）</option></select></label><label class="form-field" data-schedule-when="once interval">${spec.kind === 'interval' ? '首次执行时间' : '执行时间'}（所选时区）<input name="localAt" type="datetime-local" value="${esc(typeof spec.at === 'string' ? spec.at : typeof spec.anchorAt === 'string' ? spec.anchorAt : scheduleLocal(spec.at || spec.anchorAt || Date.now() + 3600000, zone))}"></label><label class="form-field" data-schedule-when="interval">间隔（分钟，至少 60）<input name="intervalMinutes" type="number" min="60" step="1" value="${Number(spec.intervalMs || 3600000) / 60000}"></label><label class="form-field schedule-wide" data-schedule-when="cron">五字段 cron<input name="expression" value="${esc(spec.expression || '0 9 * * *')}" placeholder="0 9 * * 1-5"><span class="panel-description">每天 09:00：0 9 * * *；工作日：0 9 * * 1-5。分钟必须为单一数字。</span></label><label class="form-field">结果交付<select name="deliveryMode"><option value="room"${item?.deliveryMode !== 'local' ? ' selected' : ''}>发送到会话</option><option value="local"${item?.deliveryMode === 'local' ? ' selected' : ''}>仅保存后台（系统 Worker）</option></select></label><label class="form-field">错过触发<select name="misfirePolicy"><option value="coalesce_once"${item?.misfirePolicy !== 'skip' ? ' selected' : ''}>合并补跑一次</option><option value="skip"${item?.misfirePolicy === 'skip' ? ' selected' : ''}>跳过</option></select></label><label class="form-field">单次硬超时（分钟）<input name="timeoutMinutes" type="number" min="1" max="1440" value="${Number(item?.timeoutMs || 3600000) / 60000}"></label><label class="form-field">补跑有效窗口（小时）<input name="catchUpHours" type="number" min="0" max="720" value="${Number(item?.catchUpWindowMs ?? 86400000) / 3600000}"></label><label class="form-field">最多触发次数（留空不限）<input name="maxRuns" type="number" min="1" value="${value('maxRuns')}"></label><label class="form-field">结束时间（留空不限，所选时区）<input name="expiresAt" type="datetime-local" value="${esc(typeof item?.expiresAt === 'string' ? item.expiresAt : scheduleLocal(item?.expiresAt, zone))}"></label><label class="form-field">所需能力 ID（可选，逗号分隔）<input name="capabilities" value="${esc((item?.requiredCapabilityIds || []).join(', '))}"></label>`;
  return `<form data-schedule-editor data-id="${esc(item?.id || '')}" data-version="${Number(item?.version || 0)}" data-key="${esc(item?._key || scheduleKey())}"><p class="panel-description">${item?.id ? `正在编辑${item.authority === 'system' ? '系统' : '用户'}任务；级别和请求人保持不变。` : '后台创建的任务为系统级，群聊无法修改。'}</p><div class="schedule-form-grid">${fields}</div><p class="schedule-frequency-note"></p><div class="schedule-actions"><button class="button" type="button" data-schedule-preview>预览未来执行时间</button><button class="button primary" type="submit">${item?.id ? '保存修改' : '创建系统任务'}</button><button class="button" type="button" data-schedule-discard>放弃草稿</button></div><p class="form-message" role="status"></p><div data-schedule-preview-result></div></form>`;
}
function syncScheduleFields(form) { const kind = form.elements ? form.elements.namedItem('kind').value : form.querySelector('[name=kind]').value; for (const node of form.querySelectorAll('[data-schedule-when]')) node.hidden = !node.dataset.scheduleWhen.split(' ').includes(kind); form.querySelector('.schedule-frequency-note').textContent = kind === 'once' ? '单次任务没有周期频率限制。' : '周期任务最多每小时执行一次；补跑、立即执行与自动触发共用此限制。'; }
function readScheduleDraft(form) {
  const field = name => form.querySelector('[name=' + name + ']').value, kind = field('kind');
  const spec = kind === 'once' ? { kind, at: field('localAt') } : kind === 'interval' ? { kind, anchorAt: field('localAt'), intervalMs: Number(field('intervalMinutes')) * 60000 } : { kind, expression: field('expression').trim() };
  const draft = { title: field('title').trim(), roomId: field('roomId'), executionKind: field('executionKind'), deliveryMode: field('deliveryMode') || 'room', content: field('content'), recipientIds: [...new Set(field('recipientIds').split(/[,，\s]+/).filter(Boolean))], timezone: field('timezone').trim(), scheduleSpec: spec, misfirePolicy: field('misfirePolicy'), timeoutMs: Number(field('timeoutMinutes')) * 60000, catchUpWindowMs: Number(field('catchUpHours')) * 3600000, requiredCapabilityIds: field('capabilities').split(/[,，\n]/).map(x => x.trim()).filter(Boolean) };
  if (form.querySelector('[name=attachmentIds]')) draft.attachmentIds = field('attachmentIds').split(/[,，\s]+/).filter(Boolean);
  if (field('maxRuns')) draft.maxRuns = Number(field('maxRuns')); else if (form.dataset.id) draft.maxRuns = null;
  if (field('expiresAt')) draft.expiresAt = field('expiresAt'); else if (form.dataset.id) draft.expiresAt = null;
  return draft;
}
function rememberScheduleDraft(form) { if (scheduleState.saving) return; scheduleState.draft = { ...scheduleState.current, ...readScheduleDraft(form), _key: form.dataset.key }; scheduleState.dirty = true; }
function openScheduleEditor(item = null) { if (source !== 'main' || scheduleState.saving) return; scheduleState.current = item; detailSequence++; $('detail-title').textContent = item?.id ? '编辑任务' : '创建系统任务'; $('detail-body').innerHTML = scheduleEditor(item); syncScheduleFields($('detail-body').querySelector('form')); if (!$('detail').open) $('detail').showModal(); }
async function previewSchedule(form) {
  const target = form.querySelector('[data-schedule-preview-result]'), message = form.querySelector('.form-message');
  try { const draft = readScheduleDraft(form), fingerprint = JSON.stringify(draft), requestedSource = source, sequence = detailSequence; const response = await scheduleApi('schedules/preview', { method: 'POST', body: { scheduleSpec: draft.scheduleSpec, timezone: draft.timezone } }); if (!form.isConnected || !$('detail').open || source !== requestedSource || sequence !== detailSequence || fingerprint !== JSON.stringify(readScheduleDraft(form))) return; target.innerHTML = '<h3>未来执行时间</h3><ol>' + response.times.map(at => '<li>' + esc(scheduleTime(at, response.timezone)) + '</li>').join('') + '</ol><p class="muted">' + esc(response.timezone) + '</p>'; message.textContent = ''; }
  catch (error) { if (form.isConnected) { message.textContent = error.message; message.classList.add('error'); } }
}
async function saveSchedule(form) {
  if (scheduleState.saving) return;
  const draft = readScheduleDraft(form); rememberScheduleDraft(form); const id = form.dataset.id, message = form.querySelector('.form-message');
  if (!draft.roomId) { message.textContent = '请先在部署配置中添加允许的目标群。'; return; }
  if (draft.scheduleSpec.kind === 'interval' && draft.scheduleSpec.intervalMs < 3600000) { message.textContent = '周期任务最多每小时执行一次。'; return; }
  scheduleState.saving = true; const controls = [...form.querySelectorAll('input,textarea,select,button')], disabled = controls.map(x => x.disabled); controls.forEach(x => { x.disabled = true; });
  try { const result = await scheduleApi(id ? 'schedules/' + encodeURIComponent(id) + '/update' : 'schedules', { method: 'POST', body: id ? { patch: draft, expectedVersion: Number(form.dataset.version), idempotencyKey: form.dataset.key } : { input: draft, idempotencyKey: form.dataset.key } }); scheduleState.draft = null; scheduleState.dirty = false; scheduleState.saving = false; await showSchedule(result.schedule.id); await render(); notice(result.message || '任务已保存。', true); }
  catch (error) { if (form.isConnected) { message.textContent = error.message; message.classList.add('error'); } }
  finally { scheduleState.saving = false; controls.forEach((x, i) => { x.disabled = disabled[i]; }); }
}
async function showSchedule(id, runsOffset = 0) {
  const sequence = ++detailSequence, requestedSource = source;
  clearImages();
  $('detail-title').textContent = '定时任务详情'; $('detail-body').innerHTML = '<p class="muted">正在读取…</p>'; if (!$('detail').open) $('detail').showModal();
  try {
    const [detail, runs] = await Promise.all([scheduleApi('schedules/' + encodeURIComponent(id)), scheduleApi('schedules/' + encodeURIComponent(id) + '/runs', { query: { offset: String(runsOffset), limit: '30' } })]);
    if (sequence !== detailSequence || source !== requestedSource || !$('detail').open) return;
    const s = detail.schedule; scheduleState.current = s; scheduleState.runsOffset = runsOffset;
    const active = !['completed', 'cancelled'].includes(s.status), controls = [['update', '编辑'], ...(s.status === 'active' ? [['pause', '暂停后续执行']] : ['paused', 'blocked'].includes(s.status) ? [['resume', '恢复']] : []), ...(active ? [['run_now', '立即执行'], ['cancel', '取消计划及当前执行']] : []), ...(!s.archivedAt && !active ? [['archive', '归档']] : [])];
    $('detail-title').textContent = s.title;
    $('detail-body').innerHTML = `<div class="detail-summary">${badge(s.status)}<span>${s.authority === 'system' ? '系统任务 · 仅后台管理' : '用户任务 · ' + esc(s.ownerId)}</span><span>第 ${number(s.version)} 版</span></div><p class="mono">${esc(s.id)} · ${esc(s.roomId)}</p><p>${esc(scheduleRule(s))} · ${esc(s.timezone)}</p><p>结果交付：${s.deliveryMode === 'local' ? '仅保存后台' : '发送到会话'}</p><p>收件人：${s.recipientIds?.length ? esc(s.recipientIds.join('、')) : '未指定'}</p><p>下次执行：${esc(scheduleTime(s.nextRunAt, s.timezone))}</p>${s.attachmentRefs?.length ? '<h3>绑定文件版本</h3><ul>' + s.attachmentRefs.map(a => '<li>' + esc(a.name) + ' · ' + number(a.bytes) + ' 字节 · <span class="mono">' + esc(a.attachmentId) + '</span><br><span class="mono">' + esc(a.sha256) + '</span></li>').join('') + '</ul>' : ''}${s.stateReason ? '<p class="notice">' + esc(scheduleReason(s.stateReason)) + '</p>' : ''}<p class="answer-body">${esc(s.content)}</p><p class="panel-description">暂停仅停止后续与未开始的执行；取消同时请求停止当前执行。取消会停止后续上传；已上传的文件和已发送的消息无法撤回。</p><div class="schedule-actions">${controls.map(([op, text]) => `<button class="button" data-schedule-op="${op}"${op === 'run_now' && s.nextEligibleAt > Date.now() ? ' disabled' : ''}>${text}</button>`).join('')}</div>${s.nextEligibleAt > Date.now() ? `<p class="panel-description">最早可再次执行：${esc(scheduleTime(s.nextEligibleAt, s.timezone))}</p>` : ''}<p data-schedule-command-message role="status"></p><div data-schedule-confirm></div><h3>执行与投递 · ${number(runs.total)} 次</h3>${(runs.items || []).map(run => `<section class="schedule-run"><div class="detail-summary">${badge(run.status)}<span>计划 ${esc(scheduleTime(run.scheduledAt, s.timezone))}</span><span>开始 ${esc(scheduleTime(run.startedAt, s.timezone))}</span><span>交付截止 ${esc(scheduleTime(run.deliveryExpiresAt, s.timezone))}</span></div><p class="table-sub">${esc(run.reason || run.error || '')}</p><div>投递：${(run.outbox || []).length ? run.outbox.map(row => badge(row.status)).join(' ') : run.deliveryStatus ? badge(run.deliveryStatus) : '尚无投递记录'}</div>${run.tokenUsage ? taskTokenCell(run.tokenUsage) : ''}<div class="schedule-actions">${run.threadId ? `<button class="button small" data-schedule-thread="${esc(run.threadId)}">执行话题与模型轨迹</button>` : ''}${['running', 'queued'].includes(run.status) ? `<button class="button small" data-schedule-op="stop_run" data-schedule-run="${esc(run.id)}">只停止本次执行</button>` : ''}</div>${run.snapshot?.deliveryMode === 'local' && run.result?.report?.shortAnswer ? `<p class="answer-body">${esc(run.result.report.shortAnswer)}</p>` : ''}${(run.outbox || []).map(row => `<p class="answer-body">${esc(replyText(row.data?.message))}</p>${replyImages(row)}${replyFiles(row)}`).join('')}${raw(run, '实例详情')}</section>`).join('') || '<p class="muted">尚无执行记录。</p>'}<div class="schedule-actions"><button class="button small" data-schedule-runs-page="${Math.max(0, runsOffset - 30)}"${runsOffset ? '' : ' disabled'}>上一页</button><button class="button small" data-schedule-runs-page="${runsOffset + 30}"${runs.hasMore ? '' : ' disabled'}>下一页</button><button class="button small" data-schedule-reload>刷新状态</button></div>${raw(detail.audits || [], '最近变更与审计')}${raw(s, '完整计划与授权来源')}`;
  } catch (error) { if (sequence === detailSequence) $('detail-body').innerHTML = '<p class="notice">' + esc(error.message) + '</p>'; }
}
async function scheduleCommand(op, runId, button) {
  const s = scheduleState.current; if (!s || scheduleState.saving) return;
  const message = $('detail-body').querySelector('[data-schedule-command-message]');
  if (['cancel', 'stop_run', 'archive'].includes(op) && !button?.hasAttribute('data-schedule-confirmed')) { $('detail-body').querySelector('[data-schedule-confirm]').innerHTML = `<p>确认${op === 'cancel' ? '取消此计划并请求停止当前执行' : op === 'stop_run' ? '停止本次执行（保留后续循环）' : '归档此计划'}？</p><button class="button" data-schedule-op="${op}" data-schedule-run="${esc(runId || '')}" data-schedule-confirmed>确认操作</button>`; return; }
  scheduleState.saving = true; if (button) button.disabled = true;
  try { const result = await scheduleApi('schedules/' + encodeURIComponent(s.id) + '/commands', { method: 'POST', body: { op, expectedVersion: s.version, idempotencyKey: button?.dataset.scheduleKey || (button ? button.dataset.scheduleKey = scheduleKey() : scheduleKey()), ...(runId ? { runId } : {}) } }); scheduleState.saving = false; await showSchedule(s.id); await render(); const next = $('detail-body').querySelector('[data-schedule-command-message]'); if (next) { next.textContent = result.message + ' 操作状态：' + label(result.command.status); if (result.command.status === 'pending') next.innerHTML += ` <button class="button small" data-schedule-command="${esc(result.command.id)}">查看处理结果</button>`; } }
  catch (error) { if (message?.isConnected) message.textContent = error.message; }
  finally { scheduleState.saving = false; if (button) button.disabled = false; }
}
for (const container of [$('content'), $('detail-body')]) {
  container.addEventListener('submit', event => { if (event.target.matches('[data-schedule-filters]')) { event.preventDefault(); applyScheduleFilters(); } if (event.target.matches('[data-schedule-permissions]')) { event.preventDefault(); saveSchedulePermissions(event.target); } if (event.target.matches('[data-schedule-editor]')) { event.preventDefault(); saveSchedule(event.target); } });
  container.addEventListener('input', event => { const form = event.target.closest('[data-schedule-editor]'); if (form) { form.dataset.key = scheduleKey(); rememberScheduleDraft(form); } });
  container.addEventListener('change', event => { const form = event.target.closest('[data-schedule-editor]'); if (form) { syncScheduleFields(form); form.dataset.key = scheduleKey(); rememberScheduleDraft(form); } });
  container.addEventListener('click', async event => {
    const b = event.target.closest('button'); if (!b) return;
    if (b.hasAttribute('data-schedule-new')) openScheduleEditor();
    else if (b.hasAttribute('data-schedule-draft')) openScheduleEditor(scheduleState.draft);
    else if (b.dataset.scheduleId) showSchedule(b.dataset.scheduleId);
    else if (b.hasAttribute('data-schedule-preview')) previewSchedule(b.closest('form'));
    else if (b.hasAttribute('data-schedule-discard')) { scheduleState.draft = null; scheduleState.dirty = false; $('detail').close(); render(); }
    else if (b.hasAttribute('data-schedule-reset')) applyScheduleFilters(true);
    else if (b.dataset.scheduleOp === 'update') openScheduleEditor(scheduleState.current);
    else if (b.dataset.scheduleOp) scheduleCommand(b.dataset.scheduleOp, b.dataset.scheduleRun, b);
    else if (b.dataset.scheduleThread) showThread(b.dataset.scheduleThread);
    else if (b.hasAttribute('data-schedule-runs-page')) showSchedule(scheduleState.current.id, Number(b.dataset.scheduleRunsPage));
    else if (b.hasAttribute('data-schedule-reload')) showSchedule(scheduleState.current.id, scheduleState.runsOffset);
    else if (b.dataset.scheduleCommand) { try { const result = await scheduleApi('schedule-commands/' + encodeURIComponent(b.dataset.scheduleCommand)); b.parentElement.textContent = '操作状态：' + label(result.command.status) + (result.command.error ? ' · ' + result.command.error : ''); } catch (error) { notice(error.message); } }
  });
}
window.addEventListener('beforeunload', event => { if (scheduleState.dirty || scheduleState.saving) { event.preventDefault(); event.returnValue = ''; } });

initialize(); setInterval(() => { if (view === 'overview' && !$('detail').open) render({ silent: true }); }, 5000);
