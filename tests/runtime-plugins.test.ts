import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { NativeAgentRuntime } from '../src/runtime/native.js';
import { mountAgentPlugins, validateAgentPlugins } from '../src/runtime/plugins.js';
class InspectAdapter extends LlmAdapter {
 requests:GenerateOptions[]=[];
 async *stream(request:GenerateOptions):AsyncIterable<StreamChunk>{
  this.requests.push(request);
  yield {type:'block-start',index:0,blockType:'text'};
  yield {type:'block-end',index:0,block:{type:'text',text:'ok'}};
  yield {type:'finish',reason:{kind:'stop'}};
 }
}
const cleanup:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const fn of cleanup.splice(0).reverse())await fn();});
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'boe2-plugins-'));cleanup.push(()=>rm(root,{recursive:true,force:true}));
 const adapter=new InspectAdapter();const runtime=await NativeAgentRuntime.create({root:join(root,'state'),adapters:{test:adapter}});cleanup.push(()=>runtime.close());
 await writeFile(join(root,'package.json'),JSON.stringify({name:'test-project',type:'module'}));
 return {root,adapter,runtime};
}
const source=`import {writeFile} from 'node:fs/promises';
export const name='local-personality-test';
export const inject=['systemPrompt'];
export async function apply(ctx, options) {
 await Promise.resolve();
 ctx.systemPrompt.section({name:'plugin-persona',order:10,text:options.text,interpolate:false});
 ctx.effect(()=>async()=>{if(options.cleanupFile)await writeFile(options.cleanupFile,'disposed');});
}`;
it('mounts an async local plugin before inference, adds its prompt and disposes its resources',async()=>{
 const {root,adapter,runtime}=await fixture();await writeFile(join(root,'plugin.mjs'),source);
 const cleanupFile=join(root,'disposed.txt');
 const a=await runtime.start({id:'local',model:{provider:'test',model:'m'},cwd:root,systemPrompt:'CORE RULES',setup:ctx=>mountAgentPlugins(ctx,[{module:'./plugin.mjs',scope:'worker',options:{text:'PERSONA',cleanupFile}}],{root,role:'worker'})});
 await a.send('question');const prompt=JSON.stringify(adapter.requests[0].messages);
 expect(prompt).toContain('CORE RULES');expect(prompt).toContain('PERSONA');
 await a.dispose();expect(await readFile(cleanupFile,'utf8')).toBe('disposed');
});
it('resolves an installed npm plugin from the project and keeps worker plugins away from Router',async()=>{
 const {root,adapter,runtime}=await fixture();const pkg=join(root,'node_modules','@boe','test-plugin');await mkdir(pkg,{recursive:true});
 await writeFile(join(pkg,'package.json'),JSON.stringify({name:'@boe/test-plugin',type:'module',exports:'./index.mjs'}));await writeFile(join(pkg,'index.mjs'),source);
 const specs=[{module:'@boe/test-plugin',options:{text:'WORKER-ONLY'}}];
 const r=await runtime.start({id:'r',model:{provider:'test',model:'r'},cwd:root,systemPrompt:'Router',setup:ctx=>mountAgentPlugins(ctx,specs,{root,role:'router'})});
 const w=await runtime.start({id:'w',model:{provider:'test',model:'w'},cwd:root,systemPrompt:'Worker',setup:ctx=>mountAgentPlugins(ctx,specs,{root,role:'worker'})});
 await r.send('route');await w.send('work');
 expect(JSON.stringify(adapter.requests.find(x=>x.model==='r')?.messages)).not.toContain('WORKER-ONLY');
 expect(JSON.stringify(adapter.requests.find(x=>x.model==='w')?.messages)).toContain('WORKER-ONLY');
});
it('rejects remote imports and invalid declarations without evaluating code',()=>{
 expect(()=>validateAgentPlugins([{module:'https://example.com/plugin.mjs'}])).toThrow('Remote plugin');
 expect(()=>validateAgentPlugins([{module:'data:text/javascript,console.log(1)'}])).toThrow('Remote plugin');
 expect(()=>validateAgentPlugins([{module:'./x.mjs',scope:'room'}])).toThrow('scope');
});
it('fails missing or duplicate modules during Agent setup, without leaving a live ID',async()=>{
 const {root,runtime}=await fixture();await writeFile(join(root,'plugin.mjs'),source);
 const options={id:'retry',model:{provider:'test',model:'m'},cwd:root,systemPrompt:'core'};
 await expect(runtime.start({...options,setup:ctx=>mountAgentPlugins(ctx,[{module:'missing-package'}],{root,role:'worker'})})).rejects.toThrow('Unable to resolve');
 // Failed setup unwinds the owned Agent scope.
 await expect(runtime.start({...options,id:'duplicate',setup:ctx=>mountAgentPlugins(ctx,[{module:'./plugin.mjs',options:{text:'one'}},{module:'./plugin.mjs',options:{text:'two'}}],{root,role:'worker'})})).rejects.toThrow('Duplicate plugin');
 const working=await runtime.start({...options,setup:ctx=>mountAgentPlugins(ctx,[{module:'./plugin.mjs',options:{text:'valid'}}],{root,role:'worker'})});
 expect((await working.send('question')).text).toBe('ok');
});
