import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '../src/store.js';
import type { BotReply, GroupMessage } from '../src/types.js';

const cleanup:Array<()=>void>=[];
afterEach(()=>{for(const fn of cleanup.splice(0).reverse())fn();});
function fixture(path=':memory:') { const store=new Store(path);cleanup.push(()=>store.close());return store; }
function message(id:string,overrides:Partial<GroupMessage>={}):GroupMessage {
  return {id:'room:'+id,platform:'replay',roomId:'room',messageId:id,authorId:'author',authorName:'作者',text:'原始文本 '+id,
    timestamp:100,mentions:[],attachments:[],isMentioned:true,isAdmin:false,...overrides};
}
function ingest(store:Store,id:string,overrides:Partial<GroupMessage>={}) {const m=message(id,overrides);store.ingest(m,m.timestamp);return m;}

describe('durable reference association',()=>{
  it('adds host intake timestamps to an old schema without changing historical messages',()=>{
    const directory=mkdtempSync(join(tmpdir(),'boe2-reference-migrate-'));
    cleanup.push(()=>rmSync(directory,{recursive:true,force:true}));
    const path=join(directory,'state.sqlite'),legacy=new DatabaseSync(path),original=message('legacy');
    legacy.exec("CREATE TABLE messages(id TEXT PRIMARY KEY,room TEXT NOT NULL,at INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,data TEXT NOT NULL)");
    legacy.prepare('INSERT INTO messages(id,room,at,data) VALUES(?,?,?,?)').run(original.id,original.roomId,original.timestamp,JSON.stringify(original));
    legacy.close();
    const store=fixture(path),thread=store.createThread(original,'旧数据',true),quote=ingest(store,'quote',{replyToMessageId:'legacy',timestamp:200});
    expect(store.message(original.id)).toEqual(original);
    expect(store.db.prepare('SELECT received_at FROM messages WHERE id=?').get(original.id)).toEqual({received_at:null});
    expect(store.resolveReference(quote,200)).toMatchObject({status:'resolved',threadId:thread.id,message:original});
    const reopened=fixture(path);
    expect(reopened.resolveReference(quote,200)).toMatchObject({status:'resolved',threadId:thread.id});
  });

  it('preserves the quoted original and resolves an old cancelled thread across authors',()=>{
    const store=fixture(),original=ingest(store,'question');
    const thread=store.createThread(original,'旧任务',true);thread.status='cancelled';store.saveThread(thread);
    for(let i=0;i<20;i++)store.createThread(ingest(store,'other-'+i),'近期任务',true);
    const followup=ingest(store,'followup',{replyToMessageId:'question',authorId:'different-author',timestamp:300});
    expect(store.resolveReference(followup,300)).toEqual({status:'resolved',threadId:thread.id,message:original,chain:['question']});
    expect(store.thread(thread.id)).toMatchObject({ownerId:'author',status:'cancelled',revision:1,latestInputSeq:1});
  });

  it('keeps text and images for an unbound original without fabricating a thread',()=>{
    const store=fixture(),original=ingest(store,'unbound',{attachments:[{kind:'image',file:'question.png'}]});
    const quote=ingest(store,'quote',{replyToMessageId:'unbound',timestamp:200});
    expect(store.resolveReference(quote,200)).toEqual({status:'unbound',message:original,chain:['unbound']});
    expect(store.resolveReference(original,200)).toEqual({status:'none',chain:[]});
  });

  it('persists silent-message bindings and attributed Worker context through reopening',()=>{
    const directory=mkdtempSync(join(tmpdir(),'boe2-reference-'));
    cleanup.push(()=>rmSync(directory,{recursive:true,force:true}));
    const path=join(directory,'state.sqlite'),store=fixture(path),original=ingest(store,'question');
    const reply:BotReply={messageId:'bot',text:'第4题具体题目',sentAt:90};
    const routingContext={resolvedRequest:'解释第4题',sourceMessageIds:[original.id],contextReplyIds:['bot'],correctionTarget:'上一轮解释'};
    const thread=store.createThread(original,'第4题',true,undefined,{contextReplies:[reply],routingContext});
    const thanks=ingest(store,'thanks',{replyToMessageId:'question',timestamp:200});
    expect(store.bindMessageThread(thanks,thread.id)).toBe('bound');
    expect(store.bindMessageThread(thanks,thread.id)).toBe('existing');
    const next=ingest(store,'next',{replyToMessageId:'thanks',timestamp:300});
    const reopened=fixture(path);
    expect(reopened.resolveReference(next,300)).toMatchObject({status:'resolved',threadId:thread.id,message:thanks});
    expect(reopened.inputs(thread.id)[0]).toMatchObject({contextReplies:[reply],routingContext});
    expect(reopened.inputs(thread.id)).toHaveLength(1);
  });

  it('resolves confirmed answers, acknowledgements and control replies independently from stale suppression metadata',()=>{
    const store=fixture(),thread=store.createThread(ingest(store,'question'),'任务',true);
    for(const kind of ['answer','ack','control']){
      const id=store.enqueue({roomId:'room',text:kind,replyToMessageId:'question'},kind==='control'
        ?{associationThreadId:thread.id}:{threadId:thread.id,revision:1,epoch:0,...(kind==='ack'?{kind:'acknowledgement' as const}:{})});
      const row=store.outbox().find(item=>item.id===id)!;
      row.status='sent';row.platformMessageId=kind;row.sentAt=200;store.saveOutbox(row);
      if(kind==='control')expect(row.threadId).toBeUndefined();
      const next=ingest(store,'quote-'+kind,{replyToMessageId:kind,timestamp:300});
      expect(store.resolveReference(next,300)).toMatchObject({status:'resolved',threadId:thread.id,
        reply:{messageId:kind,text:kind,sentAt:200,replyToMessageId:'question'}});
    }
  });

  it('does not use unknown, missing-time, future, foreign or later-intake originals',()=>{
    const store=fixture(),thread=store.createThread(ingest(store,'question'),'任务',true);
    for(const [id,status,sentAt] of [['unknown','unknown',150],['pending','pending',150],['future','sent',350],['legacy-no-time','sent',undefined]] as const)
      store.enqueue({roomId:'room',text:id},{status,platformMessageId:id,sentAt,threadId:thread.id});
    store.enqueue({roomId:'other',text:'foreign'},{status:'sent',platformMessageId:'foreign',sentAt:150});
    ingest(store,'other-human',{id:'other:foreign-human',roomId:'other',messageId:'foreign-human'});
    for(const target of ['unknown','pending','future','legacy-no-time','foreign','foreign-human','missing']) {
      const quote=ingest(store,'quote-'+target,{replyToMessageId:target,timestamp:300});
      expect(store.resolveReference(quote,300).status).toBe('missing');
    }
    const early=ingest(store,'early',{replyToMessageId:'later',timestamp:300});
    const later=ingest(store,'later',{timestamp:100});store.append(thread,later,'supplement');
    expect(store.resolveReference(early,300).status).toBe('missing');
  });

  it('follows legacy unbound quote chains and inputs without losing the directly quoted text',()=>{
    const store=fixture(),original=ingest(store,'original',{timestamp:10}),thread=store.createThread(original,'旧任务',true);
    const intermediate=ingest(store,'intermediate',{replyToMessageId:'original',timestamp:20});
    const quote=ingest(store,'quote',{replyToMessageId:'intermediate',timestamp:30});
    store.db.prepare('DELETE FROM message_thread_bindings').run();
    expect(store.resolveReference(quote,30)).toEqual({status:'resolved',threadId:thread.id,message:intermediate,chain:['intermediate','original']});
  });

  it('uses legacy sent reply metadata and follows a reply back to its input when metadata is absent',()=>{
    const store=fixture(),original=ingest(store,'original',{timestamp:10}),thread=store.createThread(original,'旧任务',true);
    store.enqueue({roomId:'room',text:'旧答案'},{status:'sent',platformMessageId:'legacy-answer',sentAt:20,threadId:thread.id});
    store.enqueue({roomId:'room',text:'旧控制回复',replyToMessageId:'original'},{status:'sent',platformMessageId:'legacy-control',sentAt:20});
    store.db.prepare('DELETE FROM message_thread_bindings').run();
    for(const target of ['legacy-answer','legacy-control']) {
      const quote=ingest(store,'quote-'+target,{replyToMessageId:target,timestamp:30});
      expect(store.resolveReference(quote,30)).toMatchObject({status:'resolved',threadId:thread.id,reply:{messageId:target}});
    }
  });

  it('binds an unbound bot original when its quote creates a task without adding stale suppression metadata',()=>{
    const store=fixture();
    store.enqueue({roomId:'room',text:'未关联的讨论'},{id:'unbound-bot',status:'sent',platformMessageId:'bot',sentAt:10});
    const quote=ingest(store,'quote',{replyToMessageId:'bot',timestamp:20}),thread=store.createThread(quote,'继续讨论',true);
    expect(store.bindReferencedThread(quote,thread.id,20)).toBe('bound');
    const next=ingest(store,'next',{replyToMessageId:'bot',timestamp:30});
    expect(store.resolveReference(next,30)).toMatchObject({status:'resolved',threadId:thread.id});
    expect(store.outbox()[0]).not.toHaveProperty('threadId');
    expect(store.outbox()[0]).not.toHaveProperty('associationThreadId');
  });

  it('uses host intake times through legacy chains despite second-precision platform times',()=>{
    const store=fixture(),original=message('original',{timestamp:1000});store.ingest(original,1010);
    const thread=store.createThread(original,'原任务',true);
    store.enqueue({roomId:'room',text:'已发送',replyToMessageId:'original'},
      {status:'sent',platformMessageId:'bot',sentAt:1100,threadId:thread.id});
    const middle=message('middle',{replyToMessageId:'bot',timestamp:1000});store.ingest(middle,1200);
    const quote=message('quote',{replyToMessageId:'middle',timestamp:1000});store.ingest(quote,1300);
    expect(store.resolveReference(quote,1500)).toMatchObject({status:'resolved',threadId:thread.id,chain:['middle','bot']});
    const tooEarly=message('too-early',{replyToMessageId:'later-bot',timestamp:1000});store.ingest(tooEarly,1250);
    store.enqueue({roomId:'room',text:'接收之后才投递'},{status:'sent',platformMessageId:'later-bot',sentAt:1400,threadId:thread.id});
    expect(store.resolveReference(tooEarly,1500).status).toBe('missing');
  });

  it('retains the first association and marks conflicting legacy or new thread bindings ambiguous',()=>{
    const store=fixture(),original=ingest(store,'original'),first=store.createThread(original,'第一个',true);
    const second=store.createThread(ingest(store,'second'),'第二个',true);
    expect(store.bindMessageThread(original,second.id)).toBe('conflict');
    expect(store.bindMessageThread(original,first.id)).toBe('conflict');
    expect(store.db.prepare('SELECT thread_id,conflict FROM message_thread_bindings WHERE room=? AND message_id=?').get('room','original'))
      .toMatchObject({thread_id:first.id,conflict:1});
    const quote=ingest(store,'quote',{replyToMessageId:'original',timestamp:200});
    expect(store.resolveReference(quote,200).status).toBe('ambiguous');
    store.append(second,original,'supplement');store.db.prepare('DELETE FROM message_thread_bindings').run();
    expect(store.resolveReference(quote,200).status).toBe('ambiguous');
  });

  it('rejects cross-room associations and never selects from conflicting outgoing records',()=>{
    const store=fixture(),thread=store.createThread(ingest(store,'original'),'本群',true);
    const foreign=ingest(store,'foreign',{id:'other:foreign',roomId:'other'});
    expect(()=>store.bindMessageThread(foreign,thread.id)).toThrow('room scope');
    expect(()=>store.append(thread,foreign,'supplement')).toThrow('room scope');
    store.enqueue({roomId:'room',text:'第一份文本'},{status:'sent',platformMessageId:'duplicate',sentAt:100,threadId:thread.id});
    store.enqueue({roomId:'room',text:'不同的文本'},{status:'sent',platformMessageId:'duplicate',sentAt:100,threadId:thread.id});
    const quote=ingest(store,'quote',{replyToMessageId:'duplicate',timestamp:200});
    expect(store.resolveReference(quote,200).status).toBe('ambiguous');
  });

  it('does not turn an ignored duplicate outbox insert into a confirmed association',()=>{
    const store=fixture(),thread=store.createThread(ingest(store,'original'),'任务',true);
    store.enqueue({roomId:'room',text:'尚未确认'},{id:'deduplicated'});
    store.enqueue({roomId:'room',text:'伪重复确认'},{id:'deduplicated',status:'sent',platformMessageId:'not-sent',sentAt:100,threadId:thread.id});
    const quote=ingest(store,'quote',{replyToMessageId:'not-sent',timestamp:200});
    expect(store.resolveReference(quote,200).status).toBe('missing');
    expect(store.db.prepare('SELECT 1 FROM message_thread_bindings WHERE room=? AND message_id=?').get('room','not-sent')).toBeUndefined();
  });

  it('bounds recursive legacy lookup and detects reply cycles',()=>{
    const store=fixture();
    for(const [id,target] of [['cycle-a','cycle-b'],['cycle-b','cycle-a']])
      store.enqueue({roomId:'room',text:id,replyToMessageId:target},{status:'sent',platformMessageId:id,sentAt:10});
    const cyclic=ingest(store,'cyclic',{replyToMessageId:'cycle-a',timestamp:20});
    expect(store.resolveReference(cyclic,20)).toMatchObject({status:'cycle',chain:['cycle-a','cycle-b']});
    for(let i=0;i<20;i++)store.enqueue({roomId:'room',text:String(i),replyToMessageId:'chain-'+(i+1)},
      {status:'sent',platformMessageId:'chain-'+i,sentAt:10});
    const deep=ingest(store,'deep',{replyToMessageId:'chain-0',timestamp:20}),resolved=store.resolveReference(deep,20);
    expect(resolved.status).toBe('depth_limit');expect(resolved.chain).toHaveLength(16);
  });
});
