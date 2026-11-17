import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { prepareWorkerContext, WORKER_CONTEXT_CHARS, type WorkerContext } from '../src/runtime/worker-context.js';
import type { ThreadInput, WorkerRequest } from '../src/types.js';

const dirs:string[]=[];
afterEach(async()=>{await Promise.all(dirs.splice(0).map(dir=>rm(dir,{recursive:true,force:true})));});
function input(seq:number,text:string,authorId='owner',kind:ThreadInput['kind']='supplement'):ThreadInput {
  return {seq,revision:seq,kind,message:{id:`room:${seq}`,messageId:String(seq),roomId:'room',authorId,authorName:authorId,
    platform:'replay',text,timestamp:seq,mentions:[],attachments:[],isMentioned:true,isAdmin:false}};
}
function request(inputs:ThreadInput[],workspace='/unused'):WorkerRequest {
  return {runId:'r-current',workspace,thread:{id:'t-test',roomId:'room',subject:'成员方案需求',ownerId:'owner',sourceMessageId:'1',
    explicit:true,participants:['owner','other'],status:'running',revision:inputs.at(-1)?.revision??1,latestInputSeq:inputs.at(-1)?.seq??1,
    sessionId:'worker-test',epoch:1,summary:'older answer'},inputs};
}
async function context(inputs:ThreadInput[]){return prepareWorkerContext(request(inputs),{persist:false});}
async function call(context:WorkerContext,args:unknown){return await context.tools[0].execute(args) as any;}

