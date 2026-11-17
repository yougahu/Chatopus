import { createServer, request, type Server, type IncomingMessage, type OutgoingHttpHeaders } from 'node:http';
import { connect, type Socket } from 'node:net';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { publicLookup, publicWebUrl, resolvePublicHost } from './public-network.js';

/** HTTP/CONNECT egress for the trusted browser process, including redirects and subresources. */
export class PublicWebProxy {
  private server?: Server;
  private readonly sockets = new Set<Socket>();
  private readonly password = randomBytes(32).toString('hex');
  private closed = false;
  private starting?: Promise<string>;
  private authorized(req: IncomingMessage) {
    const supplied = Buffer.from(req.headers['proxy-authorization'] ?? '');
    const expected = Buffer.from('Basic ' + Buffer.from('chatopus:' + this.password).toString('base64'));
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
  }
  private track(socket: Socket) {
    this.sockets.add(socket); socket.on('close', () => this.sockets.delete(socket));
    socket.on('error', () => {}); socket.setTimeout(30_000, () => socket.destroy()); return socket;
  }
  start(): Promise<string> {
    if (this.closed) return Promise.reject(new Error('Web proxy is closed'));
    return this.starting ??= this.listen();
  }
  private async listen() {
    const server = createServer((req, res) => {
      if (!this.authorized(req)) { res.writeHead(407, { 'Proxy-Authenticate': 'Basic realm="Chatopus"' }); res.end(); return; }
      let url: URL;
      try { url = publicWebUrl(req.url ?? '', true); if (url.protocol !== 'http:') throw new Error('Use CONNECT for HTTPS'); }
      catch { res.writeHead(403); res.end('Public web destinations only'); return; }
      // Drop hop-by-hop and proxy credentials before forwarding.
      const headers: OutgoingHttpHeaders = { ...req.headers, host: url.host };
      const hop = ['connection', 'proxy-connection', 'proxy-authorization', 'keep-alive', 'te', 'trailer', 'upgrade',
        ...String(req.headers.connection ?? '').split(',').map(name => name.trim().toLowerCase())];
      for (const name of hop) delete headers[name];
      const upstream = request(url, { method: req.method, headers, lookup: publicLookup, agent: false }, response => {
        res.writeHead(response.statusCode ?? 502, response.headers); response.pipe(res);
        response.on('error', () => res.destroy());
      });
      upstream.on('socket', socket => this.track(socket));
      upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end('Public web request failed'); });
      res.on('close', () => upstream.destroy());
      req.on('error', () => upstream.destroy()); req.pipe(upstream);
    });
    this.server = server;
    server.on('connection', socket => this.track(socket));
    server.on('clientError', (_error, socket) => socket.destroy());
    server.on('upgrade', (_req, socket) => socket.destroy());
    server.on('connect', (req, client, head) => {
      const socket = client as Socket;
      if (!this.authorized(req)) {
        socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="Chatopus"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
        return;
      }
      void (async () => {
        const target = req.url ?? '';
        if (!/^(?:\[[0-9a-fA-F:]+\]|[^\s/:@?#]+):443$/.test(target)) throw new Error('Invalid CONNECT target');
        const url = publicWebUrl('https://' + target);
        const [address] = await resolvePublicHost(url.hostname);
        if (this.closed || socket.destroyed) return;
        const upstream = this.track(connect({ host: address.address, family: address.family, port: 443 }));
        upstream.once('connect', () => {
          socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          if (head.length) upstream.write(head);
          socket.pipe(upstream); upstream.pipe(socket);
        });
        upstream.on('error', () => socket.destroy());
        upstream.on('close', () => socket.destroy()); socket.on('close', () => upstream.destroy());
      })().catch(() => socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'));
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
    });
    if (this.closed) { await this.close(); throw new Error('Web proxy is closed'); }
    const port = (server.address() as { port: number }).port;
    const url = new URL('http://127.0.0.1:' + port);
    url.username = 'chatopus'; url.password = this.password;
    return url.href;
  }
  async close() {
    this.closed = true;
    for (const socket of this.sockets) socket.destroy();
    if (this.server?.listening) await new Promise<void>(resolve => this.server!.close(() => resolve()));
  }
}
