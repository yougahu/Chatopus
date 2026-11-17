import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LlmAdapter, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { DshRuntime, roleProviderProfile, routerPayload, type DshOptions } from '../src/dsh-runtime.js';
import { NativeAgentRuntime } from '../src/runtime/native.js';
import { loadConfig } from '../src/config.js';
import type { GroupMessage, OutgoingImage, OutgoingFile, RouterRequest, WorkerRequest } from '../src/types.js';
import { createCapabilitySession, type CapabilitySession as DomainSession } from '../src/capabilities.js';
import { ReplyLinks, linkError } from '../src/tools/reply-links.js';
import { readOutgoingFile } from '../src/output-files.js';

class Adapter extends LlmAdapter {
 requests:GenerateOptions[]=[];
 constructor(private readonly decide:(request:GenerateOptions,index:number)=>string|Promise<string>){super();}
 async *stream(request:GenerateOptions):AsyncIterable<StreamChunk>{
  const text=await this.decide(request,this.requests.push(request)-1);
  yield {type:'block-start',index:0,blockType:'text'};yield {type:'text-delta',index:0,text};
  yield {type:'block-end',index:0,block:{type:'text',text}};yield {type:'finish',reason:{kind:'stop'}};
 }
}
const disposers:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const dispose of disposers.splice(0).reverse())await dispose();});
const message:GroupMessage={id:'m1',platform:'replay',roomId:'room',messageId:'1',authorId:'a',authorName:'A',text:'这个配置项怎么用',timestamp:0,mentions:[],attachments:[],isMentioned:true,isAdmin:false};
const routeRequest:RouterRequest={roomId:'room',event:'messages',messages:[message],recentMessages:[],threads:[]};
async function fixture(adapter:LlmAdapter,maxWorkerSteps=8,resolveImages?:(ids:string[])=>Promise<OutgoingImage[]>,options:Pick<DshOptions,'resolveImage'|'onImage'|'capabilityFactory'|'onMetrics'>={},prepareInputs?:DomainSession['prepareInputs']){
 const root=await mkdtemp(join(tmpdir(),'boe2-wrapper-'));disposers.push(()=>rm(root,{recursive:true,force:true}));
 await mkdir(join(root,'personas'));await writeFile(join(root,'personas/default.md'),'# Test persona\n简洁回应');
 const config=loadConfig(root,{stateDir:join(root,'state'),router:{provider:'mock',model:'router'},worker:{provider:'mock',model:'worker'},maxWorkerSteps});
 const native=await NativeAgentRuntime.create({root:join(root,'dsh'),adapters:{mock:adapter}});
 let closed=0,finalized=0;
 const runtime=await DshRuntime.create(config,{...options,native,capabilityFactory:options.capabilityFactory??(async()=>({tools:[],systemContext:'domain',resolveImages,prepareInputs,finalizeAnswer:async a=>{finalized++;return a+' checked';},close:async()=>{closed++;}}))});
 disposers.push(()=>runtime.close());
 return {runtime,root,config,counts:()=>({closed,finalized})};
}
function workerRequest(root:string):WorkerRequest{return {runId:'run1',workspace:join(root,'worker'),thread:{id:'t1',roomId:'room',subject:'配置项',ownerId:'a',sourceMessageId:'m1',explicit:true,participants:['a'],status:'running',revision:1,latestInputSeq:1,sessionId:'worker-t1',epoch:1,summary:''},inputs:[{seq:1,revision:1,message,kind:'question'}]};}
const report={threadId:'t1',runId:'run1',coveredInputSeq:1,basedOnRevision:1,status:'ready',shortAnswer:'回答',assumptions:[],evidenceRefs:[],openQuestions:[]};
it('repairs a link once and attaches only tool-owned receipts before completion',async()=>{
 const registry=new ReplyLinks({threadId:'t1',runId:'run1',revision:1}),reference=registry.register('https://example.test/original');
 const adapter=new Adapter((_request,index)=>JSON.stringify({...report,shortAnswer:index===0?'bad copied URL':reference}));
 const {runtime,root}=await fixture(adapter,8,undefined,{capabilityFactory:async()=>({tools:[],systemContext:'test',close:async()=>{},finalizeReport:async value=>{
   if(value.shortAnswer!==reference)throw linkError('Use the returned reference');
   return {...value,hostLinks:registry.resolve(value.shortAnswer)};
 }})});
 const result=await runtime.runWorker(workerRequest(root));expect(result).toMatchObject({status:'ready',shortAnswer:reference,hostLinks:[{url:'https://example.test/original'}]});expect(adapter.requests).toHaveLength(2);
});
it('fails delivery after one unsuccessful repair instead of repeating a bad link',async()=>{
 const adapter=new Adapter(()=>JSON.stringify(report));
 const {runtime,root}=await fixture(adapter,8,undefined,{capabilityFactory:async()=>({tools:[],systemContext:'test',close:async()=>{},finalizeReport:async()=>{throw linkError('Invalid link');}})});
 const result=await runtime.runWorker(workerRequest(root));expect(result.status).toBe('failed');expect(result.hostLinks).toBeUndefined();expect(adapter.requests).toHaveLength(2);
});
it('refreshes only presentation without tools and skips the model when expression fields did not change',async()=>{
 const adapter=new Adapter(request=>{expect(request.tools??[]).toHaveLength(0);return JSON.stringify({text:'阿强，耗时 1883–2825，记录数 20。来源：https://example.test/document'});});
 const {runtime}=await fixture(adapter);
 const before=[{memberId:'a',revision:1,fields:{preferredName:{state:'set' as const,value:'阿明'}},omittedKeys:[]}];
 const after=[{memberId:'a',revision:2,fields:{preferredName:{state:'set' as const,value:'阿强'}},omittedKeys:[]}];
 const text='阿明，耗时 1883–2825，记录数 20。来源：https://example.test/document';
 const refreshed=await runtime.refreshReplyPreferences({roomId:'room',text,memberMemory:after,previousMemberMemory:before,replyToMemberId:'a'});
 expect(refreshed).toContain('阿强');expect(adapter.requests).toHaveLength(1);
 expect(await runtime.refreshReplyPreferences({roomId:'room',text:refreshed,memberMemory:after.map(p=>({...p,revision:3})),previousMemberMemory:after})).toBe(refreshed);
 expect(adapter.requests).toHaveLength(1);
});
it('rejects a presentation rewrite which changes domain numbers before it can reach the outbox',async()=>{
 const {runtime}=await fixture(new Adapter(()=>JSON.stringify({text:'阿强，耗时 9999。'})));
 await expect(runtime.refreshReplyPreferences({roomId:'room',text:'阿明，耗时 1883。',memberMemory:[{memberId:'a',revision:2,fields:{preferredName:{state:'set',value:'阿强'}},omittedKeys:[]}]})).rejects.toMatchObject({code:'PREFERENCE_CONTENT_CHANGED'});
});
it('keeps host-only Worker metadata out of a persistent Router result without changing the original report',async()=>{
 const adapter=new Adapter(request=>{
   const text=JSON.stringify(request.messages);expect(text).not.toContain('private/host');expect(text).not.toContain('hostMemberMemory');
   expect(text).not.toContain('internal-detail');return JSON.stringify([{action:'publish_result',resultId:'result'}]);
 });
 const {runtime}=await fixture(adapter);
 const original={...report,status:'ready' as const,details:'internal-detail',hostMemberMemory:[{memberId:'a',revision:1,fields:{},omittedKeys:[]}],attachments:[{kind:'image' as const,artifactId:'image',file:'/private/host/a.png',mimeType:'image/png' as const,bytes:10,sha256:'a'.repeat(64)}]};
 const request:RouterRequest={...routeRequest,event:'worker_result',messages:[],result:{id:'result',threadId:'t1',report:original,explicit:true},routing:{routeTurnId:'turn',generation:1,sessionId:'persistent-result',mode:'seed',resume:false,context:{boundary:1,messageIds:[],replyIds:[],threadIds:[],history:'bounded',omittedHistory:true},hostEvents:[],instruction:'Current host state'}};
 expect(await runtime.route(request)).toEqual([{action:'publish_result',resultId:'result'}]);
 expect(original.attachments[0].file).toBe('/private/host/a.png');expect(original.hostMemberMemory).toHaveLength(1);
});
it('does not call the model for an uncalled request, even when quoting a previous bot reply',async()=>{
 const adapter=new Adapter(()=>{throw new Error('Uncalled message reached model');});
 const {runtime}=await fixture(adapter);
 expect(await runtime.route({...routeRequest,messages:[{...message,isMentioned:false,replyToMessageId:'bot-reply'}]})).toMatchObject([{action:'silence',sourceMessageIds:['m1']}]);
 expect(adapter.requests).toHaveLength(0);
});
it('keeps routing identity and text while excluding Worker execution metadata',()=>{
 const thread={...workerRequest('/tmp').thread,summary:'existing detailed answer',activeRunId:'private-run',failures:2,updatedAt:123};
 const payload=JSON.parse(routerPayload({...routeRequest,threads:[thread]},{recentMessageLimit:16,threadCardLimit:12}));
 expect(payload.threads[0]).toEqual({id:thread.id,roomId:thread.roomId,subject:thread.subject,ownerId:thread.ownerId,sourceMessageId:thread.sourceMessageId,explicit:thread.explicit,status:thread.status,participants:thread.participants,summary:thread.summary,revision:thread.revision,epoch:thread.epoch,latestInputSeq:thread.latestInputSeq});
 expect(payload.messages).toHaveLength(1);
});
it('repairs Router JSON once with the actual dsh agent and retains current IDs',async()=>{
 const adapter=new Adapter((_,i)=>i===0?'not-json':JSON.stringify([{action:'open_thread',sourceMessageIds:['m1'],subject:'配置项'}]));
 const {runtime}=await fixture(adapter);
 expect(await runtime.route(routeRequest)).toEqual([{action:'open_thread',sourceMessageIds:['m1'],subject:'配置项'}]);
 expect(adapter.requests).toHaveLength(2);expect(JSON.stringify(adapter.requests[1].messages)).toContain('not-json');
});
it('refuses a second invalid response rather than making an unbounded repair loop',async()=>{
 const adapter=new Adapter(()=>'{broken');const {runtime}=await fixture(adapter);
 await expect(runtime.route(routeRequest)).rejects.toMatchObject({code:'ROUTER_RECOVERY_FAILED'});expect(adapter.requests).toHaveLength(2);
});
it('applies the domain host finalizer and disposes domain state after a valid report',async()=>{
 const {runtime,root,counts}=await fixture(new Adapter(()=>JSON.stringify(report)));
 expect((await runtime.runWorker(workerRequest(root))).shortAnswer).toBe('回答 checked');
 expect(counts()).toEqual({closed:1,finalized:1});
});
it('passes the current requirement to the domain and retains the host-verified report status',async()=>{
 let scope:unknown;
 const {runtime,root}=await fixture(new Adapter(()=>JSON.stringify(report)),8,undefined,{capabilityFactory:async(_config,options)=>{
  scope=options;
  return {tools:[],systemContext:'domain',finalizeAnswer:async()=>{throw new Error('legacy finalizer must not run');},
   finalizeReport:async report=>({...report,status:'failed',shortAnswer:'缺少有效计算凭据',evidenceRefs:['calculation-receipt:test']}),close:async()=>{}};
 }});
 const request=workerRequest(root);request.inputs[0].routingContext={resolvedRequest:'以20元预算重新计算',sourceMessageIds:['m1'],routingMetadata:{'test-calculation':{required:true}}};
 const result=await runtime.runWorker(request);
 expect(scope).toMatchObject({question:'以20元预算重新计算',routingMetadata:{'test-calculation':{required:true}}});
 expect(result).toMatchObject({status:'failed',shortAnswer:'缺少有效计算凭据',evidenceRefs:['calculation-receipt:test']});
});
it('records effective prompt/tool fingerprints and separates setup from the model turn',async()=>{
 const metrics:unknown[]=[];
 const {runtime}=await fixture(new Adapter(()=>JSON.stringify([{action:'silence',sourceMessageIds:['m1']}])) ,8,undefined,{onMetrics:metric=>metrics.push(metric)});
 await runtime.route(routeRequest);
 expect(metrics[0]).toMatchObject({role:'router',phase:'initial',promptHash:expect.stringMatching(/^[a-f0-9]{64}$/),toolsHash:expect.stringMatching(/^[a-f0-9]{64}$/),queueMs:expect.any(Number),setupMs:expect.any(Number),elapsedMs:expect.any(Number)});
});
it('accepts only image IDs from model output and resolves attachments through the host',async()=>{
 const hostImage:OutgoingImage={kind:'image',artifactId:'image-test',file:'/host/current-run/.reply-images/test.png',mimeType:'image/png',bytes:100,sha256:'a'.repeat(64)};
 const resolved:string[][]=[];
 const adapter=new Adapter(()=>JSON.stringify({...report,images:['image-test'],attachments:[{...hostImage,file:'/private/forged.png'}]}));
 const {runtime,root,counts}=await fixture(adapter,8,async ids=>{resolved.push(ids);return [hostImage];});
 const result=await runtime.runWorker(workerRequest(root));
 expect(resolved).toEqual([['image-test']]);expect(result.attachments).toEqual([hostImage]);
 expect(counts()).toEqual({closed:1,finalized:1});
 const encoded=routerPayload({...routeRequest,event:'worker_result',messages:[],result:{id:'result',threadId:'t1',report:result,explicit:true}},{recentMessageLimit:16,threadCardLimit:12});
 expect(encoded).not.toContain('/host/');expect(encoded).not.toContain(hostImage.sha256);
 expect(JSON.parse(encoded).result.report.images).toEqual(['image-test']);
});
it('does not propagate model-supplied file metadata when no image ID was selected',async()=>{
 const {runtime,root}=await fixture(new Adapter(()=>JSON.stringify({...report,attachments:[{kind:'image',file:'/private/forged.png'}]})));
 expect((await runtime.runWorker(workerRequest(root))).attachments).toBeUndefined();
});
it('resolves selected file IDs only through the current capability session and hides paths from Router',async()=>{
 const hostFile:OutgoingFile={kind:'file',artifactId:'file-test',file:'/host/current-run/.reply-files/file-test',name:'translation.md',bytes:10,sha256:'b'.repeat(64)},resolved:string[][]=[];
 const adapter=new Adapter(()=>JSON.stringify({...report,files:['file-test'],fileAttachments:[{...hostFile,file:'/private/forged.md'}]}));
 const {runtime,root}=await fixture(adapter,8,undefined,{capabilityFactory:async()=>({tools:[],systemContext:'test',close:async()=>{},resolveFiles:async ids=>{resolved.push(ids);return [hostFile];}})});
 const result=await runtime.runWorker(workerRequest(root)); expect(result.fileAttachments).toEqual([hostFile]);expect(resolved).toEqual([['file-test']]);
 const encoded=routerPayload({...routeRequest,event:'worker_result',messages:[],result:{id:'result',threadId:'t1',report:result,explicit:true}},{recentMessageLimit:16,threadCardLimit:12});
 expect(encoded).not.toContain('/host/');expect(encoded).not.toContain(hostFile.sha256);
});
it('drops injected or stale file metadata when the report selects no registered file',async()=>{
 const forged:OutgoingFile={kind:'file',artifactId:'forged',file:'/private/forged.md',name:'forged.md',bytes:5,sha256:'c'.repeat(64)};
 const {runtime,root}=await fixture(new Adapter(()=>JSON.stringify({...report,fileAttachments:[forged]})),8,undefined,{capabilityFactory:async()=>({tools:[],systemContext:'test',close:async()=>{},finalizeReport:async value=>({...value,fileAttachments:[forged]})})});
 expect((await runtime.runWorker(workerRequest(root))).fileAttachments).toBeUndefined();
});
it('fails a report with an unresolved file instead of claiming delivery',async()=>{
 let closed=false;
 const {runtime,root}=await fixture(new Adapter(()=>JSON.stringify({...report,files:['file-from-old-run']})),8,undefined,{capabilityFactory:async()=>({tools:[],systemContext:'test',close:async()=>{closed=true;},resolveFiles:async()=>{throw new Error('Reply file unavailable in this run');}})});
 await expect(runtime.runWorker(workerRequest(root))).rejects.toThrow('unavailable in this run');expect(closed).toBe(true);
});
it('removes file selections when link validation repair fails',async()=>{
 let resolved=false;
 const {runtime,root}=await fixture(new Adapter(()=>JSON.stringify({...report,files:['file-test']})),8,undefined,{capabilityFactory:async()=>({tools:[],systemContext:'test',close:async()=>{},finalizeReport:async()=>{throw linkError('Invalid link');},resolveFiles:async()=>{resolved=true;return [];}})});
 const result=await runtime.runWorker(workerRequest(root));expect(result).toMatchObject({status:'failed'});expect(result.files).toBeUndefined();expect(result.fileAttachments).toBeUndefined();expect(resolved).toBe(false);
});
it('runs actual write and publish tools before returning a host-verified Markdown attachment',async()=>{
 const content='# Translated document\n\n这是一份翻译后的中性文档。';let calls=0;
 class FileAdapter extends LlmAdapter{
  async *stream(request:GenerateOptions):AsyncIterable<StreamChunk>{
   const index=calls++;
   if(index<2){
    const name=index===0?'artifact_write':'artifact_publish';
    expect(request.tools?.some(tool=>tool.name===name)).toBe(true);
    yield {type:'block-start',index:0,blockType:'tool-call'};
    yield {type:'block-end',index:0,block:{type:'tool-call',id:ToolCallId('file-call-'+index),name,arguments:JSON.stringify(index===0?{path:'translation.md',text:content}:{path:'translation.md',name:'译文.md'})}};
    yield {type:'finish',reason:{kind:'tool-calls'}};
   }else{
    const id=JSON.stringify(request.messages).match(/file-[a-f0-9-]{36}/)?.[0];expect(id).toBeTruthy();
    const text=JSON.stringify({...report,shortAnswer:'译文已生成，请查看附件。',files:[id]});
    yield {type:'block-start',index:0,blockType:'text'};yield {type:'text-delta',index:0,text};yield {type:'block-end',index:0,block:{type:'text',text}};yield {type:'finish',reason:{kind:'stop'}};
   }
  }
 }
 const {runtime,root}=await fixture(new FileAdapter(),8,undefined,{capabilityFactory:createCapabilitySession});
 const result=await runtime.runWorker(workerRequest(root));expect(calls).toBe(3);expect(result.files).toHaveLength(1);expect(result.fileAttachments).toHaveLength(1);
 expect(result.fileAttachments![0].name).toBe('译文.md');expect((await readOutgoingFile(result.fileAttachments![0],join(root,'worker'))).toString()).toBe(content);
});
it('rejects an unresolved screenshot instead of claiming to send a missing image',async()=>{
 const {runtime,root,counts}=await fixture(new Adapter(()=>JSON.stringify({...report,images:['unknown']})),8,async()=>{throw new Error('Unknown reply image');});
 await expect(runtime.runWorker(workerRequest(root))).rejects.toThrow('Unknown reply image');
 expect(counts().closed).toBe(1);
});
it('keeps Worker format repair inside the original step budget and cleans up on failure',async()=>{
 const adapter=new Adapter(()=>'{broken');const {runtime,root,counts}=await fixture(adapter,1);
 await expect(runtime.runWorker(workerRequest(root))).rejects.toThrow('step limit');expect(adapter.requests).toHaveLength(1);
 expect(counts()).toEqual({closed:1,finalized:0});
});
it('marks a steered result as covering the original binding, forcing coordinator rerun',async()=>{
 let release!:()=>void;let started!:()=>void;
 const entering=new Promise<void>(r=>started=r),gate=new Promise<void>(r=>release=r);
 const adapter=new Adapter(async()=>{started();await gate;return JSON.stringify({...report,coveredInputSeq:2,basedOnRevision:2});});
 const {runtime,root}=await fixture(adapter);const running=runtime.runWorker(workerRequest(root));await entering;
 await runtime.steer('t1',{seq:2,revision:2,message:{...message,id:'m2',text:'预算改为5'},kind:'correction'});release();
 const result=await running;expect(result.coveredInputSeq).toBe(1);expect(result.basedOnRevision).toBe(1);
});
const incomingPng='iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAE0lEQVQImWP4z8DwnwGM/zMwAAAf7gP9qS/A4gAAAABJRU5ErkJggg==';
const incomingImage={kind:'image' as const,url:'data:image/png;base64,'+incomingPng};
function currentInput(request:GenerateOptions){
 const content=request.messages.filter(m=>m.role==='user').at(-1)!.content;
 return {payload:JSON.parse(content.filter(b=>b.type==='text').map(b=>b.text).join('')),images:content.filter(b=>b.type==='image')};
}
it('delivers automatic terminology evidence for each input and rescans steered corrections',async()=>{
 let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(r=>release=r),started=new Promise<void>(r=>entered=r);
 const scans:unknown[]=[];
 const adapter=new Adapter(async (request,index)=>{
  const {payload}=currentInput(request);
  if(index===0){
   expect(payload.terminologyResolution.inputs).toEqual([{seq:1,messageId:'m1',text:message.text}]);
   entered();await gate;
  }else{
   expect(payload.event).toBe('new_input');
   expect(payload.terminologyResolution.inputs).toEqual([{seq:2,messageId:'m2',text:'不是 Node 20，是 Node 22'}]);
  }
  return JSON.stringify(report);
 });
 const {runtime,root}=await fixture(adapter,8,undefined,{},async(inputs,signal)=>{signal?.throwIfAborted();scans.push(inputs);return {terminologyResolution:{inputs}};});
 const running=runtime.runWorker(workerRequest(root));await started;
 await runtime.steer('t1',{seq:2,revision:2,kind:'correction',message:{...message,id:'m2',authorId:'b',text:'不是 Node 20，是 Node 22'}});
 release();await running;
 expect(scans).toEqual([[{seq:1,messageId:'m1',text:message.text}],[{seq:2,messageId:'m2',text:'不是 Node 20，是 Node 22'}]]);
});
it('prioritizes latest pictures over old thread images and distinguishes omissions from failed downloads',async()=>{
 const adapter=new Adapter(request=>{
  const {payload,images}=currentInput(request);
  expect(images).toHaveLength(4);expect(payload.imageAttachments.map((x:any)=>x.messageId)).toEqual(['m3','m4','m5','m6']);
  expect(payload.attachmentErrors).toEqual([]);
  expect(payload.attachmentOmissions.map((x:any)=>x.messageId).sort()).toEqual(['m1','m2']);
  return JSON.stringify(report);
 });
 const {runtime,root}=await fixture(adapter);const request=workerRequest(root);
 request.inputs=Array.from({length:6},(_,i)=>({seq:i+1,revision:i+1,kind:'supplement',message:{...message,id:'m'+(i+1),attachments:[incomingImage]}}));
 await runtime.runWorker(request);
});
it('passes historical image context to the model with original authorship and only one copy of repeated pictures',async()=>{
 const adapter=new Adapter(request=>{
  const {payload,images}=currentInput(request);
  expect(images).toHaveLength(2);expect(payload.imageAttachments.map((x:any)=>x.messageId)).toEqual(['old-picture','m2']);
  expect(payload.inputs[1].contextMessages[0]).toMatchObject({id:'old-picture',authorId:'original-author',text:'文档图'});
  expect(JSON.stringify(payload)).not.toContain(incomingPng);
  return JSON.stringify(report);
 });
 const {runtime,root}=await fixture(adapter);const request=workerRequest(root);
 const old={...message,id:'old-picture',authorId:'original-author',text:'文档图',attachments:[incomingImage]};
 request.inputs=[{seq:1,revision:1,kind:'question',message:old},{seq:2,revision:2,kind:'supplement',message:{...message,id:'m2',attachments:[incomingImage]},contextMessages:[old,old]}];
 await runtime.runWorker(request);
});
it('reports per-attachment failures without logging sensitive resolver exceptions',async()=>{
 const events:unknown[]=[];
 const adapter=new Adapter(request=>{
  const {payload,images}=currentInput(request);expect(images).toHaveLength(0);
  expect(payload.attachmentErrors).toEqual([{messageId:'m1',attachmentIndex:0,code:'image_load_failed'}]);
  return JSON.stringify(report);
 });
 const {runtime,root}=await fixture(adapter,8,undefined,{resolveImage:async()=>{throw new Error('signed URL https://example.test/?secret=private');},onImage:event=>events.push(event)});
 const request=workerRequest(root);request.inputs[0]={...request.inputs[0],message:{...message,attachments:[{kind:'image',file:'a'}]}};
 await runtime.runWorker(request);
 expect(events).toEqual([expect.objectContaining({messageId:'m1',attachmentIndex:0,status:'failed',code:'image_load_failed'})]);
 expect(JSON.stringify(events)).not.toContain('secret');
});
it('keeps provider protocol and credential routes independent without inventing DeepSeek capabilities',async()=>{
 const {config}=await fixture(new Adapter(()=>''));
 config.router={provider:'ds',model:'deepseek-chat'};config.worker={provider:'gpt',model:'gpt-6.1-sol'};
 config.providers={ds:{api:'openai-completions',baseURL:'https://api.deepseek.com',apiKeyEnv:'DEEPSEEK_API_KEY',models:[{id:'deepseek-chat',input:['text'],reasoningEfforts:false}]},gpt:{api:'openai-responses',baseURL:'https://api.openai.com/v1',apiKeyEnv:'OPENAI_API_KEY',models:[{id:'gpt-6.1-sol',input:['text','image']}]}};
 expect(roleProviderProfile(config,'router')).toMatchObject(config.providers.ds);
 expect(roleProviderProfile(config,'worker')).toMatchObject(config.providers.gpt);
 delete config.providers.ds;expect(()=>roleProviderProfile(config,'router')).toThrow('Configure provider route ds');
});
it('honors actual Router capacity while preserving complete current text and explicit omissions',()=>{
 const request={...routeRequest,recentMessages:Array.from({length:200},(_,i)=>({...message,id:'old'+i,text:'a'.repeat(20_000)})),recentReplies:Array.from({length:200},(_,i)=>({messageId:'bot'+i,replyToMessageId:'old'+i,text:'c'.repeat(20_000),sentAt:i})),messages:[{...message,text:'b'.repeat(30_000)}]};
 const encoded=routerPayload(request,{recentMessageLimit:100,threadCardLimit:12},true,64_000);
 expect(Buffer.byteLength(encoded)).toBeLessThanOrEqual(64_000);const parsed=JSON.parse(encoded);expect(parsed.messages[0]).toMatchObject({id:'m1',text:request.messages[0].text});expect(parsed.messages[0].textTruncated).toBeUndefined();
 expect(parsed.workingMemory.omittedContext).toBe(true);expect(parsed.recentReplies.at(-1).messageId).toBe('bot199');
 expect(parsed.recentReplies.every((reply:{text:string;textTruncated?:boolean})=>reply.text==='c'.repeat(20_000)&&!reply.textTruncated)).toBe(true);
 expect(()=>routerPayload(request,{recentMessageLimit:100,threadCardLimit:12},true,16_000)).toThrow('cannot fit');
});
it('sends the confirmed clarification as context through the actual native dsh Router',async()=>{
 const adapter=new Adapter(request=>{
  const text=JSON.stringify(request.messages);
  expect(text).toContain('请贴出完整地图参数');expect(text).toContain('recentReplies');
  return JSON.stringify([{action:'reply_direct',sourceMessageIds:['m1'],text:'还在等你补充地图参数。'}]);
 });
 const {runtime}=await fixture(adapter);
 const actions=await runtime.route({...routeRequest,messages:[{...message,text:'进展如何？'}],recentReplies:[{messageId:'bot-map-ask',replyToMessageId:'older-question',text:'请贴出完整地图参数',sentAt:100}]});
 expect(actions[0]).toMatchObject({action:'reply_direct',sourceMessageIds:['m1']});expect(adapter.requests).toHaveLength(1);
});

