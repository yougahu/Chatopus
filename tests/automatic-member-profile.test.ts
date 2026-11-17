import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { automaticMemoryEvidence, readAutomaticMemberProfile } from '../src/memory/automatic-member-profile.js';
import { OpenVikingClient, memoryAccountId, memoryPeerId } from '../src/memory/openviking-client.js';

const peer = memoryPeerId('alice'), other = memoryPeerId('bob'), account = memoryAccountId('test', 'bot', 'room');
const base = `viking://user/group/peers/${peer}/memories`;
const hash = (text:string) => createHash('sha256').update(text).digest('hex');
const ok = (result:unknown) => Response.json({ status: 'ok', result });
const missing = () => Response.json({ status: 'error', error: { code: 'NOT_FOUND' } }, { status: 404 });
function fact(body = '我长期喜欢统计分析', owner = peer) {
  return body + '\n\n<!-- MEMORY_FIELDS\n' + JSON.stringify({ user: owner, boe_provenance: {
    version: 1, peer_id: owner, source_role: 'user', verification: 'source_verified', source_message_ids: ['m1'],
    quote: '我长期喜欢统计分析', content_sha256: hash(body), source_created_at: '2026-11-08T07:30:00Z',
  } }) + '\n-->';
}
function fixture(files:Record<string,string>, overrideList?:unknown[], times:Record<string,number> = {}) {
  const reads:string[] = [];
  const client = new OpenVikingClient({ baseUrl: 'https://memory.invalid', credential: async () => 'user', fetch: async (input) => {
    const url = new URL(String(input)), uri = url.searchParams.get('uri')!; reads.push(uri);
    if (url.pathname === '/api/v1/fs/ls') {
      expect(url.searchParams.get('sort_by')).toBe('mtime'); expect(url.searchParams.get('sort_order')).toBe('desc');
      return ok(overrideList ?? Object.keys(files).filter(path=>path.startsWith(uri+'/'))
        .sort((a,b)=>(times[b]??0)-(times[a]??0)).slice(0,Number(url.searchParams.get('node_limit')))
        .map(path=>({uri:path,isDir:false,modTime:new Date(times[path]??0).toISOString()})));
    }
    if (url.pathname === '/api/v1/content/read') return files[uri] === undefined ? missing() : ok(files[uri]);
    throw new Error('Unexpected endpoint');
  } });
  return { client, reads };
}

describe('automatic member profile evidence and scope', () => {
  it('requires source identity, an exact body hash and the user quote before claiming source verification', () => {
    expect(automaticMemoryEvidence(fact(), peer)).toMatchObject({ verification: 'source_verified', sourceMessageIds: ['m1'], sourceCreatedAt: Date.parse('2026-11-08T07:30:00Z') });
    for (const changed of [fact('我长期喜欢统计分析，但这是一个转述'), fact().replace('"source_role":"user"', '"source_role":"assistant"'),
      fact().replace('我长期喜欢统计分析', '添加其他事实'), fact().replace('"m1"', '""'), fact() + '\n<!-- MEMORY_FIELDS {} -->'])
      expect(automaticMemoryEvidence(changed, peer).verification).toBe('unverified');
    expect(automaticMemoryEvidence(fact(undefined, other), peer)).toMatchObject({ identityMismatch: true, verification: 'unverified' });
  });
  it('loads only peer profiles and member preferences, excluding root, other members, events and owner mismatches', async () => {
    const { client, reads } = fixture({
      [`${base}/profile/fact_a.md`]: fact(),
      [`${base}/preferences/fact_b.md`]: fact(),
      [`${base}/profile.md`]: 'Legacy name; not confirmed',
      [`${base}/preferences/wrong.md`]: fact(undefined, other),
      [`viking://user/group/memories/preferences/${peer}/old.md`]: 'Legacy preference',
      [`${base}/events/e.md`]: 'One-off joke',
      [`viking://user/group/peers/${other}/memories/profile.md`]: 'Someone else',
      'viking://user/group/memories/profile.md': 'Mixed identity',
    });
    const profile = await readAutomaticMemberProfile(client, account, 'alice');
    expect(profile.entries).toHaveLength(4);
    expect(profile.entries.filter(entry=>entry.verification === 'source_verified')).toHaveLength(2);
    expect(profile.truncated).toBe(true); // An inconsistent owner was excluded.
    expect(reads).not.toContain('viking://user/group/memories/profile.md');
    expect(reads.some(uri=>uri.includes(other) || uri.includes('/events/'))).toBe(false);
    expect(profile.entries.every(entry=>!entry.text.includes('MEMORY_FIELDS'))).toBe(true);
  });
  it('rejects listing escapes and does not read a backend supplied URI from another member', async () => {
    const escape = `viking://user/group/peers/${other}/memories/profile.md`;
    const { client, reads } = fixture({}, [{ uri: escape, isDir: false }]);
    await expect(readAutomaticMemberProfile(client, account, 'alice')).rejects.toThrow('out-of-scope');
    expect(reads).not.toContain(escape);
  });
  it('retrieves newest facts before directory limits and merges profile/preferences by freshness rather than hash', async () => {
    const uris = Array.from({length:30},(_,i)=>`${base}/profile/fact_${i.toString().padStart(2,'0')}.md`);
    const preferences = `${base}/preferences/fact_zz.md`, old = `${base}/profile/fact_old.md`;
    const files = Object.fromEntries([...uris, preferences, old].map(uri=>[uri, fact()]));
    const times = Object.fromEntries(uris.map((uri,i)=>[uri, 1_000_000+i*1000]));
    times[preferences] = 2_000_000; times[old] = 1;
    const {client} = fixture(files, undefined, times);
    const profile = await readAutomaticMemberProfile(client, account, 'alice', { maxEntries: 2, maxBytes: 6000 });
    expect(profile.entries.map(entry=>entry.uri)).toEqual([preferences, uris[29]]);
    expect(profile.truncated).toBe(true);
  });
  it('bounds serialized content and metadata without splitting Unicode; limits read count even on large listings', async () => {
    const files = Object.fromEntries(Array.from({length:30},(_,i)=>[`${base}/preferences/fact_${i}.md`, '中文😀"\n'.repeat(1000)]));
    const { client, reads } = fixture(files);
    const result = await readAutomaticMemberProfile(client, account, 'alice', { maxBytes: 650, maxEntries: 2 });
    expect(Buffer.byteLength(JSON.stringify(result.entries))).toBeLessThanOrEqual(650);
    expect(result.entries.length).toBeLessThanOrEqual(2);
    expect(result.truncated).toBe(true);
    expect(reads.filter(uri=>uri.endsWith('.md')).length).toBeLessThanOrEqual(2);
    expect(result.entries[0].text).not.toMatch(/[\uD800-\uDBFF]$/);
  });
  it('reports authorization failures instead of treating them as empty profiles', async () => {
    const client = new OpenVikingClient({ baseUrl:'https://memory.invalid',credential:async()=>'user',fetch:async()=>Response.json({status:'error',error:{code:'PERMISSION_DENIED'}},{status:403}) });
    await expect(readAutomaticMemberProfile(client, account, 'alice')).rejects.toMatchObject({ status:403 });
  });
});
