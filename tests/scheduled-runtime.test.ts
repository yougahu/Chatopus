import { afterEach,describe,expect,it,vi } from 'vitest';
import { mkdtemp,rm,writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LlmAdapter,ToolCallId,type GenerateOptions,type StreamChunk } from '@deepseek-ai/dsh-llm';
import { createRouterScheduleQueryTool,createWorkerScheduleTool,scheduleModelMutationSchema } from '../src/scheduled-tasks/tools.js';
import { enforceReferenceThreads,parseRoutesForRequest,parseReport } from '../src/protocol.js';
import { prepareWorkerContext } from '../src/runtime/worker-context.js';
import { currentTaskQuestion } from '../src/runtime/task-scope.js';
import { DshRuntime,type DshOptions } from '../src/dsh-runtime.js';
import { NativeAgentRuntime } from '../src/runtime/native.js';
import { loadConfig } from '../src/config.js';
import { buildRouterPayload } from '../src/router-context-builder.js';
import { routerThreadCard } from '../src/runtime/router-recall.js';
import { scheduledExecutionConfigRevision } from '../src/scheduled-tasks/execution-config.js';
import type { GroupMessage,RouterRequest,WorkerRequest } from '../src/types.js';

const cleanup:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
const message:GroupMessage={id:'room:1',messageId:'1',roomId:'room',platform:'replay',authorId:'alice',authorName:'Alice',text:'列出我的任务',timestamp:1,isAdmin:false,isMentioned:true,mentions:[],attachments:[],memberRoleGroup:'member',roleVerifiedAt:1};
const routerRequest:RouterRequest={roomId:'room',event:'messages',messages:[message],recentMessages:[],threads:[]};
const create={op:'create' as const,input:{title:'整理记录',executionKind:'worker' as const,content:'整理新增记录并报告数量',scheduleSpec:{kind:'interval' as const,anchorAt:3_600_000,intervalMs:3_600_000},timezone:'Asia/Shanghai'}};
function request(root:string,scheduled=false):WorkerRequest {
  return {runId:'run1',workspace:join(root,'work'),inputs:scheduled?[]:[{seq:1,revision:1,kind:'question',message}],
    thread:{id:'t1',roomId:'room',ownerId:scheduled?'':'alice',sourceMessageId:scheduled?'':'1',subject:'整理记录',status:'running',explicit:true,participants:scheduled?[]:['alice'],revision:1,latestInputSeq:1,sessionId:'worker-t1',epoch:1,summary:'',
      ...(scheduled?{scheduledTask:{scheduleId:'s1',scheduleRunId:'sr1',authority:'system' as const,generation:1,title:'每日记录'}}:{})},
    ...(scheduled?{scheduledInput:{kind:'scheduled' as const,scheduleId:'s1',scheduleRunId:'sr1',authority:'system' as const,ownerId:null,roomId:'room',title:'每日记录',instructions:'整理新增记录并报告数量',scheduledAt:3_600_000,sourceRefs:[]}}:{}),
  };
}
function report(extra:Record<string,unknown>={}){return {threadId:'t1',runId:'run1',coveredInputSeq:1,basedOnRevision:1,status:'ready',shortAnswer:'整理完成，新增3条。',assumptions:[],evidenceRefs:[],openQuestions:[],...extra};}
function text(value:unknown):StreamChunk[]{const text=JSON.stringify(value);return [{type:'block-start',index:0,blockType:'text'},{type:'text-delta',index:0,text},{type:'block-end',index:0,block:{type:'text',text}},{type:'finish',reason:{kind:'stop'}}];}
function tool(name:string,args:unknown):StreamChunk[]{return [{type:'block-start',index:0,blockType:'tool-call'},{type:'block-end',index:0,block:{type:'tool-call',id:ToolCallId('tool-1'),name,arguments:JSON.stringify(args)}},{type:'finish',reason:{kind:'tool-calls'}}];}
class Adapter extends LlmAdapter {
  requests:GenerateOptions[]=[];
  constructor(readonly respond:(request:GenerateOptions,index:number)=>StreamChunk[]){super();}
  async *stream(request:GenerateOptions):AsyncIterable<StreamChunk>{for(const chunk of this.respond(request,this.requests.push(request)-1))yield chunk;}
}
async function fixture(adapter:Adapter,options:Partial<DshOptions>={}){
  const root=await mkdtemp(join(tmpdir(),'boe2-scheduled-runtime-'));cleanup.push(()=>rm(root,{recursive:true,force:true}));
  const config=loadConfig(root,{stateDir:join(root,'state'),router:{provider:'mock',model:'router'},worker:{provider:'mock',model:'worker'},maxWorkerSteps:12});
  const native=await NativeAgentRuntime.create({root:join(root,'dsh'),adapters:{mock:adapter},compaction:false});
  const runtime=await DshRuntime.create(config,{native,capabilityFactory:async()=>({tools:[],systemContext:'',close:async()=>{}}),...options});
  cleanup.push(()=>runtime.close());return {root,runtime,config};
}

