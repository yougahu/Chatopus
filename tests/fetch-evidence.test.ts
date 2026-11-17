import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LlmAdapter, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { NativeAgentRuntime } from '../src/runtime/native.js';
import { createCapabilitySession, type CapabilitySession, type ToolAuditEvent } from '../src/capabilities.js';
import { checkedSource, toolFailureReason } from '../src/tools/tool-result.js';

const fixtures=JSON.parse(await readFile(new URL('./fixtures/fetch-sources.json',import.meta.url),'utf8'));
const extension=fileURLToPath(new URL('./fixtures/source-extension.mjs',import.meta.url));
const roots:string[]=[],sessions:CapabilitySession[]=[];
afterEach(async()=>{vi.restoreAllMocks();for(const s of sessions.splice(0))await s.close();for(const r of roots.splice(0))await rm(r,{recursive:true,force:true});});
async function setup(name:string){
  const root=await mkdtemp(join(tmpdir(),'fetch-evidence-'));roots.push(root);const audit:ToolAuditEvent[]=[];
  const session=await createCapabilitySession({root,skills:[],extensions:name==='fixture_fetch'?[{id:'source-fixture',module:extension}]:[],python:'/not-installed/python',onAudit:event=>audit.push(event)},
    {threadId:'t',runId:'r',revision:1,workspace:join(root,'run'),artifactWorkspace:join(root,'artifacts'),question:'核验来源内容'});
  sessions.push(session);return {root,audit,session,call:(args:unknown)=>session.tools.find(t=>t.name===name)!.execute(args)};
}
const escape=(s:string)=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
const cases=[...fixtures.map((f:any)=>({...f,body:`<html><head><title>${escape(f.title)}</title></head><body><article>${escape(f.text)}</article></body></html>`})),
  {name:'200 CAPTCHA',status:200,body:'<html><head><title>Just a moment...</title></head><body>Verify you are human</body></html>',expected:'error'},
  {name:'200 Loading',status:200,body:'<html><body>FDC is loading…</body></html>',expected:'error'},
  {name:'200 empty',status:200,body:' \n ',expected:'error'},
  {name:'204 empty',status:204,body:null,expected:'error'},
  {name:'302 no location',status:302,body:'Moved',expected:'error'},
  {name:'nested JSON error',status:200,contentType:'application/json',body:JSON.stringify({result:{structuredContent:{response:{status:403,error:'denied'}}}}),expected:'error'},
  {name:'nested content error',status:200,contentType:'application/json',body:JSON.stringify({content:[{type:'text',text:JSON.stringify({result:{ok:false}})}]}),expected:'error'},
  {name:'normal JSON',status:200,contentType:'application/json',body:JSON.stringify({result:[],total:0}),expected:'ok'},
  {name:'article mentioning CAPTCHA',status:200,body:'<html><head><title>CAPTCHA research</title></head><body><article>A study of CAPTCHA and loading performance. The measured result was 43 seconds.</article></body></html>',expected:'ok'},
];
for(const name of ['web_fetch','fixture_fetch'])describe(name,()=>{
  it('marks the actual native model tool result as failed, then permits alternate-source recovery',async()=>{
    const f=await setup(name);
    vi.spyOn(globalThis,'fetch').mockResolvedValueOnce(new Response('FDC is loading…',{status:404}))
      .mockResolvedValueOnce(new Response('Verified fixture body: 43 kcal per 100 g.',{status:200}));
    let step=0;
    class Adapter extends LlmAdapter {
      async *stream(request:GenerateOptions):AsyncIterable<StreamChunk>{
        if(step===1){
          const result=request.messages.filter(m=>m.role==='tool').at(-1)!;
          expect(result.isError).toBe(true);expect(JSON.stringify(result)).toContain('evidenceAvailable');
        }
        if(step===2){
          expect(request.messages.filter(m=>m.role==='tool').at(-1)!.isError).not.toBe(true);
          yield {type:'block-start',index:0,blockType:'text'};
          yield {type:'text-delta',index:0,text:'Recovered using the alternative body.'};
          yield {type:'block-end',index:0,block:{type:'text',text:'Recovered using the alternative body.'}};
          yield {type:'finish',reason:{kind:'stop'}};return;
        }
        const url=step++===0?'https://example.org/missing':'https://example.org/alternative';
        yield {type:'block-start',index:0,blockType:'tool-call'};
        yield {type:'block-end',index:0,block:{type:'tool-call',id:ToolCallId(`fetch-${step}`),name,arguments:JSON.stringify({url})}};
        yield {type:'finish',reason:{kind:'tool-calls'}};
      }
    }
    const native=await NativeAgentRuntime.create({root:join(f.root,'native'),adapters:{mock:new Adapter()},compaction:false});
    try{
      const agent=await native.start({id:'fetch-evidence',model:{provider:'mock',model:'test'},cwd:f.root,systemPrompt:f.session.systemContext,tools:f.session.tools,maxSteps:3});
      expect((await agent.send('Read a source, recover from failure, and cite only acquired evidence.')).text).toContain('Recovered');
      expect(f.audit.map(e=>e.status)).toEqual(['error','ok']);
    }finally{await native.close();}
  });
  it.each(cases)('$name agrees with model errors and audit status',async fixture=>{
    const f=await setup(name);
    vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response(fixture.body,{status:fixture.status,headers:{'content-type':fixture.contentType??'text/html'}}));
    const args={url:fixture.url??'https://example.org/source',saveAs:'source.txt'};
    if(fixture.expected==='error'){
      await expect(f.call(args)).rejects.toThrow();
      expect(f.audit.at(-1)?.status).toBe('error');
      await expect(readFile(join(f.root,'artifacts/source.txt'))).rejects.toMatchObject({code:'ENOENT'});
    }else{
      expect(await f.call(args)).toMatchObject({status:200,evidenceAvailable:true});
      expect(f.audit.at(-1)?.status).toBe('ok');
      expect(await readFile(join(f.root,'artifacts/source.txt'),'utf8')).toBe(fixture.body);
    }
    expect(f.session.systemContext).toContain('never cite the failed page as if read');
  });
  it('recovers using another source and does not overwrite good evidence with an error page',async()=>{
    const f=await setup(name);
    vi.spyOn(globalThis,'fetch').mockResolvedValueOnce(new Response('Loading…',{status:404}))
      .mockResolvedValueOnce(new Response('Measured value: 43 kcal per 100 g.',{status:200}))
      .mockResolvedValueOnce(new Response('Forbidden',{status:403}));
    await expect(f.call({url:'https://example.org/unavailable',saveAs:'source.txt'})).rejects.toThrow();
    expect(await f.call({url:'https://example.org/alternative',saveAs:'source.txt'})).toMatchObject({evidenceAvailable:true,text:'Measured value: 43 kcal per 100 g.'});
    await expect(f.call({url:'https://example.org/unavailable',saveAs:'source.txt'})).rejects.toThrow();
    expect(await readFile(join(f.root,'artifacts/source.txt'),'utf8')).toBe('Measured value: 43 kcal per 100 g.');
    expect(f.audit.map(e=>e.status)).toEqual(['error','ok','error']);
  });
});

it('recognizes the actual nested tool envelopes from the incident',()=>{
  for(const fixture of fixtures){
    const envelope={isError:false,content:[{type:'text',text:{status:fixture.status,text:fixture.text}}]};
    expect(Boolean(toolFailureReason(envelope))).toBe(fixture.expected==='error');
  }
});
it('keeps retrieval failures structured and retains retry information',()=>{
  try{checkedSource({url:'https://example.org/rate-limited',status:429,text:'Rate limited',contentType:'text/plain',retryAfter:'60'});throw new Error('expected rejection');}
  catch(error){expect(error).toMatchObject({code:'SOURCE_UNAVAILABLE'});expect(JSON.parse((error as Error).message)).toMatchObject({evidenceAvailable:false,retryAfter:'60',status:429});}
});
