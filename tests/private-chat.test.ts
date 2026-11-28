import {afterEach,expect,it} from 'vitest';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {WebSocket} from 'ws';
import {once} from 'node:events';
import {parseQqRoomId,formatQqRoomId} from '../src/conversation.js';
import {PrivateChatAccess,privateChatSettings} from '../src/private-chat.js';
import {normalizeOneBotMessage,OneBotAdapter} from '../src/platform/onebot.js';
import {hasWakeCandidate} from '../src/activation.js';
import {loadConfig} from '../src/config.js';
import {Store} from '../src/store.js';
import {Coordinator} from '../src/coordinator.js';
import {MemoryPublisher} from '../src/platform/memory.js';
import type {GroupMessage,RuntimePort,RouterRequest,RouteAction} from '../src/types.js';
import {resolveBusinessProfile} from '../src/business-config.js';
const room='qq:900:private:901',settings={enabled:true,allowedUserIds:['901'],maxMessagesPerMinute:30,replyMode:'plain' as const};
const policy=()=>new PrivateChatAccess('900',settings);
const event=(extra:Record<string,unknown>={})=>({post_type:'message',message_type:'private',sub_type:'friend',self_id:900,user_id:901,message_id:1,sender:{user_id:901,nickname:'Member',role:'owner'},message:[{type:'text',data:{text:'整理这份说明'}}],...extra});
const message=(id='1',text='请解释缓存'):GroupMessage=>({...normalizeOneBotMessage(event({message_id:id}),'900',new Set(),policy())!,text});
const clean:Array<()=>unknown>=[];afterEach(async()=>{for(const close of clean.splice(0).reverse())await close();});
it('keeps complete private, group, bot and peer identities separate',()=>{
 expect(formatQqRoomId({kind:'private',botId:'900',peerId:'901'})).toBe(room);
 expect(parseQqRoomId(room)).toEqual({kind:'private',botId:'900',peerId:'901'});
 for(const invalid of ['qq:0900:private:901','qq:900:private:0','qq:900:group:901','qq:900:private:901:x'])expect(parseQqRoomId(invalid)).toBeUndefined();
});
it.each(['group','other','unknown',undefined])('rejects private subtype %s before parsing content',sub_type=>{
 const input=event({sub_type});Object.defineProperty(input,'message',{get:()=>{throw new Error('must not read content');}});
 expect(()=>normalizeOneBotMessage(input,'900',new Set(['901']),policy())).not.toThrow();
 expect(normalizeOneBotMessage(input,'900',new Set(['901']),policy())).toBeUndefined();
});
it('retains mention facts while directly activating only the private peer',()=>{
 const m=message();expect(m.isMentioned).toBe(false);expect(m.isAdmin).toBe(false);expect(m.memberRoleGroup).toBe('unknown');
 expect(hasWakeCandidate(m,[])).toBe(true);expect(hasWakeCandidate({...m,authorId:'902'},[])).toBe(false);
 expect(normalizeOneBotMessage(event({sender:{user_id:902}}),'900',new Set(),policy())).toBeUndefined();
});
it('defaults private access off and rejects unknown or unbounded settings',()=>{
 expect(privateChatSettings().enabled).toBe(false);
 for(const value of [{enabled:1},{allowedUserIds:['0']},{allowTemporary:true},{maxMessagesPerMinute:601},{replyMode:'fake'}])expect(()=>privateChatSettings(value)).toThrow();
});
it('finishes failed revocation before granting a new lease after config reversion',()=>{
 const access=policy(),old=access.capture(room);let attempts=0;
 expect(()=>access.apply({...settings,allowedUserIds:[]},[],()=>{attempts++;throw new Error('busy');})).toThrow();
 expect(old.signal.aborted).toBe(true);expect(access.allows(room)).toBe(false);
 access.apply(settings,[],rooms=>{attempts++;expect(rooms).toEqual([room]);});
 expect(attempts).toBe(2);expect(access.allows(room)).toBe(true);expect(access.valid(old)).toBe(false);expect(access.valid(access.capture(room))).toBe(true);
});
it('retains quota after lowering limits and gives controls an independent bound',()=>{
 const access=policy();for(let i=0;i<30;i++)expect(access.admit(room,false,100000).accepted).toBe(true);
 expect(access.admit(room,false,100001)).toEqual({accepted:false,notice:true});expect(access.admit(room,false,100002).notice).toBe(false);
 for(let i=0;i<10;i++)expect(access.admit(room,true,100003).accepted).toBe(true);
 expect(access.admit(room,true,100004).accepted).toBe(false);
 access.apply({...settings,maxMessagesPerMinute:1},[],()=>{});expect(access.admit(room,false,100005).accepted).toBe(false);
 expect(access.admit(room,false,160001).accepted).toBe(true);
});
function fixture(route?:(request:RouterRequest)=>Promise<RouteAction[]>,persistentRouter=false){
 const root=mkdtempSync(join(tmpdir(),'chatopus-private-'));clean.push(()=>rmSync(root,{recursive:true,force:true}));
 const config=loadConfig(root,{persistentRouter,routerBatchWindowMs:0,qq:{enabled:true,selfId:'900',accessToken:'test',host:'127.0.0.1',port:0,allowedGroupIds:[],privateChat:settings}});
 const store=new Store(join(root,'state.sqlite')),publisher=new MemoryPublisher(),requests:RouterRequest[]=[];
 const runtime:RuntimePort={route:async request=>{requests.push(request);return route?route(request):[{action:'reply_direct',sourceMessageIds:request.messages.map(m=>m.id),text:'已收到'}];},runWorker:async()=>{throw new Error('unexpected worker');},steer:async()=>{},cancel:async()=>{},close:async()=>{}};
 const coordinator=new Coordinator(config,store,runtime,publisher);clean.push(async()=>{await coordinator.close();store.close();});return {root,config,store,publisher,requests,coordinator};
}
it('answers consecutive private input without mentions and keeps source links in plain mode',async()=>{
 const {coordinator,publisher,store,requests}=fixture();await coordinator.start();
 await coordinator.receive(message());await coordinator.receive(message('2'));await coordinator.drain();
 expect(requests).toHaveLength(2);expect(publisher.messages).toHaveLength(2);
 expect(store.outbox('sent')[0].message).toMatchObject({quoteReply:false,replyToMessageId:'1',sourceInputId:room+':1'});
});
it('deduplicates before quota and leaves exact controls usable under normal rate limiting',async()=>{
 const {coordinator,publisher,store,requests}=fixture();coordinator.privateAccess.apply({...settings,maxMessagesPerMinute:1},[],()=>{});
 await coordinator.receive(message());await coordinator.receive(message());await coordinator.receive(message('2'));await coordinator.receive(message('3','/status'));await coordinator.drain();
 expect(requests).toHaveLength(1);expect(store.message(room+':2')).toBeUndefined();expect(publisher.messages.some(m=>m.message.text.includes('可操作'))).toBe(true);
});
it('answers a conversational progress question naturally while preserving its task association',async()=>{
 let threadId='';
 const {coordinator,store,publisher}=fixture(async request=>[{action:'request_status',sourceMessageIds:request.messages.map(m=>m.id),threadId}]);
 const thread=store.createThread(message('101'),'整理文档',true);threadId=thread.id;thread.status='running';store.saveThread(thread);
 await coordinator.receive(message('102','是不是睡着了'));
 const row=store.outbox().find(row=>row.id==='control:'+room+':102')!;
 expect(row.message.text).toBe('这个问题还在处理中，有结果后我会告诉你。');
 expect(row.associationThreadId).toBe(thread.id);
 expect(publisher.messages.some(sent=>sent.message.text===row.message.text)).toBe(true);
});
it('does not commit late Router output after revoke and regrant',async()=>{
 let release!:(actions:RouteAction[])=>void;const gate=new Promise<RouteAction[]>(resolve=>release=resolve);
 const {coordinator,store,root,publisher,requests}=fixture(async()=>gate);const receiving=coordinator.receive(message());
 for(let n=0;n<100&&!requests.length;n++)await new Promise(resolve=>setTimeout(resolve,2));
 writeFileSync(join(root,'config.local.json'),JSON.stringify({qq:{selfId:'900',privateChat:{...settings,allowedUserIds:[]}}}));
 (coordinator as any).refreshPrivatePolicy(true);
 writeFileSync(join(root,'config.local.json'),JSON.stringify({qq:{selfId:'900',privateChat:settings}}));(coordinator as any).refreshPrivatePolicy(true);
 release([{action:'reply_direct',sourceMessageIds:[room+':1'],text:'obsolete'}]);await receiving;await coordinator.tick();
 expect(publisher.messages).toHaveLength(0);expect(store.db.prepare('SELECT status FROM messages WHERE id=?').get(room+':1')?.status).toBe('failed');
});
it('resolves business by the full private room without inheriting group bindings',()=>{
 const {config}=fixture();config.business!.roomProfiles={'qq:900:901':'documents',[room]:'documents'};
 config.business!.profiles.documents={...config.business!.profiles.default,name:'文档'};
 expect(resolveBusinessProfile(config,room).id).toBe('documents');expect(resolveBusinessProfile(config,'qq:900:private:902').id).toBe('default');
});
it('uses friend verification and private-only wire params, preserving plain source metadata',async()=>{
 const adapter=new OneBotAdapter({selfId:'900',accessToken:'test',allowedGroupIds:[],privateChat:settings,port:0,onMessage:async()=>{}});clean.push(()=>adapter.close());await adapter.start();
 const ws=new WebSocket(`ws://127.0.0.1:${adapter.port}/onebot/v11/ws`,{headers:{Authorization:'Bearer test','X-Self-ID':'900'}});await once(ws,'open');
 const actions:any[]=[];ws.on('message',raw=>{const packet=JSON.parse(raw.toString());actions.push(packet);ws.send(JSON.stringify({status:'ok',retcode:0,echo:packet.echo,data:packet.action==='get_friend_list'?[{user_id:901}]:{message_id:50}}));});
 expect(await adapter.send({roomId:room,text:'hello',replyToMessageId:'1',quoteReply:false},'one')).toMatchObject({status:'sent'});
 expect(actions.map(a=>a.action)).toEqual(['get_friend_list','send_private_msg']);expect(actions[1].params).toEqual({user_id:'901',message:[{type:'text',data:{text:'hello'}}]});
 expect(await adapter.send({roomId:room,text:'hello',recipientIds:['901']},'bad')).toMatchObject({status:'failed'});
});

