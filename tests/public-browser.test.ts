import { afterEach, expect, it, vi } from 'vitest';
import { PublicBrowser, validateBrowserConfig } from '../src/tools/public-browser.js';
import { PrivateMcp } from '../src/tools/mcp.js';
import { request } from 'node:http';

afterEach(() => vi.restoreAllMocks());
const managed = { command: 'npx', args: ['--yes', '@playwright/mcp@0.0.85', '--headless', '--browser', 'chromium'] };
it('requires a pinned managed server and rejects settings that bypass its network boundary', () => {
  expect(() => validateBrowserConfig(managed)).not.toThrow();
  for (const args of [ ['@playwright/mcp@latest'], ['@playwright/mcp@0.0.85', '--config', '/tmp/override.json'],
    ['@playwright/mcp@0.0.85', '--proxy-bypass', '*'], ['@playwright/mcp@0.0.85', '--cdp-endpoint', 'http://localhost'],
    ['@playwright/mcp@0.0.85', '--browser', 'firefox'] ]) {
    expect(() => validateBrowserConfig({ command: 'npx', args })).toThrow();
  }
  expect(() => validateBrowserConfig({ ...managed, env: { PLAYWRIGHT_MCP_PROXY_SERVER: 'http://localhost' } })).toThrow();
  expect(() => validateBrowserConfig({ command: 'custom-mcp' })).toThrow('networkIsolation');
  expect(() => validateBrowserConfig({ command: 'custom-mcp', networkIsolation: 'external' })).not.toThrow();
});
it('starts an authenticated proxy for the MCP process and shuts it down with the session', async () => {
  let captured: any;
  vi.spyOn(PrivateMcp.prototype, 'list').mockImplementation(async function(this: any) { captured = this.config; return []; });
  vi.spyOn(PrivateMcp.prototype, 'close').mockResolvedValue();
  const browser = new PublicBrowser(managed, '/tmp/synthetic-browser-workspace');
  await browser.list();
  const args: string[] = captured.args, url = new URL(args[args.indexOf('--proxy-server') + 1]);
  try {
    expect(args.slice(-4)).toEqual(['--proxy-bypass', '<-loopback>', '--isolated', '--block-service-workers']);
    expect(url.hostname).toBe('127.0.0.1'); expect(url.password.length).toBe(64);
    expect(captured.env.CHATOPUS_PROXY_PASSWORD).toBe(url.password);
    const status = await new Promise<number>((resolve, reject) => {
      const req = request({ hostname: url.hostname, port: url.port, path: 'http://127.0.0.1/' }, res => { res.resume(); resolve(res.statusCode!); });
      req.on('error', reject); req.end();
    });
    expect(status).toBe(407);
  } finally { await browser.close(); }
  await expect(browser.list()).rejects.toThrow('closed');
});
