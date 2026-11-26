import type {PrivateFileContract} from './private-files.js';
import {resolve,relative,isAbsolute} from 'node:path';
import {PrivateChatAccess,type PrivateChatSettings,type AccessLease} from '../private-chat.js';
import {parseQqRoomId,formatQqRoomId,type QqConversation} from '../conversation.js';
import { createServer, type Server } from 'node:http';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
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
  privateChat?:Partial<PrivateChatSettings>;
  privateFiles?:PrivateFileContract;
  privateAccess?:PrivateChatAccess;
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
export function normalizeOneBotMessage(event: unknown, selfId: string, allowedGroups: ReadonlySet<string>, privateAccess?:PrivateChatAccess): GroupMessage | undefined {
  const p = object(event);
  if (!p || p.post_type !== 'message' || !['group','private'].includes(String(p.message_type)) || id(p.self_id) !== selfId) return;
  const authorId = id(p.user_id), groupId = id(p.group_id), messageId = id(p.message_id, true), isPrivate=p.message_type==='private';
  if (!authorId || authorId === selfId || !messageId) return;
  if(isPrivate){
    if(p.sub_type!=='friend'||!privateAccess?.allows(`qq:${selfId}:private:${authorId}`))return;
    const senderId=object(p.sender)?.user_id;if(senderId!==undefined&&id(senderId)!==authorId)return;
  }else if(!groupId||!allowedGroups.has(groupId))return;
  if(!Array.isArray(p.message))return;
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
    else if(isPrivate&&segment.type==='file'){
      const name=typeof data.name==='string'?data.name:typeof data.file_name==='string'?data.file_name:'文件';
      attachments.push({kind:'file',name,...(typeof data.file_id==='string'?{file:data.file_id}:{}),
        ...(typeof data.url==='string'?{url:data.url}:{}),...(typeof data.size==='number'?{bytes:data.size}:{})});
    }
    else if (typeof segment.type === 'string') text.push(`[${segment.type}]`);
  }
  const sender = object(p.sender) ?? {};
  const authorName = [sender.card, sender.nickname].find(x => typeof x === 'string' && x.trim()) as string | undefined;
  const roomId = isPrivate?`qq:${selfId}:private:${authorId}`:`qq:${selfId}:${groupId}`;
  return {
    id: `${roomId}:${messageId}`, platform: 'qq', roomId, messageId, authorId,
    authorName: authorName ?? authorId, text: text.join('').trim(),
    timestamp: typeof p.time === 'number' && Number.isFinite(p.time) ? p.time * 1000 : Date.now(),
    replyToMessageId, mentions, attachments,
    isMentioned: mentions.includes(selfId), isAdmin: !isPrivate&&(sender.role === 'owner' || sender.role === 'admin'),
    memberRoleGroup:isPrivate?'unknown':sender.role==='owner'||sender.role==='admin'?'group_admin':sender.role==='member'?'member':'unknown',
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
  readonly privateAccess:PrivateChatAccess;
  private deliveryGuard?:(key:string,roomId:string)=>boolean;
  private friends=new Map<string,number>();
  private verifiedFileConnection?:WebSocket;
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
    if (options.allowedGroupIds.some(x => !id(x))) throw new Error('Invalid allowedGroupIds');
    this.privateAccess=options.privateAccess??new PrivateChatAccess(options.selfId,options.privateChat);
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
    this.friends.clear();
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
      if(packet.post_type==='notice'){
        if(this.jobs.size>=(this.options.maxPendingEvents??1000))return;
        const job=this.fileNotice(packet).catch(()=>{this.options.onError?.('private_file_notice_rejected');}).finally(()=>this.jobs.delete(job));this.jobs.add(job);return;
      }
      const message = normalizeOneBotMessage(packet, this.options.selfId, this.groups,this.privateAccess);
      if(message&&this.options.privateFiles?.source==='offline_file')message.attachments=message.attachments.filter(a=>a.kind!=='file');
      if (!message || this.incoming.has(message.id) || this.seen.has(message.id)) return;
      if (this.jobs.size >= (this.options.maxPendingEvents ?? 1000)) { this.options.onError?.('input_overflow', message.id); return; }
      if(parseQqRoomId(message.roomId)?.kind==='private')this.friends.set(message.authorId,Date.now());
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

  async call(action: 'send_group_msg' | 'upload_group_file' | 'get_image' | 'get_msg' | 'get_group_member_info' | 'send_private_msg' | 'upload_private_file' | 'get_friend_list' | 'get_private_file_url' | 'get_version_info', params: Json): Promise<Json> {
    const ws = this.connection;
    if (!ws || ws.readyState !== WebSocket.OPEN || this.closing) throw new OneBotActionError('not_connected', false);
    if (this.pending.size >= 100) throw new OneBotActionError('too_many_pending_actions', false);
    const echo = randomUUID();
    const reply = await new Promise<Json>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(echo); reject(new OneBotActionError('timeout', true));
      }, this.options.actionTimeoutMs ?? (action.startsWith('upload_') ? 120000 : 15000));
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
        if(action === 'upload_group_file'||action==='upload_private_file')throw new OneBotActionError('upload_result_unknown', true,reply.retcode);
        if(action === 'send_group_msg'||action==='send_private_msg')throw new OneBotActionError('send_result_unknown', true,reply.retcode);
      }
      throw new OneBotActionError('action_failed', true,reply.retcode);
    }
    if(action==='upload_private_file'&&reply.status==='ok'&&reply.data===null&&this.options.privateFiles?.receipt==='synchronous'&&this.verifiedFileConnection===ws)return {};
    if(action==='get_friend_list'&&reply.status==='ok'&&Array.isArray(reply.data))return {friends:reply.data};
    if (reply.status !== 'ok' || !object(reply.data)) throw new OneBotActionError('invalid_response', true);
    return reply.data as Json;
  }

  async send(message: OutgoingMessage, dedupeKey: string): Promise<SendReceipt> {
    const room=this.allowedRoom(message.roomId);
    if(!room)return {status:'failed',reason:'invalid_room_scope'};
    if(room.kind==='private'&&message.recipientIds?.length)return {status:'failed',reason:'invalid_recipient_ids'};
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
    const promise = this.transmit(message,room,dedupeKey);
    this.sends.set(dedupeKey, { signature, promise });
    const result = await promise;
    // Definite failure can be retried; unknown delivery must never be blindly retried.
    if (result.status === 'failed' || result.status === 'deferred') this.sends.delete(dedupeKey);
    while (this.sends.size > 10000) this.sends.delete(this.sends.keys().next().value!);
    return result;
  }

  /** The coordinator persists each file receipt before sending the next part. */
  async uploadFile(roomId: string, file: OutgoingFile, dedupeKey: string): Promise<SendReceipt> {
    const room=this.allowedRoom(roomId);
    if(!room)return {status:'failed',reason:'invalid_room_scope'};
    if (!dedupeKey || !this.options.outputRoot) return { status: 'failed', reason: 'unsupported_output' };
    if (!object(file)) return { status: 'failed', reason: 'invalid_output_file' };
    const snapshot = { ...file }, signature = JSON.stringify({ roomId, file: snapshot });
    const prior = this.uploads.get(dedupeKey);
    if (prior) return signature === prior.signature ? prior.promise : { status: 'failed', reason: 'dedupe_key_conflict' };
    const promise = this.transmitFile(snapshot,room,dedupeKey);
    this.uploads.set(dedupeKey, { signature, promise });
    const result = await promise;
    if (result.status === 'failed' || result.status === 'deferred') this.uploads.delete(dedupeKey);
    while (this.uploads.size > 10000) this.uploads.delete(this.uploads.keys().next().value!);
    return result;
  }

  private async transmitFile(file: OutgoingFile, room:QqConversation, key:string): Promise<SendReceipt> {
    const roomId=formatQqRoomId(room),lease=room.kind==='private'?this.privateAccess.capture(roomId):undefined;
    let bytes: Buffer;
    try { bytes = await readOutgoingFile(file, this.options.outputRoot!); }
    catch { return { status: 'failed', reason: 'invalid_output_file' }; }
    try {
      // Transfer validated bytes so the bridge does not need access to host paths.
      const denied=await this.preparePrivate(room,lease);if(denied)return denied;
      if(room.kind==='private')try{await this.verifyFileContract();}catch{return {status:'failed',reason:'private_file_unsupported',retryable:false};}
      let transportFile=`base64://${bytes.toString('base64')}`;
      if(room.kind==='private'&&this.options.privateFiles?.transport==='shared_path'){
        const root=resolve(this.options.privateFiles.sharedRoot!),target=resolve(file.file),rel=relative(root,target);
        if(!rel||rel.startsWith('..')||isAbsolute(rel))return {status:'failed',reason:'private_file_unsupported'};
        transportFile=target;
      }
      if(!this.sendAllowed(roomId,key,lease))return {status:'failed',reason:'private_access_denied'};
      const data = await this.call(room.kind==='private'?'upload_private_file':'upload_group_file', { ...(room.kind==='private'?{user_id:room.peerId}:{group_id:room.groupId}), file: transportFile, name: file.name, upload_file: true });
      const fileId = typeof data.file_id === 'string' && data.file_id.trim() && data.file_id.length <= 1024 && !/[\x00-\x1f\x7f]/.test(data.file_id) ? data.file_id : undefined;
      return fileId ? { status: 'sent', platformFileId: fileId } : room.kind==='private'&&this.options.privateFiles?.receipt==='synchronous'?{status:'sent'}:{ status: 'unknown', reason: 'missing_file_id' };
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

  private async transmit(message: OutgoingMessage, room:QqConversation,key:string): Promise<SendReceipt> {
    const lease=room.kind==='private'?this.privateAccess.capture(message.roomId):undefined;
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
      ...(message.replyToMessageId&&message.quoteReply!==false ? [{ type: 'reply', data: { id: message.replyToMessageId } }] : []),
      ...(message.recipientIds??[]).flatMap(qq=>[{type:'at',data:{qq}},{type:'text',data:{text:' '}}]),
      ...(message.text.trim() ? [{ type: 'text', data: { text: message.text } }] : []),
      ...images.map(data => ({ type: 'image', data: { file: `base64://${data.toString('base64')}` } })),
    ];
    try {
      const denied=await this.preparePrivate(room,lease);if(denied)return denied;
      if(!this.sendAllowed(message.roomId,key,lease))return {status:'failed',reason:'private_access_denied'};
      const data = await this.call(room.kind==='private'?'send_private_msg':'send_group_msg', { ...(room.kind==='private'?{user_id:room.peerId}:{group_id:room.groupId}), message: segments });
      const messageId = id(data.message_id, true);
      return messageId ? { status: 'sent', platformMessageId: messageId } : { status: 'unknown', reason: 'missing_message_id' };
    } catch (error) {
      const known = error instanceof OneBotActionError;
      if (known && !error.sent) return { status: 'deferred', reason: error.code };
      return { status: known && error.code === 'action_failed' ? 'failed' : 'unknown', reason: known ? error.code : 'send_error',
        ...(known&&error.platformCode!==undefined?{platformCode:error.platformCode}:{}),...(known&&error.code==='action_failed'?{retryable:false}:{}) };
    }
  }

  private allowedRoom(roomId:string){
    const room=parseQqRoomId(roomId);
    return room&&room.botId===this.options.selfId&&(room.kind==='private'?this.privateAccess.allows(roomId):this.groups.has(room.groupId))?room:undefined;
  }
  setDeliveryGuard(guard:(key:string,roomId:string)=>boolean){this.deliveryGuard=guard;}
  private async verifyFileContract(){
    const contract=this.options.privateFiles,connection=this.connection;
    if(!contract||!connection)throw new Error('private_file_unsupported');
    if(this.verifiedFileConnection===connection)return;
    const info=await this.call('get_version_info',{});
    if(this.connection!==connection||info.app_name!==contract.implementation||info.app_version!==contract.version)throw new Error('private_file_unsupported');
    this.verifiedFileConnection=connection;
  }
  async privateFileUrl(roomId:string,attachment:Attachment):Promise<string|undefined>{
    const lease=this.privateAccess.capture(roomId);await this.verifyFileContract();this.privateAccess.assert(lease);
    if(attachment.url)return attachment.url;
    if(!attachment.file)throw new Error('file_url_unavailable');
    const room=parseQqRoomId(roomId)!;
    if(room.kind!=='private')throw new Error('invalid_room_scope');
    const result=await this.call('get_private_file_url',{user_id:room.peerId,file_id:attachment.file});this.privateAccess.assert(lease);
    if(typeof result.url!=='string')throw new Error('file_url_unavailable');return result.url;
  }
  private async fileNotice(packet:Json){
    // No content access until transport identity, subtype and current policy pass.
    const peer=id(packet.user_id),roomId=`qq:${this.options.selfId}:private:${peer}`;
    if(this.options.privateFiles?.source!=='offline_file'||packet.notice_type!=='offline_file'||id(packet.self_id)!==this.options.selfId
      ||!peer||peer===this.options.selfId||packet.sub_type!==undefined&&packet.sub_type!=='friend'||!this.privateAccess.allows(roomId))return;
    const lease=this.privateAccess.capture(roomId);await this.verifyFileContract();this.privateAccess.assert(lease);
    if(!await this.verifyFriend(roomId))return;this.privateAccess.assert(lease);
    const file=object(packet.file);
    if(!file||typeof file.name!=='string'||typeof file.url!=='string'||typeof file.size!=='number'||!Number.isFinite(packet.time)||Number(packet.time)<=0)return;
    const identity=createHash('sha256').update(JSON.stringify([roomId,packet.time,file.name,file.size,file.url,file.id??null])).digest('hex');
    const key=roomId+':file:'+identity;if(this.incoming.has(key)||this.seen.has(key))return;
    this.incoming.add(key);
    try{
      this.privateAccess.assert(lease);
      await this.options.onMessage({id:key,roomId,platform:'qq',messageId:'',authorId:peer,authorName:peer,text:'',timestamp:Number(packet.time)*1000,
        mentions:[],isMentioned:false,isAdmin:false,memberRoleGroup:'unknown',roleVerifiedAt:Date.now(),
        attachments:[{kind:'file',name:file.name,url:file.url,bytes:file.size,...(typeof file.id==='string'?{file:file.id}:{})}]});
      this.seen.set(key,Date.now());while(this.seen.size>10000)this.seen.delete(this.seen.keys().next().value!);
    }finally{this.incoming.delete(key);}
  }
  private sendAllowed(roomId:string,key:string,lease?:AccessLease){return !!this.allowedRoom(roomId)&&(!lease||this.privateAccess.valid(lease))&&(!this.deliveryGuard||this.deliveryGuard(key,roomId));}
  async verifyFriend(roomId:string):Promise<boolean>{
    const room=this.allowedRoom(roomId);if(!room||room.kind!=='private')return false;
    const lease=this.privateAccess.capture(roomId),now=Date.now();
    if(now-(this.friends.get(room.peerId)??0)<=60000)return true;
    const data=await this.call('get_friend_list',{});this.privateAccess.assert(lease);
    if(!Array.isArray(data.friends))throw new Error('invalid_friend_list');
    this.friends.clear();for(const friend of data.friends){const peer=id(object(friend)?.user_id);if(peer)this.friends.set(peer,Date.now());}
    return this.friends.has(room.peerId);
  }
  private async preparePrivate(room:QqConversation,lease?:AccessLease):Promise<SendReceipt|undefined>{
    if(room.kind!=='private')return;
    try{if(!await this.verifyFriend(formatQqRoomId(room)))return {status:'failed',reason:'friend_unavailable',retryable:false};}
    catch{return {status:'deferred',reason:'friend_verification_unavailable'};}
    if(!lease||!this.privateAccess.valid(lease))return {status:'failed',reason:'private_access_denied',retryable:false};
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
