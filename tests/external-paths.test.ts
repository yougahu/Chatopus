import { expect, it, vi } from 'vitest';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { loadConfig, reloadAgentConfig } from '../src/config.js';
import { capabilityRevision, createCapabilitySession, loadExtensions, type CapabilitySession } from '../src/capabilities.js';
import { NativeAgentRuntime } from '../src/runtime/native.js';
import { mountAgentPlugins } from '../src/runtime/plugins.js';

const fakeHome = vi.hoisted(() => ({ path: '' }));
vi.mock('node:os', async importOriginal => ({
  ...await importOriginal<typeof import('node:os')>(), homedir: () => fakeHome.path,
}));

it('runs with state, skills, extension tools and plugins outside the checkout using home paths', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'chatopus-external-'));
  const root = join(temporary, 'checkout'); fakeHome.path = join(temporary, 'home');
  const skill = join(fakeHome.path, 'skills', 'document-reader');
  const tools = join(fakeHome.path, 'tools');
  let session: CapabilitySession | undefined, runtime: NativeAgentRuntime | undefined;
  try {
    await Promise.all([mkdir(root), mkdir(skill, { recursive: true }), mkdir(tools, { recursive: true })]);
    await writeFile(join(skill, 'SKILL.md'), '# Document reader\nKeep paragraph references.\n');
    await writeFile(join(tools, 'extension.mjs'), `export async function createSession(){return {
      systemContext:'External document tools', tools:[{name:'document_count',description:'Count a synthetic batch',
      inputSchema:{type:'object',properties:{}},async execute(){return '36'}}],async close(){}}}`);
    await writeFile(join(tools, 'plugin.mjs'), `export const name='external-plugin';
      export const inject=['systemPrompt'];export function apply(ctx){
      ctx.systemPrompt.section({name:'external',order:10,text:'EXTERNAL_PLUGIN_ACTIVE',interpolate:false});}`);
    await writeFile(join(root, 'config.local.json'), JSON.stringify({
      stateDir: '~/runtime', skills: [{ id: 'document-reader', path: '~/skills/document-reader' }],
      extensions: [{ id: 'document-tools', module: '~/tools/extension.mjs' }],
      plugins: [{ module: '~/tools/plugin.mjs' }],
    }));
    const config = loadConfig(root);
    expect(config.stateDir).toBe(join(fakeHome.path, 'runtime'));
    expect(config.skills[0].path).toBe(skill);
    expect(reloadAgentConfig(config).config.skills[0].path).toBe(skill);
    expect(await readFile(join(config.skills[0].path, 'SKILL.md'), 'utf8')).toContain('paragraph references');
    expect(await loadExtensions(config)).toHaveLength(1);
    expect(capabilityRevision(config)).toMatch(/^[a-f0-9]{64}$/);
    session = await createCapabilitySession(config, {
      threadId: 'document', runId: 'fixture', revision: 1, question: 'Count the batch',
      workspace: join(config.stateDir, 'workspaces', 'document', 'fixture'),
    });
    expect(await session.tools.find(tool => tool.name === 'document_count')!.execute({})).toBe('36');
    let prompt = '';
    class InspectAdapter extends LlmAdapter {
      async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
        prompt = JSON.stringify(request.messages);
        yield { type: 'block-start', index: 0, blockType: 'text' };
        yield { type: 'block-end', index: 0, block: { type: 'text', text: '36' } };
        yield { type: 'finish', reason: { kind: 'stop' } };
      }
    }
    runtime = await NativeAgentRuntime.create({ root: join(config.stateDir, 'native'), adapters: { test: new InspectAdapter() } });
    const agent = await runtime.start({ id: 'external', model: { provider: 'test', model: 'm' },
      cwd: config.stateDir, systemPrompt: 'Core',
      setup: ctx => mountAgentPlugins(ctx, config.plugins ?? [], { root, role: 'worker' }) });
    expect((await agent.send('Count the batch')).text).toBe('36');
    expect(prompt).toContain('EXTERNAL_PLUGIN_ACTIVE');
    await expect(access(join(root, '.runtime'))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await session?.close(); await runtime?.close();
    await rm(temporary, { recursive: true, force: true });
  }
});
