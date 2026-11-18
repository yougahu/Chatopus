import { mkdir, open } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import LlmRuntime, { BlockAssembler, createSystemMessage, createUserMessage, isAgentLoopRequest, markAgentLoopRequest, LlmError, ReasoningEffortId, type LlmAdapter, type ContentBlock, type StreamChunk } from '@deepseek-ai/dsh-llm';
import SessionStore, { Session, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session';
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native';
import AgentRegistry, { type AgentHandle, type CreateAgentOptions } from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import * as JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import { SessionPersistenceNotFoundError } from '@deepseek-ai/dsh-session-persistence';
import * as PiAi from '@deepseek-ai/dsh-llm-pi-ai';
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local';
import TokenMeter from '@deepseek-ai/dsh-token-meter';
import BasicCompaction, { type BasicCompactionConfig } from '@deepseek-ai/dsh-compaction-basic';
import ToolResultPruner from '@deepseek-ai/dsh-compaction-tool-result-pruner';
import type { ImageMediaType, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment';
import type { ModelSelection, ToolDefinition, RouterExecution } from '../types.js';
import { RouterCompaction } from './router-compaction.js';
import { retryModelStream } from './model-retry.js';
import { resolveRouterCompactionSettings, type RouterCompactionSettings } from './router-compaction-policy.js';
import { claimLogicalSession, DEFAULT_SESSION_MAX_BYTES, hasUnsettledWork, nextGeneration, readGeneration, surfaceSeed, writeGeneration, type SessionRotation, type SessionGeneration } from './session-generation.js';

export interface NativeRuntimeOptions {
  root: string;
  providers?: PiAi.Options['providers'];
  /** Test adapters use the real dsh loop, inbox, tools and persistence. */
  adapters?: Record<string, LlmAdapter>;
  /** Official dsh policy; false disables automatic compaction and host-limit recovery. */
  compaction?: BasicCompactionConfig | false;
  /** Router hosts summarize routing background; Workers retain the native policy. */
  compactionRole?: 'router';
  compactionModel?:ModelSelection;
  routerCompaction?:RouterCompactionSettings;
}
export interface NativeAgentOptions {
  id: string;
  model: ModelSelection;
  cwd: string;
  systemPrompt: string;
  tools?: ToolDefinition[];
  resume?: boolean | 'auto';
  /** Host owns durable Worker inputs; pending native inbox entries must not replay. */
  hostOwnedInputs?:boolean;
  maxSteps?: number;
  /** Reserve the last steps for an honest, bounded handoff rather than new research. */
  finishReserveSteps?:number;
  timeoutMs?: number;
  signal?: AbortSignal;
  maxContextChars?: number;
  /** Conservative model-input byte budget, excluding host IDs and replay metadata. */
  maxContextBytes?: number;
  maxContextTokens?:number;
  execution?:RouterExecution;
  onModelCall?:(call:NativeModelCall)=>void;
  /** Rotate the persisted audit log while preserving the current model-visible surface. */
  rotation?:SessionRotation;
  /** Trusted output-only conversion; callers must validate the complete current decision. */
  normalizeOutput?: (blocks:readonly ContentBlock[])=>string|undefined;
  /** Trusted host composition hook; registrations belong to this Agent only. */
  setup?: (ctx: Context) => void | Promise<void>;
}
export interface NativeImage {
  data: Uint8Array;
  mediaType: ImageMediaType;
  name?: string;
}
export interface NativeResult {
  text: string;
  sessionId: string;
  eventCount: number;
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens?:number; cacheWriteTokens?:number };
  promptHash?:string;
  toolsHash?:string;
  outputNormalizations?:number;
  compaction?: { summaries: number; prunedResults: number; inputTokens: number; outputTokens: number };
  status?:'completed'|'failed'|'superseded';
  code?:string;
  usageStatus?:'known'|'partial'|'unknown'|'not_called';
  modelCalls?:number;
  missingUsageCalls?:number;
  steps?:number;
  measurementId?:string;
}
export interface NativeModelCall {
  callId:string;sessionId:string;purpose:string;elapsedMs:number;startedAt:number;endedAt:number;code?:string;measurementId?:string;step?:number;
  status:'completed'|'failed';
  usage?:NativeResult['usage'];
}
export type NativeMeasurement=Omit<NativeResult,'text'>;

export class NativeRuntimeError extends LlmError {
  constructor(code: string, message: string) {
    super(message, code);
    this.name = 'NativeRuntimeError';
  }
}

/** Owns an actual Cordis host. Both roles use dsh's native AgentLoop. */
export class NativeAgentRuntime {
  private readonly ctx = new Context();
  private readonly agents = new Map<string, NativeAgent>();
  private closed = false;
  private automaticCompaction = false;
  private readonly executions=new Map<string,RouterExecution>();
  private readonly modelObservers=new Map<string,(call:NativeModelCall)=>void>();
  private readonly retryRequests = new WeakSet<object>();
  private constructor(private readonly options: NativeRuntimeOptions) {}

  async modelContext(model:ModelSelection,signal?:AbortSignal){
    return this.ctx.llm.resolveModelInfo(model.provider,model.model,signal);
  }

  static async create(options: NativeRuntimeOptions): Promise<NativeAgentRuntime> {
    const runtime = new NativeAgentRuntime(options);
    try { await runtime.mount(); return runtime; }
    catch (error) { await runtime.ctx.fiber.dispose(); throw error; }
  }

  private async mount(): Promise<void> {
    const ctx = this.ctx;
    await mkdir(resolve(this.options.root), { recursive: true, mode: 0o700 });
    await ctx.plugin(LlmRuntime);
    await ctx.plugin(SessionStore);
    await ctx.plugin(SessionProjectionRegistry);
    await ctx.plugin(SystemPrompt, { personaPrefix: '' });
    await ctx.plugin(ToolRuntime);
    await ctx.plugin(NativeToolExecutor);
    await ctx.plugin(AgentRegistry);
    await ctx.plugin(LocalAttachmentStore, { dshHome: resolve(this.options.root), maxImagesPerMessage: 4, maxImageBytes: 10 * 1024 * 1024 });
    await ctx.plugin(JsonlPersistence, { root: join(resolve(this.options.root), 'sessions'), compression: 'none' });
    await ctx.plugin(AgentLoop, { agents: [], maxParallelToolCalls: 1 });
    if (this.options.providers && Object.keys(this.options.providers).length) {
      await ctx.plugin(PiAi, { providers: this.options.providers });
    }
    for (const [provider, adapter] of Object.entries(this.options.adapters ?? {})) {
      ctx.llm.registerAdapter([provider], adapter);
    }
    ctx.on('llm/stream', (request, next) => {
      if (this.retryRequests.has(request)) return next();
      let first = true;
      return retryModelStream(() => {
        if (first) { first = false; return next(); }
        // Cordis continuations and prepared model calls are single-use. Each
        // retry dispatches a fresh call with the identical request snapshot.
        const retry = {...request}; this.retryRequests.add(retry);
        if (isAgentLoopRequest(request)) markAgentLoopRequest(retry);
        return ctx.llm.stream(retry);
      }, request.signal);
    });
    // This runs inside the retry middleware: each transport attempt, including an
    // unsuccessful summary, consumes the same durable business budget and reports usage.
    const executions=this.executions,modelObservers=this.modelObservers;
    ctx.on('llm/stream',async function*(request,next){
      const execution=request.sessionId?executions.get(request.sessionId):undefined;
      execution?.signal.throwIfAborted();execution?.consumeModelCall(request.purpose==='compaction');
      const started=Date.now(),assembler=new BlockAssembler();let code:string|undefined,finished=false;
      try{for await(const chunk of next()){assembler.push(chunk);if(chunk.type==='finish')finished=true;yield chunk;}
        const finish=assembler.finish;code=!finished?'INCOMPLETE_RESPONSE':finish.kind==='stop'||finish.kind==='tool-calls'?undefined:finish.kind==='error'||finish.kind==='aborted'?finish.failure.code:finish.kind;
      }catch(error){code=String((error as {code?:unknown})?.code??'MODEL_CALL_FAILED');throw error;}
      finally{
        const elapsedMs=Date.now()-started;
        try{execution?.onModelCall?.({purpose:request.purpose??'route',code,inputTokens:assembler.usage?.inputTokens??0,outputTokens:assembler.usage?.outputTokens??0,elapsedMs});}catch{/* observation only */}
        if(request.sessionId)modelObservers.get(request.sessionId)?.({callId:randomUUID(),sessionId:request.sessionId,purpose:request.purpose??'agent',elapsedMs,startedAt:started,endedAt:Date.now(),code,status:code?'failed':'completed',
          ...(assembler.usage?{usage:{...assembler.usage}}:{})});
      }
    });
    await ctx.plugin(TokenMeter);
    if (this.options.compaction !== false) {
      let policy = this.options.compaction ?? {};
      if(this.options.compactionRole==='router'&&this.options.compactionModel){
        const target=this.options.compactionModel,info=await ctx.llm.resolveModelInfo(target.provider,target.model);
        const window=info.context?.contextWindow;
        if(window){
          const budget=resolveRouterCompactionSettings(this.options.routerCompaction);
          const capacity=Math.min(window,budget.contextTokens??window);
          const output=target.maxTokens??info.defaultMaxTokens??0;
          const available=capacity-output-budget.headroomTokens;
          if(available<=0)throw new Error('Router model leaves no context capacity; reduce routerCompaction.headroomTokens or the output reservation');
          const threshold=Math.floor(Math.min(capacity*budget.thresholdRatio,budget.thresholdTokens??Infinity,available));
          const retained=Math.floor((capacity-output)*budget.retainRatio);
          if(retained>=threshold)throw new Error('Router retention reaches the pressure threshold; reduce routerCompaction.retainRatio or increase capacity');
          // Use dsh's full-window defaults unless an operator supplies a smaller
          // working set. Both pressure and retention then scale to that capacity.
          const {retainTokens:_,retainRatio:__,...rest}=policy;
          const capped=budget.contextTokens!==undefined||budget.thresholdTokens!==undefined;
          policy={...rest,thresholdRatio:capped?threshold/window:budget.thresholdRatio,headroomTokens:budget.headroomTokens,
            ...(capped?{retainTokens:retained}:{retainRatio:budget.retainRatio}),
            maxTokens:Math.min(policy.maxTokens??budget.maxTokens,info.defaultMaxTokens??16_384,Math.floor(window/4))};
        }
      }
      await ctx.plugin(ToolResultPruner);
      // Mount before the final size guard. Router capacity follows dsh defaults;
      // the auxiliary summary output budget stays independently bounded.
      await ctx.plugin(this.options.compactionRole==='router'?RouterCompaction:BasicCompaction, {
        thresholdRatio: 0.65, headroomTokens: 8192, maxTokens: 8192,
        ...(policy.retainTokens === undefined ? { retainRatio: 0.12 } : {}),
        maxOverflowRetries: 1, compactionRetries: 1, ...policy,
      });
      this.automaticCompaction = policy.auto !== false;
    }
  }

  async start(options: NativeAgentOptions): Promise<NativeAgent> {
    if (!/^[a-zA-Z0-9_-]{1,180}$/.test(options.id)) throw new NativeRuntimeError('INVALID_ID', 'Invalid session identity');
    const release=claimLogicalSession(this.options.root,options.id);
    try{return await this.startOwned(options,release);}catch(error){release();throw error;}
  }

  private async startOwned(options:NativeAgentOptions,release:()=>void):Promise<NativeAgent> {
    if (this.closed) throw new NativeRuntimeError('CLOSED', 'Runtime is closed');
    if (this.agents.has(options.id)) throw new NativeRuntimeError('AGENT_EXISTS', 'Agent is already active');
    if (!/^[a-zA-Z0-9_-]{1,180}$/.test(options.id)) throw new NativeRuntimeError('INVALID_ID', 'Invalid session identity');
    await mkdir(resolve(options.cwd), { recursive: true, mode: 0o700 });
    let steps = 0;
    const inFlightTools=new Set<Promise<unknown>>();
    const maxSteps = options.maxSteps ?? 30;
    if (!Number.isSafeInteger(maxSteps) || maxSteps < 1) throw new NativeRuntimeError('INVALID_LIMIT', 'maxSteps must be positive');
    const contextLimit = options.maxContextBytes ?? options.maxContextChars ?? 240_000;
    if (!Number.isSafeInteger(contextLimit) || contextLimit < 1) throw new NativeRuntimeError('INVALID_LIMIT', 'maxContextChars must be positive');
    let compactionFailure:string|undefined;
    const normalization={sessionId:undefined as string|undefined,count:0};
    const auditRoot=resolve(this.options.root);
    const setup = async (ctx: Context) => {
      if(this.options.compactionRole==='router')ctx.on('session/event',(session,event)=>{
        if(session.id===normalization.sessionId&&event.type==='compaction/end'&&event.data.error)compactionFailure=event.data.error;
      });
      if(options.normalizeOutput)ctx.on('llm/stream',async function*(request,next){
        // llm/stream is a host waterfall, even when registered by Agent setup.
        // Explicit identity excludes other live Agents and auxiliary summaries.
        if(!normalization.sessionId||request.sessionId!==normalization.sessionId||request.purpose!==undefined||!isAgentLoopRequest(request)){
          yield*next();return;
        }
        const chunks:StreamChunk[]=[],assembler=new BlockAssembler();let bytes=0,overflow=false;
        for await(const chunk of next()){
          request.signal?.throwIfAborted();
          if(overflow){yield chunk;continue;}
          chunks.push(structuredClone(chunk));assembler.push(chunk);bytes+=Buffer.byteLength(JSON.stringify(chunk));
          // A pathological provider response must not make buffering unbounded.
          if(bytes>4_000_000){overflow=true;yield*chunks;chunks.length=0;}
        }
        if(overflow)return;
        request.signal?.throwIfAborted();
        const finish=chunks.findLast(chunk=>chunk.type==='finish');
        const text=finish?.type==='finish'&&(finish.reason.kind==='stop'||finish.reason.kind==='tool-calls')
          ?options.normalizeOutput!(assembler.blocks()):undefined;
        if(text===undefined){yield*chunks;return;}
        const number=normalization.count+1;
        // Conversion changes the durable model message, so preserve the exact
        // provider stream separately before allowing the loop to accept it.
        await auditNormalizedOutput(auditRoot,normalization.sessionId,number,{provider:request.provider,model:request.model,chunks,text});
        request.signal?.throwIfAborted();normalization.count=number;
        yield {type:'text-delta',index:0,text};
        if(assembler.usage)yield {type:'usage',usage:assembler.usage};
        // Provider replay envelopes describe the original tool blocks and are
        // intentionally absent from the converted text response.
        yield {type:'finish',reason:{kind:'stop'}};
      });
      ctx.systemPrompt.section({ name: 'boe2', order: 0, text: options.systemPrompt, interpolate: false });
      if(options.finishReserveSteps)ctx.systemPrompt.context({name:'host-budget',order:1000,required:true,interpolate:false,text:()=>{
        const remaining=Math.max(0,maxSteps-steps);
        return remaining<=(options.finishReserveSteps??0)?`宿主剩余 ${remaining} 个模型步骤。现在收束：停止新增研究，保存必要的阶段产物并输出规定格式的报告。只列已核实结果、未完成项和下一步；未完成时不得标为 ready，不得声称未执行的保存或验证。`:steps>=Math.floor(maxSteps*.75)?`宿主已使用至少四分之三步骤预算，剩余 ${remaining} 步。缩小研究范围，优先完成当前验证并保存可恢复的阶段产物，预留最后步骤交付。`:'';
      }});
      for (const tool of options.tools ?? []) {
        ctx.tools.register({
          name: tool.name, description: tool.description,
          parameters: tool.inputSchema as never,
          output: { schema: {}, render: (_args, raw) => {
            const value = raw as unknown as { value: unknown; images: ImageAttachmentRef[] };
            return [{ type: 'text', text: typeof value.value === 'string' ? value.value : JSON.stringify(value.value) },
              ...value.images.map(attachment => ({ type: 'image' as const, attachment }))];
          } },
          execute: async (args, exec) => {
            options.signal?.throwIfAborted();exec.signal.throwIfAborted();
            const pending=Promise.resolve().then(async()=>{
              options.signal?.throwIfAborted();exec.signal.throwIfAborted();
              const value=await tool.execute(args,exec.signal);exec.signal.throwIfAborted();
              return projectToolImages(this.ctx,value);
            });
            inFlightTools.add(pending);
            try{return await pending;}finally{inFlightTools.delete(pending);}
          },
        });
      }
      // Reject impossible new inputs and exhausted work before spending a
      // compaction request; history enforcement runs after dsh's own hook.
      const contentBytes=(content:unknown):number=>Array.isArray(content)?content.reduce((total,block)=>{
        // The model sees text, not the JSON transport's second escaping of it.
        // Keep framing overhead, but never count host replay/source metadata.
        if((block?.type==='text'||block?.type==='reasoning')&&typeof block.text==='string')return total+Buffer.byteLength(block.text)+32;
        if(block?.type==='tool-call')return total+Buffer.byteLength(String(block.name??''))+Buffer.byteLength(String(block.arguments??''))+64;
        return total+Buffer.byteLength(JSON.stringify(block));
      },0):Buffer.byteLength(JSON.stringify(content)??'');
      const inputSize=(messages:readonly {role?:string;content:unknown}[])=>options.maxContextBytes===undefined
        ?JSON.stringify(messages).length:messages.reduce((total,message)=>total+contentBytes(message.content)+32,0);
      ctx.on('agent/pre-step', async (payload, next) => {
        options.signal?.throwIfAborted();payload.signal.throwIfAborted();
        const inputChars = inputSize(payload.messages);
        // Pending inputs are not yet in the session: never summarize or silently
        // truncate a new question which cannot fit even with no history.
        if (inputChars > contextLimit) throw new NativeRuntimeError('CONTEXT_LIMIT', 'Agent input exceeds the configured size limit');
        if (++steps > maxSteps) throw new NativeRuntimeError('STEP_LIMIT', 'Agent reached its step limit');
        return next();
      }, { prepend: true });
      ctx.on('agent/pre-step', async (payload, next) => {
        if(compactionFailure)throw new NativeRuntimeError('ROUTER_COMPACTION_FAILED',compactionFailure);
        const inputChars = inputSize(payload.messages);
        const tokens=()=>(ctx.get('tokenMeter') as TokenMeter).measure(payload.agent.session).totalTokens+payload.messages.reduce((sum,message)=>sum+(ctx.get('tokenMeter') as TokenMeter).estimateMessage(message),0)
          +(payload.agent.session.requestHeader()?0:(ctx.get('tokenMeter') as TokenMeter).estimateMessage(createSystemMessage(options.systemPrompt+JSON.stringify(options.tools??[]))))+(options.model.maxTokens??4096);
        const tooLarge=()=>size()>contextLimit||(options.maxContextTokens!==undefined&&tokens()>options.maxContextTokens);
        const size = () => {
          const history=payload.agent.session.deriveMessages();
          return inputSize(history)+inputChars+(options.maxContextBytes===undefined?0:
            Buffer.byteLength(JSON.stringify(options.tools?.map(t=>({name:t.name,description:t.description,parameters:t.inputSchema}))??[]))
            +(history.some(m=>m.role==='system')?0:Buffer.byteLength(options.systemPrompt)));
        };
        if (tooLarge() && this.automaticCompaction) {
          // A gateway may advertise a larger token window than our serialized
          // host budget. Normal token-pressure compaction alone can then skip
          // the exact sessions that hit this guard. Use dsh's durable pruning
          // and maximal balanced reduction before refusing those sessions.
          const pruner = ctx.get('toolResultPruner'), compactor = ctx.get('compaction');
          if (!pruner || !compactor) throw new NativeRuntimeError('COMPACTION_UNAVAILABLE', 'Official context compaction services are unavailable');
          pruner.pruneSession(payload.agent.session);
          if (tooLarge()) {
            await compactor.compactIfNeeded(payload.agent, 'context-overflow', payload.signal);
          }
          payload.signal.throwIfAborted();
        }
        if(compactionFailure)throw new NativeRuntimeError('ROUTER_COMPACTION_FAILED',compactionFailure);
        if (tooLarge()) throw new NativeRuntimeError('CONTEXT_LIMIT', 'Agent context still exceeds the configured size limit after compaction');
        return next();
      });
      await options.setup?.(ctx);
    };
    const generation=options.rotation?await readGeneration(this.options.root,options.id):undefined;
    const common = { sessionId: SessionId(generation?.activeId??options.id), agentOptions: { ...options.model, reasoningEffort: options.model.reasoningEffort ? ReasoningEffortId(options.model.reasoningEffort) : undefined }, setup, signal: options.signal };
    let handle: AgentHandle;
    if (options.resume === true || options.resume === 'auto') {
      try { handle = (generation?await this.rotate(generation,options,common):undefined)??await this.ctx.agents.resume({ ...common, resumeSessionId: common.sessionId }); }
      catch (error) {
        if (options.resume === 'auto' && !generation?.generation && error instanceof SessionPersistenceNotFoundError) {
          handle = await this.ctx.agents.create({ ...common, meta: { cwd: resolve(options.cwd) } });
        } else throw error;
      }
    } else handle = await this.ctx.agents.create({ ...common, meta: { cwd: resolve(options.cwd) } });
    if(options.hostOwnedInputs)handle.agent.cancel({kind:'user'},{keepInbox:false});
    // A configured model choice applies to this run even when history is restored.
    handle.agent.model.select({ provider: options.model.provider, model: options.model.model, ...(options.model.reasoningEffort ? { reasoningEffort: ReasoningEffortId(options.model.reasoningEffort) } : {}) });
    normalization.sessionId=handle.agent.session.id;
    if(options.execution)this.executions.set(handle.agent.session.id,options.execution);
    const calls:NativeModelCall[]=[];
    this.modelObservers.set(handle.agent.session.id,call=>{const observed={...call,measurementId:agent.measurementId,step:steps};calls.push(observed);try{options.onModelCall?.(observed);}catch{/* observation only */}});
    const agent = new NativeAgent(this.ctx, handle, {...options,id:handle.agent.session.id}, () => { steps = 0; }, () => {this.agents.delete(options.id);this.executions.delete(handle.agent.session.id);this.modelObservers.delete(handle.agent.session.id);release();},()=>normalization.count,()=>calls,()=>Math.min(steps,maxSteps),async()=>{await Promise.allSettled([...inFlightTools]);});
    this.agents.set(options.id, agent);
    return agent;
  }

  private async rotate(generation:SessionGeneration,options:NativeAgentOptions,common:CreateAgentOptions):Promise<AgentHandle|undefined> {
    const maxBytes=options.rotation?.maxBytes??DEFAULT_SESSION_MAX_BYTES;
    if(!Number.isSafeInteger(maxBytes)||maxBytes<1000)throw new NativeRuntimeError('INVALID_LIMIT','Session rotation byte limit must be at least 1000');
    const stat=await this.ctx.sessionPersistence.stat(SessionId(generation.activeId),{signal:options.signal});
    if(!stat?.sizeBytes||stat.sizeBytes<maxBytes)return;
    // Exclusive access keeps the source prefix stable through the pointer commit.
    // It is read without resuming: the old log receives no lifecycle events.
    // The JSONL backend memoizes cold logs. Use a disposable reader so a large
    // legacy archive does not remain cached in the long-lived model host.
    const reader=new Context();
    await reader.plugin(JsonlPersistence,{root:join(resolve(this.options.root),'sessions'),compression:'none'});
    let source:Awaited<ReturnType<typeof reader.sessionPersistence.open>>|undefined;
    let target:AgentHandle|undefined;
    try{
      source=await reader.sessionPersistence.open(SessionId(generation.activeId),'write',{signal:options.signal});
      if((await readGeneration(this.options.root,options.id)).activeId!==generation.activeId)throw new NativeRuntimeError('GENERATION_CHANGED','Session generation changed during rotation; retry from the current pointer');
      const loaded=await source.read(0,undefined,{signal:options.signal});
      if(hasUnsettledWork(loaded.events))return; // dsh owns interrupted-turn/inbox recovery.
      const restored=Session.fromRestore(source.id,loaded.events,source.header,source.inheritedEventCount,loaded.eventState,this.ctx.sessions.messageProjections);
      const next=nextGeneration(generation,restored.deriveMessages());
      const seed=surfaceSeed(restored,next.activeId);
      // No lossy truncation to satisfy disk budgets. Normal context compaction
      // can reduce an unusually large effective surface before the next rotation.
      if(Buffer.byteLength(JSON.stringify(seed))>=stat.sizeBytes*0.85)return;
      options.signal?.throwIfAborted();
      target=await this.ctx.agents.create({...common,sessionId:SessionId(next.activeId),seed,meta:{cwd:resolve(options.cwd)}});
      if(JSON.stringify(target.agent.session.deriveMessages())!==JSON.stringify(restored.deriveMessages()))throw new Error('Created generation changed model-visible history');
      await this.ctx.sessions.flush(target.agent.session);
      options.signal?.throwIfAborted();
      await writeGeneration(this.options.root,next);
      return target;
    }catch(error){await target?.dispose();throw error;}
    finally{try{await source?.close();}finally{await reader.fiber.dispose();}}
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await Promise.all([...this.agents.values()].map(agent => agent.dispose()));
    await this.ctx.fiber.dispose();
  }
}

/** One owned dsh session; send waits for the complete turn, steer enters its next step. */
export class NativeAgent {
  private active?: Promise<NativeResult>;
  private disposed = false;
  private abortReason?: string;
  lastMeasurement?:NativeMeasurement;
  private measurementKey?:string;
  constructor(private readonly ctx: Context, private readonly handle: AgentHandle,
    private readonly options: NativeAgentOptions, private readonly resetSteps: () => void,
    private readonly onDispose: () => void,private readonly outputNormalizationCount:()=>number=()=>0,
    private readonly modelCalls:()=>readonly NativeModelCall[]=()=>[],private readonly stepCount:()=>number=()=>0,private readonly settleTools:()=>Promise<void>=async()=>{}) {}

  get sessionId(): string { return this.options.id; }
  get measurementId():string|undefined {return this.measurementKey;}
  get usedSteps():number {return this.stepCount();}

  send(text: string, images: NativeImage[] = [], options: { continueBudget?: boolean } = {}): Promise<NativeResult> {
    if (this.disposed) return Promise.reject(new NativeRuntimeError('DISPOSED', 'Agent is disposed'));
    if (this.active) return Promise.reject(new NativeRuntimeError('BUSY', 'Use steer for an active turn'));
    if (!options.continueBudget) this.resetSteps();
    this.abortReason = undefined;
    this.lastMeasurement=undefined;this.measurementKey=randomUUID();
    const promise = this.execute(text, images);
    this.active = promise;
    void promise.finally(() => { if (this.active === promise) this.active = undefined; }).catch(() => {});
    return promise;
  }

  private async execute(text: string, images: NativeImage[]): Promise<NativeResult> {
    const signal = this.options.signal;
    const start = this.handle.agent.session.snapshotEvents().length;
    const callStart=this.modelCalls().length;
    const stepStart=this.usedSteps;
    const normalizedBefore=this.outputNormalizationCount();
    let timer:ReturnType<typeof setTimeout>|undefined,result:NativeResult|undefined,code:string|undefined;
    const cancel = () => { this.abortReason = signal?.reason?.code==='SUPERSEDED'?'SUPERSEDED':'ABORTED'; this.handle.agent.cancel({ kind: 'user' }, { keepInbox: !this.options.hostOwnedInputs }); };
    try {
      signal?.throwIfAborted();
      const content: ContentBlock[] = [{ type: 'text', text }];
      for (const attachment of await this.ctx.attachments.saveImages(images)) content.push({ type: 'image', attachment });
      signal?.throwIfAborted();
      signal?.addEventListener('abort', cancel, { once: true });
      timer = setTimeout(() => { this.abortReason = 'TIMEOUT'; this.handle.agent.cancel({ kind: 'user' }, { keepInbox: !this.options.hostOwnedInputs }); }, this.options.timeoutMs ?? 180_000);
      await this.handle.agent.followup(createUserMessage({ content, source: { kind: 'user' } }));
      await this.handle.agent.whenIdle();
      await this.ctx.sessions.flush(this.handle.agent.session);
      if (this.abortReason) throw new NativeRuntimeError(this.abortReason, 'Agent execution was cancelled or timed out');
      const session=this.handle.agent.session,events=session.snapshotEvents();
      const system=events.findLast(event=>event.type==='system/message');
      const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
      result={...resultOf(this.options.id,events.slice(start)),
        promptHash:hash(system?.type==='system/message'?system.data.message.content:[]),
        toolsHash:hash(session.requestHeader()?.tools??[]),
        ...(this.outputNormalizationCount()>normalizedBefore?{outputNormalizations:this.outputNormalizationCount()-normalizedBefore}:{})};
      return result;
    } catch(error){code=this.abortReason??String((error as {code?:unknown})?.code??'AGENT_FAILED');throw error;}
    finally {
      clearTimeout(timer); signal?.removeEventListener('abort', cancel);
      const calls=this.modelCalls().slice(callStart),usage:NativeResult['usage']={inputTokens:0,outputTokens:0};
      for(const call of calls)if(call.usage)for(const key of ['inputTokens','outputTokens','cacheReadTokens','cacheWriteTokens'] as const){
        const value=call.usage[key];if(value!==undefined)usage[key]=(usage[key]??0)+value;
      }
      const missingUsageCalls=calls.filter(call=>!call.usage).length;
      this.lastMeasurement={measurementId:this.measurementKey,sessionId:this.sessionId,eventCount:this.handle.agent.session.snapshotEvents().length-start,
        usage,status:result?'completed':code==='SUPERSEDED'?'superseded':'failed',code,modelCalls:calls.length,missingUsageCalls,steps:this.usedSteps-stepStart,
        usageStatus:!calls.length?'not_called':missingUsageCalls===calls.length?'unknown':missingUsageCalls?'partial':'known',
        ...(result?{promptHash:result.promptHash,toolsHash:result.toolsHash,compaction:result.compaction,outputNormalizations:result.outputNormalizations}:{})};
      if(result)Object.assign(result,this.lastMeasurement);
    }
  }

  async steer(text: string, images: NativeImage[] = []): Promise<void> {
    if (this.disposed) throw new NativeRuntimeError('DISPOSED', 'Agent is disposed');
    // dsh steer wakes an idle agent. Only inject into the send lifecycle we own;
    // the coordinator persists early/late inputs and schedules a complete rerun.
    if (!this.active || this.handle.agent.status !== 'running') return;
    const content: ContentBlock[] = [{ type: 'text', text }];
    if (images.length) for (const attachment of await this.ctx.attachments.saveImages(images)) content.push({ type: 'image', attachment });
    if (this.disposed) throw new NativeRuntimeError('DISPOSED', 'Agent is disposed');
    if (!this.active || this.handle.agent.status !== 'running') return;
    this.options.signal?.throwIfAborted();
    this.handle.agent.steer(createUserMessage({ content, source: { kind: 'user' } }));
  }
  wait(): Promise<NativeResult> {
    return this.active ?? Promise.reject(new NativeRuntimeError('NO_RUN', 'Agent has no pending run'));
  }
  async cancel(reason='ABORTED'): Promise<void> {
    this.abortReason = reason;
    this.handle.agent.cancel({ kind: 'user' }, { keepInbox: !this.options.hostOwnedInputs });
    await this.handle.agent.whenIdle();
    await this.ctx.sessions.flush(this.handle.agent.session);
  }
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.abortReason = 'DISPOSED';
    try { await this.handle.dispose(); } finally { try{await this.settleTools();}finally{this.onDispose();} }
  }
}

