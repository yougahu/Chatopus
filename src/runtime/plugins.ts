import { createRequire } from 'node:module';
import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Context } from '@deepseek-ai/cordis';

export interface AgentPluginSpec {
  /** Installed npm package/subpath, local path, or file URL. No remote imports. */
  module: string;
  scope?: 'router' | 'worker' | 'both';
  options?: Record<string, unknown>;
  enabled?: boolean;
}
export interface PluginScope { root: string; role: 'router' | 'worker' }

/** Operator-owned configuration only. This function never installs packages. */
export function validateAgentPlugins(value: unknown): asserts value is AgentPluginSpec[] {
  if (!Array.isArray(value) || value.length > 30) throw new Error('plugins must be an array of at most 30 trusted modules');
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Invalid plugin declaration');
    const p = item as Record<string, unknown>;
    if (typeof p.module !== 'string' || !p.module.trim() || p.module.length > 1000 || /[\r\n\0]/.test(p.module)) throw new Error('Invalid plugin module');
    if (p.scope !== undefined && !['router', 'worker', 'both'].includes(String(p.scope))) throw new Error('Invalid plugin scope');
    if (p.enabled !== undefined && typeof p.enabled !== 'boolean') throw new Error('Invalid plugin enabled flag');
    if (p.options !== undefined && (!p.options || typeof p.options !== 'object' || Array.isArray(p.options))) throw new Error('Plugin options must be an object');
    if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(p.module) && !p.module.startsWith('file:')) throw new Error('Remote plugin imports are disabled; install a trusted package or use a local file');
  }
}

async function moduleUrl(module: string, root: string): Promise<string> {
  let file: string;
  if (module.startsWith('file:')) file = fileURLToPath(module);
  else if (module.startsWith('~/')) file = join(homedir(), module.slice(2));
  else if (isAbsolute(module) || module.startsWith('./') || module.startsWith('../')) file = resolve(root, module);
  else {
    // Resolution is anchored in this project, so npm-installed plugins share its pinned peers.
    const require = createRequire(join(resolve(root), 'package.json'));
    file = require.resolve(module);
  }
  return pathToFileURL(await realpath(file)).href;
}

/** Mount native Cordis plugins inside the Agent's owned scope, in configured order. */
export async function mountAgentPlugins(ctx: Context, specs: readonly AgentPluginSpec[], scope: PluginScope): Promise<void> {
  validateAgentPlugins(specs);
  const mounted = new Set<string>();
  for (const spec of specs) {
    if (spec.enabled === false || ((spec.scope ?? 'worker') !== 'both' && (spec.scope ?? 'worker') !== scope.role)) continue;
    let url: string;
    try { url = await moduleUrl(spec.module, scope.root); }
    catch { throw new Error(`Unable to resolve configured plugin ${spec.module}; check its local path or installed package`); }
    if (mounted.has(url)) throw new Error(`Duplicate plugin in ${scope.role} scope: ${spec.module}`);
    mounted.add(url);
    const imported = await import(url);
    const plugin = imported.default ?? imported;
    if (typeof plugin !== 'function' && (!plugin || typeof plugin.apply !== 'function')) {
      throw new Error(`Configured module is not a Cordis plugin: ${spec.module}`);
    }
    // Cordis owns dependency checks, configuration validation and disposal of the child fiber.
    await ctx.plugin(plugin, structuredClone(spec.options ?? {}));
  }
}
