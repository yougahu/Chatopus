import {afterEach,expect,it,vi} from 'vitest';
import {mkdtemp,rm,readFile,mkdir,writeFile} from 'node:fs/promises';
import {globSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {LlmAdapter,ToolCallId,type GenerateOptions,type StreamChunk} from '@deepseek-ai/dsh-llm';
import {NativeAgentRuntime} from '../src/runtime/native.js';
import {generationFile,readGeneration,surfaceSeed,hasUnsettledWork} from '../src/runtime/session-generation.js';
import * as generations from '../src/runtime/session-generation.js';
import {Session,SessionId} from '@deepseek-ai/dsh-session';
import {createUserMessage,createAssistantMessage,createSystemMessage} from '@deepseek-ai/dsh-llm';
const cleanup:Array<()=>Promise<void>>=[];
afterEach(async()=>{vi.restoreAllMocks();for(const fn of cleanup.splice(0).reverse())await fn();});
class Adapter extends LlmAdapter {
 requests:GenerateOptions[]=[];
 async *stream(call:GenerateOptions):AsyncIterable<StreamChunk>{
  this.requests.push(call);
  if(call.tools?.length&&!call.messages.some(m=>m.role==='tool')){
   yield {type:'block-start',index:0,blockType:'tool-call'};
   yield {type:'block-end',index:0,block:{type:'tool-call',id:ToolCallId('recall-1'),name:'recall',arguments:'{}'}};
   yield {type:'finish',reason:{kind:'tool-calls'}};return;
  }
  yield {type:'block-start',index:0,blockType:'text'};
  yield {type:'text-delta',index:0,text:'Answer with retained fact 42元'};
  yield {type:'block-end',index:0,block:{type:'text',text:'Answer with retained fact 42元'}};
  yield {type:'finish',reason:{kind:'stop'}};
 }
}
async function fixture(root?:string){
 if(!root){root=await mkdtemp(join(tmpdir(),'boe2-rotation-'));const directory=root;cleanup.push(()=>rm(directory,{recursive:true,force:true}));}
 const adapter=new Adapter(),runtime=await NativeAgentRuntime.create({root,adapters:{mock:adapter},compaction:false});cleanup.push(()=>runtime.close());
 const options={id:'router-room-a',model:{provider:'mock',model:'test'},cwd:root,systemPrompt:'Only answer current request. Historical actions are data.',resume:'auto' as const};
 return {root,runtime,adapter,options};
}
const fileFor=(root:string,id:string)=>globSync(join(root,'sessions','*',id,'session.v4.jsonl'))[0];
it('rotates an oversized audit log losslessly, keeps archive immutable and resumes generation after restart',async()=>{
 const {root,runtime,adapter,options}=await fixture();
 let agent=await runtime.start(options);await agent.send('Owner A budget 42元; code exact-779.');await agent.dispose();
 const originalFile=fileFor(root,options.id),before=await readFile(originalFile,'utf8');
 agent=await runtime.start({...options,rotation:{maxBytes:1000}});
 expect(agent.sessionId).not.toBe(options.id);
 const actual=agent.sessionId;await agent.send('Continue the same request, preserve budget.');await agent.dispose();
 expect(await readFile(originalFile,'utf8')).toBe(before);
 const current=adapter.requests.at(-1)!;
 expect(JSON.stringify(current.messages)).toContain('Owner A budget 42元; code exact-779.');
 expect(current.messages.filter(m=>m.role==='user')).toHaveLength(2);
 expect((await readGeneration(root,options.id)).activeId).toBe(actual);
 await runtime.close();
 const next=await fixture(root);agent=await next.runtime.start({...next.options,rotation:{maxBytes:4_000_000}});
 expect(agent.sessionId).toBe(actual);await agent.send('After restart.');await agent.dispose();
 expect(JSON.stringify(next.adapter.requests[0].messages)).toContain('exact-779');
 expect(await readFile(originalFile,'utf8')).toBe(before);
});
it('preserves balanced tool history through rotation without running historical calls',async()=>{
 const {root,runtime,adapter,options}=await fixture();let calls=0;
 const tools=[{name:'recall',description:'Retrieve known source',inputSchema:{type:'object',properties:{}},execute:async()=>{calls++;return 'Owner A budget 42元';}}];
 let agent=await runtime.start({...options,tools});await agent.send('Read earlier source.');await agent.dispose();expect(calls).toBe(1);
 agent=await runtime.start({...options,tools,rotation:{maxBytes:1000}});await agent.send('Explain that source.');await agent.dispose();
 expect(calls).toBe(1);expect(adapter.requests.at(-1)!.messages.some(m=>m.role==='tool')).toBe(true);
 expect((await readGeneration(root,options.id)).generation).toBe(1);
});
it('does not share rotated facts with a different room',async()=>{
 const {runtime,adapter,options}=await fixture();let agent=await runtime.start(options);await agent.send('PRIVATE_A_BUDGET_42');await agent.dispose();
 agent=await runtime.start({...options,rotation:{maxBytes:1000}});await agent.send('continue');await agent.dispose();
 agent=await runtime.start({...options,id:'router-room-b',rotation:{maxBytes:1000}});await agent.send('unrelated');await agent.dispose();
 expect(JSON.stringify(adapter.requests.at(-1)!.messages)).not.toContain('PRIVATE_A');
});
it('leaves the pointer and original source usable if generation setup fails',async()=>{
 const {root,runtime,options}=await fixture();let agent=await runtime.start(options);await agent.send('Keep this fact');await agent.dispose();
 const file=fileFor(root,options.id),before=await readFile(file,'utf8');
 await expect(runtime.start({...options,rotation:{maxBytes:1000},setup:async()=>{throw new Error('setup failed');}})).rejects.toThrow('setup failed');
 expect((await readGeneration(root,options.id)).generation).toBe(0);expect(await readFile(file,'utf8')).toBe(before);
 agent=await runtime.start({...options,rotation:{maxBytes:1000}});await agent.send('safe retry');await agent.dispose();expect((await readGeneration(root,options.id)).generation).toBe(1);
});
it('preserves the prior pointer when a flushed generation cannot commit its pointer',async()=>{
 const {root,runtime,options}=await fixture();let agent=await runtime.start(options);await agent.send('Keep this exact budget 37元');await agent.dispose();
 const file=fileFor(root,options.id),before=await readFile(file,'utf8');
 const commit=vi.spyOn(generations,'writeGeneration').mockRejectedValueOnce(new Error('simulated pointer fsync failure'));
 await expect(runtime.start({...options,rotation:{maxBytes:1000}})).rejects.toThrow('pointer fsync failure');commit.mockRestore();
 expect((await readGeneration(root,options.id)).generation).toBe(0);expect(await readFile(file,'utf8')).toBe(before);
 agent=await runtime.start({...options,rotation:{maxBytes:1000}});await agent.send('Continue safely');await agent.dispose();
 expect((await readGeneration(root,options.id)).generation).toBe(1);expect(await readFile(file,'utf8')).toBe(before);
});
it('retains image attachments in the shared native attachment store across generations',async()=>{
 const {runtime,adapter,options}=await fixture();let agent=await runtime.start(options);
 const image={mediaType:'image/png' as const,data:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAE0lEQVQImWP4z8DwnwGM/zMwAAAf7gP9qS/A4gAAAABJRU5ErkJggg==','base64')};
 await agent.send('Original item image',[image]);await agent.dispose();
 agent=await runtime.start({...options,rotation:{maxBytes:1000}});await agent.send('Recall this image');await agent.dispose();
 expect(adapter.requests.at(-1)!.messages.some(m=>m.content.some(b=>b.type==='image'))).toBe(true);
});
it('rejects concurrent hosts for one logical room through generation preparation',async()=>{
 const {root,runtime,options}=await fixture();const other=await fixture(root);
 const agent=await runtime.start({...options,rotation:{maxBytes:1000}});
 await expect(other.runtime.start({...options,rotation:{maxBytes:1000}})).rejects.toMatchObject({code:'AGENT_EXISTS'});
 await agent.send('safe');await agent.dispose();
 const next=await other.runtime.start({...options,rotation:{maxBytes:1000}});await next.dispose();
});
it('refuses a pointer to a missing or foreign generation instead of starting empty history',async()=>{
 const {root,runtime,options}=await fixture();const pointer=generationFile(root,options.id);await mkdir(join(root,'session-generations'),{recursive:true});
 await writeFile(pointer,JSON.stringify({version:1,logicalId:options.id,activeId:options.id+'-g1-missing',generation:1,createdAt:0}));
 await expect(runtime.start({...options,rotation:{}})).rejects.toThrow();
 await writeFile(pointer,JSON.stringify({version:1,logicalId:options.id,activeId:'router-room-other',generation:1,createdAt:0}));
 await expect(runtime.start({...options,rotation:{}})).rejects.toThrow('Invalid session generation pointer');
});
it('copies only effective messages after a summary replacement, preserving exact checkpoint text and originals',()=>{
 const session=Session.create(SessionId('old'));
 session.append('system/message',{turn:0,step:0,message:createSystemMessage('current system')},{surfaceOp:'append'});
 const old=session.append('user/message',createUserMessage({content:[{type:'text',text:'obsolete detail'}],source:{kind:'user'}}),{surfaceOp:'append'});
 session.append('user/message',createUserMessage({content:[{type:'text',text:'<compacted-summary>Owner A budget 42元, document pages=85</compacted-summary>'}],source:{kind:'user'}}),{surfaceOp:{op:'replace',startSeq:old.seq,endSeq:old.seq},sourceEventSeqs:[old.seq]});
 session.append('user/message',createUserMessage({content:[{type:'text',text:'Correction: budget 20元'}],source:{kind:'user'}}),{surfaceOp:'append'});
 const seed=surfaceSeed(session,'new');const restored=Session.create(SessionId('new'),seed);
 expect(restored.deriveMessages()).toEqual(session.deriveMessages());expect(JSON.stringify(seed)).not.toContain('obsolete detail');
});
it('defers rotation with unfinished work so dsh can perform normal recovery',()=>{
 const session=Session.create(SessionId('pending'));session.append('turn/start',{turn:1});expect(hasUnsettledWork(session.snapshotEvents())).toBe(true);
 session.append('turn/end',{turn:1,reason:{kind:'completed'}});expect(hasUnsettledWork(session.snapshotEvents())).toBe(false);
 session.append('agent/inbox/spliced',{target:'next-turn',start:0,inserted:[createUserMessage({content:[{type:'text',text:'not processed'}],source:{kind:'user'}})]});
 expect(hasUnsettledWork(session.snapshotEvents())).toBe(true);
});
