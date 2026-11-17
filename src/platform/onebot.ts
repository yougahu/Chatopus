import { createServer, type Server } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import type { Attachment, GroupMessage, OutgoingFile, OutgoingMessage, PublisherPort, SendReceipt } from '../types.js';
import { MAX_OUTPUT_IMAGE_COUNT, MAX_OUTPUT_TOTAL_BYTES, readOutgoingImage } from '../output-images.js';
import { readOutgoingFile } from '../output-files.js';
import { recipientIdsSchema } from '../message-recipients.js';

type Json = Record<string, unknown>;
// get_image returns up to 10 MiB of image bytes encoded as base64 inside JSON.
const DEFAULT_MAX_MESSAGE_BYTES = 4 * Math.ceil((10 * 1024 * 1024) / 3) + 64 * 1024;
function object(value: unknown): Json | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Json : undefined;
}
function id(value: unknown, signed = false): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  if (typeof value === 'number' && !Number.isSafeInteger(value)) return undefined;
  const str = String(value);
  return (signed ? /^-?[0-9]+$/ : /^[1-9][0-9]*$/).test(str) ? str : undefined;
}

export interface OneBotOptions {
  selfId: string;
  accessToken: string;
  allowedGroupIds: string[];
  host?: '127.0.0.1' | '::1';
  port?: number;
  path?: string;
  actionTimeoutMs?: number;
  maxPendingEvents?: number;
  maxMessageBytes?: number;
  /** Only host-created image and file artifacts inside this directory can be sent. */
  outputRoot?: string;
  onMessage(message: GroupMessage): Promise<void>;
  onError?(code: string, messageId?: string): void;
}

/** Authenticated transport supplies identity; CQ-looking user text is always literal. */
export function normalizeOneBotMessage(event: unknown, selfId: string, allowedGroups: ReadonlySet<string>): GroupMessage | undefined {
  const p = object(event);
  if (!p || p.post_type !== 'message' || p.message_type !== 'group' || id(p.self_id) !== selfId) return;
  const authorId = id(p.user_id), groupId = id(p.group_id), messageId = id(p.message_id, true);
  if (!authorId || authorId === selfId || !groupId || !allowedGroups.has(groupId) || !messageId || !Array.isArray(p.message)) return;
  const mentions: string[] = [], attachments: Attachment[] = [], text: string[] = [];
  let replyToMessageId: string | undefined;
  for (const item of p.message) {
    const segment = object(item), data = object(segment?.data);
    if (!segment || !data) continue;
    if (segment.type === 'text' && typeof data.text === 'string') text.push(data.text);
    else if (segment.type === 'at') {
      const target = data.qq === 'all' ? 'all' : id(data.qq);
      if (target) { mentions.push(target); text.push(`@${target}`); }
    } else if (segment.type === 'reply') replyToMessageId ??= id(data.id, true);
    else if (segment.type === 'image') attachments.push({ kind: 'image',
      ...(typeof data.file === 'string' ? { file: data.file } : {}),
      ...(typeof data.url === 'string' ? { url: data.url } : {}),
    });
    else if (typeof segment.type === 'string') text.push(`[${segment.type}]`);
  }
  const sender = object(p.sender) ?? {};
  const authorName = [sender.card, sender.nickname].find(x => typeof x === 'string' && x.trim()) as string | undefined;
  const roomId = `qq:${selfId}:${groupId}`;
  return {
    id: `${roomId}:${messageId}`, platform: 'qq', roomId, messageId, authorId,
    authorName: authorName ?? authorId, text: text.join('').trim(),
    timestamp: typeof p.time === 'number' && Number.isFinite(p.time) ? p.time * 1000 : Date.now(),
    replyToMessageId, mentions, attachments,
    isMentioned: mentions.includes(selfId), isAdmin: sender.role === 'owner' || sender.role === 'admin',
    memberRoleGroup:sender.role==='owner'||sender.role==='admin'?'group_admin':sender.role==='member'?'member':'unknown',
    roleVerifiedAt:Date.now(),
  };
}

export class OneBotActionError extends Error {
  constructor(readonly code: string, readonly sent: boolean, readonly platformCode?:number) { super(code); }
}
interface PendingAction {
  socket: WebSocket;
  resolve: (data: Json) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/** OneBot reverse WS server; construction is inert, start() explicitly binds loopback. */
export class OneBotAdapter implements PublisherPort {
  private readonly groups: Set<string>;
  private server?: Server;
  private wss?: WebSocketServer;
  private connection?: WebSocket;
  private pending = new Map<string, PendingAction>();
  private seen = new Map<string, number>();
  private incoming = new Set<string>();
  private jobs = new Set<Promise<void>>();
  private sends = new Map<string, { signature: string; promise: Promise<SendReceipt> }>();
  private uploads = new Map<string, { signature: string; promise: Promise<SendReceipt> }>();
  private closing = false;
  private listeningPort?: number;

