vi.mock('../src/runtime/retry-delay.js', () => ({waitForModelRetry: async () => {}}));
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createUserMessage, LlmAdapter, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import type BasicCompaction from '@deepseek-ai/dsh-compaction-basic';
import { NativeAgentRuntime, type NativeRuntimeOptions } from '../src/runtime/native.js';
import { NativeRuntimePool } from '../src/runtime/pool.js';
import { projectRouterSummaryMessages, ROUTER_COMPACTION_INSTRUCTION, ROUTER_COMPACTION_POLICY, ROUTER_COMPACTION_RETRY_INSTRUCTION } from '../src/runtime/router-compaction.js';
import { loadConfig } from '../src/config.js';

const oldHistory='Old group conversation. '.repeat(450);
const summary='背景摘要：qq:bot:room 的 player-A 询问 thread-A；预算更正为 10元。旧 publish_result 仅是建议，实际投递未知；最新宿主快照优先。';
function response(text:string):StreamChunk[] {
  return [{type:'block-start',index:0,blockType:'text'},
    {type:'text-delta',index:0,text},{type:'block-end',index:0,block:{type:'text',text}},
    {type:'usage',usage:{inputTokens:17,outputTokens:5}},{type:'finish',reason:{kind:'stop'}}];
}
class Adapter extends LlmAdapter {
  readonly requests:GenerateOptions[]=[];
  constructor(private readonly summarize:(request:GenerateOptions)=>StreamChunk[]|Promise<StreamChunk[]>=()=>response(summary)){super();}
  override async resolveModel(provider:string,model:string):Promise<LlmResolvedModelInfo>{
    return {provider,id:model,name:model,context:{contextWindow:1_000_000}};
  }
  async *stream(request:GenerateOptions):AsyncIterable<StreamChunk>{
    this.requests.push(request);
    const chunks=request.purpose==='compaction'?await this.summarize(request):response('Observed group details. '.repeat(100));
    for(const chunk of chunks){request.signal?.throwIfAborted();yield chunk;}
  }
  get summaries(){return this.requests.filter(request=>request.purpose==='compaction');}
  get main(){return this.requests.filter(request=>request.purpose!=='compaction');}
}
const cleanup:Array<()=>Promise<void>>=[];
afterEach(async()=>{vi.restoreAllMocks();for(const dispose of cleanup.splice(0).reverse())await dispose();});
async function root(){const value=await mkdtemp(join(tmpdir(),'boe2-router-compaction-'));cleanup.push(()=>rm(value,{recursive:true,force:true}));return value;}
async function mount(adapter:Adapter,options:Partial<NativeRuntimeOptions>={}){
  const directory=options.root??await root();
  const runtime=await NativeAgentRuntime.create({root:directory,adapters:{mock:adapter},compactionRole:'router',
    compaction:{...ROUTER_COMPACTION_POLICY,summarizationProvider:'mock',summarizationModel:'summary-current'},...options});
  cleanup.push(()=>runtime.close());return {runtime,directory};
}

