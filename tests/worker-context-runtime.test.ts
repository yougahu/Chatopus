import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LlmAdapter, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { DshRuntime } from '../src/dsh-runtime.js';
import { NativeAgentRuntime } from '../src/runtime/native.js';
import { loadConfig } from '../src/config.js';
import type { ThreadInput, WorkerRequest } from '../src/types.js';
import type { CapabilitySession as DomainSession } from '../src/capabilities.js';

const cleanup:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
function text(value:unknown):StreamChunk[]{
  const text=JSON.stringify(value);
  return [{type:'block-start',index:0,blockType:'text'},{type:'text-delta',index:0,text},
    {type:'block-end',index:0,block:{type:'text',text}},{type:'finish',reason:{kind:'stop'}}];
}
function tool(args:unknown,id:number):StreamChunk[]{return [{type:'block-start',index:0,blockType:'tool-call'},
  {type:'block-end',index:0,block:{type:'tool-call',id:ToolCallId(`recall-${id}`),name:'worker_input_history',arguments:JSON.stringify(args)}},
  {type:'finish',reason:{kind:'tool-calls'}}];}
function userPayload(call:GenerateOptions){
  for(const message of [...call.messages].reverse()){
    if(message.role!=='user')continue;
    try{const value=JSON.parse(message.content.filter(block=>block.type==='text').map(block=>block.text).join(''));if(value.inputSnapshot)return value;}catch{}
  }
  throw new Error('No current Worker input');
}
function latestScan(call:GenerateOptions,runId:string){
  for(const message of [...call.messages].reverse()){
    if(message.role!=='tool')continue;
    try{const value=JSON.parse(message.content.filter(block=>block.type==='text').map(block=>block.text).join(''));if(value.runId===runId&&Array.isArray(value.records)&&'nextCursor'in value)return value;}catch{}
  }
}
class Adapter extends LlmAdapter {
  requests:GenerateOptions[]=[];
  constructor(readonly respond:(call:GenerateOptions,index:number)=>StreamChunk[]){super();}
  async *stream(call:GenerateOptions):AsyncIterable<StreamChunk>{for(const chunk of this.respond(call,this.requests.push(call)-1))yield chunk;}
}
async function fixture(adapter:Adapter,domainOverrides:Partial<DomainSession>={}){
  const root=await mkdtemp(join(tmpdir(),'boe2-worker-context-runtime-'));cleanup.push(()=>rm(root,{recursive:true,force:true}));
  await mkdir(join(root,'personas'));await writeFile(join(root,'personas/default.md'),'# Test\n简短准确');
  const config=loadConfig(root,{stateDir:join(root,'state'),worker:{provider:'mock',model:'worker'},maxWorkerSteps:40});
  const native=await NativeAgentRuntime.create({root:join(root,'dsh'),adapters:{mock:adapter},compaction:false});
  const runtime=await DshRuntime.create(config,{native,capabilityFactory:async()=>({tools:[],systemContext:'Test domain',finalizeAnswer:async answer=>answer,close:async()=>{},...domainOverrides})});
  cleanup.push(()=>runtime.close());return {root,runtime};
}
function input(seq:number,text:string,kind:ThreadInput['kind']='supplement',authorId='owner'):ThreadInput {
  return {seq,revision:seq,kind,message:{id:`room:${seq}`,messageId:String(seq),roomId:'room',authorId,authorName:authorId,platform:'replay',text,timestamp:seq,mentions:[],attachments:[],isMentioned:true,isAdmin:false}};
}
function request(root:string,inputs:ThreadInput[],runId='r-first'):WorkerRequest {
  return {runId,workspace:join(root,runId),thread:{id:'t1',roomId:'room',subject:'方案预算',ownerId:'owner',sourceMessageId:'1',explicit:true,participants:['owner'],status:'running',revision:inputs.at(-1)!.revision,latestInputSeq:inputs.at(-1)!.seq,sessionId:'worker-t1',epoch:1,summary:''},inputs};
}
function report(payload:any,extra:Record<string,unknown>={}){return {threadId:payload.threadId,runId:payload.runId,coveredInputSeq:payload.latestInputSeq,basedOnRevision:payload.revision,status:'ready',shortAnswer:'预算5元，保留原键盘',assumptions:[],evidenceRefs:[],openQuestions:[],...extra};}
function longInputs(){
  const inputs=Array.from({length:90},(_,index)=>input(index+1,`原文 ${index+1}: ${'背景说明。'.repeat(420)}`));
  inputs[0]=input(1,'预算10元，保留原键盘','question');inputs[19]=input(20,'预算改为5元，键盘不变','correction');inputs[89]=input(90,'继续');return inputs;
}