  constructor(private readonly options: OneBotOptions) {
    if (!id(options.selfId) || !options.accessToken) throw new Error('OneBot requires selfId and accessToken');
    if (!options.allowedGroupIds.length || options.allowedGroupIds.some(x => !id(x))) throw new Error('Explicit allowedGroupIds are required');
    if (options.host && !['127.0.0.1', '::1'].includes(options.host)) throw new Error('OneBot listener must use loopback');
    if (options.path && (!options.path.startsWith('/') || /[?#]/.test(options.path))) throw new Error('Invalid WebSocket path');
    if (options.port !== undefined && (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535)) throw new Error('Invalid port');
    this.groups = new Set(options.allowedGroupIds);
  }

  get port(): number | undefined { return this.listeningPort; }
  get connected(): boolean { return this.connection?.readyState === WebSocket.OPEN; }

  async start(): Promise<void> {
    if (this.server) return;
    this.closing = false;
    const server = createServer((_req, res) => { res.writeHead(404); res.end(); });
    const wss = new WebSocketServer({ noServer: true, maxPayload: this.options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES });
    server.on('upgrade', (req, socket, head) => {
      const supplied = Buffer.from(req.headers.authorization ?? '');
      const expected = Buffer.from(`Bearer ${this.options.accessToken}`);
      const accepted = supplied.length === expected.length && timingSafeEqual(supplied, expected);
      if (this.closing || req.url !== (this.options.path ?? '/onebot/v11/ws') || !accepted || req.headers['x-self-id'] !== this.options.selfId) {
        socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return;
      }
      wss.handleUpgrade(req, socket, head, ws => { this.attach(ws); });
    });
    this.server = server; this.wss = wss;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(this.options.port ?? 8083, this.options.host ?? '127.0.0.1', () => {
          server.off('error', reject); resolve();
        });
      });
      const address = server.address();
      this.listeningPort = typeof address === 'object' && address ? address.port : undefined;
    } catch (error) { this.server = undefined; wss.close(); this.wss = undefined; throw error; }
  }

  private attach(ws: WebSocket): void {
    if (this.connection) {
      this.failConnection(this.connection, 'connection_replaced');
      this.connection.close(1001, 'Replaced');
    }
    this.connection = ws;
    ws.on('error', () => this.options.onError?.('socket_error'));
    ws.on('close', () => {
      this.failConnection(ws, 'disconnected');
      if (this.connection === ws) this.connection = undefined;
    });
    ws.on('message', (raw: RawData, binary: boolean) => {
      if (binary || ws !== this.connection || this.closing) return;
      let data: unknown;
      try { data = JSON.parse(raw.toString()); } catch { this.options.onError?.('invalid_json'); return; }
      const packet = object(data);
      if (!packet) return;
      if (typeof packet.echo === 'string') {
        const pending = this.pending.get(packet.echo);
        if (pending?.socket === ws) { clearTimeout(pending.timer); this.pending.delete(packet.echo); pending.resolve(packet); }
        return;
      }
      const message = normalizeOneBotMessage(packet, this.options.selfId, this.groups);
      if (!message || this.incoming.has(message.id) || this.seen.has(message.id)) return;
      if (this.jobs.size >= (this.options.maxPendingEvents ?? 1000)) { this.options.onError?.('input_overflow', message.id); return; }
      this.incoming.add(message.id);
      // Enter the handler immediately: Coordinator persists intake before its
      // first await, including when shutdown starts in the next microtask.
      const job = (async () => { await this.options.onMessage(message); })().then(() => {
        this.seen.set(message.id, Date.now());
        // Durable duplicate protection lives in the coordinator's message store.
        while (this.seen.size > 10000) this.seen.delete(this.seen.keys().next().value!);
      }).catch(() => { this.options.onError?.('message_handler_failed', message.id); }).finally(() => {
        this.incoming.delete(message.id); this.jobs.delete(job);
      });
      this.jobs.add(job);
    });
  }

  private failConnection(ws: WebSocket, code: string): void {
    for (const [echo, pending] of this.pending) if (pending.socket === ws) {
      clearTimeout(pending.timer); this.pending.delete(echo); pending.reject(new OneBotActionError(code, true));
    }
  }