it('retains the immediate group conversation when old task cards crowd the Router budget',()=>{
 const target={...workerRequest('/tmp').thread,id:'quoted-task',subject:'原任务'.repeat(400),summary:'摘要'.repeat(400)};
 const recentMessages=Array.from({length:16},(_,i)=>({...message,id:`chat-${i}`,messageId:`chat-${i}`,authorId:`member-${i%2}`,text:'群友正在互相讨论外观。'.repeat(60)}));
 const request:RouterRequest={...routeRequest,
  references:{m1:{status:'resolved',threadId:target.id,chain:['quoted']}},
  threads:[target,...Array.from({length:11},(_,i)=>({...target,id:`old-task-${i}`}))],recentMessages,
  recentReplies:Array.from({length:8},(_,i)=>({messageId:`reply-${i}`,text:'已经回答的旧问题。'.repeat(100),sentAt:i})),
 };
 const original=structuredClone(request);
 const encoded=routerPayload(request,{recentMessageLimit:16,threadCardLimit:12},true,64_000);
 const payload=JSON.parse(encoded);
 expect(Buffer.byteLength(encoded)).toBeLessThanOrEqual(64_000);
 expect(payload.recentMessages.length).toBeGreaterThan(0);
 expect(payload.recentMessages.map((m:GroupMessage)=>m.id)).toEqual(recentMessages.slice(-payload.recentMessages.length).map(m=>m.id));
 expect(payload.recentMessages.at(-1).text).toBe(recentMessages.at(-1)!.text);
 expect(payload.workingMemory?.omittedContext).toBe(true);
 expect(payload.threads.some((t:{id:string})=>t.id==='quoted-task')).toBe(true);
 expect(payload.threads.every((t:any)=>t.sessionId===undefined&&t.activeRunId===undefined&&t.epoch!==undefined)).toBe(true);
 expect(payload.messages[0].id).toBe(message.id);
 expect(request).toEqual(original);
});