describe('scheduled task model boundaries',()=>{
  it('accepts explicit recipients in registrations and patches while keeping them visible in query summaries',async()=>{
    const operation={...create,input:{...create.input,recipientIds:['alice','bob']}};
    expect(parseRoutesForRequest(JSON.stringify([{action:'manage_schedule',sourceMessageIds:[message.id],operation}]),routerRequest)[0]).toMatchObject({operation});
    expect(scheduleModelMutationSchema.parse({op:'update',id:'s1',expectedVersion:1,patch:{recipientIds:[]}})).toMatchObject({patch:{recipientIds:[]}});
    expect(()=>scheduleModelMutationSchema.parse({...create,input:{...create.input,recipientIds:[123]}})).toThrow();
    const propose=vi.fn(async()=>({id:'p1',status:'proposed'}));
    const worker=createWorkerScheduleTool(request('/tmp'),{query:async()=>[],propose});
    await worker.execute({operation:'propose',slot:'reminder',mutation:operation});
    expect(propose.mock.calls[0]).toEqual([operation,'reminder',undefined]);
    const query=createRouterScheduleQueryTool(routerRequest,async()=>({items:[{id:'s1',recipientIds:['alice','bob']}],total:1,hasMore:false}));
    expect(await query.execute({sourceMessageId:message.id,query:{operation:'list'}})).toMatchObject({items:[{recipientIds:['alice','bob']}]});
  });
  it('accepts one-author registration but rejects identity injection and multi-author registration',()=>{
    expect(parseRoutesForRequest(JSON.stringify([{action:'manage_schedule',sourceMessageIds:[message.id],operation:create}]),routerRequest)[0]).toMatchObject({operation:create});
    expect(()=>scheduleModelMutationSchema.parse({...create,input:{...create.input,roomId:'other'}})).toThrow();
    expect(()=>scheduleModelMutationSchema.parse({...create,input:{...create.input,authority:'system',ownerId:'admin'}})).toThrow();
    const second={...message,id:'room:2',messageId:'2',authorId:'bob'};
    expect(()=>parseRoutesForRequest(JSON.stringify([{action:'manage_schedule',sourceMessageIds:[message.id,second.id],operation:create}]),{...routerRequest,messages:[message,second]})).toThrow('one current request author');
  });
  it('allows a near-future once but rejects an interval shorter than an hour',()=>{
    expect(scheduleModelMutationSchema.parse({...create,input:{...create.input,scheduleSpec:{kind:'once',at:60_000}}})).toMatchObject({input:{scheduleSpec:{kind:'once'}}});
    expect(()=>scheduleModelMutationSchema.parse({...create,input:{...create.input,scheduleSpec:{kind:'interval',anchorAt:0,intervalMs:3_599_999}}})).toThrow();
    expect(()=>scheduleModelMutationSchema.parse({...create,input:{...create.input,content:'x'.repeat(12001)}})).toThrow();
    expect(()=>scheduleModelMutationSchema.parse({...create,input:{...create.input,timeoutMs:24*3_600_000+1}})).toThrow();
  });
  it('does not bind a new question or a schedule control to a quoted system execution',()=>{
    const thread=request('/tmp',true).thread;
    const supplied={...routerRequest,threads:[thread],references:{[message.id]:{status:'resolved',threadId:thread.id,chain:[]}}};
    const open={action:'open_thread' as const,sourceMessageIds:[message.id],subject:'解释刚才的公开结果'};
    expect(enforceReferenceThreads([open],supplied)).toEqual([open]);
    expect(enforceReferenceThreads([open],{...supplied,threads:[{...thread,scheduledTask:{...thread.scheduledTask!,authority:'user'}}]})).toEqual([open]);
    const control={action:'manage_schedule' as const,sourceMessageIds:[message.id],operation:{op:'cancel' as const,id:'s2',expectedVersion:1}};
    expect(enforceReferenceThreads([control],supplied)).toEqual([control]);
    expect(JSON.parse(buildRouterPayload(supplied,{recentMessageLimit:5,threadCardLimit:5},true)).threads[0].scheduledTask).toEqual(thread.scheduledTask);
    expect(routerThreadCard(thread).scheduledTask).toEqual(thread.scheduledTask);
    const combined={...open,scheduleOperations:[create]};
    expect(enforceReferenceThreads([combined],{...supplied,threads:[{...thread,scheduledTask:undefined}]})).toEqual([combined]);
    const multiSource={...combined,sourceMessageIds:[message.id,'room:2']};
    expect(enforceReferenceThreads([multiSource],{...supplied,references:{...supplied.references,'room:2':{status:'resolved',threadId:'t2',chain:[]}}})).toEqual([multiSource]);
    const multiControl={...control,sourceMessageIds:multiSource.sourceMessageIds};
    expect(enforceReferenceThreads([multiControl],{...supplied,references:{...supplied.references,'room:2':{status:'resolved',threadId:'t2',chain:[]}}})).toEqual([multiControl]);
  });
  it('binds Router queries to a current source without owner or room overrides',async()=>{
    const query=vi.fn(async()=>({items:[],total:0,hasMore:false}));
    const t=createRouterScheduleQueryTool(routerRequest,query);
    await t.execute({sourceMessageId:message.id,query:{operation:'list'}});
    expect(query).toHaveBeenCalledWith(message.id,{operation:'list'},undefined);
    await expect(t.execute({sourceMessageId:'older-message',query:{operation:'list'}})).rejects.toThrow('outside');
    await expect(t.execute({sourceMessageId:message.id,query:{operation:'list',ownerId:'bob'}})).rejects.toThrow();
    expect(query).toHaveBeenCalledTimes(1);
  });
  it('stages exact Worker proposals and excludes recursive scheduled execution tools',async()=>{
    const req=request('/tmp'),propose=vi.fn(async()=>({id:'proposal-1',status:'proposed'}));
    const t=createWorkerScheduleTool(req,{query:async()=>({items:[]}),propose});
    expect(await t.execute({operation:'propose',slot:'daily-summary',mutation:create})).toEqual({id:'proposal-1',status:'proposed'});
    expect(propose).toHaveBeenCalledWith(create,'daily-summary',undefined);
    const withdrawal={op:'withdraw_proposal',id:'proposal-1'};
    expect(parseRoutesForRequest(JSON.stringify([{action:'manage_schedule',sourceMessageIds:[message.id],operation:withdrawal}]),routerRequest)[0]).toMatchObject({operation:withdrawal});
    await expect(t.execute({operation:'propose',slot:'withdraw',mutation:withdrawal})).rejects.toThrow();
    expect(parseReport(JSON.stringify(report({scheduleProposalIds:['proposal-1']}))).scheduleProposalIds).toEqual(['proposal-1']);
    expect(()=>createWorkerScheduleTool(request('/tmp',true),{query:async()=>[],propose})).toThrow('recursively');
  });
  it('keeps list/history responses bounded without truncating get instructions',async()=>{
    const content='说明'.repeat(16_000),entry={id:'s1',title:'记录',content,version:1,canManage:true};
    const t=createRouterScheduleQueryTool(routerRequest,async(_source,query)=>query.operation==='get'?entry:{items:Array.from({length:10},()=>entry),total:20,hasMore:true,nextOffset:10});
    const listed=await t.execute({sourceMessageId:message.id,query:{operation:'list'}}) as {items:unknown[];nextOffset:number};
    expect(listed.items).toHaveLength(10);expect(listed.items[0]).toEqual({id:'s1',title:'记录',version:1,canManage:true});expect(listed.nextOffset).toBe(10);
    expect(await t.execute({sourceMessageId:message.id,query:{operation:'get',id:'s1'}})).toEqual(entry);
  });
});

