import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/store.js';
import { Coordinator } from '../src/coordinator.js';
import { MemoryPublisher } from '../src/platform/memory.js';
import { ReplyLinks } from '../src/tools/reply-links.js';
import type { RuntimePort, GroupMessage } from '../src/types.js';

const cleanup:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const fn of cleanup.splice(0).reverse())await fn();});
function fixture(withMemory=false){
 const root=mkdtempSync(join(tmpdir(),'link-delivery-'));
 const config=loadConfig(root,{apiKey:'',stateDir:join(root,'state'),persistentRouter:false});
 const store=new Store(join(root,'state.sqlite')),publisher=new MemoryPublisher();
 const refresh=vi.fn(async({text}:{text:string})=>'阿明，'+text);
 const runtime={route:async()=>[],runWorker:async()=>{throw new Error('Not expected');},steer:async()=>{},cancel:async()=>{},close:async()=>{},refreshReplyPreferences:refresh,
  ...(withMemory?{sharedMemory:{account:()=>'test-account',project:async()=>[{memberId:'a',revision:1,fields:{preferredName:{state:'set',value:'阿明'}},omittedKeys:[]}]}}:{})} as unknown as RuntimePort;
 const coordinator=new Coordinator(config,store,runtime,publisher);
 const msg:GroupMessage={id:'m1',messageId:'1',platform:'replay',roomId:'room',authorId:'a',authorName:'A',text:'给我链接',timestamp:Date.now(),mentions:[],attachments:[],isMentioned:true,isAdmin:false};
 store.ingest(msg);const thread=store.createThread(msg,'link',true);thread.status='idle';store.saveThread(thread);
 const registry=new ReplyLinks({threadId:thread.id,runId:'run',revision:thread.revision});
 const url='https://example.test/search/H4sI_really_long_exact_URL_123',reference=registry.register(url),template='链接：\n'+reference;
 const id=store.enqueue({roomId:'room',replyToMessageId:'1',text:template},{threadId:thread.id,revision:thread.revision,epoch:thread.epoch,hostLinks:registry.resolve(template)});
 cleanup.push(async()=>{await coordinator.close();store.close();rmSync(root,{recursive:true,force:true});});
 return {root,store,publisher,coordinator,refresh,url,reference,template,id};
}
it('inserts the original URL after preference rewriting and preserves receipts through SQLite reload',async()=>{
 const f=fixture(true),row=f.store.outbox('pending')[0];
 expect(row.hostLinks).toHaveLength(1);
 await f.coordinator.tick();
 expect(f.refresh).toHaveBeenCalledWith(expect.objectContaining({text:f.template}));
 expect(f.publisher.messages[0].message.text).toBe('阿明，链接：\n'+f.url);
 const sent=f.store.outbox('sent')[0];expect(sent.hostLinkTemplate).toBe('阿明，'+f.template);expect(sent.message.text).not.toContain('[[link:');
});
it('blocks a rewrite that deletes or changes the link before publishing',async()=>{
 const f=fixture(true);f.refresh.mockImplementation(async()=> '阿明，修好了');
 await f.coordinator.tick();expect(f.publisher.messages).toEqual([]);expect(f.store.outbox('pending')).toHaveLength(1);
});
it('blocks corrupted durable link receipts even when no preference model runs',async()=>{
 const f=fixture(),row=f.store.outbox('pending')[0];row.hostLinks![0].url+='Za';f.store.saveOutbox(row);
 await f.coordinator.tick();expect(f.publisher.messages).toEqual([]);expect(f.store.outbox('failed')[0].reason).toBe('REPLY_LINK_INVALID');
});
it('reuses the template when a delivery is deferred and preferences change before retry',async()=>{
 const f=fixture(true);const original=f.publisher.send.bind(f.publisher);let calls=0;
 f.publisher.send=async(message,key)=>++calls===1?{status:'deferred',reason:'busy'}:original(message,key);
 await f.coordinator.tick();const row=f.store.outbox('pending')[0];expect(row.message.text).toContain(f.url);row.dueAt=0;f.store.saveOutbox(row);
 await f.coordinator.tick();expect(f.publisher.messages[0].message.text).toBe('阿明，链接：\n'+f.url);expect(f.publisher.messages[0].message.text).not.toContain('[[link:');
});