it('keeps old quoted thread cards and original quote markers when trimming optional history',()=>{
 const target={...workerRequest('/tmp').thread,id:'old-target',subject:'重要原问题',summary:'x'.repeat(2000)};
 const request:RouterRequest={...routeRequest,messages:[{...message,replyToMessageId:'quoted'}],
  references:{m1:{status:'resolved',threadId:target.id,chain:['quoted'],message:{...message,id:'quoted-full',messageId:'quoted',text:'q'.repeat(3000)}}},
  threads:[...Array.from({length:20},(_,i)=>({...target,id:`unrelated-${i}`})),target],
  recentMessages:Array.from({length:30},(_,i)=>({...message,id:`context-${i}`,text:'z'.repeat(4000)})),
 };
 const encoded=routerPayload(request,{recentMessageLimit:30,threadCardLimit:1},true,16_000);
 const payload=JSON.parse(encoded);expect(Buffer.byteLength(encoded)).toBeLessThanOrEqual(16_000);
 expect(payload.threads.some((t:{id:string})=>t.id==='old-target')).toBe(true);
 expect(payload.references.m1.messageRef).toBe('quoted-full');expect(payload.references.m1.message).toBeUndefined();
 expect(payload.recentMessages.find((m:GroupMessage)=>m.id==='quoted-full')).toMatchObject({messageId:'quoted',text:'q'.repeat(3000)});
 expect(payload.workingMemory.omittedContext).toBe(true);
});
it('passes the task subject, attributed quote, and correction interpretation to the actual Worker',async()=>{
 const adapter=new Adapter(request=>{
  const {payload}=currentInput(request);expect(payload.taskSubject).toBe('Node 20 服务部署');
  expect(payload.inputs[0]).toMatchObject({contextReplies:[{messageId:'book',text:'第4题：版本兼容性'}],
   routingContext:{resolvedRequest:'仍然是Node 20任务，纠正之前误解',correctionTarget:'Node 22误解'}});
  return JSON.stringify(report);
 });
 const {runtime,root}=await fixture(adapter);const request=workerRequest(root);request.thread.subject='Node 20 服务部署';
 request.inputs[0]={...request.inputs[0],kind:'correction',contextReplies:[{messageId:'book',text:'第4题：版本兼容性',sentAt:1}],
  routingContext:{resolvedRequest:'仍然是Node 20任务，纠正之前误解',correctionTarget:'Node 22误解',sourceMessageIds:['m1']}};
 await runtime.runWorker(request);
});
it('accepts a valid single action without repair and reports precise invalid subject length on repair',async()=>{
 const adapter=new Adapter((request,index)=>{
  if(index===0)return JSON.stringify({action:'open_thread',sourceMessageIds:['m1'],subject:'x'.repeat(1001)});
  const last=request.messages.filter(m=>m.role==='user').at(-1)!;
  expect(JSON.stringify(last)).toContain('subject');expect(JSON.stringify(last)).toContain('1000');
  return JSON.stringify({action:'open_thread',sourceMessageIds:['m1'],subject:'x'.repeat(1000)});
 });
 const {runtime}=await fixture(adapter);expect((await runtime.route(routeRequest))[0]).toHaveProperty('subject','x'.repeat(1000));
 expect(adapter.requests).toHaveLength(2);
});

it('emits exactly one failed repair measurement when the shared step budget is exhausted',async()=>{
 const metrics:any[]=[];const {runtime,root}=await fixture(new Adapter(()=>'{broken'),1,undefined,{onMetrics:metric=>metrics.push(metric)});
 await expect(runtime.runWorker(workerRequest(root))).rejects.toMatchObject({code:'STEP_LIMIT',workerProgress:{steps:1}});
 expect(metrics).toHaveLength(2);
 expect(metrics[0]).toMatchObject({role:'worker',threadId:'t1',runId:'run1',status:'completed',usageStatus:'unknown',modelCalls:1});
 expect(metrics[1]).toMatchObject({role:'worker',threadId:'t1',runId:'run1',phase:'repair',status:'failed',code:'STEP_LIMIT',usageStatus:'not_called',modelCalls:0});
});
