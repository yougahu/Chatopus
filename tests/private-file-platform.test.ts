import {afterEach,expect,it} from 'vitest';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {once} from 'node:events';
import {WebSocket} from 'ws';
import {OneBotAdapter} from '../src/platform/onebot.js';
import {privateFileContract,type PrivateFileContract} from '../src/platform/private-files.js';
import type {GroupMessage,OutgoingFile} from '../src/types.js';
const clean:Array<()=>unknown>=[],room='qq:900:private:901';
afterEach(async()=>{for(const close of clean.splice(0).reverse())await close();});
async function fixture(contract?:Partial<PrivateFileContract>,receipt:unknown={file_id:'f-1'},bridgeVersion='test-1'){
 const root=mkdtempSync(join(tmpdir(),'chatopus-bridge-'));clean.push(()=>rmSync(root,{recursive:true,force:true}));
 const bytes=Buffer.from('notes'),path=join(root,'notes.txt');writeFileSync(path,bytes);
 const file:OutgoingFile={kind:'file',file:path,name:'notes.txt',bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),artifactId:'artifact-1'};
 const messages:GroupMessage[]=[],packets:any[]=[],settings=contract?privateFileContract({implementation:'SyntheticBridge',version:'test-1',transport:'base64',receipt:'file_id',source:'message',...contract, ...(contract.transport==='shared_path'?{sharedRoot:root}:{})}):undefined;
 const adapter=new OneBotAdapter({selfId:'900',accessToken:'test',allowedGroupIds:[],privateChat:{enabled:true,allowedUserIds:['901']},privateFiles:settings,port:0,outputRoot:root,actionTimeoutMs:100,onMessage:async m=>{messages.push(m);}});await adapter.start();clean.push(()=>adapter.close());
 const client=new WebSocket(`ws://127.0.0.1:${adapter.port}/onebot/v11/ws`,{headers:{Authorization:'Bearer test','X-Self-ID':'900'}});await once(client,'open');
 client.on('message',raw=>{const p=JSON.parse(raw.toString());packets.push(p);client.send(JSON.stringify({echo:p.echo,status:'ok',retcode:0,data:p.action==='get_friend_list'?[{user_id:901}]:p.action==='get_version_info'?{app_name:settings?.implementation,app_version:bridgeVersion}:p.action==='get_private_file_url'?{url:'https://qq.com/file'}:receipt}));});
 return {adapter,client,packets,messages,file,root};
}
it('pins a base64 upload contract and sends only the private user ID',async()=>{
 const f=await fixture({});expect(await f.adapter.uploadFile(room,f.file,'upload')).toEqual({status:'sent',platformFileId:'f-1'});
 expect(f.packets.map(p=>p.action)).toEqual(['get_friend_list','get_version_info','upload_private_file']);
 expect(f.packets.at(-1).params).toMatchObject({user_id:'901',file:'base64://bm90ZXM='});expect(f.packets.at(-1).params.group_id).toBeUndefined();
});
it('requires an explicit supported contract and refuses version drift before upload',async()=>{
 const missing=await fixture();expect((await missing.adapter.uploadFile(room,missing.file,'missing')).reason).toBe('private_file_unsupported');
 const mismatch=await fixture({},null,'test-2');expect((await mismatch.adapter.uploadFile(room,mismatch.file,'mismatch')).reason).toBe('private_file_unsupported');expect(mismatch.packets.some(p=>p.action==='upload_private_file')).toBe(false);
});
it('distinguishes concrete file receipts from a documented synchronous null receipt',async()=>{
 const uncertain=await fixture({},null);expect((await uncertain.adapter.uploadFile(room,uncertain.file,'unknown')).status).toBe('unknown');
 const documented=await fixture({implementation:'go-cqhttp',source:'offline_file',transport:'shared_path',receipt:'synchronous'},null);
 expect((await documented.adapter.uploadFile(room,documented.file,'sync')).status).toBe('sent');expect(documented.packets.at(-1).params.file).toBe(documented.file.file);
});
it('does not promote explicitly temporary notices, and gives offline notices stable host-only IDs',async()=>{
 const f=await fixture({implementation:'go-cqhttp',source:'offline_file',transport:'shared_path',receipt:'synchronous'},null);
 const event={post_type:'notice',notice_type:'offline_file',self_id:900,user_id:901,time:12345,file:{name:'notes.txt',size:5,url:'https://qq.com/file'}};
 const temporary={...event,sub_type:'group'};Object.defineProperty(temporary,'file',{get(){throw new Error('body must remain unread');}});
 await (f.adapter as any).fileNotice(temporary);expect(f.packets).toHaveLength(0);
 await (f.adapter as any).fileNotice(event);await (f.adapter as any).fileNotice(event);
 expect(f.messages).toHaveLength(1);expect(f.messages[0]).toMatchObject({roomId:room,messageId:'',isAdmin:false,isMentioned:false});expect(f.messages[0].id).toMatch(/:file:[a-f0-9]{64}$/);
});
it('rechecks the original lease after bridge lookup, even if access is regranted',async()=>{
 const f=await fixture({});f.adapter.privateAccess.apply({enabled:false},[room],()=>{});
 expect((await f.adapter.uploadFile(room,f.file,'revoked')).status).toBe('failed');expect(f.packets).toHaveLength(0);
});
it('does not accept synchronous success assumptions for unrelated implementations',()=>{
 expect(()=>privateFileContract({implementation:'OtherBridge',version:'1',transport:'base64',receipt:'synchronous',source:'message'})).toThrow();
});
