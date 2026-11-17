import { vi } from 'vitest';
vi.mock('../src/runtime/retry-delay.js', () => ({waitForModelRetry: async () => {}}));
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LlmAdapter, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { NativeAgentRuntime } from '../src/runtime/native.js';

function textResponse(text: string): StreamChunk[] {
  return [{ type:'block-start',index:0,blockType:'text' }, {type:'text-delta',index:0,text},
    {type:'block-end',index:0,block:{type:'text',text}},
    {type:'usage',usage:{inputTokens:10,outputTokens:5}}, {type:'finish',reason:{kind:'stop'}}];
}
function toolResponse(name: string): StreamChunk[] {
  return [{type:'block-start',index:0,blockType:'tool-call'},
    {type:'block-end',index:0,block:{type:'tool-call',id:ToolCallId('call-1'),name,arguments:'{}'}},
    {type:'finish',reason:{kind:'tool-calls'}}];
}
class ScriptAdapter extends LlmAdapter {
  requests: GenerateOptions[] = [];
  constructor(private readonly script:(req:GenerateOptions,index:number)=>Promise<StreamChunk[]>|StreamChunk[]){super();}
  async *stream(req:GenerateOptions):AsyncIterable<StreamChunk>{
    this.requests.push(req);
    for(const chunk of await this.script(req,this.requests.length-1)) { req.signal?.throwIfAborted(); yield chunk; }
  }
}
const roots:string[]=[]; const runtimes:NativeAgentRuntime[]=[];
afterEach(async()=>{for(const r of runtimes.splice(0))await r.close();for(const p of roots.splice(0))await rm(p,{recursive:true,force:true});});
async function mount(adapter:LlmAdapter,root?:string){
  root??=await mkdtemp(join(tmpdir(),'boe2-runtime-')); roots.push(root);
  const runtime=await NativeAgentRuntime.create({root,adapters:{mock:adapter}});runtimes.push(runtime);return {runtime,root};
}
const model={provider:'mock',model:'test-model'};
it('cancels a run then resumes the same conversation with one fresh followup and no old inbox replay',async()=>{
 let entered!:()=>void;const entering=new Promise<void>(resolve=>entered=resolve);
 const adapter=new ScriptAdapter(async(request,index)=>{
   if(index===0)return toolResponse('resource_value');
   if(index===1){entered();await new Promise<void>((_resolve,reject)=>request.signal!.addEventListener('abort',()=>reject(request.signal!.reason),{once:true}));}
   return textResponse('continued');
 });
 const {runtime,root}=await mount(adapter);let tools=0;
 const first=await runtime.start({id:'continue-owned',model,cwd:root,systemPrompt:'Worker',hostOwnedInputs:true,resume:'auto',
   tools:[{name:'resource_value',description:'Read value',inputSchema:{type:'object'},execute:async()=>{tools++;return {value:42};}}]});
 const sending=first.send('Original request: Node 20');const rejected=expect(sending).rejects.toMatchObject({code:'SUPERSEDED'});
 await entering;await first.steer('obsolete pending inbox');await first.cancel('SUPERSEDED');await rejected;await first.dispose();
 const resumed=await runtime.start({id:'continue-owned',model,cwd:root,systemPrompt:'Worker',hostOwnedInputs:true,resume:'auto'});
 expect((await resumed.send('Correction: Node 22')).text).toBe('continued');
 const context=JSON.stringify(adapter.requests.at(-1)!.messages);
 expect(context).toContain('Original request: Node 20');expect(context).toContain('42');
 expect(context.match(/Correction: Node 22/g)).toHaveLength(1);expect(context).not.toContain('obsolete pending inbox');expect(tools).toBe(1);
 await resumed.dispose();
});
it('does not release a cancelled session until an uncooperative tool has settled',async()=>{
 let entered!:()=>void,release!:()=>void;const entering=new Promise<void>(resolve=>entered=resolve),gate=new Promise<void>(resolve=>release=resolve);
 const adapter=new ScriptAdapter((_request,index)=>index===0?toolResponse('slow_write'):textResponse('continued'));
 const {runtime,root}=await mount(adapter);let calls=0;
 const first=await runtime.start({id:'slow-owned',model,cwd:root,systemPrompt:'Worker',hostOwnedInputs:true,resume:'auto',tools:[{
   name:'slow_write',description:'Synthetic delayed operation',inputSchema:{type:'object'},execute:async()=>{calls++;entered();await gate;return 'recorded';}}]});
 const sending=first.send('Perform one operation');const rejected=expect(sending).rejects.toMatchObject({code:'SUPERSEDED'});
 await entering;let released=false;const stopping=(async()=>{await first.cancel('SUPERSEDED');await first.dispose();released=true;})();
 try{await new Promise(resolve=>setTimeout(resolve,20));expect(released).toBe(false);}finally{release();}
 await stopping;await rejected;
 const resumed=await runtime.start({id:'slow-owned',model,cwd:root,systemPrompt:'Worker',hostOwnedInputs:true,resume:'auto'});
 await resumed.send('Report the observed outcome, do not repeat the operation');
 expect(calls).toBe(1);expect(adapter.requests).toHaveLength(2);
 await resumed.dispose();
});
it('retries inside a model step without replaying tools or retaining failed partial output',async()=>{
 const adapter=new ScriptAdapter((_request,index)=>{
  if(index===0)return [...toolResponse('resource_value').slice(0,-1),{type:'finish',reason:{kind:'error',failure:{code:'PI_AI_ERROR',message:'overloaded'}}}];
  if(index===1)return toolResponse('resource_value');
  if(index===2||index===3)throw new Error('connection reset');
  return textResponse('complete');
 });
 const {runtime,root}=await mount(adapter);let calls=0;
 const agent=await runtime.start({id:'retry-tools',model,cwd:root,systemPrompt:'Worker',maxSteps:2,tools:[{name:'resource_value',description:'value',inputSchema:{type:'object'},execute:async()=>{calls++;return 42;}}]});
 expect((await agent.send('calculate')).text).toBe('complete');expect(calls).toBe(1);expect(adapter.requests).toHaveLength(5);
 expect(adapter.requests[0].messages).toEqual(adapter.requests[1].messages);
 expect(adapter.requests[2].messages).toEqual(adapter.requests[4].messages);
});
it('returns a stable model error after exactly six native adapter calls',async()=>{
 const adapter=new ScriptAdapter(()=>{throw new Error('server overloaded');});const {runtime,root}=await mount(adapter);
 const agent=await runtime.start({id:'retry-exhausted',model,cwd:root,systemPrompt:'Worker',maxSteps:1});
 await expect(agent.send('calculate')).rejects.toMatchObject({code:'MODEL_RETRIES_EXHAUSTED',message:expect.stringContaining('server overloaded')});
 expect(adapter.requests).toHaveLength(6);
});
it.each(['http-401','stream-error'] as const)('bounds actual pi-ai %s failures to six HTTP requests',async mode=>{
 const {createServer}=await import('node:http');let calls=0;
 const server=createServer(async(req,res)=>{
  for await(const _chunk of req){}calls++;
  if(mode==='http-401'){res.writeHead(401,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{message:'invalid test credential',type:'invalid_request_error',code:'invalid_api_key'}}));}
  else{
   res.writeHead(200,{'Content-Type':'text/event-stream'});
   res.end('event: response.failed\ndata: '+JSON.stringify({type:'response.failed',response:{id:'failed-test',status:'failed',error:{code:'server_error',message:'Our servers are currently overloaded.'}}})+'\n\n');
  }
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const address=server.address();if(!address||typeof address==='string')throw new Error('Missing listener');
 const root=await mkdtemp(join(tmpdir(),'boe2-retry-wire-'));roots.push(root);process.env.BOE2_RETRY_TEST_KEY='local-test-key';
 try{
  const runtime=await NativeAgentRuntime.create({root,compaction:false,providers:{wire:{api:'openai-responses',baseURL:`http://127.0.0.1:${address.port}/v1`,apiKeyEnv:'BOE2_RETRY_TEST_KEY',models:[{id:'test-model',input:['text']}],retryPolicy:{mode:'normal',maxRetries:0}}}});runtimes.push(runtime);
  const agent=await runtime.start({id:'wire-retry',model:{provider:'wire',model:'test-model'},cwd:root,systemPrompt:'Test',maxSteps:1});
  await expect(agent.send('test')).rejects.toMatchObject({code:'MODEL_RETRIES_EXHAUSTED',message:expect.stringContaining(mode==='http-401'?'invalid test credential':'overloaded')});
  expect(calls).toBe(6);
 }finally{delete process.env.BOE2_RETRY_TEST_KEY;await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
});
describe('native dsh runtime',()=>{
 it('isolates Router from Worker tools and runs the actual tool loop',async()=>{
   const adapter=new ScriptAdapter((r)=> r.model==='worker' && !r.messages.some(m=>m.role==='tool') ? toolResponse('resource_value') : textResponse(r.model));
   const {runtime,root}=await mount(adapter); let calls=0;
   const worker=await runtime.start({id:'worker',model:{...model,model:'worker'},cwd:root,systemPrompt:'Worker',tools:[{name:'resource_value',description:'value',inputSchema:{type:'object',properties:{}},execute:async()=>{calls++;return {value:42};}}]});
   const router=await runtime.start({id:'router',model:{...model,model:'router'},cwd:root,systemPrompt:'Router',maxSteps:1});
   const [w,r]=await Promise.all([worker.send('compute'),router.send('route')]);
   expect(w.text).toBe('worker');expect(r.text).toBe('router');expect(calls).toBe(1);
   expect(adapter.requests.find(r=>r.model==='router')?.tools??[]).toHaveLength(0);
   expect(adapter.requests.find(r=>r.model==='worker')?.tools?.map(t=>t.name)).toEqual(['resource_value']);
   expect(w.usage.inputTokens).toBe(10);
   expect(w.promptHash).toMatch(/^[a-f0-9]{64}$/);expect(w.promptHash).not.toBe(r.promptHash);
   expect(w.toolsHash).toMatch(/^[a-f0-9]{64}$/);expect(w.toolsHash).not.toBe(r.toolsHash);
 });
 it('persists and resumes original conversation through a fresh host',async()=>{
   const a=new ScriptAdapter(()=>textResponse('first'));
   const {runtime,root}=await mount(a);
   const original=await runtime.start({id:'persistent',model,cwd:root,systemPrompt:'Worker',resume:'auto'});
   await original.send('remember budget 10');await runtime.close();
   const b=new ScriptAdapter(()=>textResponse('resumed'));
   const {runtime:second}=await mount(b,root);
   const resumed=await second.start({id:'persistent',model,cwd:root,systemPrompt:'Worker',resume:'auto'});
   expect((await resumed.send('continue')).text).toBe('resumed');
   expect(JSON.stringify(b.requests[0]?.messages)).toContain('remember budget 10');
   expect(JSON.stringify(b.requests[0]?.messages)).toContain('first');
 });
 it('consumes steering at the next step while a different agent stays responsive',async()=>{
   let release!:()=>void;let entered!:()=>void;
   const entering=new Promise<void>(r=>entered=r), gate=new Promise<void>(r=>release=r);
   const adapter=new ScriptAdapter(r=>r.model==='worker'&&!r.messages.some(m=>m.role==='tool')?toolResponse('resource_slow'):textResponse(JSON.stringify(r.messages)));
   const {runtime,root}=await mount(adapter);
   const w=await runtime.start({id:'steer-worker',model:{...model,model:'worker'},cwd:root,systemPrompt:'worker',tools:[{name:'resource_slow',description:'slow',inputSchema:{type:'object',properties:{}},execute:async()=>{entered();await gate;return 'done';}}]});
   const running=w.send('initial'); await entering;await w.steer('budget now 5',[{mediaType:'image/png',data:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAE0lEQVQImWP4z8DwnwGM/zMwAAAf7gP9qS/A4gAAAABJRU5ErkJggg==','base64')}]);
   const r=await runtime.start({id:'fast-router',model,cwd:root,systemPrompt:'router'});
   expect((await r.send('route')).text).toContain('route');release();
   expect((await running).text).toContain('budget now 5');
   const steered=adapter.requests.filter(request=>request.model==='worker').at(-1)!.messages.filter(m=>m.role==='user').at(-1)!;
   expect(steered.content.some(block=>block.type==='image')).toBe(true);
 });
 it('cancels an in-flight model and does not report partial text as success',async()=>{
   let entered!:()=>void;const entering=new Promise<void>(r=>entered=r);
   const adapter=new ScriptAdapter(async r=>{entered();await new Promise<void>((_,reject)=>r.signal?.addEventListener('abort',()=>reject(new Error('aborted')),{once:true}));return textResponse('never');});
   const {runtime,root}=await mount(adapter);
   const a=await runtime.start({id:'cancelled',model,cwd:root,systemPrompt:'worker'});
   const promise=a.send('work');const assertion=expect(promise).rejects.toMatchObject({code:'ABORTED'});
   await entering;await a.cancel();await assertion;
 });
 it('never wakes an idle native agent from an early or late image steer',async()=>{
   const adapter=new ScriptAdapter(()=>textResponse('controlled turn'));
   const {runtime,root}=await mount(adapter);
   const agent=await runtime.start({id:'idle-steer',model,cwd:root,systemPrompt:'worker'});
   const images=[{mediaType:'image/png' as const,data:Buffer.from('invalid image is never touched when idle')}];
   await agent.steer('early image',images);expect(adapter.requests).toHaveLength(0);
   await agent.send('complete input');expect(adapter.requests).toHaveLength(1);
   await agent.steer('late image',images);expect(adapter.requests).toHaveLength(1);
   await agent.send('next complete input');expect(adapter.requests).toHaveLength(2);
   expect(JSON.stringify(adapter.requests[1].messages)).not.toMatch(/early image|late image/);
 });
 it('caps model/tool loops with a real pre-step hook',async()=>{
   const {runtime,root}=await mount(new ScriptAdapter(()=>toolResponse('resource_loop')));
   const a=await runtime.start({id:'limited',model,cwd:root,systemPrompt:'worker',maxSteps:2,tools:[{name:'resource_loop',description:'loop',inputSchema:{type:'object',properties:{}},execute:async()=>1}]});
   await expect(a.send('work')).rejects.toThrow('step limit');
 });
});

it('sends model, reasoning, vision and auth through the official dsh pi-ai Responses adapter',async()=>{
 const {createServer}=await import('node:http');
 let requestBody:any; let auth:string|undefined; let url:string|undefined;
 const server=createServer(async(req,res)=>{
  const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));
  requestBody=JSON.parse(Buffer.concat(chunks).toString());auth=req.headers.authorization;url=req.url;
  res.writeHead(200,{'Content-Type':'text/event-stream'});
  const output={id:'msg_test',type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'vision-ok',annotations:[]}]};
  const events=[
   {type:'response.created',response:{id:'resp_test',object:'response',status:'in_progress',output:[]}},
   {type:'response.output_item.added',output_index:0,item:{...output,status:'in_progress',content:[]}},
   {type:'response.content_part.added',output_index:0,content_index:0,item_id:'msg_test',part:{type:'output_text',text:'',annotations:[]}},
   {type:'response.output_text.delta',output_index:0,content_index:0,item_id:'msg_test',delta:'vision-ok'},
   {type:'response.output_text.done',output_index:0,content_index:0,item_id:'msg_test',text:'vision-ok'},
   {type:'response.output_item.done',output_index:0,item:output},
   {type:'response.completed',response:{id:'resp_test',object:'response',status:'completed',output:[output],usage:{input_tokens:13,output_tokens:3,total_tokens:16,input_tokens_details:{cached_tokens:0},output_tokens_details:{reasoning_tokens:0}}}}
  ];
  for(const event of events)res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);res.end();
 });
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 const address=server.address();if(!address||typeof address==='string')throw new Error('no server');
 const root=await mkdtemp(join(tmpdir(),'boe2-wire-'));roots.push(root);
 process.env.BOE2_TEST_KEY='test-key-only';
 try{
  const runtime=await NativeAgentRuntime.create({root,providers:{testwire:{api:'openai-responses',baseURL:`http://127.0.0.1:${address.port}/v1`,apiKeyEnv:'BOE2_TEST_KEY',models:[{id:'gpt-6.1-terra',input:['text','image'],reasoningEfforts:{low:'low',high:'high'}}]}}});runtimes.push(runtime);
  const agent=await runtime.start({id:'vision',model:{provider:'testwire',model:'gpt-6.1-terra',reasoningEffort:'low',maxTokens:500},cwd:root,systemPrompt:'read image'});
  const result=await agent.send('what is shown',[{data:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAE0lEQVQImWP4z8DwnwGM/zMwAAAf7gP9qS/A4gAAAABJRU5ErkJggg==','base64'),mediaType:'image/png'}]);
  expect(result.text).toBe('vision-ok');expect(auth).toBe('Bearer test-key-only');expect(url).toBe('/v1/responses');
  expect(requestBody.model).toBe('gpt-6.1-terra');expect(requestBody.reasoning.effort).toBe('low');
  expect(JSON.stringify(requestBody.input)).toContain('data:image/');expect(result.usage).toEqual({inputTokens:13,outputTokens:3});
 }finally{delete process.env.BOE2_TEST_KEY;await new Promise<void>((r,e)=>server.close(error=>error?e(error):r()));}
});

it('projects MCP screenshots as image blocks and removes their base64 from tool text',async()=>{
 const png='iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAE0lEQVQImWP4z8DwnwGM/zMwAAAf7gP9qS/A4gAAAABJRU5ErkJggg==';
 const adapter=new ScriptAdapter((_,index)=>index===0?toolResponse('resource_screenshot'):textResponse('image-read'));
 const {runtime,root}=await mount(adapter);
 const agent=await runtime.start({id:'screenshot',model,cwd:root,systemPrompt:'worker',tools:[{name:'resource_screenshot',description:'screenshot',inputSchema:{type:'object',properties:{}},execute:async()=>({content:[{type:'image',mimeType:'image/png',data:png},{type:'text',text:'page'}]})}]});
 expect((await agent.send('read')).text).toBe('image-read');
 const replay=JSON.stringify(adapter.requests[1].messages);expect(replay).not.toContain(png);expect(replay).toContain('"type":"image"');expect(replay).toContain('attachment');
});
it('bounds the full derived context instead of truncating facts silently',async()=>{
 const adapter=new ScriptAdapter(()=>textResponse('unused'));const {runtime,root}=await mount(adapter);
 const a=await runtime.start({id:'context-limit',model,cwd:root,systemPrompt:'worker',maxContextChars:100});
 await expect(a.send('x'.repeat(200))).rejects.toThrow('size limit');expect(adapter.requests).toHaveLength(0);
});

it('accounts failed steps and retry attempts without inventing missing usage',async()=>{
 const adapter=new ScriptAdapter((_,index)=>index===0?[
   {type:'usage',usage:{inputTokens:7,outputTokens:2,cacheReadTokens:11}},
   {type:'finish',reason:{kind:'error',failure:{code:'OVERLOADED',message:'retry'}}},
 ]:toolResponse('resource_loop'));
 const {runtime,root}=await mount(adapter),calls:any[]=[];
 const agent=await runtime.start({id:'failed-usage',model,cwd:root,systemPrompt:'worker',maxSteps:2,onModelCall:call=>calls.push(call),
   tools:[{name:'resource_loop',description:'loop',inputSchema:{type:'object'},execute:async()=>1}]});
 await expect(agent.send('work')).rejects.toMatchObject({code:'STEP_LIMIT'});
 expect(calls).toHaveLength(3);expect(new Set(calls.map(call=>call.callId)).size).toBe(3);
 expect(agent.lastMeasurement).toMatchObject({status:'failed',code:'STEP_LIMIT',steps:2,modelCalls:3,missingUsageCalls:2,usageStatus:'partial',usage:{inputTokens:7,outputTokens:2,cacheReadTokens:11}});
 expect(calls[0].code).toBe('OVERLOADED');expect(calls[1].usage).toBeUndefined();
});
it('records known zero when the input guard prevents any model call',async()=>{
 const adapter=new ScriptAdapter(()=>textResponse('unused'));const {runtime,root}=await mount(adapter);
 const agent=await runtime.start({id:'guard-usage',model,cwd:root,systemPrompt:'worker',maxContextChars:100});
 await expect(agent.send('x'.repeat(200))).rejects.toMatchObject({code:'CONTEXT_LIMIT'});
 expect(agent.lastMeasurement).toMatchObject({status:'failed',usageStatus:'not_called',modelCalls:0,usage:{inputTokens:0,outputTokens:0}});
});
