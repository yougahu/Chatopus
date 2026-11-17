import { afterEach, describe, expect, it, vi } from 'vitest';
import { request, createServer } from 'node:http';
import { connect } from 'node:net';
import { once } from 'node:events';
import { isPublicAddress, publicLookup, publicWebUrl, PublicWebAccess, resolvePublicHost } from '../src/tools/public-network.js';
import { PublicWebProxy } from '../src/tools/public-web-proxy.js';

const dns = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock('node:dns/promises', () => ({ lookup: dns.lookup }));
afterEach(() => { vi.restoreAllMocks(); dns.lookup.mockReset(); });

describe('public web destinations', () => {
  it.each(['127.0.0.1', '10.1.2.3', '172.16.1.1', '192.168.1.1', '169.254.169.254', '100.64.0.1',
    '0.0.0.0', '198.18.0.1', '192.0.2.1', '224.0.0.1', '255.255.255.255', '::1', 'fc00::1', 'fe80::1',
    '::ffff:127.0.0.1', '64:ff9b::a00:1', '2001:db8::1', '2002:7f00:1::', '3fff::1'])('rejects %s', ip => {
    expect(isPublicAddress(ip)).toBe(false);
  });
  it.each(['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '2001:4860:4860::8888'])('accepts %s', ip => {
    expect(isPublicAddress(ip)).toBe(true);
  });
  it.each(['https://localhost/', 'https://service.internal/', 'https://printer/', 'https://127.1/',
    'https://2130706433/', 'https://0x7f000001/', 'https://[::ffff:7f00:1]/', 'https://10.0.0.1/',
    'http://example.org/', 'https://example.org:8443/', 'file:///etc/hosts'])('rejects unsafe URL %s', url => {
    expect(() => publicWebUrl(url)).toThrow();
  });
  it('allows HTTP only for the proxy, with public destinations and default ports', () => {
    expect(publicWebUrl('http://example.org:80/', true).href).toBe('http://example.org/');
    expect(() => publicWebUrl('http://127.0.0.1:80/', true)).toThrow();
    expect(() => publicWebUrl('https://' + ['user', 'password'].join(':') + '@example.org/')).toThrow();
  });
  it('rejects a mixed DNS result and returns vetted addresses without a second lookup', async () => {
    dns.lookup.mockResolvedValueOnce([{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }]);
    await expect(resolvePublicHost('example.org')).rejects.toThrow('DNS resolved');
    dns.lookup.mockResolvedValueOnce([{ address: '8.8.8.8', family: 4 }]);
    const address = await new Promise((resolve, reject) => publicLookup('example.org', { family: 4 }, (error, ip, family) => {
      if (error) reject(error); else resolve({ ip, family });
    }));
    expect(address).toEqual({ ip: '8.8.8.8', family: 4 });
    expect(dns.lookup).toHaveBeenCalledTimes(2);
  });
  it('fails closed on empty answers, mapped private answers and lookup errors', async () => {
    for (const answers of [[], [{ address: '::ffff:10.0.0.1', family: 6 }]]) {
      dns.lookup.mockResolvedValueOnce(answers);
      await expect(resolvePublicHost('example.org')).rejects.toThrow('DNS resolved');
    }
    dns.lookup.mockRejectedValueOnce(new Error('DNS unavailable'));
    await expect(resolvePublicHost('example.org')).rejects.toThrow('DNS unavailable');
  });
  it('blocks private DNS at the actual fetch connection before any local request', async () => {
    const server = createServer((_req, res) => { res.end('private data'); });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    let contacted = false; server.on('connection', () => { contacted = true; });
    const web = new PublicWebAccess();
    dns.lookup.mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
    try {
      await expect(web.fetch('https://example.org/')).rejects.toThrow();
      expect(dns.lookup).toHaveBeenCalled(); expect(contacted).toBe(false);
    } finally { await web.close(); await new Promise<void>(r => server.close(() => r())); }
  });
});

it('authenticates proxy clients and blocks private HTTP/CONNECT destinations, including DNS rebinding', async () => {
  const proxy = new PublicWebProxy(), url = new URL(await proxy.start());
  const auth = 'Basic ' + Buffer.from(url.username + ':' + url.password).toString('base64');
  const http = (target: string, authenticated = true) => new Promise<number>((resolve, reject) => {
    const req = request({ host: url.hostname, port: url.port, path: target,
      headers: authenticated ? { 'Proxy-Authorization': auth } : {} }, res => { res.resume(); resolve(res.statusCode!); });
    req.on('error', reject); req.end();
  });
  const tunnel = (target: string, authenticated = true) => new Promise<string>((resolve, reject) => {
    const socket = connect(Number(url.port), url.hostname);
    socket.once('error', reject); socket.once('data', data => { resolve(data.toString()); socket.destroy(); });
    socket.once('connect', () => socket.write('CONNECT ' + target + ' HTTP/1.1\r\nHost: ' + target
      + (authenticated ? '\r\nProxy-Authorization: ' + auth : '') + '\r\n\r\n'));
  });
  try {
    expect(await http('http://example.org/', false)).toBe(407);
    const challenge = await tunnel('example.org:443', false);
    expect(challenge).toContain('407 Proxy Authentication Required');
    expect(challenge).toContain('Proxy-Authenticate: Basic realm="Chatopus"');
    expect(await http('http://127.0.0.1/')).toBe(403);
    expect(await http('http://169.254.169.254/')).toBe(403);
    expect(await tunnel('127.0.0.1:443')).toContain('403');
    expect(await tunnel('example.org:8092')).toContain('403');
    dns.lookup.mockResolvedValue([{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }]);
    expect(await tunnel('example.org:443')).toContain('403');
    expect(await http('http://example.org/')).toBe(502);
  } finally { await proxy.close(); }
  await expect(proxy.start()).rejects.toThrow('closed');
});