describe('Worker context through real native tools and report validation',()=>{
  it('consumes an omitted correction, persists host-stamped state and supplies only the next delta',async()=>{
    let observedCorrection=false,scans=0;
    const adapter=new Adapter((call,index)=>{
      const payload=userPayload(call),page=latestScan(call,payload.runId);
      if(payload.runId==='r-first'){
        expect(payload.inputSnapshot.mode).toBe('bounded');
        if(page?.records.some((row:any)=>row.seq===20&&row.text.includes('预算改为5元')))observedCorrection=true;
        if(!page||page.nextCursor){scans++;return tool({operation:'scan',...(page?.nextCursor??{afterSeq:0})},index);}
        expect(observedCorrection).toBe(true);
        return text(report(payload,{requirementState:{byAuthor:[{authorId:'owner',text:'预算5元；保留原键盘',sourceSeqs:[1,20,90]}]}}));
      }
      expect(payload.inputSnapshot.mode).toBe('incremental');expect(payload.inputs).toHaveLength(1);expect(payload.inputs[0].seq).toBe(91);
      expect(payload.inputSnapshot.previousSnapshot.byAuthor[0].text).toBe('预算5元；保留原键盘');
      return text(report(payload,{requirementState:{byAuthor:[{authorId:'owner',text:'预算5元；保留原键盘；继续按该预算',sourceSeqs:[1,20,90,91]}]}}));
    });
    const {root,runtime}=await fixture(adapter),inputs=longInputs();
    expect(JSON.stringify(inputs).length).toBeGreaterThan(160_000);
    const first=await runtime.runWorker(request(root,inputs));
    expect(first).toMatchObject({status:'ready',requirementSnapshot:{throughInputSeq:90,revision:90,inputDigest:expect.stringMatching(/^[a-f0-9]{64}$/)}});
    expect(scans).toBeGreaterThan(1);expect(scans).toBeLessThan(15);
    const next=request(root,[...inputs,input(91,'继续按该预算')],'r-next');next.previousRequirementSnapshot=first.requirementSnapshot;
    const second=await runtime.runWorker(next);expect(second).toMatchObject({status:'ready',requirementSnapshot:{throughInputSeq:91}});
  });
  it('allows one coverage repair and then fails an unread ready report without asking for repeated user data',async()=>{
    const adapter=new Adapter(call=>text(report(userPayload(call),{shortAnswer:'错误预算10元',requirementState:{byAuthor:[{authorId:'owner',text:'预算10元',sourceSeqs:[1,90]}]}})));
    const {root,runtime}=await fixture(adapter),result=await runtime.runWorker(request(root,longInputs()));
    expect(adapter.requests).toHaveLength(2);expect(result.status).toBe('failed');expect(result.requirementSnapshot).toBeUndefined();
    expect(result.shortAnswer).not.toContain('10元');expect(result.shortAnswer).toContain('已保存的条件和原文仍保留');expect(result.openQuestions).toEqual([]);
    const corrective=adapter.requests[1].messages.filter(message=>message.role==='user').at(-1)!;
    expect(JSON.stringify(corrective)).toContain('input_coverage_required');
  });
  it.each(['failed','ready'] as const)('cannot render domain receipts or attachments over an unread %s report',async status=>{
    let finalized=0,imagesResolved=0,legacyFinalized=0,closed=0;
    const image={kind:'image' as const,artifactId:'unchecked-image',file:'/private/unchecked.png',mimeType:'image/png' as const,bytes:10,sha256:'a'.repeat(64)};
    const adapter=new Adapter(call=>text(report(userPayload(call),{status,shortAnswer:'未充分核对但成功率99%',images:['unchecked-image'],
      evidenceRefs:['unverified number'],openQuestions:['请重新发送已经保存的材料'],requirementState:{byAuthor:[{authorId:'owner',text:'预算10元',sourceSeqs:[1,90]}]}})));
    const {root,runtime}=await fixture(adapter,{
      finalizeReport:async report=>{finalized++;return {...report,status:'ready',shortAnswer:'整理成功率99%',images:['unchecked-image'],attachments:[image]};},
      finalizeAnswer:async()=>{legacyFinalized++;return '整理成功率99%';},
      resolveImages:async()=>{imagesResolved++;return [image];},close:async()=>{closed++;},
    });
    const result=await runtime.runWorker(request(root,longInputs()));
    expect(adapter.requests).toHaveLength(status==='failed'?1:2);
    expect({finalized,legacyFinalized,imagesResolved,closed}).toEqual({finalized:0,legacyFinalized:0,imagesResolved:0,closed:1});
    expect(result).toMatchObject({status:'failed',shortAnswer:expect.stringContaining('已有任务材料的核对'),openQuestions:[],evidenceRefs:[]});
    expect(result.shortAnswer).not.toContain('99%');expect(result.images).toBeUndefined();expect(result.attachments).toBeUndefined();
    expect(result.requirementSnapshot).toBeUndefined();expect(result.requirementState).toBeUndefined();
  });
  it('can recover coverage with native scan calls during the single corrective turn',async()=>{
    let calls=0;
    const adapter=new Adapter((call,index)=>{
      const payload=userPayload(call);if(calls++===0)return text(report(payload));
      const page=latestScan(call,payload.runId);
      if(!page||page.nextCursor)return tool({operation:'scan',...(page?.nextCursor??{afterSeq:0})},index);
      return text(report(payload,{requirementState:{byAuthor:[{authorId:'owner',text:'预算5元；保留原键盘',sourceSeqs:[1,20,90]}]}}));
    });
    const {root,runtime}=await fixture(adapter),result=await runtime.runWorker(request(root,longInputs()));
    expect(result).toMatchObject({status:'ready',requirementSnapshot:{throughInputSeq:90}});
  });
  it('does not persist model state omitting an author or citing another author’s source',async()=>{
    const inputs=[input(1,'预算10元','question','owner'),input(2,'我的预算100元','question','other')];
    for(const byAuthor of [[{authorId:'owner',text:'10元',sourceSeqs:[1]}],
      [{authorId:'owner',text:'100元',sourceSeqs:[1,2]},{authorId:'other',text:'100元',sourceSeqs:[2]}]]){
      const adapter=new Adapter(call=>text(report(userPayload(call),{requirementState:{byAuthor},requirementSnapshot:{throughInputSeq:2,revision:2,inputDigest:'a'.repeat(64),byAuthor}})));
      const {root,runtime}=await fixture(adapter),result=await runtime.runWorker(request(root,inputs));
      expect(result.status).toBe('ready');expect(result.requirementSnapshot).toBeUndefined();
    }
  });
});
