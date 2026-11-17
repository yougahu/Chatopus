import { vi } from 'vitest';
vi.mock('../src/runtime/retry-delay.js', () => ({waitForModelRetry: async () => {}}));
import {afterEach,describe,expect,it} from 'vitest';
import {mkdtemp,readFile,readdir,rm,stat,writeFile} from 'node:fs/promises';
import {globSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {LlmAdapter,ToolCallId,type ContentBlock,type GenerateOptions,type StreamChunk} from '@deepseek-ai/dsh-llm';
import {NativeAgentRuntime} from '../src/runtime/native.js';
import {normalizeRouterActionOutput} from '../src/runtime/router-output.js';
import {enforceExplicitActivation} from '../src/activation.js';
import type {GroupMessage,RouterRequest,ThreadCard} from '../src/types.js';

const msg=(id:string,authorId='owner'):GroupMessage=>({id,roomId:'room',messageId:id,authorId,authorName:authorId,platform:'replay',text:'继续分析',timestamp:1,mentions:[],attachments:[],isMentioned:true,isAdmin:false});
const thread:ThreadCard={id:'thread',roomId:'room',subject:'任务',ownerId:'owner',sourceMessageId:'old',explicit:true,status:'idle',participants:['owner'],summary:'原任务',sessionId:'worker',revision:1,latestInputSeq:1,epoch:1};
const request=():RouterRequest=>({roomId:'room',event:'messages',messages:[msg('current')],recentMessages:[msg('old')],threads:[thread]});
const call=(name:string,args:unknown,id='call'):ContentBlock=>({type:'tool-call',id:ToolCallId(id),name,arguments:JSON.stringify(args)});
const silence=(id='current')=>call('silence',{sourceMessageIds:[id],reason:'闲聊'});
const normalized=(blocks:ContentBlock[],r=request())=>normalizeRouterActionOutput(blocks,r);

describe('Router action output normalization',()=>{
  it('normalizes complete consecutive JSON objects without changing their actions',()=>{
    const r=request();r.messages.push(msg('second','other'));
    const actions=[{action:'reply_direct',sourceMessageIds:['current'],text:'含有 { 花括号 } 和 "引号"'},{action:'silence',sourceMessageIds:['second']}];
    expect(JSON.parse(normalized([{type:'text',text:actions.map(action=>JSON.stringify(action)).join('\n')}],r)!)).toEqual(actions);
    for(const suffix of [' trailing prose','\n{"action":','\n```'])expect(normalized([{type:'text',text:actions.map(action=>JSON.stringify(action)).join('\n')+suffix}],r)).toBeUndefined();
    expect(normalized([{type:'text',text:JSON.stringify(actions[0])+'\n'+JSON.stringify({action:'silence',sourceMessageIds:['old']})}],r)).toBeUndefined();
    const schedule={action:'manage_schedule',sourceMessageIds:['current','second'],operation:{op:'create',input:{title:'提醒',executionKind:'reminder',content:'检查记录',timezone:'UTC',scheduleSpec:{kind:'once',at:Date.now()+3600000}}}};
    expect(normalized([{type:'text',text:JSON.stringify(schedule)+'\n'+JSON.stringify({action:'silence',sourceMessageIds:['second']})}],r)).toBeUndefined();
  });
  it('validates the complete multi-action batch and does not mutate provider blocks',()=>{
    const r=request();r.messages.push(msg('second'));
    const blocks=[{type:'reasoning' as const,text:'internal'},silence(),call('reply_direct',{sourceMessageIds:['second'],text:'收到'},'second-call')];
    const original=structuredClone(blocks),text=normalized(blocks,r);
    expect(JSON.parse(text!)).toEqual([{action:'silence',sourceMessageIds:['current'],reason:'闲聊'},{action:'reply_direct',sourceMessageIds:['second'],text:'收到'}]);
    expect(blocks).toEqual(original);expect(normalized([silence()],r)).toBeUndefined();
    expect(normalized([silence(),silence()],r)).toBeUndefined();
  });
  it.each([
    [silence(),{type:'text',text:'not an unambiguous action batch'}],
    [silence(),call('router_context',{kind:'threads'})],
    [call('unknown_action',{sourceMessageIds:['current']})],
    [call('silence',[])],
    [call('silence',null)],
    [call('silence',{action:'reply_direct',sourceMessageIds:['current']})],
    [{type:'tool-call',id:ToolCallId('bad'),name:'silence',arguments:'{broken'}],
  ] as ContentBlock[][])('leaves mixed, malformed or conflicting responses unchanged (%#)',(...blocks)=>{
    expect(normalized(blocks as ContentBlock[])).toBeUndefined();
  });
  it('rejects historical sources, foreign targets and cross-author image context',()=>{
    expect(normalized([silence('old')])).toBeUndefined();
    expect(normalized([call('append_thread',{sourceMessageIds:['current'],threadId:'foreign'})])).toBeUndefined();
    const r=request();r.recentMessages=[{...msg('image','other'),attachments:[{kind:'image',file:'other.png'}]}];
    expect(normalized([call('open_thread',{sourceMessageIds:['current'],subject:'分析图片',contextMessageIds:['image']})],r)).toBeUndefined();
  });
  it('reads current mutable recall scope and preserves the downstream activation gate',()=>{
    const r=request();r.threads=[];
    const blocks=[call('append_thread',{sourceMessageIds:['current'],threadId:'thread'})];
    expect(normalized(blocks,r)).toBeUndefined();r.threads.push(thread);
    expect(normalized(blocks,r)).toBeDefined();
    r.messages[0].isMentioned=false;
    expect(enforceExplicitActivation(JSON.parse(normalized(blocks,r)!),r.messages,['bot'])).toEqual([{action:'silence',sourceMessageIds:['current'],reason:'本条未明确@或呼唤机器人'}]);
  });
  it('only accepts the current result identity for result events',()=>{
    const r=request();r.event='worker_result';r.messages=[];
    r.result={id:'result',threadId:'thread',explicit:true,report:{threadId:'thread',runId:'run',coveredInputSeq:1,basedOnRevision:1,status:'ready',shortAnswer:'答案',assumptions:[],evidenceRefs:[],openQuestions:[]}};
    expect(normalized([call('publish_result',{resultId:'result'})],r)).toBeDefined();
    expect(normalized([call('publish_result',{resultId:'old-result'})],r)).toBeUndefined();
  });
});

const roots:string[]=[],hosts:NativeAgentRuntime[]=[];
afterEach(async()=>{for(const host of hosts.splice(0))await host.close();for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
class Adapter extends LlmAdapter {
  calls:GenerateOptions[]=[];
  constructor(private script:(request:GenerateOptions,n:number)=>StreamChunk[]|Promise<StreamChunk[]>){super();}
  async *stream(req:GenerateOptions):AsyncIterable<StreamChunk>{this.calls.push(req);for(const chunk of await this.script(req,this.calls.length))yield chunk;}
}
const text=(value:string):StreamChunk[]=>[{type:'text-delta',index:0,text:value},{type:'finish',reason:{kind:'stop'}}];
function response(block:ContentBlock=silence()):StreamChunk[]{return [{type:'block-end',index:0,block},
  {type:'usage',usage:{inputTokens:12,outputTokens:8,cacheReadTokens:100,totalTokens:120}},
  {type:'finish',reason:{kind:'tool-calls'},replayState:{response:{original:true},blocks:[{original:true}]}}];}
async function mount(adapter:Adapter){
  const root=await mkdtemp(join(tmpdir(),'boe-router-output-'));roots.push(root);
  const host=await NativeAgentRuntime.create({root,compaction:false,adapters:{mock:adapter}});hosts.push(host);
  return {root,host};
}
const model={provider:'mock',model:'test'};
const logs=async(root:string)=>Promise.all(globSync(join(root,'sessions/**/session.v4.jsonl')).map(async file=>(await readFile(file,'utf8')).trim().split('\n').map(line=>JSON.parse(line))));

describe('native output stream boundary',()=>{
  it('normalizes a successful model retry once without executing Router action tools',async()=>{
    const adapter=new Adapter((_request,n)=>n===1?[{type:'finish',reason:{kind:'error',failure:{code:'PI_AI_ERROR',message:'overloaded'}}}]:response());
    const {host,root}=await mount(adapter);
    const agent=await host.start({id:'router-retry',model,cwd:root,systemPrompt:'router',maxSteps:1,normalizeOutput:blocks=>normalized([...blocks])});
    const out=await agent.send('current');expect(adapter.calls).toHaveLength(2);expect(out.outputNormalizations).toBe(1);
    expect(JSON.parse(out.text)[0].action).toBe('silence');
    expect(await readdir(join(root,'output-normalizations/router-retry'))).toHaveLength(1);
    expect((await logs(root)).flat().some(event=>event.type==='tool/result')).toBe(false);
  });
  it('normalizes one response without executing tools or another model call, preserving usage and raw audit',async()=>{
    const adapter=new Adapter(()=>response()),{host,root}=await mount(adapter);
    const agent=await host.start({id:'router',model,cwd:root,systemPrompt:'router',maxSteps:1,normalizeOutput:blocks=>normalized([...blocks])});
    const out=await agent.send('current');expect(adapter.calls).toHaveLength(1);expect(out.outputNormalizations).toBe(1);expect(out.usage).toEqual({inputTokens:12,outputTokens:8,cacheReadTokens:100});
    expect(JSON.parse(out.text)[0].action).toBe('silence');
    const files=await readdir(join(root,'output-normalizations/router'));expect(files).toHaveLength(1);
    const file=join(root,'output-normalizations/router',files[0]),audit=JSON.parse(await readFile(file,'utf8'));
    expect(audit.chunks).toEqual(response());expect(audit.text).toBe(out.text);expect((await stat(file)).mode&0o777).toBe(0o600);
    const events=(await logs(root)).flat();expect(events.some(e=>e.type==='tool/result')).toBe(false);
    const assistant=events.find(e=>e.type==='assistant/message');expect(assistant.data.usage.cacheReadTokens).toBe(100);expect(assistant.data.message.source.replayState).toBeUndefined();
  });
  it('filters concurrent agents by exact identity and excludes auxiliary model calls',async()=>{
    const adapter=new Adapter(req=>req.sessionId==='router-a'||req.sessionId==='router-b'?response(silence(req.sessionId)):text('worker'));
    const {host,root}=await mount(adapter),seen:string[]=[];
    const make=async(id:string)=>host.start({id,model,cwd:root,systemPrompt:id,maxSteps:1,normalizeOutput:blocks=>{seen.push(id);const r=request();r.messages=[msg(id)];return normalized([...blocks],r);},
      setup(ctx){ctx.on('agent/pre-step',async(payload,next)=>{if(payload.agent.session.id===id)for await(const _ of ctx.llm.stream({provider:'mock',model:'test',messages:[],sessionId:payload.agent.session.id,purpose:'compaction' as never})){};return next();});}});
    const a=await make('router-a'),b=await make('router-b'),w=await host.start({id:'worker',model,cwd:root,systemPrompt:'worker',maxSteps:1});
    const results=await Promise.all([a.send('a'),b.send('b'),w.send('w')]);
    expect(seen.sort()).toEqual(['router-a','router-b']);expect(results[2].text).toBe('worker');expect(results[2].outputNormalizations).toBeUndefined();
    expect(await readdir(join(root,'output-normalizations'))).toEqual(['router-a','router-b']);
  });
  it('allows genuine recall first, then validates the expanded request without another repair',async()=>{
    const r=request();r.threads=[];let recallCalls=0;
    const adapter=new Adapter((_,n)=>response(n===1?call('router_context',{kind:'threads'}):call('append_thread',{sourceMessageIds:['current'],threadId:'thread'})));
    const {host,root}=await mount(adapter),agent=await host.start({id:'recall',model,cwd:root,systemPrompt:'router',maxSteps:2,normalizeOutput:blocks=>normalized([...blocks],r),tools:[{name:'router_context',description:'read',inputSchema:{type:'object'},execute:async()=>{recallCalls++;r.threads.push(thread);return {threads:[thread]};}}]});
    const out=await agent.send('continue');expect(adapter.calls).toHaveLength(2);expect(recallCalls).toBe(1);expect(out.outputNormalizations).toBe(1);expect(JSON.parse(out.text)[0].threadId).toBe('thread');
  });
  it('leaves invalid identities to ordinary tool rejection and recovery',async()=>{
    const adapter=new Adapter((_,n)=>n===1?response(silence('old')):text('[{"action":"silence","sourceMessageIds":["current"]}]'));
    const {host,root}=await mount(adapter),agent=await host.start({id:'invalid',model,cwd:root,systemPrompt:'router',maxSteps:2,normalizeOutput:blocks=>normalized([...blocks])});
    const out=await agent.send('current');expect(adapter.calls).toHaveLength(2);expect(out.outputNormalizations).toBeUndefined();expect((await logs(root)).flat().some(e=>e.type==='tool/result'&&(e.data.message??e.data).isError)).toBe(true);
  });
  it('does not normalize token truncation, provider errors or an unterminated response',async()=>{
    for(const finish of [{kind:'max-tokens'},{kind:'error',failure:{message:'failure',code:'MOCK'}},undefined] as const){
      let attempts=0;const adapter=new Adapter(()=>{const chunks=response();chunks.pop();if(finish)chunks.push({type:'finish',reason:finish});return chunks;});
      const {host,root}=await mount(adapter),agent=await host.start({id:'incomplete',model,cwd:root,systemPrompt:'router',maxSteps:1,normalizeOutput:()=>{attempts++;return 'bad';}});
      await expect(agent.send('current')).rejects.toThrow();expect(attempts).toBe(0);await agent.dispose();
    }
  });
  it('never accepts a buffered action when its request is cancelled',async()=>{
    let entered!:()=>void;const waiting=new Promise<void>(resolve=>entered=resolve);let attempts=0;
    class Pending extends Adapter {
      async *stream(req:GenerateOptions):AsyncIterable<StreamChunk>{
        this.calls.push(req);yield {type:'block-end',index:0,block:silence()};entered();
        await new Promise<void>((_,reject)=>req.signal?.addEventListener('abort',()=>reject(new Error('cancelled')),{once:true}));
        yield {type:'finish',reason:{kind:'tool-calls'}};
      }
    }
    const adapter=new Pending(()=>[]),{host,root}=await mount(adapter);
    const agent=await host.start({id:'cancelled',model,cwd:root,systemPrompt:'router',normalizeOutput:()=>{attempts++;return 'must not accept';}});
    const running=agent.send('current'),assertion=expect(running).rejects.toMatchObject({code:'ABORTED'});
    await waiting;await agent.cancel();await assertion;expect(attempts).toBe(0);
    expect((await logs(root)).flat().some(e=>e.type==='tool/result')).toBe(false);
  });
  it('fails closed when raw audit cannot be persisted',async()=>{
    const adapter=new Adapter(()=>response()),{host,root}=await mount(adapter);
    await writeFile(join(root,'output-normalizations'),'not a directory');
    const agent=await host.start({id:'audit-failure',model,cwd:root,systemPrompt:'router',maxSteps:1,normalizeOutput:blocks=>normalized([...blocks])});
    await expect(agent.send('current')).rejects.toThrow();expect(adapter.calls).toHaveLength(1);
    expect((await logs(root)).flat().some(e=>e.type==='assistant/message')).toBe(false);
  });
  it('counts conversions per send and safely records repeated calls in the same session',async()=>{
    const adapter=new Adapter((_,n)=>n===2?text('unchanged'):response()),{host,root}=await mount(adapter);
    const agent=await host.start({id:'counter',model,cwd:root,systemPrompt:'router',maxSteps:1,normalizeOutput:blocks=>normalized([...blocks])});
    expect((await agent.send('one')).outputNormalizations).toBe(1);expect((await agent.send('two')).outputNormalizations).toBeUndefined();expect((await agent.send('three')).outputNormalizations).toBe(1);
    const files=await readdir(join(root,'output-normalizations/counter'));expect(files.map(f=>f.slice(0,6))).toEqual(['000001','000002']);
  });
});