describe('bounded Worker context with attributed original recall',()=>{
  it('preserves all short inputs and explicit context while removing attachment locators',async()=>{
    const own=input(1,'预算20元','owner','question');own.message.attachments=[{kind:'image',url:'data:image/png;base64,SECRET_IMAGE',file:'/private/image.png'}];
    const second=input(2,'比较这个','other');second.contextMessages=[own.message];second.contextReplies=[{messageId:'bot:1',text:'原始回答',sentAt:1}];
    const prepared=await context([own,second]);
    expect(prepared.snapshot).toMatchObject({mode:'complete',totalInputs:2,omittedInputs:0,inlineSeqs:[1,2],requiredReads:[]});
    expect(prepared.inputs[1]).toMatchObject({message:{authorId:'other'},contextMessages:[{authorId:'owner',text:'预算20元'}],contextReplies:[{text:'原始回答'}]});
    expect(JSON.stringify(prepared.inputs)).not.toContain('SECRET_IMAGE');expect(JSON.stringify(prepared.inputs)).not.toContain('/private/');
    expect(prepared.selectedInputs[0].message.attachments[0].url).toContain('SECRET_IMAGE');
    expect(prepared.unreadCurrentInputs()).toEqual([]);expect(()=>prepared.assertReady({status:'ready'})).not.toThrow();
    const scan=await call(prepared,{operation:'scan'});
    expect(scan.records.find((row:any)=>row.part==='context_reply')).toMatchObject({sourceRole:'bot',inputAuthorId:'other'});
    expect(scan.records.find((row:any)=>row.part==='context_reply').authorId).toBeUndefined();
    expect(scan.records.find((row:any)=>row.part==='context_message')).toMatchObject({sourceRole:'user',authorId:'owner',inputAuthorId:'other'});
  });
  it('bounds large histories while making an omitted old budget and later correction recoverable',async()=>{
    const inputs=Array.from({length:120},(_,index)=>input(index+1,`原始材料 ${index+1} ${'背景细节。'.repeat(800)}`));
    inputs[18]=input(19,'预算20元。键盘保持原物品，禁止替换。');
    inputs[100]=input(101,'预算改成15元，但键盘不变。','owner','correction');
    inputs[119]=input(120,'按刚才更正后的预算继续');
    inputs[119].routingContext={resolvedRequest:'按成员 owner 最新预算继续优化方案，保留原键盘',sourceMessageIds:['room:120'],routingMetadata:{'test-calculation':{required:false}}};
    const prepared=await context(inputs);
    expect(JSON.stringify({inputs:prepared.inputs,snapshot:prepared.snapshot}).length).toBeLessThanOrEqual(WORKER_CONTEXT_CHARS);
    expect(prepared.snapshot).toMatchObject({mode:'bounded',totalInputs:120,currentInterpretations:[{authorId:'owner',seq:120}]});
    const old=await call(prepared,{operation:'search',query:'预算20元'});
    expect(old.records[0]).toMatchObject({seq:19,authorId:'owner',match:{part:'message',text:expect.stringContaining('键盘保持原物品')}});
    const correction=await call(prepared,{operation:'search',query:'预算改成'});
    expect(correction.records[0]).toMatchObject({seq:101,kind:'correction',authorId:'owner'});
    expect(await call(prepared,{operation:'read',seq:101})).toMatchObject({text:'预算改成15元，但键盘不变。',nextOffset:null});
    expect(prepared.snapshot.instruction).toContain('未被新原文明示更正或撤销');
    expect(()=>prepared.assertReady({status:'ready'})).toThrow('remains unread');
    // Merely seeing a search excerpt does not cover omitted text or corrections.
    expect(prepared.unreadCurrentInputs().some(part=>part.seq===101)).toBe(false);
    expect(prepared.unreadCurrentInputs().length).toBeGreaterThan(0);
  });
  it('keeps separate authors and exact quote ownership in metadata and read results',async()=>{
    const inputs=Array.from({length:30},(_,index)=>input(index+1,'填充'.repeat(2000),index%2?'other':'owner'));
    inputs[0]=input(1,'我的预算10元','owner','question');inputs[1]=input(2,'我的预算100元','other','question');
    inputs[29]=input(30,'按我的100元继续','other');inputs[29].contextMessages=[inputs[0].message];
    const prepared=await context(inputs);
    expect((prepared.snapshot.currentInterpretations as any[]).map(row=>row.authorId)).toEqual(['other','owner']);
    const list=await call(prepared,{operation:'list',authorId:'owner',limit:2});
    expect(list.records.map((row:any)=>row.authorId)).toEqual(['owner','owner']);expect(list.nextAfterSeq).toBe(3);
    expect(await call(prepared,{operation:'read',seq:30,part:'context_message',index:0})).toMatchObject({authorId:'owner',messageId:'room:1',text:'我的预算10元'});
  });
  it('pages a huge current message without losing tail conditions or faking read coverage',async()=>{
    const text='长输入。'.repeat(45_000)+'最终预算7元，必须交付报告链接';
    const prepared=await context([input(1,text,'owner','question')]);
    expect(prepared.snapshot.mode).toBe('bounded');expect(JSON.stringify({inputs:prepared.inputs,snapshot:prepared.snapshot}).length).toBeLessThanOrEqual(WORKER_CONTEXT_CHARS);
    expect(()=>prepared.assertReady({status:'ready'})).toThrow('remains unread');
    expect(()=>prepared.assertReady({status:'needs_input'})).not.toThrow();
    const first=prepared.unreadCurrentInputs()[0];
    await call(prepared,{operation:'read',seq:1,offset:text.length-100});
    expect(prepared.unreadCurrentInputs()[0].offset).toBe(first.offset);
    const chunks=[text.slice(0,first.offset)];let offset=first.offset;
    while(offset<text.length){const result=await call(prepared,{operation:'read',seq:1,offset});chunks.push(result.text);offset=result.nextOffset??text.length;}
    expect(chunks.join('')).toBe(text);expect(prepared.unreadCurrentInputs()).toEqual([]);expect(()=>prepared.assertReady({status:'ready'})).not.toThrow();
  });
  it('requires reading truncated current quoted evidence and correction metadata too',async()=>{
    const latest=input(2,'看这个更正','owner','correction');latest.contextMessages=[input(1,'图中原文'.repeat(3000),'other').message];
    latest.routingContext={resolvedRequest:'解释'.repeat(20_000),correctionTarget:'旧版本'.repeat(10_000),sourceMessageIds:['room:2']};
    const prepared=await context([latest]);
    expect(prepared.unreadCurrentInputs().map(row=>row.part).sort()).toEqual(['context_message','correction_target','resolved_request']);
    for(const part of prepared.unreadCurrentInputs()){
      let offset=part.offset;
      while(offset<part.totalCharacters){const result=await call(prepared,{operation:'read',seq:part.seq,part:part.part,index:part.index,offset});offset=result.nextOffset??part.totalCharacters;}
    }
    expect(prepared.unreadCurrentInputs()).toEqual([]);
  });
  it('binds recall to the initial run and rejects cross-task, future and cancelled reads',async()=>{
    const inputs=[input(1,'original')],req=request(inputs),abort=new AbortController();req.signal=abort.signal;
    const prepared=await prepareWorkerContext(req,{persist:false});
    inputs[0].message.text='mutated';inputs.push(input(2,'future'));
    expect(await call(prepared,{operation:'read',seq:1})).toMatchObject({threadId:'t-test',runId:'r-current',throughInputSeq:1,text:'original'});
    await expect(call(prepared,{operation:'read',seq:2})).rejects.toThrow('outside');
    await expect(call(prepared,{operation:'read',seq:1,threadId:'foreign'})).rejects.toThrow('Unsupported');
    abort.abort();await expect(call(prepared,{operation:'list'})).rejects.toThrow();
    const another=await context([input(1,'one')]);another.close();await expect(call(another,{operation:'list'})).rejects.toThrow('closed');
    const foreign=input(1,'foreign');foreign.message.roomId='foreign';await expect(context([foreign])).rejects.toThrow('room scope');
  });
  it('paginates stable list and search cursors and rejects unbounded parameters',async()=>{
    const prepared=await context(Array.from({length:25},(_,index)=>input(index+1,'预算'+index)));
    const all:number[]=[];let cursor=0;
    for(;;){const page=await call(prepared,{operation:'search',query:'预算',afterSeq:cursor,limit:6});all.push(...page.records.map((row:any)=>row.seq));if(page.nextAfterSeq===null)break;cursor=page.nextAfterSeq;}
    expect(all).toEqual(Array.from({length:25},(_,index)=>index+1));
    for(const args of [{operation:'read',seq:1,offset:-1},{operation:'read',seq:1,limit:100_000},{operation:'list',limit:1000},{operation:'search',query:''},{operation:'read',seq:1,part:'unknown'}])await expect(call(prepared,args)).rejects.toThrow();
  });
  it('persists a bounded inspectable snapshot and a stable digest without media bytes',async()=>{
    const workspace=await mkdtemp(join(tmpdir(),'boe2-worker-context-'));dirs.push(workspace);
    const data=input(1,'budget 20元');data.message.attachments=[{kind:'image',url:'data:image/png;base64,private'}];
    const prepared=await prepareWorkerContext(request([data],workspace));
    const snapshotFile=join(workspace,'.worker-input-snapshots',createHash('sha256').update('r-current').digest('hex')+'.json');
    const disk=JSON.parse(await readFile(snapshotFile,'utf8'));
    expect(disk).toEqual({inputs:prepared.inputs,snapshot:prepared.snapshot});expect(JSON.stringify(disk)).not.toContain('base64');
    const second=await context([data]);expect(second.snapshot.inputDigest).toBe(prepared.snapshot.inputDigest);
    data.message.text='budget 5元';expect((await context([data])).snapshot.inputDigest).not.toBe(prepared.snapshot.inputDigest);
    await expect(prepareWorkerContext(request([data],workspace))).rejects.toThrow('different Worker input snapshot');
    await expect(prepareWorkerContext({...request([data],workspace),runId:'other-run'})).resolves.toBeDefined();
  });
  it('requires middle corrections and consumes long history through bounded scan pages',async()=>{
    const inputs=Array.from({length:130},(_,index)=>input(index+1,'约束'.repeat(1000)));
    inputs[0]=input(1,'预算10元','owner','question');inputs[19]=input(20,'预算改5元，其他条件不变','owner','correction');inputs[129]=input(130,'继续');
    const prepared=await context(inputs);
    expect(prepared.unreadCurrentInputs().some(part=>part.seq===20)).toBe(true);
    expect(()=>prepared.validateCandidateState({byAuthor:[{authorId:'owner',text:'预算10元',sourceSeqs:[1,130]}]})).toThrow('unread');
    let cursor:Record<string,unknown>={afterSeq:0},pages=0;const observed:any[]=[];
    for(;;){const page=await call(prepared,{operation:'scan',...cursor});expect(JSON.stringify(page).length).toBeLessThanOrEqual(32_000);pages++;observed.push(...page.records);if(!page.nextCursor)break;cursor=page.nextCursor;}
    expect(pages).toBeLessThan(20);expect(observed.some(row=>row.seq===20&&row.text==='预算改5元，其他条件不变')).toBe(true);
    expect(prepared.unreadCurrentInputs()).toEqual([]);
    const checkpoint=prepared.validateCandidateState({byAuthor:[{authorId:'owner',text:'预算5元；其余未撤销条件保持',sourceSeqs:[20,130]}]});
    const next=await prepareWorkerContext(request([...inputs,input(131,'键盘不要替换')]),{persist:false,previousSnapshot:checkpoint});
    expect(next.snapshot.mode).toBe('incremental');expect(next.inputs).toHaveLength(1);expect(next.snapshot.previousSnapshot).toEqual(checkpoint);
    expect(next.unreadCurrentInputs()).toEqual([]);expect(JSON.stringify({inputs:next.inputs,snapshot:next.snapshot}).length).toBeLessThan(6000);
    const changed=structuredClone(inputs);changed[19].message.text='tampered';
    await expect(prepareWorkerContext(request([...changed,input(131,'继续')]),{persist:false,previousSnapshot:checkpoint})).rejects.toThrow('checkpoint');
  });
  it('validates checkpoint author coverage and requires current source provenance',async()=>{
    const prepared=await context([input(1,'10元','owner'),input(2,'100元','other'),input(3,'5元','owner','correction')]);
    for(const byAuthor of [
      [{authorId:'owner',text:'5元',sourceSeqs:[3]}],
      [{authorId:'owner',text:'10元',sourceSeqs:[1]},{authorId:'other',text:'100元',sourceSeqs:[2]}],
      [{authorId:'owner',text:'5元',sourceSeqs:[2,3]},{authorId:'other',text:'100元',sourceSeqs:[2]}],
      [{authorId:'owner',text:'5元',sourceSeqs:[3]},{authorId:'foreign',text:'100元',sourceSeqs:[2]}],
    ])expect(()=>prepared.validateCandidateState({byAuthor})).toThrow();
    expect(prepared.validateCandidateState({byAuthor:[{authorId:'owner',text:'5元',sourceSeqs:[3]},{authorId:'other',text:'100元',sourceSeqs:[2]}]})).toMatchObject({throughInputSeq:3,revision:3,inputDigest:expect.stringMatching(/^[a-f0-9]{64}$/)});
  });
  it('accounts for escaped JSON when paging and never marks missing text as read',async()=>{
    const content='\u0000\n"\\'.repeat(30_000),prepared=await context([input(1,content)]);
    let cursor:Record<string,unknown>={afterSeq:0};const text:string[]=[];
    for(;;){const page=await call(prepared,{operation:'scan',...cursor});expect(JSON.stringify(page).length).toBeLessThanOrEqual(32_000);text.push(...page.records.map((row:any)=>row.text));if(!page.nextCursor)break;cursor=page.nextCursor;}
    expect(text.join('')).toBe(content);expect(prepared.unreadCurrentInputs()).toEqual([]);
  });
});