async function auditNormalizedOutput(root:string,sessionId:string,number:number,response:{provider:string;model:string;chunks:StreamChunk[];text:string}):Promise<void>{
  const folder=join(root,'output-normalizations',sessionId);
  await mkdir(folder,{recursive:true,mode:0o700});
  const file=await open(join(folder,`${String(number).padStart(6,'0')}-${randomUUID()}.json`),'wx',0o600);
  try{await file.writeFile(JSON.stringify({version:1,sessionId,number,createdAt:new Date().toISOString(),...response})+'\n');await file.sync();}
  finally{await file.close();}
}

function resultOf(sessionId: string, events: readonly SessionEvent[]): NativeResult {
  const end = events.findLast(event => event.type === 'turn/end');
  if (!end || end.type !== 'turn/end') throw new NativeRuntimeError('NO_RESULT', 'Agent did not finish a turn');
  if (end.data.reason.kind !== 'completed') {
    const reason = end.data.reason;
    throw new NativeRuntimeError(reason.kind === 'error' ? reason.error.code : reason.kind,
      reason.kind === 'error' ? reason.error.message : `Agent ended with ${reason.kind}`);
  }
  const assistants = events.filter(event => event.type === 'assistant/message');
  const last = assistants.at(-1);
  const text = last?.type === 'assistant/message'
    ? last.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('\n') : '';
  const usage:NativeResult['usage'] = { inputTokens: 0, outputTokens: 0 };
  for (const event of assistants) {
    if (event.type !== 'assistant/message') continue;
    usage.inputTokens += event.data.usage?.inputTokens ?? 0;
    usage.outputTokens += event.data.usage?.outputTokens ?? 0;
    for(const key of ['cacheReadTokens','cacheWriteTokens'] as const){
      const value=event.data.usage?.[key];if(value!==undefined)usage[key]=(usage[key]??0)+value;
    }
  }
  const compaction = { summaries: 0, prunedResults: 0, inputTokens: 0, outputTokens: 0 };
  for (const event of events) {
    if (event.type === 'compaction/prune') compaction.prunedResults++;
    if (event.type !== 'compaction/summary') continue;
    compaction.summaries++;
    compaction.inputTokens += event.data.usage?.inputTokens ?? 0;
    compaction.outputTokens += event.data.usage?.outputTokens ?? 0;
    for(const key of ['cacheReadTokens','cacheWriteTokens'] as const){
      const value=event.data.usage?.[key];if(value!==undefined)usage[key]=(usage[key]??0)+value;
    }
  }
  usage.inputTokens += compaction.inputTokens;
  usage.outputTokens += compaction.outputTokens;
  if (!text) throw new NativeRuntimeError('EMPTY_RESULT', 'Agent returned no text result');
  return { text, sessionId, eventCount: events.length, usage,
    ...(compaction.summaries || compaction.prunedResults ? { compaction } : {}) };
}

