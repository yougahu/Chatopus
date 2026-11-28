import {afterEach,expect,it} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {LlmAdapter,ToolCallId,type GenerateOptions,type StreamChunk} from '@deepseek-ai/dsh-llm';
import {DshRuntime,type DshOptions} from '../src/dsh-runtime.js';
import {NativeAgentRuntime} from '../src/runtime/native.js';
import {sourceImage} from '../src/runtime/incoming-images.js';
import {PersistentRouterManager} from '../src/runtime/persistent-router.js';
import {Store} from '../src/store.js';
import {loadConfig} from '../src/config.js';
import type {GroupMessage,RouterRequest} from '../src/types.js';

const png='iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAE0lEQVQImWP4z8DwnwGM/zMwAAAf7gP9qS/A4gAAAABJRU5ErkJggg==';
const picture={kind:'image' as const,url:'data:image/png;base64,'+png};
const cleanup:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const dispose of cleanup.splice(0).reverse())await dispose();});
const message=(id:string,patch:Partial<GroupMessage>={}):GroupMessage=>({id,messageId:id,roomId:'qq:1:2',platform:'qq',authorId:'3',authorName:'User',text:'看一下这张图',timestamp:1,mentions:[],attachments:[picture],isMentioned:true,isAdmin:false,...patch});
const request=(current:GroupMessage):RouterRequest=>({roomId:current.roomId,event:'messages',messages:[current],recentMessages:[],threads:[]});
const silence=(ids=['current'])=>JSON.stringify([{action:'silence',sourceMessageIds:ids}]);
function currentInput(input:GenerateOptions){
  const content=input.messages.filter(m=>m.role==='user').at(-1)!.content;
  return {payload:JSON.parse(content.filter(b=>b.type==='text').map(b=>b.text).join('')),images:content.filter(b=>b.type==='image')};
}
class Adapter extends LlmAdapter {
  calls=0;
  constructor(private decide:(input:GenerateOptions,index:number)=>string){super();}
  async *stream(input:GenerateOptions):AsyncIterable<StreamChunk>{
    const text=this.decide(input,this.calls++);
    yield {type:'block-start',index:0,blockType:'text'};yield {type:'text-delta',index:0,text};
    yield {type:'block-end',index:0,block:{type:'text',text}};yield {type:'finish',reason:{kind:'stop'}};
  }
}
async function fixture(adapter:LlmAdapter,options:Pick<DshOptions,'resolveImage'|'onImage'>={}){
  const root=await mkdtemp(join(tmpdir(),'router-vision-'));cleanup.push(()=>rm(root,{recursive:true,force:true}));
  const config=loadConfig(root,{stateDir:join(root,'state'),router:{provider:'mock',model:'vision'},worker:{provider:'mock',model:'worker'}});
  const native=await NativeAgentRuntime.create({root:join(root,'native'),adapters:{mock:adapter}});
  const runtime=await DshRuntime.create(config,{native,...options});cleanup.push(()=>runtime.close());return {runtime,config};
}

it.each(['qq:1:2','qq:1:private:3'])('delivers real images through persistent routing and format repair in %s',async roomId=>{
  const store=new Store(':memory:');cleanup.push(async()=>store.close());
  const current=message('current',{roomId,text:'',isMentioned:roomId==='qq:1:2'});store.ingest(current);
  const manager=new PersistentRouterManager(store.routerSessions);
  const prepared=await manager.prepare(request(current),'vision-test',50_000);
  expect(JSON.stringify(prepared.request)).not.toContain(png);
  const resolved:unknown[]=[],events:unknown[]=[];
  const adapter=new Adapter((input,index)=>{
    const {payload,images}=currentInput(input);expect(images).toHaveLength(1);
    expect(payload.imageAttachments).toEqual([{messageId:'current',attachmentIndex:0}]);
    expect(payload.messages[0]).toMatchObject({id:'current',authorId:'3'});
    expect(JSON.stringify(payload)).not.toContain(png);
    expect(JSON.stringify(input)).toContain('先看图再决定是否建立或补充任务');
    return index===0?'invalid json':silence();
  });
  const {runtime}=await fixture(adapter,{resolveImage:async(marker,context)=>{
    expect(marker.url).toBeUndefined();resolved.push(context);return sourceImage(store.message(context.messageId),context);
  },onImage:event=>events.push(event)});
  expect(await runtime.route(prepared.request)).toMatchObject([{action:'silence',sourceMessageIds:['current']}]);
  expect(adapter.calls).toBe(2);expect(resolved).toHaveLength(1);
  expect(events).toEqual([expect.objectContaining({role:'router',roomId,messageId:'current',phase:'route',status:'loaded'})]);
});

it('prioritizes addressed current images and explicit quotes while excluding unrelated authors and file markers',async()=>{
  const current=message('current',{attachments:[picture,picture,picture,picture,picture]}),quoted=message('quoted',{authorId:'4',isMentioned:false});
  const unrelated=message('other-current',{authorId:'5',isMentioned:false,text:''});
  const input=request({...current,replyToMessageId:'quoted'});input.messages.push(unrelated);
  input.recentMessages=[message('old-1'),message('old-2'),message('old-3'),message('other-history',{authorId:'5'}),quoted,message('file',{attachments:[{kind:'file',name:'notes.txt'}]})];
  input.references={current:{status:'unbound',message:quoted,chain:['quoted']}};
  const {runtime}=await fixture(new Adapter(input=>{
    const {payload,images}=currentInput(input);expect(images).toHaveLength(4);
    expect(payload.imageAttachments).toEqual([0,1,2,3].map(attachmentIndex=>({messageId:'current',attachmentIndex})));
    expect(payload.attachmentOmissions).toEqual([{messageId:'current',attachmentIndex:4,reason:'image_limit'},{messageId:'quoted',attachmentIndex:0,reason:'image_limit'}]);
    return silence(['current','other-current']);
  }));
  await runtime.route(input);
});

