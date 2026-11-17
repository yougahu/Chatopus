import { afterEach,expect,it } from 'vitest';
import { Store } from '../src/store.js';
import { createRouterRecall,mergeRouterContext } from '../src/runtime/router-recall.js';
import { parseRoutesForRequest } from '../src/protocol.js';
import type { GroupMessage,RouterRequest } from '../src/types.js';
const stores:Store[]=[];
afterEach(()=>{for(const store of stores.splice(0))store.close();});
function message(id:string,text:string,roomId='room'):GroupMessage{return {id:roomId+':'+id,messageId:id,roomId,platform:'replay',authorId:'owner',authorName:'owner',text,timestamp:1,mentions:[],attachments:[],isAdmin:false,isMentioned:true};}
function fixture(){const store=new Store(':memory:');stores.push(store);const old=message('old','预算20元');store.ingest(old,1);const current=message('current','继续刚才的问题');store.ingest(current,2);const request:RouterRequest={roomId:'room',messages:[current],event:'messages',recentMessages:[],threads:[]};return{store,old,current,request};}
it('recalls only earlier same-room inputs regardless of forged timestamps',async()=>{
 const {store,request}=fixture();const read=store.routerContextReader('room','room:current',3);
 store.ingest(message('future','预算999元'),1);store.ingest(message('foreign','预算100元','other'),1);
 const result=await read({kind:'messages',query:'预算'});expect(result.messages?.map(m=>m.text)).toEqual(['预算20元']);
 expect(await read({kind:'messages',id:'foreign'})).toMatchObject({messages:[]});
 expect(await read({kind:'messages',id:'current'})).toMatchObject({messages:[]});
 mergeRouterContext(request,result);expect(request.messages).toHaveLength(1);expect(request.recentMessages).toHaveLength(1);
});
it('reads confirmed past replies and excludes sends registered or confirmed after the cutoff',async()=>{
 const {store}=fixture();store.enqueue({roomId:'room',text:'confirmed'},{id:'sent',status:'sent',sentAt:2,platformMessageId:'bot1'});
 store.enqueue({roomId:'room',text:'not confirmed'},{id:'pending'});
 const read=store.routerContextReader('room','room:current',3);
 store.enqueue({roomId:'room',text:'later'},{id:'later',status:'sent',sentAt:1,platformMessageId:'bot2'});
 const row=store.outbox().find(x=>x.id==='pending')!;row.status='sent';row.sentAt=4;store.saveOutbox(row);
 expect((await read({kind:'replies'})).replies?.map(r=>r.text)).toEqual(['confirmed']);
});
it('registers recalled task/context IDs for this turn without making historical messages actionable',async()=>{
 const {store,old,request}=fixture();const thread=store.createThread(old,'old comparison',true);
 const recall=createRouterRecall(request,store.routerContextReader('room','room:current',3));
 await recall.tool.execute({kind:'threads',id:thread.id});await recall.tool.execute({kind:'messages',id:old.id});
 const action={action:'append_thread',threadId:thread.id,sourceMessageIds:['room:current'],contextMessageIds:[old.id]};
 expect(parseRoutesForRequest(JSON.stringify([action]),request)).toEqual([action]);
 expect(()=>parseRoutesForRequest(JSON.stringify([{...action,sourceMessageIds:[old.id]}]),request)).toThrow('source messages');
 expect(recall.repairContext().threads?.[0].id).toBe(thread.id);
});
it('reads persistent memory as hints and requires a separate original read to authorize context IDs',async()=>{
 const {store,old,request}=fixture(),batch=store.roomMemory.batch('room',1);
 store.roomMemory.commit({...batch,notes:[{id:'budget',authorId:old.authorId,text:'预算20元；'+'条件'.repeat(700),sourceSeqs:[batch.events[0].seq]}]});
 const recall=createRouterRecall(request,store.routerContextReader('room','room:current',3));
 const shown=await recall.tool.execute({kind:'memory',id:'budget'}) as any;
 expect(shown.memories[0]).toMatchObject({id:'budget',textTruncated:true,nextTextOffset:1200,sources:[{seq:1,kind:'message',id:old.id,authorId:old.authorId}]});
 expect(request.recentMessages).toEqual([]);expect(request.threads).toEqual([]);expect(request.recentReplies).toEqual([]);
 expect(recall.repairContext().memories?.[0].id).toBe('budget');
 const action={action:'open_thread',sourceMessageIds:['room:current'],contextMessageIds:[old.id],subject:'按记忆继续'};
 expect(()=>parseRoutesForRequest(JSON.stringify([action]),request)).toThrow('context outside supplied source scope');
 await recall.tool.execute({kind:'messages',id:old.id});
 expect(parseRoutesForRequest(JSON.stringify([action]),request)).toEqual([action]);
 expect(()=>parseRoutesForRequest(JSON.stringify([{action:'silence',sourceMessageIds:[old.id]}]),request)).toThrow('source messages');
});
it('keeps image ownership checks after recall and never exposes image locators',async()=>{
 const store=new Store(':memory:');stores.push(store);const old={...message('old','picture'),authorId:'other',attachments:[{kind:'image' as const,url:'https://private.invalid/secret',file:'/private/file.png'}]};
 store.ingest(old,1);const current=message('now','分析我的文档');store.ingest(current,2);
 const request:RouterRequest={roomId:'room',event:'messages',messages:[current],recentMessages:[],threads:[]};
 const recall=createRouterRecall(request,store.routerContextReader('room',current.id));
 const shown=await recall.tool.execute({kind:'messages',id:old.id});expect(JSON.stringify(shown)).not.toContain('private');
 expect(()=>parseRoutesForRequest(JSON.stringify([{action:'open_thread',sourceMessageIds:[current.id],subject:'分析',contextMessageIds:[old.id]}]),request)).toThrow('Image context');
});
it('bounds calls, validates query arguments and supports text continuation',async()=>{
 const {store,request}=fixture();const long=message('long','中文'.repeat(3000));
 store.db.prepare('UPDATE messages SET data=? WHERE id=?').run(JSON.stringify({...long,id:'room:old',messageId:'old'}),'room:old');
 const recall=createRouterRecall(request,store.routerContextReader('room','room:current'));
 const a=await recall.tool.execute({kind:'messages',id:'old'}) as any;expect(a.messages[0]).toMatchObject({textTruncated:true,nextTextOffset:1200,totalCharacters:6000});
 const b=await recall.tool.execute({kind:'messages',id:'old',textOffset:1200}) as any;expect(b.messages[0].text).toBe(long.text.slice(1200,2400));
 await expect(recall.tool.execute({kind:'messages',roomId:'other'})).rejects.toThrow();
 await recall.tool.execute({kind:'messages'});await recall.tool.execute({kind:'messages'});
 await expect(recall.tool.execute({kind:'messages'})).rejects.toThrow('budget');
});
it('keeps repair context bounded after four maximal pages and threads have lossless shared offsets',async()=>{
 const {request}=fixture();
 const lookup=async({offset=0}:any)=>({messages:Array.from({length:4},(_,i)=>message('old-'+(offset+i),'long'.repeat(1000))),hasMore:true,nextOffset:offset+4});
 const recall=createRouterRecall(request,lookup);
 for(let offset=0;offset<16;offset+=4)await recall.tool.execute({kind:'messages',offset});
 expect(JSON.stringify(recall.repairContext()).length).toBeLessThan(16000);expect(recall.repairContext().messages).toHaveLength(16);
 const {store,old}=fixture();const thread=store.createThread(old,'S'.repeat(1400),true);thread.summary='A'.repeat(700);store.saveThread(thread);
 const pages=createRouterRecall({...request,threads:[]},store.routerContextReader('room','room:current'));
 const first=await pages.tool.execute({kind:'threads',id:thread.id}) as any;
 const second=await pages.tool.execute({kind:'threads',id:thread.id,textOffset:first.threads[0].nextTextOffset}) as any;
 const third=await pages.tool.execute({kind:'threads',id:thread.id,textOffset:second.threads[0].nextTextOffset}) as any;
 expect([first,second,third].map(p=>p.threads[0].subject).join('')).toBe(thread.subject);
 expect([first,second,third].map(p=>p.threads[0].summary).join('')).toBe(thread.summary);
});
it('requires complete paged evidence before an executable decision and allows clarification',async()=>{
 const {request}=fixture(),old=message('long','前提'.repeat(1200)+'最终更正：预算五元');
 const recall=createRouterRecall(request,async()=>({messages:[old],hasMore:false}));
 const action={action:'reply_direct' as const,sourceMessageIds:[request.messages[0].id],text:'按条件执行'};
 await recall.tool.execute({kind:'messages',id:old.id});expect(()=>recall.assertComplete([action])).toThrow('unread');
 expect(()=>recall.assertComplete([{...action,action:'clarify'}])).not.toThrow();
 await recall.tool.execute({kind:'messages',id:old.id,textOffset:1200});await recall.tool.execute({kind:'messages',id:old.id,textOffset:2400});expect(()=>recall.assertComplete([action])).not.toThrow();
});

