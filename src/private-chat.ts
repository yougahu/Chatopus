import {createHash} from 'node:crypto';
import {readFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {parseEnv} from 'node:util';
import {formatQqRoomId,parseQqRoomId,qqId} from './conversation.js';

export interface PrivateChatSettings {enabled:boolean;allowedUserIds:string[];maxMessagesPerMinute:number;replyMode:'plain'|'quote'}
export function qqStartupDigest(qq:Record<string,unknown>){return createHash('sha256').update(JSON.stringify(Object.fromEntries(['enabled','selfId','accessToken','allowedGroupIds','host','port','imageCacheRoot','privateFiles'].map(key=>[key,qq[key]])))).digest('hex');}
export function privateChatSettings(value:unknown={}):PrivateChatSettings {
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid qq.privateChat');
  const input=value as Record<string,unknown>;
  if(Object.keys(input).some(key=>!['enabled','allowedUserIds','maxMessagesPerMinute','replyMode'].includes(key)))throw new Error('Unknown qq.privateChat setting');
  const result={enabled:false,allowedUserIds:[],maxMessagesPerMinute:30,replyMode:'plain',...input} as PrivateChatSettings;
  if(typeof result.enabled!=='boolean'||!Array.isArray(result.allowedUserIds)||result.allowedUserIds.length>1000
    ||result.allowedUserIds.some(id=>!qqId(id))||!Number.isSafeInteger(result.maxMessagesPerMinute)||result.maxMessagesPerMinute<1
    ||result.maxMessagesPerMinute>600||!['plain','quote'].includes(result.replyMode))throw new Error('Invalid qq.privateChat settings');
  result.allowedUserIds=[...new Set(result.allowedUserIds.map(String))].sort();return result;
}
export type AccessLease={roomId:string;signal:AbortSignal};
/** One service-owned policy. Revoked leases can never be revived by a later grant. */
export class PrivateChatAccess {
  private settings:PrivateChatSettings;
  private candidate:PrivateChatSettings;
  private leases=new Map<string,AbortController>();
  private pending=new Set<string>();
  private windows=new Map<string,{normal:number[];control:number[];notice:number}>();
  private lastPoll=0;
  private applied=false;
  constructor(readonly botId:string,settings?:Partial<PrivateChatSettings>){this.settings=privateChatSettings(settings);this.candidate=this.settings;}
  get snapshot():PrivateChatSettings{return structuredClone(this.settings);}
  get digest(){return createHash('sha256').update(JSON.stringify(this.settings)).digest('hex');}
  rooms(){return this.settings.enabled?this.settings.allowedUserIds.map(peerId=>formatQqRoomId({kind:'private',botId:this.botId,peerId})):[];}
  allows(roomId:string){const room=parseQqRoomId(roomId);return !!room&&room.kind==='private'&&room.botId===this.botId&&this.settings.enabled&&this.settings.allowedUserIds.includes(room.peerId)&&!this.pending.has(roomId);}
  capture(roomId:string):AccessLease {
    if(!this.allows(roomId))throw new Error('private_access_denied');
    let controller=this.leases.get(roomId);if(!controller){controller=new AbortController();this.leases.set(roomId,controller);}
    return {roomId,signal:controller.signal};
  }
  valid(lease:AccessLease){return !lease.signal.aborted&&this.allows(lease.roomId);}
  assert(lease:AccessLease){if(!this.valid(lease))throw new Error('private_access_denied');}
  /** Cleanup and success audit must commit synchronously before the policy is published. */
  apply(value:unknown,knownRooms:readonly string[],commit:(rooms:string[],settings:PrivateChatSettings,digest:string)=>void){
    this.candidate=privateChatSettings(value);
    const allowed=new Set(this.candidate.enabled?this.candidate.allowedUserIds:[]);
    for(const roomId of new Set([...this.rooms(),...knownRooms,...this.leases.keys()])){
      const room=parseQqRoomId(roomId);if(!room||room.kind!=='private')continue;
      if(room.botId===this.botId&&allowed.has(room.peerId))continue;
      this.pending.add(roomId);this.leases.get(roomId)?.abort();this.leases.delete(roomId);this.windows.delete(roomId);
    }
    const digest=createHash('sha256').update(JSON.stringify(this.candidate)).digest('hex');
    if(this.applied&&!this.pending.size&&digest===this.digest)return false;
    commit([...this.pending],structuredClone(this.candidate),digest);
    this.settings=this.candidate;this.pending.clear();this.applied=true;return true;
  }
  poll(root:string,knownRooms:readonly string[],commit:Parameters<PrivateChatAccess['apply']>[2],onError:(code:string)=>void,force=false){
    if(!force&&Date.now()-this.lastPoll<1000)return;this.lastPoll=Date.now();
    let candidate:unknown=this.candidate;
    try{
      const file=join(root,'config.local.json');
      if(existsSync(file)){
        const disk=JSON.parse(readFileSync(file,'utf8'));
        const envFile=join(root,'.env'),env={...process.env,...(existsSync(envFile)?parseEnv(readFileSync(envFile,'utf8')):{})};
        if(String(env.QQ_SELF_ID??disk.qq?.selfId??this.botId)!==this.botId)throw new Error('restart_required');
        candidate=privateChatSettings(disk.qq?.privateChat);
      }
    }catch(error){onError(error instanceof Error&&error.message==='restart_required'?'restart_required':'invalid_private_config');}
    try{this.apply(candidate,knownRooms,commit);}catch{onError('private_config_apply_failed');}
  }
  admit(roomId:string,control:boolean,now=Date.now()):{accepted:boolean;notice:boolean}{
    if(!this.allows(roomId))return {accepted:false,notice:false};
    for(const [key,value]of this.windows)if(!value.normal.some(at=>at>now-60000)&&!value.control.some(at=>at>now-60000)&&value.notice<now-60000)this.windows.delete(key);
    let window=this.windows.get(roomId);if(!window){window={normal:[],control:[],notice:0};this.windows.set(roomId,window);}
    const key=control?'control':'normal';window[key]=window[key].filter(at=>at>now-60000);
    if(window[key].length>=(control?10:this.settings.maxMessagesPerMinute)){
      const notice=now-window.notice>=60000;if(notice)window.notice=now;return {accepted:false,notice};
    }
    window[key].push(now);return {accepted:true,notice:false};
  }
}