  async call(action: 'send_group_msg' | 'upload_group_file' | 'get_image' | 'get_msg' | 'get_group_member_info', params: Json): Promise<Json> {
    const ws = this.connection;
    if (!ws || ws.readyState !== WebSocket.OPEN || this.closing) throw new OneBotActionError('not_connected', false);
    if (this.pending.size >= 100) throw new OneBotActionError('too_many_pending_actions', false);
    const echo = randomUUID();
    const reply = await new Promise<Json>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(echo); reject(new OneBotActionError('timeout', true));
      }, this.options.actionTimeoutMs ?? (action === 'upload_group_file' ? 120000 : 15000));
      this.pending.set(echo, { socket: ws, resolve, reject, timer });
      ws.send(JSON.stringify({ action, params, echo }), error => {
        if (error && this.pending.delete(echo)) { clearTimeout(timer); reject(new OneBotActionError('write_failed', true)); }
      });
    });
    if (reply.status === 'async' || reply.retcode === 1) throw new OneBotActionError('pending', true);
    if (typeof reply.retcode !== 'number') throw new OneBotActionError('invalid_response', true);
    if (reply.retcode !== 0) {
      // NapCat uses 1200 for any exception inside the upload handler, including
      // a timeout after QQ may have received the file. Only schema/unknown-API
      // rejection proves that this action never entered the handler.
      if (![1400, 1404].includes(reply.retcode)) {
        if(action === 'upload_group_file')throw new OneBotActionError('upload_result_unknown', true,reply.retcode);
        if(action === 'send_group_msg')throw new OneBotActionError('send_result_unknown', true,reply.retcode);
      }
      throw new OneBotActionError('action_failed', true,reply.retcode);
    }
    if (reply.status !== 'ok' || !object(reply.data)) throw new OneBotActionError('invalid_response', true);
    return reply.data as Json;
  }

  async send(message: OutgoingMessage, dedupeKey: string): Promise<SendReceipt> {
    const match = /^qq:([0-9]+):([0-9]+)$/.exec(message.roomId);
    if (!match || match[1] !== this.options.selfId || !this.groups.has(match[2])) return { status: 'failed', reason: 'invalid_room_scope' };
    if (!dedupeKey || typeof message.text !== 'string' || message.text.length > 20000
      || (message.attachments !== undefined && !Array.isArray(message.attachments))
      || (message.files !== undefined && (!Array.isArray(message.files) || message.files.length > 0))) return { status: 'failed', reason: 'unsupported_output' };
    if(message.recipientIds!==undefined){
      const parsed=recipientIdsSchema.safeParse(message.recipientIds);
      if(!parsed.success||parsed.data.some(recipient=>!id(recipient)))return {status:'failed',reason:'invalid_recipient_ids'};
      message={...message,recipientIds:[...new Set(parsed.data)]};
    }
    const attachments = message.attachments ?? [];
    if ((!message.text.trim() && !attachments.length && !message.recipientIds?.length) || attachments.length > MAX_OUTPUT_IMAGE_COUNT
      || (attachments.length && !this.options.outputRoot)) return { status: 'failed', reason: 'unsupported_output' };
    if (message.replyToMessageId && !id(message.replyToMessageId, true)) return { status: 'failed', reason: 'invalid_reply_id' };
    const signature = JSON.stringify(message);
    const prior = this.sends.get(dedupeKey);
    if (prior) return signature === prior.signature ? prior.promise : { status: 'failed', reason: 'dedupe_key_conflict' };
    const promise = this.transmit(message, match[2]);
    this.sends.set(dedupeKey, { signature, promise });
    const result = await promise;
    // Definite failure can be retried; unknown delivery must never be blindly retried.
    if (result.status === 'failed' || result.status === 'deferred') this.sends.delete(dedupeKey);
    while (this.sends.size > 10000) this.sends.delete(this.sends.keys().next().value!);
    return result;
  }

  /** The coordinator persists each file receipt before sending the next part. */
  async uploadFile(roomId: string, file: OutgoingFile, dedupeKey: string): Promise<SendReceipt> {
    const match = /^qq:([0-9]+):([0-9]+)$/.exec(roomId);
    if (!match || match[1] !== this.options.selfId || !this.groups.has(match[2])) return { status: 'failed', reason: 'invalid_room_scope' };
    if (!dedupeKey || !this.options.outputRoot) return { status: 'failed', reason: 'unsupported_output' };
    if (!object(file)) return { status: 'failed', reason: 'invalid_output_file' };
    const snapshot = { ...file }, signature = JSON.stringify({ roomId, file: snapshot });
    const prior = this.uploads.get(dedupeKey);
    if (prior) return signature === prior.signature ? prior.promise : { status: 'failed', reason: 'dedupe_key_conflict' };
    const promise = this.transmitFile(snapshot, match[2]);
    this.uploads.set(dedupeKey, { signature, promise });
    const result = await promise;
    if (result.status === 'failed' || result.status === 'deferred') this.uploads.delete(dedupeKey);
    while (this.uploads.size > 10000) this.uploads.delete(this.uploads.keys().next().value!);
    return result;
  }

  private async transmitFile(file: OutgoingFile, groupId: string): Promise<SendReceipt> {
    let bytes: Buffer;
    try { bytes = await readOutgoingFile(file, this.options.outputRoot!); }
    catch { return { status: 'failed', reason: 'invalid_output_file' }; }
    try {
      // Transfer validated bytes so the bridge does not need access to host paths.
      const data = await this.call('upload_group_file', { group_id: groupId, file: `base64://${bytes.toString('base64')}`, name: file.name, upload_file: true });
      const fileId = typeof data.file_id === 'string' && data.file_id.trim() && data.file_id.length <= 1024 && !/[\x00-\x1f\x7f]/.test(data.file_id) ? data.file_id : undefined;
      return fileId ? { status: 'sent', platformFileId: fileId } : { status: 'unknown', reason: 'missing_file_id' };
    } catch (error) {
      const known = error instanceof OneBotActionError;
      if (known && !error.sent) return { status: 'deferred', reason: error.code };
      return { status: known && error.code === 'action_failed' ? 'failed' : 'unknown', reason: known ? error.code : 'upload_error',
        ...(known&&error.platformCode!==undefined?{platformCode:error.platformCode}:{}),...(known&&error.code==='action_failed'?{retryable:false}:{}) };
    }
  }

  async resolveMemberRole(roomId:string,memberId:string):Promise<{roleGroup:'group_admin'|'member'|'unknown';verifiedAt:number}>{
    const match=/^qq:([0-9]+):([0-9]+)$/.exec(roomId);
    if(!match||match[1]!==this.options.selfId||!this.groups.has(match[2])||!id(memberId))throw new Error('Invalid member scope');
    const data=await this.call('get_group_member_info',{group_id:match[2],user_id:memberId,no_cache:true});
    if(id(data.user_id)!==memberId||id(data.group_id)!==match[2])throw new Error('Member identity mismatch');
    return {roleGroup:data.role==='owner'||data.role==='admin'?'group_admin':data.role==='member'?'member':'unknown',verifiedAt:Date.now()};
  }

  private async transmit(message: OutgoingMessage, groupId: string): Promise<SendReceipt> {
    const images: Buffer[] = [];
    try {
      let totalBytes = 0;
      // Verify every file before the first platform action. Never send partial
      // text/images and then discover a broken or substituted later artifact.
      for (const attachment of message.attachments ?? []) {
        const data = await readOutgoingImage(attachment, this.options.outputRoot!);
        totalBytes += data.length;
        if (totalBytes > MAX_OUTPUT_TOTAL_BYTES) throw new Error('Image reply exceeds total size');
        images.push(data);
      }
    } catch { return { status: 'failed', reason: 'invalid_output_image' }; }
    const segments = [
      ...(message.replyToMessageId ? [{ type: 'reply', data: { id: message.replyToMessageId } }] : []),
      ...(message.recipientIds??[]).flatMap(qq=>[{type:'at',data:{qq}},{type:'text',data:{text:' '}}]),
      ...(message.text.trim() ? [{ type: 'text', data: { text: message.text } }] : []),
      ...images.map(data => ({ type: 'image', data: { file: `base64://${data.toString('base64')}` } })),
    ];
    try {
      const data = await this.call('send_group_msg', { group_id: groupId, message: segments });
      const messageId = id(data.message_id, true);
      return messageId ? { status: 'sent', platformMessageId: messageId } : { status: 'unknown', reason: 'missing_message_id' };
    } catch (error) {
      const known = error instanceof OneBotActionError;
      if (known && !error.sent) return { status: 'deferred', reason: error.code };
      return { status: known && error.code === 'action_failed' ? 'failed' : 'unknown', reason: known ? error.code : 'send_error',
        ...(known&&error.platformCode!==undefined?{platformCode:error.platformCode}:{}),...(known&&error.code==='action_failed'?{retryable:false}:{}) };
    }
  }

  /** Stop ingress and settle platform calls before the coordinator cancels model work. */
  stopIntake(): void {
    this.closing = true;
    if (this.connection) this.failConnection(this.connection, 'closed');
    this.wss?.clients.forEach(ws => ws.terminate());
  }

  async close(): Promise<void> {
    this.stopIntake();
    await Promise.allSettled([...this.jobs]);
    this.wss?.close();
    if (this.server) await new Promise<void>(resolve => this.server!.close(() => resolve()));
    this.connection = undefined; this.wss = undefined; this.server = undefined; this.listeningPort = undefined;
  }
}
