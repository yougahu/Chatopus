import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Config } from '../config.js';
import { resolveBusinessProfile } from '../business-config.js';
import { OpenVikingClient, OpenVikingError, memoryAccountId, memoryPeerId, memberMemoryUri } from '../memory/openviking-client.js';
import { OpenVikingCredentials } from '../memory/openviking-credentials.js';
import { readAutomaticMemberProfile, type AutomaticMemberProfile } from '../memory/automatic-member-profile.js';
import { CORE_MEMORY_FIELDS, memberMemoryDocumentSchema } from '../memory/types.js';

export class AdminMemoryError extends Error {
  constructor(readonly status: number, message: string) { super(message); this.name = 'AdminMemoryError'; }
}
type Row = Record<string, unknown>;
const validMessage = `json_valid(data) AND json_extract(data,'$.id')=id AND json_extract(data,'$.roomId')=room
  AND json_type(data,'$.authorId')='text' AND length(json_extract(data,'$.authorId')) BETWEEN 1 AND 256`;
const memberCte = `WITH members AS (SELECT json_extract(data,'$.authorId') AS id,
  json_extract(data,'$.authorName') AS name,at AS lastSeen,
  ROW_NUMBER() OVER(PARTITION BY json_extract(data,'$.authorId') ORDER BY at DESC,rowid DESC) AS rank
  FROM messages WHERE room=? AND ${validMessage})`;
const phases = new Set(['prepared', 'creating', 'appending', 'appended', 'committing', 'archived']);
const parse = (raw: unknown): Row | null => {
  try { const value = JSON.parse(String(raw)); return value && typeof value === 'object' && !Array.isArray(value) ? value : null; }
  catch { return null; }
};
const count = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
function page(url: URL, name: string, fallback: number, max: number, min = 0): number {
  const raw = url.searchParams.get(name); if (raw === null) return fallback;
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) < min || Number(raw) > max)
    throw new AdminMemoryError(400, '分页参数无效。');
  return Number(raw);
}
function identity(url: URL, name: string): string {
  const value = url.searchParams.get(name) ?? '';
  if (!value || value.length > 256 || /[\x00-\x1f\x7f]/.test(value)) throw new AdminMemoryError(400, '群、成员或来源标识无效。');
  return value;
}