it('does not download or call the model for unaddressed group images',async()=>{
  const adapter=new Adapter(()=>{throw new Error('unexpected inference');});
  const {runtime}=await fixture(adapter,{resolveImage:async()=>{throw new Error('unexpected download');}});
  expect(await runtime.route(request(message('current',{isMentioned:false,attachments:[{kind:'image',file:'image'}]})))).toMatchObject([{action:'silence'}]);
  expect(adapter.calls).toBe(0);
});

it('attaches a directly quoted image from another author without fetching unrelated history',async()=>{
  const quoted=message('quoted',{authorId:'4',isMentioned:false});
  const input=request(message('current',{attachments:[],replyToMessageId:'quoted'}));
  input.recentMessages=[message('unrelated'),quoted];
  input.references={current:{status:'unbound',message:quoted,chain:['quoted']}};
  const {runtime}=await fixture(new Adapter(input=>{
    const {payload,images}=currentInput(input);expect(images).toHaveLength(1);
    expect(payload.imageAttachments).toEqual([{messageId:'quoted',attachmentIndex:0}]);
    expect(payload.recentMessages.find((m:GroupMessage)=>m.id==='quoted').authorId).toBe('4');
    return silence();
  }));
  await runtime.route(input);
});

it('reports actual image failures without leaking resolver URLs or claiming that a marker was viewed',async()=>{
  const events:unknown[]=[];
  const {runtime}=await fixture(new Adapter(input=>{
    const {payload,images}=currentInput(input);expect(images).toHaveLength(0);
    expect(payload.attachmentErrors).toEqual([{messageId:'current',attachmentIndex:0,code:'image_load_failed'}]);
    expect(JSON.stringify(payload)).not.toContain('private-token');return silence();
  }),{resolveImage:async()=>{throw new Error('https://example.test/?private-token');},onImage:event=>events.push(event)});
  await runtime.route(request(message('current',{attachments:[{kind:'image',file:'image'}]})));
  expect(events).toEqual([expect.objectContaining({role:'router',status:'failed',code:'image_load_failed'})]);
});

it('stops waiting for a stuck image resolver at the Router deadline and releases the room queue',async()=>{
  let entered!:()=>void;const started=new Promise<void>(resolve=>entered=resolve);
  const adapter=new Adapter(()=>silence());
  const {runtime}=await fixture(adapter,{resolveImage:async()=>{entered();return new Promise(()=>{});}});
  const abort=new AbortController();
  const pending=runtime.route(request(message('current',{attachments:[{kind:'image',file:'image'}]})),undefined,{signal:abort.signal,consumeModelCall:()=>{}});
  const rejected=expect(pending).rejects.toMatchObject({code:'ROUTER_DEADLINE'});
  await started;abort.abort();await rejected;expect(adapter.calls).toBe(0);
  await runtime.route(request(message('current',{attachments:[]})));expect(adapter.calls).toBe(1);
});

it('rejects foreign-room image originals before invoking the resolver',async()=>{
  const input=request(message('current'));
  input.references={current:{status:'unbound',chain:['foreign'],message:message('foreign',{roomId:'qq:1:99'})}};
  const {runtime}=await fixture(new Adapter(()=>{throw new Error('unexpected inference');}),{resolveImage:async()=>{throw new Error('unexpected download');}});
  await expect(runtime.route(input)).rejects.toMatchObject({code:'INVALID_ROUTER_CONTEXT'});
});

it('delivers historical image bytes from an exact router_context read without exposing them in JSON',async()=>{
  const old=message('old'),current=message('current',{attachments:[],text:'描述我之前那张图片'});
  let calls=0;
  class RecallAdapter extends LlmAdapter {
    async *stream(input:GenerateOptions):AsyncIterable<StreamChunk>{
      if(calls++===0){
        yield {type:'block-start',index:0,blockType:'tool-call'};
        yield {type:'block-end',index:0,block:{type:'tool-call',id:ToolCallId('read-image'),name:'router_context',arguments:JSON.stringify({kind:'messages',id:'old'})}};
        yield {type:'finish',reason:{kind:'tool-calls'}};return;
      }
      const content=input.messages.filter(m=>m.role==='tool').at(-1)!.content;
      expect(content.filter(block=>block.type==='image')).toHaveLength(1);
      const text=content.filter(block=>block.type==='text').map(block=>block.text).join('');
      expect(text).toContain('imageAttachments');expect(text).toContain('old');expect(text).not.toContain(png);
      const result=JSON.stringify([{action:'reply_direct',sourceMessageIds:['current'],text:'已查看这张图片。'}]);
      yield {type:'block-start',index:0,blockType:'text'};yield {type:'text-delta',index:0,text:result};
      yield {type:'block-end',index:0,block:{type:'text',text:result}};yield {type:'finish',reason:{kind:'stop'}};
    }
  }
  const {runtime}=await fixture(new RecallAdapter());
  const actions=await runtime.route(request(current),async()=>({messages:[old],hasMore:false}));
  expect(actions[0].action).toBe('reply_direct');expect(calls).toBe(2);
});