describe('Router compaction',()=>{
  it('uses the bounded routing policy and saves a summary that resumes with the newest input intact',async()=>{
    const adapter=new Adapter(),{runtime,directory}=await mount(adapter);
    const events:SessionEvent[]=[];
    let policy:BasicCompaction['config']|undefined;
    const agent=await runtime.start({id:'router-room',model:{provider:'mock',model:'route-current'},cwd:directory,
      systemPrompt:'Router must output action JSON.',resume:'auto',maxContextChars:12_000,
      setup(ctx){policy=(ctx.get('compaction') as BasicCompaction).config;ctx.on('session/event',(_session,event)=>{events.push(event);});}});
    await agent.send(oldHistory);
    const correction='Current host: player-A changed budget to 10元; only qq:bot:room:new is actionable.';
    const result=await agent.send(correction);
    expect(policy).toMatchObject({maxTokens:16384,thresholdRatio:0.8,headroomTokens:65536,retainRatio:0.16});
    expect(policy).not.toHaveProperty('retainTokens');
    expect(adapter.summaries).toHaveLength(1);
    const request=adapter.summaries[0];
    expect(request).toMatchObject({provider:'mock',model:'summary-current',maxTokens:16384,sessionId:'router-room',purpose:'compaction'});
    expect(request.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.stringify(request.messages)).toContain(oldHistory);
    expect(request.messages[0]).toMatchObject({role:'system',content:[{type:'text',text:expect.stringContaining(ROUTER_COMPACTION_INSTRUCTION)}]});
    expect(request.messages[0].content).toEqual([{type:'text',text:expect.stringContaining('Router must output action JSON.')}]);
    expect(request.messages[0].content).toEqual([{type:'text',text:expect.stringContaining('用户明确要求记住的代号、名字、数字及单位等必须在摘要中逐字保留')}]);
    expect(request.messages.slice(1).some(message=>message.role==='system')).toBe(false);
    expect(request.messages.at(-1)?.content).toEqual([{type:'text',text:ROUTER_COMPACTION_INSTRUCTION}]);
    expect(JSON.stringify(request.messages)).not.toContain('AI coding assistant');
    expect(result.compaction).toMatchObject({summaries:1,inputTokens:17,outputTokens:5});
    expect(result.usage).toEqual({inputTokens:34,outputTokens:10});
    expect(events.some(event=>event.type==='compaction/summary')).toBe(true);
    const current=JSON.stringify(adapter.main.at(-1)?.messages);
    expect(current).toContain(summary);expect(current).toContain(correction);expect(current).not.toContain(oldHistory);

    await runtime.close();
    const restoredAdapter=new Adapter(),restored=await mount(restoredAdapter,{root:directory});
    const resumed=await restored.runtime.start({id:'router-room',model:{provider:'mock',model:'route-current'},cwd:directory,systemPrompt:'Current Router policy.',resume:'auto'});
    await resumed.send('Latest host snapshot remains authoritative.');
    expect(JSON.stringify(restoredAdapter.main[0].messages)).toContain(summary);
    expect(JSON.stringify(restoredAdapter.main[0].messages)).toContain(correction);
    expect(JSON.stringify(restoredAdapter.main[0].messages)).not.toContain(oldHistory);
  });

  it.each(['max-tokens','empty','provider-error'] as const)('does not commit a %s summary or reuse the previous routing answer',async failure=>{
    const adapter=new Adapter(()=>failure==='max-tokens'
      ?[...response('incomplete summary').slice(0,-1),{type:'finish',reason:{kind:'max-tokens'}}]
      :failure==='empty'?response('   '):[{type:'finish',reason:{kind:'error',failure:{code:'TRANSPORT',message:'Summary unavailable'}}}]);
    const {runtime,directory}=await mount(adapter),events:SessionEvent[]=[];
    const agent=await runtime.start({id:'router-failure',model:{provider:'mock',model:'route-current'},cwd:directory,systemPrompt:'Router',maxContextChars:12_000,
      setup(ctx){ctx.on('session/event',(_session,event)=>{events.push(event);});}});
    await agent.send(oldHistory);
    await expect(agent.send('Only route this newest message.')).rejects.toThrow(/truncated|no text summary|Summary unavailable/);
    expect(adapter.summaries).toHaveLength(failure==='max-tokens'?2:failure==='provider-error'?6:1);expect(adapter.main).toHaveLength(1);
    if(failure==='max-tokens')expect(adapter.summaries.map(request=>request.maxTokens)).toEqual([16384,16384]);
    expect(events.some(event=>event.type==='compaction/summary')).toBe(false);
    expect(events.some(event=>event.type==='compaction/end'&&event.data.error)).toBe(true);
  });

  it('recovers truncation once with a consolidation instruction, accounts for both calls, and commits only the complete summary',async()=>{
    let calls=0;
    const adapter=new Adapter(()=>++calls===1
      ?[...response('discard this truncated partial checkpoint').slice(0,-1),{type:'finish',reason:{kind:'max-tokens'}}]
      :response(summary));
    const {runtime,directory}=await mount(adapter),events:SessionEvent[]=[];
    const agent=await runtime.start({id:'router-recovered',model:{provider:'mock',model:'route-current'},cwd:directory,systemPrompt:'Router',maxContextChars:12_000,
      setup(ctx){ctx.on('session/event',(_session,event)=>{events.push(event);});}});
    await agent.send(oldHistory);
    const result=await agent.send('Newest correction and quoted thread remain authoritative.');
    expect(adapter.summaries.map(request=>request.maxTokens)).toEqual([16384,16384]);
    expect(JSON.stringify(adapter.summaries[0].messages)).not.toContain(ROUTER_COMPACTION_RETRY_INSTRUCTION);
    expect(adapter.summaries[1].messages[0].content).toEqual([{type:'text',text:expect.stringContaining(ROUTER_COMPACTION_RETRY_INSTRUCTION)}]);
    expect(adapter.summaries[1].messages.at(-1)?.content).toEqual([{type:'text',text:expect.stringContaining(ROUTER_COMPACTION_RETRY_INSTRUCTION)}]);
    expect(JSON.stringify(adapter.summaries[1].messages)).not.toContain('discard this truncated');
    expect(adapter.summaries.every(request=>request.reasoningEffort===undefined)).toBe(true);
    expect(result.compaction).toMatchObject({summaries:1,inputTokens:34,outputTokens:10});
    expect(result.usage).toEqual({inputTokens:51,outputTokens:15});
    const checkpoints=events.filter(event=>event.type==='compaction/summary');
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0].data).toMatchObject({maxTokens:16384,usage:{inputTokens:34,outputTokens:10}});
    expect(checkpoints[0].data).not.toHaveProperty('llmStreamCall');
    expect(JSON.stringify(checkpoints)).not.toContain('discard this truncated');
    expect(JSON.stringify(adapter.main.at(-1)?.messages)).toContain('Newest correction and quoted thread');
  });

  it('preserves and restores the previous valid checkpoint after recovery is exhausted',async()=>{
    let calls=0;
    const adapter=new Adapter(()=>++calls===1?response(summary)
      :[...response('broken replacement').slice(0,-1),{type:'finish',reason:{kind:'max-tokens'}}]);
    const {runtime,directory}=await mount(adapter),events:SessionEvent[]=[];
    const agent=await runtime.start({id:'router-last-valid',model:{provider:'mock',model:'route-current'},cwd:directory,systemPrompt:'Router',maxContextChars:12_000,resume:'auto',
      setup(ctx){ctx.on('session/event',(_session,event)=>{events.push(event);});}});
    await agent.send(oldHistory);await agent.send('Keep player-A correction.');
    await expect(agent.send(oldHistory)).rejects.toMatchObject({code:'ROUTER_COMPACTION_TRUNCATED',message:expect.stringContaining('16384 -> 16384')});
    expect(adapter.summaries).toHaveLength(3);
    expect(events.filter(event=>event.type==='compaction/summary')).toHaveLength(1);
    await runtime.close();
    const restoredAdapter=new Adapter(),restored=await mount(restoredAdapter,{root:directory});
    const resumed=await restored.runtime.start({id:'router-last-valid',model:{provider:'mock',model:'route-current'},cwd:directory,systemPrompt:'Router',resume:'auto'});
    await resumed.send('Resume from the valid background.');
    expect(JSON.stringify(restoredAdapter.main[0].messages)).toContain(summary);
    expect(JSON.stringify(restoredAdapter.main[0].messages)).toContain('Keep player-A correction.');
    expect(JSON.stringify(restoredAdapter.main[0].messages)).not.toContain('broken replacement');
  });

  it.each([false,true])('forwards cancellation with truncation recovery=%s and does not persist a partial summary',async recover=>{
    let entered!:()=>void;const entering=new Promise<void>(resolve=>{entered=resolve;});
    let attempts=0;
    const adapter=new Adapter(async request=>{
      if(recover&&++attempts===1)return [...response('truncated').slice(0,-1),{type:'finish',reason:{kind:'max-tokens'}}];
      entered();
      await new Promise<void>((_resolve,reject)=>{request.signal?.throwIfAborted();request.signal?.addEventListener('abort',()=>reject(request.signal?.reason),{once:true});});
      return response('must not persist');
    });
    const {runtime,directory}=await mount(adapter),events:SessionEvent[]=[];
    const agent=await runtime.start({id:'router-cancel-summary',model:{provider:'mock',model:'route-current'},cwd:directory,systemPrompt:'Router',maxContextChars:12_000,
      setup(ctx){ctx.on('session/event',(_session,event)=>{events.push(event);});}});
    await agent.send(oldHistory);
    const pending=agent.send('Current message'),rejected=expect(pending).rejects.toMatchObject({code:'ABORTED'});
    await entering;await agent.cancel();await rejected;
    expect(adapter.summaries).toHaveLength(recover?2:1);
    expect(adapter.main).toHaveLength(1);
    expect(events.some(event=>event.type==='compaction/summary')).toBe(false);
  });

  it('enables one Router compactor while preserving Worker summarization',async()=>{
    const directory=await root(),adapter=new Adapter(),create=NativeAgentRuntime.create.bind(NativeAgentRuntime);
    vi.spyOn(NativeAgentRuntime,'create').mockImplementation(options=>create({...options,providers:undefined,adapters:{'boe-router':adapter,'boe-worker':adapter}}));
    const config=loadConfig(directory,{routerApiKey:'test-router',workerApiKey:'test-worker'}),pool=new NativeRuntimePool(directory);
    cleanup.push(()=>pool.close());
    for(const role of ['router','worker'] as const){
      const lease=await pool.acquire(role,config);let policy:BasicCompaction['config']|undefined;
      const agent=await lease.native.start({id:`${role}-pool`,model:{...lease.model,reasoningEffort:undefined},cwd:directory,systemPrompt:role,maxContextChars:12_000,
        setup(ctx){policy=(ctx.get('compaction') as BasicCompaction|undefined)?.config;}});
      await agent.send(oldHistory);
      if(role==='router'){
        expect(policy).toMatchObject({maxTokens:16384,thresholdRatio:0.8,headroomTokens:65536,retainRatio:0.16});
        await agent.send('Continue with the current request.');
        expect(adapter.summaries).toHaveLength(1);
        expect(adapter.summaries[0].messages[0].content).toEqual([{type:'text',text:expect.stringContaining(ROUTER_COMPACTION_INSTRUCTION)}]);
      }else{
        await agent.send('Continue with the current request.');
        const request=adapter.summaries.at(-1)!;
        expect(request).toMatchObject({provider:'boe-worker',model:config.worker.model,maxTokens:8192});
        expect(request.messages.some(message=>message.content.some(block=>block.type==='text'&&block.text.includes(ROUTER_COMPACTION_INSTRUCTION)))).toBe(false);
        expect(policy).toMatchObject({retainRatio:0.12,headroomTokens:8192});
      }
      await agent.dispose();await lease.release();
    }
  });

  it('keeps summary instructions at system priority on a provider without mid-conversation system support',async()=>{
    const requests:Array<{messages:Array<{role:string;content:string}>;max_tokens?:number;max_completion_tokens?:number}>=[];
    const server=createServer(async(req,res)=>{
      const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));
      const body=JSON.parse(Buffer.concat(chunks).toString());requests.push(body);
      const text=body.messages[0].content.includes(ROUTER_COMPACTION_INSTRUCTION)?summary:'Observed group details. '.repeat(100);
      res.writeHead(200,{'Content-Type':'text/event-stream'});
      const base={id:'local-summary-test',object:'chat.completion.chunk',created:1,model:'router-model'};
      res.write(`data: ${JSON.stringify({...base,choices:[{index:0,delta:{role:'assistant',content:text},finish_reason:null}]})}\n\n`);
      res.write(`data: ${JSON.stringify({...base,choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:17,completion_tokens:5,total_tokens:22}})}\n\n`);
      res.end('data: [DONE]\n\n');
    });
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
    cleanup.push(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));});
    const address=server.address();if(!address||typeof address==='string')throw new Error('Missing listener');
    const directory=await root(),keyEnv='BOE2_COMPACTION_TEST_'+randomUUID().replaceAll('-','');
    process.env[keyEnv]='local-test-key';cleanup.push(async()=>{delete process.env[keyEnv];});
    const runtime=await NativeAgentRuntime.create({root:directory,compactionRole:'router',
      compaction:{...ROUTER_COMPACTION_POLICY,summarizationProvider:'wire',summarizationModel:'router-model'},
      providers:{wire:{api:'openai-completions',baseURL:`http://127.0.0.1:${address.port}/v1`,apiKeyEnv:keyEnv,
        models:[{id:'router-model',input:['text'],contextWindow:1_000_000,reasoningEfforts:false}]}}});
    cleanup.push(()=>runtime.close());
    const agent=await runtime.start({id:'router-wire',model:{provider:'wire',model:'router-model'},cwd:directory,
      systemPrompt:'Router must output action JSON.',maxContextChars:12_000});
    await agent.send(oldHistory);await agent.send('Newest host input.');
    const auxiliary=requests.find(body=>body.messages[0].content.includes(ROUTER_COMPACTION_INSTRUCTION));
    expect(auxiliary).toBeDefined();
    expect(['system','developer']).toContain(auxiliary!.messages[0].role);
    expect(auxiliary!.messages[0].content).toContain('Router must output action JSON.');
    expect(auxiliary!.messages.at(-1)?.role).toBe('user');
    expect(auxiliary!.messages.at(-1)?.content).toBe(ROUTER_COMPACTION_INSTRUCTION);
    expect(auxiliary!.max_tokens??auxiliary!.max_completion_tokens).toBe(16384);
    expect(JSON.stringify(requests.at(-1))).toContain(summary);
  });

  it('honors explicit summary budgets through the model-aware pool and retires old policies on reload',async()=>{
    const directory=await root(),adapter=new Adapter(),create=NativeAgentRuntime.create.bind(NativeAgentRuntime);
    vi.spyOn(NativeAgentRuntime,'create').mockImplementation(options=>create({...options,providers:undefined,adapters:{'boe-router':adapter}}));
    const config=loadConfig(directory,{routerApiKey:'test-router',routerCompaction:{maxTokens:3072}}),pool=new NativeRuntimePool(directory);
    cleanup.push(()=>pool.close());
    const first=await pool.acquire('router',config);
    let original:BasicCompaction['config']|undefined;
    const agent=await first.native.start({id:'budget-original',model:{...first.model,reasoningEffort:undefined},cwd:directory,systemPrompt:'Router',maxContextChars:12_000,
      setup(ctx){original=(ctx.get('compaction') as BasicCompaction).config;}});
    await agent.send(oldHistory);await agent.send('Keep the current input.');
    expect(adapter.summaries[0].maxTokens).toBe(3072);
    const second=await pool.acquire('router',{...config,routerCompaction:{maxTokens:1536,thresholdTokens:96000,contextTokens:128000,headroomTokens:16384}});
    expect(second.native).not.toBe(first.native);
    let nextPolicy:BasicCompaction['config']|undefined;
    const updated=await second.native.start({id:'budget-updated',model:{...second.model,reasoningEffort:undefined},cwd:directory,systemPrompt:'Router',maxContextChars:12_000,
      setup(ctx){nextPolicy=(ctx.get('compaction') as BasicCompaction).config;}});
    await updated.send(oldHistory);await updated.send('Keep the new input.');
    expect(adapter.summaries[1].maxTokens).toBe(1536);
    expect(original?.maxTokens).toBe(3072);
    expect(original?.thresholdRatio).toBe(0.8);
    expect(nextPolicy?.thresholdRatio).toBe(96000/1_000_000);
    await agent.dispose();await updated.dispose();await first.release();await second.release();
  });

  it('clamps an explicit summary budget to the resolved model capacity',async()=>{
    class SmallAdapter extends Adapter {
      override async resolveModel(provider:string,model:string):Promise<LlmResolvedModelInfo>{
        return {provider,id:model,name:model,context:{contextWindow:32_000},defaultMaxTokens:5000};
      }
    }
    const {runtime,directory}=await mount(new SmallAdapter(),{compactionModel:{provider:'mock',model:'small',maxTokens:1200},routerCompaction:{headroomTokens:4096},compaction:{...ROUTER_COMPACTION_POLICY,maxTokens:16_384}});
    let policy:BasicCompaction['config']|undefined;
    const agent=await runtime.start({id:'small-summary',model:{provider:'mock',model:'small'},cwd:directory,systemPrompt:'Router',
      setup(ctx){policy=(ctx.get('compaction') as BasicCompaction).config;}});
    expect(policy?.maxTokens).toBe(5000);
    expect(policy?.headroomTokens).toBe(4096);
    expect(policy?.retainRatio).toBe(0.16);
    await agent.dispose();
  });

  it('does not compact at the old 48k limit when the model has room under the official policy',async()=>{
    class UsageAdapter extends Adapter {
      override async *stream(request:GenerateOptions):AsyncIterable<StreamChunk>{
        this.requests.push(request);
        for(const chunk of response('Still within the model working set.'))
          yield chunk.type==='usage'?{type:'usage',usage:{inputTokens:100000,outputTokens:10}}:chunk;
      }
    }
    const adapter=new UsageAdapter(),{runtime,directory}=await mount(adapter,{compactionModel:{provider:'mock',model:'large',maxTokens:8192}});
    const agent=await runtime.start({id:'official-window',model:{provider:'mock',model:'large',maxTokens:8192},cwd:directory,systemPrompt:'Router',
      maxContextTokens:1_000_000,maxContextBytes:4_000_000});
    await agent.send(oldHistory);await agent.send('Continue from the recent input.');
    expect(adapter.summaries).toHaveLength(0);
    expect(adapter.main).toHaveLength(2);
    expect(JSON.stringify(adapter.main[1].messages)).toContain(oldHistory);
    await agent.dispose();
  });

  it('requires explicit headroom for a small model instead of silently changing the official defaults',async()=>{
    class SmallAdapter extends Adapter {
      override async resolveModel(provider:string,model:string):Promise<LlmResolvedModelInfo>{
        return {provider,id:model,name:model,context:{contextWindow:32_000}};
      }
    }
    await expect(mount(new SmallAdapter(),{compactionModel:{provider:'mock',model:'small',maxTokens:1200}}))
      .rejects.toThrow('routerCompaction.headroomTokens');
  });
});

