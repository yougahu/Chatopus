import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { agentSettingsRevision, type Config } from '../config.js';
import { resolveBusinessProfile } from '../business-config.js';
import { capabilityRevision } from '../capabilities.js';
import { loadPersona } from '../persona.js';
import { WORKER_PROMPT } from '../protocol.js';
import { QQ_TEXT_FORMAT } from '../platform/text-format.js';
import { WORKER_SCHEDULE_INSTRUCTION } from './tools.js';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');

/** Persist only this hash. Credentials and operator file contents never enter the task record. */
export function scheduledExecutionConfigRevision(config: Config, roomId: string): string {
  const profile = resolveBusinessProfile(config, roomId);
  const skills = config.skills.filter(skill => profile.skillIds.includes(skill.id));
  const extensions = config.extensions.filter(extension => profile.extensionIds.includes(extension.id));
  const plugins = (config.plugins ?? []).filter(plugin => plugin.enabled !== false && (plugin.scope ?? 'worker') !== 'router').map(plugin => {
    const file = plugin.module.startsWith('file:') ? fileURLToPath(plugin.module)
      : isAbsolute(plugin.module) || plugin.module.startsWith('.') ? resolve(config.root, plugin.module)
      : createRequire(join(config.root, 'package.json')).resolve(plugin.module);
    return { ...plugin, contentHash: digest(readFileSync(file, 'utf8')) };
  });
  return digest(JSON.stringify({ version: 1, settings: agentSettingsRevision(config.root), profile,
    worker: config.worker, provider: config.providers?.[config.worker.provider], baseUrl: config.baseUrl,
    credentialHash: digest(config.workerApiKey), capabilities: capabilityRevision({ root: config.root, skills, extensions }),
    persona: loadPersona(config, roomId)?.prompt ?? '', plugins, memory: config.memory, python: config.python, browser: config.browser,
    workerTimeoutMs: config.workerTimeoutMs, maxWorkerSteps: config.maxWorkerSteps, bot: config.qq.selfId,
    prompts: [WORKER_PROMPT, WORKER_SCHEDULE_INSTRUCTION, roomId.startsWith('qq:') ? QQ_TEXT_FORMAT : ''] }));
}