describe('explicit scheduled input provenance',()=>{
  it('keeps a system instruction separate from chat messages and user checkpoints',async()=>{
    const req=request('/tmp',true),context=await prepareWorkerContext(req,{persist:false});
    expect(context.selectedInputs).toEqual([]);
    expect(context.inputs[0]).toMatchObject({kind:'scheduled',sourceRole:'host',authority:'system',ownerId:null,instructions:req.scheduledInput!.instructions});
    expect(context.inputs[0]).not.toHaveProperty('message');
    expect(currentTaskQuestion([],req.scheduledInput)).toBe(req.scheduledInput!.instructions);
    expect(()=>context.validateCandidateState({byAuthor:[{authorId:'system',text:'fake',sourceSeqs:[1]}]})).toThrow('user-author');
    context.close();
  });
  it('requires complete paginated instructions and rejects foreign source binding',async()=>{
    const req=request('/tmp',true);req.scheduledInput!.instructions='完整任务条件。'.repeat(15_000);
    const context=await prepareWorkerContext(req,{persist:false,maxChars:8000});
    expect(context.unreadCurrentInputs()).toHaveLength(1);expect(()=>context.assertReady({status:'ready'})).toThrow();
    for(let offset=context.unreadCurrentInputs()[0].offset;offset<req.scheduledInput!.instructions.length;offset+=8000){
      await context.tools[0].execute({operation:'read',seq:1,part:'scheduled_instruction',offset});
    }
    expect(context.unreadCurrentInputs()).toEqual([]);expect(()=>context.assertReady({status:'ready'})).not.toThrow();context.close();
    await expect(prepareWorkerContext({...req,scheduledInput:{...req.scheduledInput!,roomId:'other'}},{persist:false})).rejects.toThrow('binding');
    await expect(prepareWorkerContext({...req,inputs:request('/tmp').inputs},{persist:false})).rejects.toThrow('binding');
  });
});