/** MCP screenshots remain image content, never multi-megabyte base64 prompt text. */
async function projectToolImages(ctx: Context, value: unknown): Promise<{ value: unknown; images: ImageAttachmentRef[] }> {
  const images: ImageAttachmentRef[] = [];
  if (!value || typeof value !== 'object' || !Array.isArray((value as {content?:unknown}).content)) return { value, images };
  const source = value as Record<string, unknown> & { content: unknown[] };
  const content: unknown[] = [];
  for (const block of source.content) {
    if (!block || typeof block !== 'object' || (block as {type?:string}).type !== 'image') { content.push(block); continue; }
    const b = block as { data?:unknown; mimeType?:unknown };
    if (typeof b.data !== 'string' || typeof b.mimeType !== 'string' || !/^image\/(png|jpeg|webp|gif)$/.test(b.mimeType)) throw new NativeRuntimeError('IMAGE_FORMAT', 'Tool returned an unsupported image');
    if (images.length >= 4 || b.data.length > 14_000_000) throw new NativeRuntimeError('IMAGE_LIMIT', 'Tool image exceeds configured limits');
    images.push(await ctx.attachments.saveImage({ data: Buffer.from(b.data, 'base64'), mediaType: b.mimeType as ImageMediaType }));
    content.push({ type: 'text', text: '[Image attached below]' });
  }
  return { value: { ...source, content }, images };
}
