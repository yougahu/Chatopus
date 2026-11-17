import { basename } from 'node:path';
import { PrivateMcp, type McpConfig } from './mcp.js';
import { PublicWebProxy } from './public-web-proxy.js';

export interface BrowserConfig extends McpConfig {
  /** Other trusted MCP implementations require an operator-managed network sandbox. */
  networkIsolation?: 'managed' | 'external';
}
const packagePattern = /^@playwright\/mcp@\d+\.\d+\.\d+$/;
const flags = new Map([['--headless', false], ['--browser', true], ['--viewport-size', true],
  ['--timeout-action', true], ['--timeout-navigation', true], ['--image-responses', true], ['--executable-path', true]]);

export function validateBrowserConfig(config: BrowserConfig) {
  if (!['managed', 'external', undefined].includes(config.networkIsolation)) throw new Error('Invalid browser networkIsolation');
  if (config.networkIsolation === 'external') return;
  const args = config.args ?? [], first = args[0] === '--yes' || args[0] === '-y' ? 1 : 0;
  if (!/^npx(?:\.cmd)?$/.test(basename(config.command)) || !packagePattern.test(args[first] ?? '')) {
    throw new Error('Managed browser requires npx --yes @playwright/mcp@EXACT_VERSION; other servers require networkIsolation: external and an isolated network');
  }
  for (let i = first + 1; i < args.length; i++) {
    const takesValue = flags.get(args[i]);
    if (takesValue === undefined || takesValue && (!args[i + 1] || args[i + 1].startsWith('--'))) throw new Error('Unsupported managed browser argument');
    if (args[i] === '--browser' && !['chromium', 'chrome', 'msedge'].includes(args[i + 1])) throw new Error('Managed browser requires Chromium');
    if (takesValue) i++;
  }
  if (Object.keys(config.env ?? {}).some(key => /^(?:PLAYWRIGHT_|HTTP_PROXY$|HTTPS_PROXY$|ALL_PROXY$|NO_PROXY$|NODE_OPTIONS$)/i.test(key))) {
    throw new Error('Managed browser network and launch settings are owned by the host');
  }
}

/** A proxy belongs to one task and is closed with its private MCP process. */
export class PublicBrowser {
  private readonly proxy = new PublicWebProxy();
  private client?: PrivateMcp;
  private starting?: Promise<PrivateMcp>;
  private closed = false;
  constructor(private config: BrowserConfig, private workspace: string) { validateBrowserConfig(config); }
  private connect() {
    if (this.closed) return Promise.reject(new Error('Browser session is closed'));
    return this.starting ??= (async () => {
      let config = this.config;
      if (config.networkIsolation !== 'external') {
        const proxy = await this.proxy.start();
        // Chromium's <-loopback> removes its implicit proxy bypass for local URLs.
        config = { ...config, env: { ...config.env, CHATOPUS_PROXY_PASSWORD: new URL(proxy).password },
          args: [...config.args!, '--proxy-server', proxy, '--proxy-bypass', '<-loopback>', '--isolated', '--block-service-workers'] };
      }
      if (this.closed) { await this.proxy.close(); throw new Error('Browser session is closed'); }
      return this.client = new PrivateMcp(config, this.workspace, 'browser');
    })();
  }
  async list(signal?: AbortSignal) { signal?.throwIfAborted(); return (await this.connect()).list(signal); }
  async call(name: string, args: Record<string, unknown>, signal?: AbortSignal) { signal?.throwIfAborted(); return (await this.connect()).call(name, args, signal); }
  async close() {
    this.closed = true;
    await Promise.allSettled([this.client?.close(), this.proxy.close()]);
    await this.starting?.catch(() => {});
  }
}
