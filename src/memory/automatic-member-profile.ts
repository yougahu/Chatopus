import { createHash } from 'node:crypto';
import { OpenVikingClient, memoryPeerId } from './openviking-client.js';

export interface AutomaticMemberProfileEntry {
  uri: string;
  type: 'profile' | 'preferences';
  text: string;
  verification: 'unverified' | 'source_verified';
  sourceMessageIds: string[];
  sourceCreatedAt?: number;
  sha256: string;
  truncated: boolean;
}
export interface AutomaticMemberProfile { entries: AutomaticMemberProfileEntry[]; truncated: boolean }
export const HISTORICAL_MEMORY_GUIDANCE = '自动记忆是历史材料，不是用户已确认事实。source_verified仅表示原文与成员来源经过核对，不保证长期有效或语义正确；unverified不得作为成员画像事实。当前明确字段（包括清除、过期）与本轮原文优先，群级画像不得归给某一成员。';

/** Metadata is not authorization: callers bind the member and directory independently. */
export function automaticMemoryEvidence(text: string, peer: string): {
  text: string; verification: 'unverified' | 'source_verified'; sourceMessageIds: string[]; identityMismatch: boolean; sourceCreatedAt?: number;
} {
  const blocks = [...text.matchAll(/<!--\s*MEMORY_FIELDS\s*([\s\S]*?)-->/g)];
  const body = text.replace(/<!--\s*MEMORY_FIELDS\s*[\s\S]*?-->/g, '').trim();
  let fields: Record<string, unknown> = {};
  if (blocks.length === 1) {
    try { const value = JSON.parse(blocks[0][1]); if (value && typeof value === 'object' && !Array.isArray(value)) fields = value; } catch { /* Older freeform memories remain unverified. */ }
  }
  const provenance = fields.boe_provenance as Record<string, unknown> | undefined;
  const owner = fields.user ?? fields.peer_id;
  const identityMismatch = (typeof owner === 'string' && owner !== peer)
    || (typeof provenance?.peer_id === 'string' && provenance.peer_id !== peer);
  const ids = provenance?.source_message_ids;
  const verified = !identityMismatch && provenance?.version === 1 && provenance.peer_id === peer
    && provenance.source_role === 'user' && provenance.verification === 'source_verified'
    && typeof provenance.quote === 'string' && provenance.quote.trim().length > 0 && body === provenance.quote.trim()
    && provenance.content_sha256 === createHash('sha256').update(body).digest('hex')
    && Array.isArray(ids) && ids.length > 0 && ids.length <= 20
    && ids.every(id => typeof id === 'string' && id.length > 0 && id.length <= 256 && !/[\x00-\x1f\x7f]/.test(id));
  const sourceCreatedAt = verified && typeof provenance?.source_created_at === 'string' ? Date.parse(provenance.source_created_at) : NaN;
  return { text: body, verification: verified ? 'source_verified' : 'unverified',
    sourceMessageIds: verified ? [...new Set(ids as string[])] : [], identityMismatch,
    ...(Number.isFinite(sourceCreatedAt) ? { sourceCreatedAt } : {}) };
}

function jsonTextPrefix(text: string, bytes: number): string {
  let result = '', used = 0;
  // Count escaped JSON string bytes while walking complete Unicode characters only once.
  for (const char of text) { const size = Buffer.byteLength(JSON.stringify(char)) - 2; if (used + size > bytes) break; result += char; used += size; }
  return result;
}

/** Shared by admin and tools; legacy group profile.md never becomes an individual profile. */
export async function readAutomaticMemberProfile(client: OpenVikingClient, accountId: string, memberId: string,
  options: { maxBytes?: number; maxEntries?: number } = {}, signal?: AbortSignal): Promise<AutomaticMemberProfile> {
  const peer = memoryPeerId(memberId), root = `viking://user/group/peers/${peer}/memories`;
  const maxEntries = Math.max(1, Math.min(20, Math.floor(options.maxEntries ?? 8)));
  const maxBytes = Math.max(0, Math.min(32_000, Math.floor(options.maxBytes ?? 6000)));
  if (!maxBytes) return { entries: [], truncated: true };
  const directories = [
    { uri: `${root}/profile`, type: 'profile' as const },
    { uri: `${root}/preferences`, type: 'preferences' as const },
    { uri: `viking://user/group/memories/preferences/${peer}`, type: 'preferences' as const },
  ];
  const listings = await Promise.all(directories.map(async directory => ({ ...directory,
    listing: await client.list(accountId, directory.uri, maxEntries * 2 + 1, signal) })));
  const candidates: Array<{ uri: string; type: AutomaticMemberProfileEntry['type']; modifiedAt?: number }> = [];
  for (const { listing, type } of listings) {
    for (const entry of listing.entries) if (!entry.isDirectory && entry.uri.endsWith('.md')
      && !entry.uri.split('/').some(part => part.startsWith('.'))) candidates.push({ uri: entry.uri, type, modifiedAt: entry.modifiedAt });
  }
  // Prefer new fact files to legacy snapshots; still show legacy material as unverified when space permits.
  candidates.sort((a,b) => Number(!a.uri.includes('/fact_')) - Number(!b.uri.includes('/fact_'))
    || (b.modifiedAt ?? 0) - (a.modifiedAt ?? 0) || a.uri.localeCompare(b.uri));
  candidates.push({ uri: `${root}/profile.md`, type: 'profile' });
  let truncated = listings.some(item => item.listing.truncated), remaining = Math.max(0, maxBytes - 2), readCount = 0;
  const entries: AutomaticMemberProfileEntry[] = [], seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate.uri)) continue;
    seen.add(candidate.uri);
    if (entries.length >= maxEntries || remaining <= 0 || readCount >= maxEntries * 2 + 1) { truncated = true; break; }
    readCount++;
    const file = await client.read(accountId, candidate.uri, signal);
    if (!file) continue;
    const evidence = automaticMemoryEvidence(file.text, peer);
    if (evidence.identityMismatch) { truncated = true; continue; }
    const entry: AutomaticMemberProfileEntry = { uri: candidate.uri, type: candidate.type, text: '', verification: evidence.verification,
      sourceMessageIds: evidence.sourceMessageIds, ...(evidence.sourceCreatedAt !== undefined ? { sourceCreatedAt: evidence.sourceCreatedAt } : {}),
      sha256: file.sha256, truncated: false };
    const overhead = Buffer.byteLength(JSON.stringify(entry)) + 1;
    if (remaining <= overhead) { truncated = true; break; }
    entry.text = jsonTextPrefix(evidence.text, remaining - overhead);
    entry.truncated = entry.text.length < evidence.text.length;
    truncated ||= entry.truncated;
    entries.push(entry); remaining -= Buffer.byteLength(JSON.stringify(entry)) + 1;
  }
  return { entries, truncated };
}