/** The admin reads existing identities and state; constructing runtime stores/services here would write. */
export class AdminMemoryApi {
  private readonly secrets: Set<string>;
  private client?: OpenVikingClient;
  constructor(private readonly config: Config) {
    this.secrets = new Set([config.memoryApiKey, config.apiKey, config.routerApiKey, config.workerApiKey, config.qq.accessToken].filter((key): key is string => !!key));
  }
  private redact(value: unknown): unknown {
    if (typeof value === 'string') {
      for (const key of this.secrets) value = (value as string).replaceAll(key, '[redacted]');
      return value;
    }
    if (Array.isArray(value)) return value.map(item => this.redact(item));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, this.redact(item)]));
    return value;
  }
  private backend(): OpenVikingClient {
    if (!this.client) {
      const memory = this.config.memory!;
      const credentials = new OpenVikingCredentials({ baseUrl: memory.baseUrl, rootKey: this.config.memoryApiKey!, timeoutMs: memory.timeoutMs });
      this.client = new OpenVikingClient({ baseUrl: memory.baseUrl, timeoutMs: memory.timeoutMs, maxResponseBytes: 256_000,
        credential: async account => {
          const key = await credentials.lookupExisting(account);
          if (!key) throw new AdminMemoryError(503, '本群尚未建立 OpenViking 记忆身份。');
          this.secrets.add(key); return key;
        },
      });
    }
    return this.client;
  }
  private account(room: string): string { return memoryAccountId(this.config.memory!.namespace, this.config.qq.selfId || 'local', room); }
  private table(db: DatabaseSync, name: string): boolean { return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name); }
  private knownRoom(db: DatabaseSync, room: string): void {
    if (!db.prepare(`SELECT 1 FROM messages WHERE room=? AND ${validMessage} LIMIT 1`).get(room)) throw new AdminMemoryError(404, '未找到该群的本地记录。');
  }
  private knownMember(db: DatabaseSync, room: string, member: string): void {
    if (!db.prepare(`SELECT 1 FROM messages WHERE room=? AND ${validMessage} AND json_extract(data,'$.authorId')=? LIMIT 1`).get(room, member))
      throw new AdminMemoryError(404, '未找到该群成员。');
  }
  private knownPeer(db: DatabaseSync, room: string, peer: string): boolean {
    // A bounded identity list prevents arbitrary peer URIs from becoming a general file browser.
    const rows = db.prepare(`SELECT DISTINCT json_extract(data,'$.authorId') AS id FROM messages WHERE room=? AND ${validMessage} LIMIT 10000`).all(room);
    return rows.some(row => memoryPeerId(String(row.id)) === peer);
  }
  private allowedUri(db: DatabaseSync, room: string, uri: string): boolean {
    if (uri.length > 1000 || /[\x00-\x1f\x7f\\%?#]/.test(uri)) return false;
    const match = /^viking:\/\/user\/group\/(?:memories\/|peers\/(member_[a-f0-9]{40})\/memories\/)(.+)$/.exec(uri);
    if (!match || match[2].split('/').some(part => !part || part.startsWith('.') || /^(?:private|sessions?|secrets?|credentials?)$/i.test(part))) return false;
    return !match[1] || this.knownPeer(db, room, match[1]);
  }
  private source(db: DatabaseSync, room: string, id: string) {
    const row = db.prepare('SELECT data FROM messages WHERE room=? AND id=?').get(room, id);
    const message = row && parse(row.data);
    if (message && message.id === id && message.roomId === room && typeof message.authorId === 'string' && typeof message.text === 'string'
      && typeof message.timestamp === 'number' && Number.isFinite(message.timestamp)) {
      return { room, id, kind: 'message' as const, authorId: message.authorId, authorName: typeof message.authorName === 'string' ? message.authorName : message.authorId,
        text: message.text.slice(0, 30_000), truncated: message.text.length > 30_000, timestamp: message.timestamp,
        messageId: typeof message.messageId === 'string' ? message.messageId : null,
        replyToMessageId: typeof message.replyToMessageId === 'string' ? message.replyToMessageId : null };
    }
    if (!this.table(db, 'outbox')) return null;
    const outgoing = db.prepare("SELECT data FROM outbox WHERE room=? AND id=? AND status='sent'").get(room, id);
    const reply = outgoing && parse(outgoing.data), body = reply?.message as Row | undefined;
    if (!reply || reply.id !== id || reply.status !== 'sent' || body?.roomId !== room || typeof body.text !== 'string'
      || typeof reply.sentAt !== 'number' || !Number.isFinite(reply.sentAt)) return null;
    return { room, id, kind: 'reply' as const, authorId: null, authorName: '机器人', text: body.text.slice(0, 30_000), truncated: body.text.length > 30_000,
      timestamp: reply.sentAt, messageId: typeof reply.platformMessageId === 'string' ? reply.platformMessageId : null,
      replyToMessageId: typeof body.replyToMessageId === 'string' ? body.replyToMessageId : null };
  }
  private lanes(db: DatabaseSync, room: string) {
    if (!this.table(db, 'openviking_ingestion')) return [];
    const hasEvents = this.table(db, 'room_memory_events');
    // Sample imports and former namespaces do not describe this live memory account.
    return db.prepare("SELECT covered,target,batch,failures,retry_at,last_error,blocked,mode FROM openviking_ingestion WHERE room=? AND account=? AND mode='live' LIMIT 100")
      .all(room, this.account(room)).map(row => {
        const batch = parse(row.batch), covered = count(row.covered), target = count(row.target);
        const pending = hasEvents ? count(db.prepare('SELECT count(*) AS n FROM room_memory_events WHERE room=? AND valid=1 AND seq>? AND seq<=?').get(room, covered, target)?.n) : null;
        return { mode: 'live', covered, target, pending, batchPhase: typeof batch?.phase === 'string' && phases.has(batch.phase) ? batch.phase : null,
          failures: count(row.failures), retryAt: count(row.retry_at),
          lastError: typeof row.last_error === 'string' && /^[A-Z_]{1,64}$/.test(row.last_error) ? row.last_error : row.last_error ? 'INGESTION_FAILED' : null,
          blocked: row.blocked === 1 };
      });
  }
  async data(url: URL): Promise<unknown> {
    try { return this.redact(await this.read(url)); }
    catch (error) {
      if (error instanceof AdminMemoryError) throw error;
      if (error instanceof OpenVikingError) throw new AdminMemoryError(503, 'OpenViking 暂不可用，请检查服务连接与权限。');
      // Do not expose backend response bodies, database paths, credentials, or parse failures.
      throw new AdminMemoryError(503, '共享记忆暂不可用，请检查本地记录与服务配置。');
    }
  }
  private async read(url: URL): Promise<unknown> {
    const routes: Record<string, string[]> = {
      '/api/memory': [], '/api/memory/members': ['room', 'offset', 'limit', 'q'], '/api/memory/profile': ['room', 'member'],
      '/api/memory/search': ['room', 'member', 'q', 'limit'], '/api/memory/content': ['room', 'uri', 'offset'],
      '/api/memory/source': ['room', 'id'], '/api/memory/status': ['room'],
    };
    const allowed = routes[url.pathname]; if (!allowed) throw new AdminMemoryError(404, '未知的记忆接口。');
    for (const key of url.searchParams.keys()) if ((key !== 'source' && !allowed.includes(key)) || url.searchParams.getAll(key).length !== 1)
      throw new AdminMemoryError(400, '记忆请求参数无效。');
    const enabled = !!this.config.memory?.enabled, file = join(this.config.stateDir, 'state.sqlite');
    const reason = (url.searchParams.get('source') ?? 'main') !== 'main' ? '终端验证来源不连接当前服务的共享记忆。'
      : !enabled ? '共享记忆尚未启用。' : !this.config.memoryApiKey ? '共享记忆凭据尚未配置。'
      : !existsSync(file) ? '尚无当前服务的本地记录。' : null;
    if (reason) {
      if (url.pathname !== '/api/memory') throw new AdminMemoryError(503, reason);
      return { enabled, available: false, reason, connection: 'not_checked', rooms: [], roomsTruncated: false,
        ingestion: { laneCount: 0, blocked: 0, retrying: 0, pending: 0 } };
    }
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      if (!this.table(db, 'messages')) throw new AdminMemoryError(503, '尚无可读取的本地消息记录。');
      if (url.pathname === '/api/memory') {
        const rows = db.prepare(`SELECT room AS id,count(DISTINCT json_extract(data,'$.authorId')) AS memberCount FROM messages WHERE ${validMessage} GROUP BY room ORDER BY room LIMIT 501`).all();
        const rooms = rows.slice(0, 500).map(row => ({ id: String(row.id), name: String(row.id), memberCount: count(row.memberCount) }));
        const lanes = rooms.flatMap(room => this.lanes(db, room.id));
        return { enabled, available: true, reason: null, connection: 'not_checked', rooms, roomsTruncated: rows.length > 500,
          ingestion: { laneCount: lanes.length, blocked: lanes.filter(lane => lane.blocked).length,
            retrying: lanes.filter(lane => lane.failures > 0 && !lane.blocked).length,
            pending: lanes.some(lane => lane.pending === null) ? null : lanes.reduce((sum, lane) => sum + (lane.pending ?? 0), 0) } };
      }
      const room = identity(url, 'room'); this.knownRoom(db, room);
      if (url.pathname === '/api/memory/members') {
        const offset = page(url, 'offset', 0, 1_000_000), limit = page(url, 'limit', 50, 100, 1);
        const rawQuery = url.searchParams.get('q') ?? '', query = rawQuery.trim();
        if (query.length > 100 || /[\x00-\x1f\x7f-\x9f]/.test(rawQuery)) throw new AdminMemoryError(400, '成员搜索词不能超过 100 个字符或包含控制字符。');
        const rows = db.prepare(memberCte + ` SELECT id,name,lastSeen FROM members WHERE rank=1
          AND (instr(lower(id),lower(?))>0 OR (typeof(name)='text' AND instr(lower(name),lower(?))>0))
          ORDER BY lastSeen DESC,id LIMIT ? OFFSET ?`).all(room, query, query, limit + 1, offset);
        return { room, members: rows.slice(0, limit).map(row => ({ id: row.id, name: typeof row.name === 'string' ? row.name : row.id, lastSeen: row.lastSeen })),
          offset, hasMore: rows.length > limit, nextOffset: rows.length > limit ? offset + limit : null };
      }
      if (url.pathname === '/api/memory/status') { const lanes = this.lanes(db, room); return { room, tracked: lanes.length > 0, lanes }; }
      if (url.pathname === '/api/memory/source') {
        const source = this.source(db, room, identity(url, 'id'));
        if (!source) throw new AdminMemoryError(404, '原始消息不存在或未确认发送。');
        return source;
      }
      if (url.pathname === '/api/memory/profile') {
        const member = identity(url, 'member'); this.knownMember(db, room, member);
        const file = await this.backend().read(this.account(room), memberMemoryUri(member));
        const document = file ? memberMemoryDocumentSchema.parse(JSON.parse(file.text)) : null;
        if (document && document.memberId !== member) throw new AdminMemoryError(503, '成员记忆身份不一致。');
        let automatic: AutomaticMemberProfile & { unavailable?: boolean };
        try {
          automatic = await readAutomaticMemberProfile(this.backend(), this.account(room), member,
            { maxBytes: Math.min(this.config.memory!.recallBytes, 16_000), maxEntries: 8 });
        } catch { automatic = { entries: [], truncated: false, unavailable: true }; }
        const definitions=new Map([...CORE_MEMORY_FIELDS,...(this.config.memory?.fields??[])].map(field=>[field.key,field]));
        const active=new Set([...CORE_MEMORY_FIELDS.map(field=>field.key),...(resolveBusinessProfile(this.config,room).memoryFields??[])]);
        return { room, member, exists: document !== null, revision: document?.revision ?? null, updatedAt: document?.updatedAt ?? null,
          fields: document ? [...definitions.keys(),...Object.keys(document.fields).filter(key=>!definitions.has(key)).sort()].flatMap(key => {
            const field = document.fields[key]; if (!field) return [];
            const source = this.source(db, room, field.sourceMessageId);
            return [{ key, label: definitions.get(key)?.label??key, enabled: active.has(key), ...field, expired: field.expiresAt !== undefined && field.expiresAt <= Date.now(),
              sourceAvailable: source?.kind === 'message' && source.authorId === member }];
          }) : [],
          automatic: { ...automatic, entries: automatic.entries.map(entry => ({ ...entry,
            sources: entry.sourceMessageIds.map(id => {
              const source = this.source(db, room, id);
              return { id, available: source?.kind === 'message' && source.authorId === member };
            }),
          })) } };
      }
      if (url.pathname === '/api/memory/search') {
        const query = url.searchParams.get('q')?.trim() ?? '';
        if (!query || query.length > 2000) throw new AdminMemoryError(400, '检索词须为 1–2000 个字符。');
        const member = url.searchParams.has('member') ? identity(url, 'member') : undefined;
        if (member) this.knownMember(db, room, member);
        const hits = await this.backend().find(this.account(room), query, { memberId: member,
          limit: page(url, 'limit', 8, 8, 1), maxBytes: Math.min(this.config.memory!.recallBytes, 32_000) });
        return { room, member: member ?? null, query, hits: hits.filter(hit => this.allowedUri(db, room, hit.uri)) };
      }
      const uri = url.searchParams.get('uri') ?? '';
      if (!this.allowedUri(db, room, uri)) throw new AdminMemoryError(400, '只允许读取本群共享记忆条目。');
      const offset = page(url, 'offset', 0, 1_000_000), file = await this.backend().read(this.account(room), uri);
      if (!file) throw new AdminMemoryError(404, '该记忆条目已不存在。');
      if (offset > file.text.length || (offset > 0 && /[\uDC00-\uDFFF]/.test(file.text[offset] ?? '') && /[\uD800-\uDBFF]/.test(file.text[offset - 1])))
        throw new AdminMemoryError(400, '内容分页位置无效。');
      let text = '', bytes = 0, end = offset;
      for (const char of file.text.slice(offset)) {
        const size = Buffer.byteLength(char); if (bytes + size > Math.min(this.config.memory!.recallBytes, 24_000)) break;
        text += char; bytes += size; end += char.length;
      }
      return { room, uri, text, sha256: file.sha256, offset, nextOffset: end < file.text.length ? end : null, totalCharacters: file.text.length };
    } finally { db.close(); }
  }
}