it('allows an independent new task after truncated candidate cards, but fully reads the selected target',async()=>{
 const {store,old,request}=fixture();
 const selected=store.createThread(old,'document comparison',true);selected.summary='A'.repeat(700);store.saveThread(selected);
 const other=store.createThread(message('other','other document'),'other comparison',true);other.summary='B'.repeat(900);store.saveThread(other);
 const recall=createRouterRecall(request,async query=>({threads:query.id===selected.id?[selected]:[selected,other],hasMore:false}));
 await recall.tool.execute({kind:'threads',query:'comparison'});
 const open={action:'open_thread' as const,sourceMessageIds:['room:current'],subject:'independent analysis'};
 expect(()=>recall.assertComplete([open])).not.toThrow();
 const append={action:'append_thread' as const,threadId:selected.id,sourceMessageIds:['room:current']};
 expect(()=>recall.assertComplete([append])).toThrow('unread');
 expect(()=>recall.assertComplete([{action:'reply_direct',sourceMessageIds:['room:current'],text:'answer'}])).toThrow('unread');
 await recall.tool.execute({kind:'threads',id:selected.id,textOffset:500});
 expect(()=>recall.assertComplete([append])).not.toThrow();
});

it('requires full selected cards after quote binding while allowing unrelated candidate previews',async()=>{
 const {store,old,request}=fixture();const target=store.createThread(old,'selected document',true);target.summary='A'.repeat(700);store.saveThread(target);
 const other={...target,id:'other-task',summary:'B'.repeat(1400)};
 const recall=createRouterRecall(request,async query=>({threads:query.id===target.id?[target]:[target,other],hasMore:false}));
 await recall.tool.execute({kind:'threads',query:'document'});
 request.references={['room:current']:{status:'resolved',threadId:target.id,message:old,chain:[old.messageId]}};
 const open={action:'open_thread' as const,sourceMessageIds:['room:current'],subject:'continue quoted document'};
 expect(()=>recall.assertComplete([open])).toThrow('unread');
 await recall.tool.execute({kind:'threads',id:target.id,textOffset:500});
 expect(()=>recall.assertComplete([open])).not.toThrow();
});

it('requires missing original task conditions for a continuation and complete quoted message text',async()=>{
 const {request}=fixture(),old=message('long','condition '.repeat(150));
 request.taskStates=[{threadId:'selected',revision:1,epoch:1,updates:[],needsRecall:true,throughInputSeq:1,nextInputSeq:1}];
 const recall=createRouterRecall(request,async query=>query.kind==='task_inputs'
   ?{taskInputs:[{threadId:'selected',seq:1,revision:1,kind:'supplement',message:old}],hasMore:false}
   :{messages:[old],hasMore:false});
 const append={action:'append_thread' as const,threadId:'selected',sourceMessageIds:['room:current']};
 expect(()=>recall.assertComplete([append])).toThrow('original input');
 await recall.tool.execute({kind:'task_inputs',id:'selected'});
 expect(()=>recall.assertComplete([append])).toThrow('unread');
 await recall.tool.execute({kind:'task_inputs',id:'selected',textOffset:1200});
 expect(()=>recall.assertComplete([append])).not.toThrow();
 await recall.tool.execute({kind:'messages',id:old.id});
 expect(()=>recall.assertComplete([{action:'open_thread',sourceMessageIds:['room:current'],subject:'analysis',contextMessageIds:[old.id]}])).toThrow('unread');
});