describe('native scheduled task runtime tools',()=>{
  it('answers a personal task query through the Router native tool without starting a Worker',async()=>{
    const query=vi.fn(async()=>({items:[{id:'s1',title:'每日记录',version:1}],total:1,hasMore:false}));
    const adapter=new Adapter((call,index)=>index===0?tool('scheduled_tasks_query',{sourceMessageId:message.id,query:{operation:'list'}}):text([{action:'reply_direct',sourceMessageIds:[message.id],text:'你有一个任务：每日记录。'}]));
    const {runtime}=await fixture(adapter);
    expect(await runtime.route(routerRequest,undefined,undefined,[createRouterScheduleQueryTool(routerRequest,query)])).toMatchObject([{action:'reply_direct'}]);
    expect(query).toHaveBeenCalledOnce();expect(adapter.requests).toHaveLength(2);
  });
  it('returns staged proposal IDs in a Worker report without claiming a host commit',async()=>{
    const adapter=new Adapter((_call,index)=>index===0?tool('scheduled_tasks',{operation:'propose',slot:'daily',mutation:create}):text(report({scheduleProposalIds:['proposal-1']})));
    const {runtime,root}=await fixture(adapter),req=request(root),propose=vi.fn(async()=>({id:'proposal-1',status:'proposed'}));
    req.taskTools=[createWorkerScheduleTool(req,{query:async()=>({items:[]}),propose})];
    const result=await runtime.runWorker(req);
    expect(propose).toHaveBeenCalledOnce();expect(result.scheduleProposalIds).toEqual(['proposal-1']);expect(adapter.requests).toHaveLength(2);
  });
  it('runs a system schedule without fabricated member memory or recursive task tools',async()=>{
    let question='';const project=vi.fn(),read=vi.fn();
    const adapter=new Adapter(call=>{
      const payload=call.messages.filter(m=>m.role==='user').at(-1)!.content.filter(b=>b.type==='text').map(b=>b.text).join('');
      const parsed=JSON.parse(payload);expect(parsed.inputs[0]).toMatchObject({kind:'scheduled',ownerId:null,sourceRole:'host'});
      expect(call.tools?.some(t=>t.name==='scheduled_tasks')).toBe(false);
      return text(report({scheduleProposalIds:['forged'],requirementState:{byAuthor:[{authorId:'system',text:'fake',sourceSeqs:[1]}]}}));
    });
    const {root,runtime,config}=await fixture(adapter,{
      sharedMemory:{snapshot:()=>({project,createReadTool:read})} as unknown as DshOptions['sharedMemory'],
      capabilityFactory:async(_config,scope)=>{expect(scope.execution).toMatchObject({kind:'scheduled',authority:'system',scheduleId:'s1'});question=scope.question;return {tools:[],systemContext:'',close:async()=>{}};},
    });
    const req=request(root,true);req.thread.scheduledTask!.executionConfigRevision=scheduledExecutionConfigRevision(config,req.thread.roomId);
    req.taskTools=[{name:'scheduled_tasks',description:'forbidden',inputSchema:{type:'object'},execute:async()=>{throw new Error('should not run');}}];
    const result=await runtime.runWorker(req);expect(question).toBe(req.scheduledInput!.instructions);
    expect(project).not.toHaveBeenCalled();expect(read).not.toHaveBeenCalled();expect(result.scheduleProposalIds).toBeUndefined();expect(result.requirementState).toBeUndefined();
  });
  it('refuses a scheduled retry with missing or changed configuration before any model call',async()=>{
    const adapter=new Adapter(()=>text(report())),{root,runtime,config}=await fixture(adapter),req=request(root,true);
    await expect(runtime.runWorker(req)).rejects.toMatchObject({code:'SCHEDULE_CONFIG_CHANGED'});
    req.thread.scheduledTask!.executionConfigRevision=scheduledExecutionConfigRevision(config,req.thread.roomId);
    await writeFile(join(root,'config.local.json'),JSON.stringify({worker:{model:'changed-model'}}));
    await expect(runtime.runWorker(req)).rejects.toMatchObject({code:'SCHEDULE_CONFIG_CHANGED'});
    expect(adapter.requests).toHaveLength(0);
  });
  it('detects operator file changes while capabilities load before starting the scheduled model',async()=>{
    const adapter=new Adapter(()=>text(report()));let rootPath='';
    const {root,runtime,config}=await fixture(adapter,{capabilityFactory:async()=>{
      await writeFile(join(rootPath,'config.local.json'),JSON.stringify({worker:{model:'changed-during-setup'}}));
      return {tools:[],systemContext:'',close:async()=>{}};
    }});rootPath=root;
    const req=request(root,true);req.thread.scheduledTask!.executionConfigRevision=scheduledExecutionConfigRevision(config,req.thread.roomId);
    await expect(runtime.runWorker(req)).rejects.toMatchObject({code:'SCHEDULE_CONFIG_CHANGED'});
    expect(adapter.requests).toHaveLength(0);
  });
});
