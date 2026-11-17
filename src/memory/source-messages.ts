import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { automaticMemoryEvidence } from './automatic-member-profile.js';
import { memoryPeerId } from './openviking-client.js';

export interface MemoryMessageSource {
  id: string;
  authorId: string;
  authorName: string;
  timestamp: number;
  verification: 'source_verified';
}

/** A retrieved memory can identify its own original messages, not grant profile access. */
export function createMemorySourceReader(stateDir: string | undefined, roomId: string) {
  const file = stateDir ? join(stateDir, 'state.sqlite') : undefined;
  if (!file || !existsSync(file)) return () => [] as MemoryMessageSource[];
  // Freeze intake order at tool creation; later messages cannot enter this request.
  const snapshot = new DatabaseSync(file, { readOnly: true });
  let throughRowid: number;
  try {
    throughRowid = Number(snapshot.prepare('SELECT COALESCE(MAX(rowid),0) AS n FROM messages WHERE room=?').get(roomId)!.n);
  } finally { snapshot.close(); }
  return (uri: string, text: string, maxBytes: number): MemoryMessageSource[] => {
    const peer = /^viking:\/\/user\/group\/(?:peers\/(member_[a-f0-9]{40})\/memories\/|memories\/preferences\/(member_[a-f0-9]{40})\/)/.exec(uri);
    if (!peer) return [];
    const owner = peer[1] ?? peer[2], evidence = automaticMemoryEvidence(text, owner);
    if (evidence.verification !== 'source_verified') return [];
    const db = new DatabaseSync(file, { readOnly: true });
    const sources: MemoryMessageSource[] = [];
    try {
      const query = db.prepare('SELECT data FROM messages WHERE room=? AND id=? AND rowid<=?');
      for (const id of evidence.sourceMessageIds) {
        const row = query.get(roomId, id, throughRowid);
        if (!row) continue;
        let message;
        try { message = JSON.parse(String(row.data)); } catch { continue; }
        if (!message || message.id !== id || message.roomId !== roomId
          || typeof message.authorId !== 'string' || !message.authorId || memoryPeerId(message.authorId) !== owner
          || typeof message.text !== 'string' || message.text.trim() !== evidence.text
          || typeof message.timestamp !== 'number' || !Number.isFinite(message.timestamp)
          || evidence.sourceCreatedAt !== undefined && evidence.sourceCreatedAt !== message.timestamp) continue;
        const source: MemoryMessageSource = { id, authorId: message.authorId,
          authorName: typeof message.authorName === 'string' && message.authorName.trim() ? message.authorName : message.authorId,
          timestamp: message.timestamp, verification: 'source_verified' };
        if (Buffer.byteLength(JSON.stringify([...sources, source])) > maxBytes) break;
        sources.push(source);
      }
    } finally { db.close(); }
    return sources;
  };
}