it('revokes active tasks even when newer completed history exceeds the card limit',()=>{
 const f=fixture(),source=message(),thread=f.store.createThread(source,'old active task',true);
 f.store.db.prepare('UPDATE threads SET updated=0 WHERE id=?').run(thread.id);
 for(let i=0;i<1001;i++)f.store.saveThread({...thread,id:'historical-'+i,status:'idle'});
 expect(f.store.threads().some(t=>t.id===thread.id)).toBe(false);
 f.store.transaction(()=>f.store.revokePrivateRoom(room));expect(f.store.thread(thread.id)?.status).toBe('cancelled');
});

it('asks for unknown resend confirmation once without failing or replaying the intake',async()=>{
 const f=fixture(async request=>[{action:'resend_delivery',sourceMessageIds:[request.messages[0].id],outboxId:'uncertain'}]);
 f.store.enqueue({roomId:room,text:'earlier result'},{id:'uncertain',status:'unknown'});
 await f.coordinator.receive(message('55','send that again'));await f.coordinator.drain();
 expect(f.requests).toHaveLength(1);expect(f.publisher.messages.at(-1)?.message.text).toContain('仍然补发');expect(f.store.outbox().filter(row=>row.resendOf)).toHaveLength(0);
 expect(f.store.db.prepare('SELECT status FROM messages WHERE id=?').get(room+':55')?.status).toBe('routed');
});

it.each([false,true])('commits a prepared explicit resend across Router proposal reconstruction (persistent=%s)',async persistent=>{
 const f=fixture(async request=>[{action:'resend_delivery',sourceMessageIds:[request.messages[0].id],outboxId:'uncertain',confirmedUnknown:true}],persistent);
 f.store.enqueue({roomId:room,text:'earlier result'},{id:'uncertain',status:'unknown'});
 await f.coordinator.receive(message('56','I understand it might have arrived; send it again.'));await f.coordinator.drain();
 expect(f.store.outbox().filter(row=>row.resendOf==='uncertain')).toHaveLength(1);expect(f.store.outbox().find(row=>row.id==='uncertain')).toMatchObject({status:'unknown',deliveryResolutions:[{reason:'resent'}]});
});
