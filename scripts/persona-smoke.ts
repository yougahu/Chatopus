/** Explicit API verification of actual dsh Router replies under two native persona profiles. */
import { mkdirSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DEFAULT_BUSINESS_SETTINGS } from '../src/business-config.js';
import { loadConfig } from '../src/config.js';
import { DshRuntime, type RuntimeMetrics } from '../src/dsh-runtime.js';
import type { GroupMessage } from '../src/types.js';

const base = loadConfig(); const id = randomUUID();
const output = join(base.stateDir, 'verification', `persona-${id}`); mkdirSync(output, { recursive: true });
const formal = join(output, 'formal.md'); const friendly = join(output, 'friendly.md');
writeFileSync(formal, '# 正式问候验收\n你说话简洁礼貌。向群友问候时称呼“访客”，只用一个完整句子，不使用表情符号，不用“老哥”。');
writeFileSync(friendly, '# 热情问候验收\n你像热情的聊天伙伴。向群友问候时称呼“老哥”，用一两句轻松的话并加一个🙂。不使用“访客”作为称呼。');
// Bind synthetic rooms to independent business profiles in this invocation's own store.
const business = structuredClone(DEFAULT_BUSINESS_SETTINGS);
business.profiles.default.personaFile = formal;
business.profiles.friendly = { ...business.profiles.default, name: '友好助手', personaFile: friendly };
business.roomProfiles['persona-friendly'] = 'friendly';
const config = { ...base, business, stateDir: join(output, 'runtime') };
const metrics: RuntimeMetrics[] = [];
const runtime = await DshRuntime.create(config, { onMetrics: x => metrics.push(x) });
const checks: unknown[] = [];
function sessionFile(dir: string, sessionId: string): string | undefined {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue; const child = join(dir, e.name);
    if (e.name === sessionId) return join(child, 'session.v4.jsonl');
    const found = sessionFile(child, sessionId); if (found) return found;
  }
}
try {
  for (const roomId of ['persona-formal', 'persona-friendly']) {
    const message: GroupMessage = { id: `${roomId}:1`, platform: 'replay', roomId, messageId: '1', authorId: 'tester', authorName: '测试群友', text: '机器人在吗？我今天刚上线，打个招呼吧。', timestamp: Date.now(), mentions: [], attachments: [], isMentioned: true, isAdmin: false };
    console.log(JSON.stringify({ event: 'started', roomId, model: config.router.model }));
    const actions = await runtime.route({ roomId, event: 'messages', messages: [message], recentMessages: [], threads: [] });
    const action = actions[0];
    if (actions.length !== 1 || action.action !== 'reply_direct') throw new Error(`${roomId}: expected a direct greeting`);
    const text = action.text;
    if (roomId === 'persona-formal' && (!text.includes('访客') || text.includes('老哥') || text.includes('🙂'))) throw new Error('Formal persona not reflected in actual response');
    if (roomId === 'persona-friendly' && (!text.includes('老哥') || !text.includes('🙂') || text.includes('访客'))) throw new Error('Friendly persona not reflected in actual response');
    const sessionId = metrics.at(-1)?.sessionId; if (!sessionId) throw new Error('Missing real model metrics');
    const file = sessionFile(join(config.stateDir, 'dsh/sessions'), sessionId); if (!file) throw new Error('Missing durable native dsh trace');
    const events = readFileSync(file, 'utf8').trim().split('\n').map(x => JSON.parse(x));
    const systems = events.filter(e => e.type === 'system/message').map(e => e.data.message.content.map((c: { text?: string }) => c.text ?? '').join('\n'));
    if (!systems.some(text => text.includes('<operator-persona>') && text.includes(roomId === 'persona-formal' ? '正式问候验收' : '热情问候验收'))) throw new Error('Native prompt did not contain mounted persona');
    checks.push({ roomId, actions, sessionId, trace: file });
    console.log(JSON.stringify({ event: 'passed', roomId, text }));
  }
  const evidence = { status: 'passed', time: new Date().toISOString(), model: config.router.model, checks, metrics };
  writeFileSync(join(output, 'result.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ status: 'passed', report: join(output, 'result.json'), checks: checks.length }));
} catch (error) {
  writeFileSync(join(output, 'result.json'), JSON.stringify({ status: 'failed', time: new Date().toISOString(), model: config.router.model, checks, metrics, error: error instanceof Error ? error.message : String(error) }, null, 2));
  throw error;
} finally { await runtime.close(); }
