import { lookup } from 'node:dns/promises';
import type { LookupFunction } from 'node:net';
import ipaddr from 'ipaddr.js';
import { Agent } from 'undici';

/** Only globally routable unicast addresses may receive model-controlled web traffic. */
export function isPublicAddress(address: string): boolean {
  try {
    const parsed = ipaddr.process(address);
    if (parsed.range() !== 'unicast') return false;
    if (parsed.kind() === 'ipv6') {
      const v6 = parsed as ipaddr.IPv6;
      return v6.match(ipaddr.parseCIDR('2000::/3'))
        && !['2001::/23', '2001:db8::/32', '2002::/16', '3fff::/20'].some(cidr => v6.match(ipaddr.parseCIDR(cidr)));
    }
    return true;
  } catch { return false; }
}

export function publicWebUrl(raw: string, allowHttp = false): URL {
  const url = new URL(raw), host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (!(url.protocol === 'https:' || allowHttp && url.protocol === 'http:') || url.username || url.password || url.port) {
    throw new Error('Use a public web URL without credentials or custom ports');
  }
  if (!host || host === 'localhost' || /\.(?:localhost|local|internal|lan|home|onion)$/.test(host)
    || (!host.includes('.') && !host.includes(':')) || ipaddr.isValid(host) && !isPublicAddress(host)) {
    throw new Error('Local, private and reserved network destinations are unavailable');
  }
  return url;
}

/** Check every answer, then connect to a checked address without resolving it again. */
export async function resolvePublicHost(hostname: string, resolve = lookup) {
  const host = hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
  publicWebUrl('https://' + (host.includes(':') ? '[' + host + ']' : host));
  const answers = ipaddr.isValid(host)
    ? [{ address: host, family: ipaddr.parse(host).kind() === 'ipv4' ? 4 : 6 }]
    : await resolve(host, { all: true, verbatim: true });
  if (!answers.length || answers.some(answer => !isPublicAddress(answer.address))) {
    throw new Error('DNS resolved to a local, private or reserved network destination');
  }
  return answers;
}

export const publicLookup: LookupFunction = (hostname, options, callback) => {
  void resolvePublicHost(hostname).then(answers => {
    const selected = answers.filter(answer => !options.family || answer.family === Number(options.family));
    if (!selected.length) throw new Error('No public address for the requested address family');
    if (options.all) callback(null, selected);
    else callback(null, selected[0].address, selected[0].family);
  }).catch(error => callback(error as NodeJS.ErrnoException, ''));
};

export class PublicWebAccess {
  private readonly agent = new Agent({ connect: { lookup: publicLookup, timeout: 15_000 } });
  fetch(raw: string, signal?: AbortSignal, redirect:RequestRedirect='error') {
    const url = publicWebUrl(raw);
    const options: RequestInit & { dispatcher: Agent } = { dispatcher: this.agent, redirect,
      signal: AbortSignal.any([AbortSignal.timeout(30_000), ...(signal ? [signal] : [])]) };
    return fetch(url, options);
  }
  async close() { await this.agent.destroy(); }
}