describe('Router summary snapshot projection',()=>{
  it('removes only exact repeated background, keeping new inputs, changed conditions, quotes and room boundaries',()=>{
    const member={id:'qq:room:member-message',messageId:'platform-message',authorId:'player-A',text:'User original condition. '.repeat(30)};
    const card={id:'thread-A',subject:'Document question',summary:'Unfinished task details. '.repeat(30),status:'running'};
    const current={...member,id:'current-id',text:'Correction: budget is now 10元.',replyToMessageId:'platform-message'};
    const host=(roomId:string,changed=false)=>({roomId,event:'messages',currentTime:changed?2:1,messages:[current],
      recentMessages:[member],recentReplies:[],threads:[changed?{...card,status:'completed'}:card],
      references:{'current-id':{status:'resolved',threadId:'thread-A',message:member}},addressing:{'current-id':{replyTo:{kind:'member',threadId:'thread-A'}}}});
    const user=(value:unknown)=>createUserMessage({content:[{type:'text',text:JSON.stringify(value)}],source:{kind:'user'}});
    const messages=[user(host('qq:room')),user(host('qq:other-room')),user(host('qq:room')),user(host('qq:room',true))];
    const original=JSON.stringify(messages),projected=projectRouterSummaryMessages(messages);
    const payloads=projected.map(message=>JSON.parse(message.content[0].type==='text'?message.content[0].text:''));
    expect(JSON.stringify(messages)).toBe(original);
    expect(projected).toHaveLength(messages.length);
    expect(payloads[0].recentMessages).toEqual([]);
    expect(payloads[0].threads).toEqual([]);
    expect(payloads[0].summaryProjection.removedExactDuplicates).toEqual({recentMessages:1,threads:1});
    expect(payloads[1]).toEqual(host('qq:other-room'));
    expect(payloads[2].threads).toEqual([card]);
    expect(payloads[3]).toEqual(host('qq:room',true));
    for(const payload of payloads){
      expect(payload.messages).toEqual([current]);
      expect(payload.references['current-id'].message).toEqual(member);
      expect(payload.addressing['current-id'].replyTo.threadId).toBe('thread-A');
    }
    expect(JSON.stringify(projected).length).toBeLessThan(original.length);
  });

  it('leaves opaque history and non-host JSON unchanged',()=>{
    const messages=['Previous valid checkpoint',JSON.stringify({messages:[],threads:[]}),JSON.stringify(null)]
      .map(text=>createUserMessage({content:[{type:'text',text}],source:{kind:'user'}}));
    expect(projectRouterSummaryMessages(messages)).toEqual(messages);
  });
});
