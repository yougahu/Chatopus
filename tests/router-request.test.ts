import { afterEach,expect,it } from 'vitest';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LlmAdapter,type GenerateOptions,type StreamChunk } from '@deepseek-ai/dsh-llm';
import { routerClock,routerOutputContract } from '../src/runtime/router-request.js';
import { buildRouterPayload } from '../src/router-context-builder.js';
import { NativeAgentRuntime } from '../src/runtime/native.js';
import { DshRuntime } from '../src/dsh-runtime.js';
import { loadConfig } from '../src/config.js';
import type { RouterRequest,GroupMessage } from '../src/types.js';

const message=(id:string,authorId:string):GroupMessage=>({id,authorId,authorName:authorId,roomId:'room',messageId:id,platform:'replay',text:'请提醒我',timestamp:0,mentions:[],attachments:[],isMentioned:true,isAdmin:false});
const request=():RouterRequest=>({roomId:'room',event:'messages',currentTime:Date.UTC(2026,10,12,16,5,6),messages:[message('current-a','a'),message('current-b','b')],recentMessages:[message('historical','a')],threads:[]});

it('formats the same instant across local midnight, UTC and daylight saving time',()=>{
  expect(routerClock(Date.UTC(2026,10,12,16,5,6),'Asia/Shanghai')).toEqual({date:'2026-11-13',time:'00:05:06',weekday:'Friday',timeZone:'Asia/Shanghai',utcOffset:'+08:00',iso8601:'2026-11-13T00:05:06+08:00'});
  expect(routerClock(0,'UTC').iso8601).toBe('1970-01-01T00:00:00+00:00');
  expect(routerClock(Date.UTC(2026,6,1),'America/New_York')).toMatchObject({date:'2026-06-30',time:'20:00:00',utcOffset:'-04:00'});
});

it('replaces stale action scope with only current IDs, grouped by author',()=>{
  const r=request();r.outputContract={format:'json_array',allowedActions:['publish_result'],sourceMessageIds:['historical'],scheduleSourceGroups:[]};
  const payload=JSON.parse(buildRouterPayload(r,{recentMessageLimit:16,threadCardLimit:12}));
  expect(payload.outputContract).toMatchObject({format:'json_array',sourceMessageIds:['current-a','current-b'],scheduleSourceGroups:[{authorId:'a',sourceMessageIds:['current-a']},{authorId:'b',sourceMessageIds:['current-b']}]});
  expect(payload.outputContract.allowedActions).not.toContain('publish_result');
  const contract=routerOutputContract({...r,event:'worker_result',result:{id:'current-result',threadId:'thread',explicit:true,report:{threadId:'thread',runId:'run',coveredInputSeq:1,basedOnRevision:1,status:'ready',shortAnswer:'完成',assumptions:[],evidenceRefs:[],openQuestions:[]}}});
  expect(contract).toEqual({format:'json_array',allowedActions:['publish_result','defer_result'],resultId:'current-result',sourceMessageIds:[],scheduleSourceGroups:[]});
});

const cleanup:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
it('sends the configured 8192-token budget and readable clock on initial and repair calls',async()=>{
  const root=await mkdtemp(join(tmpdir(),'boe-router-clock-'));cleanup.push(()=>rm(root,{recursive:true,force:true}));
  const calls:GenerateOptions[]=[];
  class Adapter extends LlmAdapter {
    async *stream(call:GenerateOptions):AsyncIterable<StreamChunk>{
      calls.push(call);
      const answer=calls.length===1?'invalid JSON':JSON.stringify([{action:'reply_direct',sourceMessageIds:['current-a'],text:'已记录'},{action:'silence',sourceMessageIds:['current-b']}]);
      yield {type:'text-delta',index:0,text:answer};yield {type:'finish',reason:{kind:'stop'}};
    }
  }
  const native=await NativeAgentRuntime.create({root:join(root,'dsh'),adapters:{mock:new Adapter()},compaction:false});
  const config=loadConfig(root,{router:{provider:'mock',model:'router',maxTokens:8192}});
  const runtime=await DshRuntime.create(config,{native});cleanup.push(()=>runtime.close());
  await runtime.route(request());expect(calls).toHaveLength(2);
  for(const call of calls){
    expect(call.maxTokens).toBe(8192);
    const payloads=call.messages.filter(message=>message.role==='user').flatMap(message=>message.content.flatMap(block=>block.type==='text'?[block.text]:[])).map(text=>{try{return JSON.parse(text);}catch{return null;}});
    expect(payloads.at(-1)).toMatchObject({currentTime:Date.UTC(2026,10,12,16,5,6),currentTimeContext:{date:'2026-11-13',time:'00:05:06',timeZone:'Asia/Shanghai'},outputContract:{sourceMessageIds:['current-a','current-b']}});
  }
});

it('advertises read-only handoff actions in the current message contract',async()=>{
 const {routerOutputContract}=await import('../src/runtime/router-request.js');
 expect(routerOutputContract(request()).allowedActions).toContain('request_handoff');
});
