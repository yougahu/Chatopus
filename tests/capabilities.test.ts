import { afterEach, describe, expect, it, vi } from 'vitest';
import { PrivateMcp } from '../src/tools/mcp.js';
import { snapshotJsonValue } from '@deepseek-ai/dsh-util-values';
import { mkdtemp, mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';
import { confinedPath } from '../src/tools/paths.js';
import { createCapabilitySession, loadExtensions, validateRoutingExtensions, type CapabilityConfig, type CapabilityContext, type CapabilitySession } from '../src/capabilities.js';
import type { WorkerReport, RouteAction } from '../src/types.js';
import { readOutgoingFile } from '../src/output-files.js';

const roots:string[]=[],sessions:CapabilitySession[]=[];
afterEach(async()=>{for(const session of sessions.splice(0))await session.close().catch(()=>{});for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
async function fixture(){
  const root=await mkdtemp(join(tmpdir(),'chat-capabilities-'));roots.push(root);
  const config:CapabilityConfig={root,skills:[],extensions:[],python:'python3'};
  const context:CapabilityContext={threadId:'t-1',runId:'r-1',revision:2,workspace:join(root,'run'),artifactWorkspace:join(root,'artifacts'),historyWorkspace:join(root,'history'),question:'Read the document'};
  await mkdir(context.historyWorkspace!,{recursive:true});
  return {root,config,context};
}
async function extension(config:CapabilityConfig,id:string,source:string,options:Record<string,unknown>={}){
  const file=join(config.root,id+'.mjs');await writeFile(file,source);config.extensions.push({id,module:file,options});
}
async function open(config:CapabilityConfig,context:CapabilityContext){const session=await createCapabilitySession(config,context);sessions.push(session);return session;}
function tool(session:CapabilitySession,name:string){const value=session.tools.find(t=>t.name===name);if(!value)throw new Error('Missing tool '+name);return value;}
function report(status:WorkerReport['status']='ready'):WorkerReport{return {threadId:'t-1',runId:'r-1',coveredInputSeq:1,basedOnRevision:2,status,shortAnswer:'Answer',assumptions:[],evidenceRefs:[],openQuestions:[]};}
const base='tools:[],systemContext:"Example extension",async close(){}';

describe('generic capability sessions',()=>{
  it('rejects local fetch and browser navigation before invoking their transports',async()=>{
    const {config,context}=await fixture();
    config.browser={command:'synthetic-mcp',networkIsolation:'external'};
    const fetch=vi.spyOn(globalThis,'fetch'),call=vi.spyOn(PrivateMcp.prototype,'call');
    try{
      const session=await open(config,context);
      await expect(tool(session,'web_fetch').execute({url:'https://127.0.0.1/'})).rejects.toThrow();
      await expect(tool(session,'browser_call').execute({name:'browser_navigate',arguments:{url:'http://127.0.0.1:8092/'}})).rejects.toThrow();
      await expect(tool(session,'browser_call').execute({name:'browser_tabs',arguments:{action:'new',url:'http://localhost/'}})).rejects.toThrow();
      expect(fetch).not.toHaveBeenCalled();expect(call).not.toHaveBeenCalled();
    }finally{fetch.mockRestore();call.mockRestore();}
  });
  it('keeps domain packages and skill identifiers outside the default host',async()=>{
    const {root}=await fixture(),config=loadConfig(root);
    expect(config.skills).toEqual([]);expect(config.extensions).toEqual([]);
    const source=fileURLToPath(new URL('../src/',import.meta.url));
    const importsDomain=/(?:\b(?:from|import)\s+(?:brain_of_exile|poe_crafting)\b|from\s+["'][^"']*(?:brain_of_exile|poe_crafting)|(?:import|require)\s*\(?\s*["'][^"']*(?:brain_of_exile|poe_crafting)|["']poe-(?:chat-runtime|crafting|mechanics-and-data|terminology-translation|ninja|trade-link)["']|["']pob-mcp["'])/;
    const dependencies:string[]=[];
    async function inspect(folder:string,prefix=''):Promise<void>{
      for(const entry of await readdir(folder,{withFileTypes:true})){
        const relative=prefix+entry.name,file=join(folder,entry.name);
        if(entry.isDirectory())await inspect(file,relative+'/');
        else if(/\.(ts|py)$/.test(entry.name)&&importsDomain.test(await readFile(file,'utf8')))dependencies.push(relative);
      }
    }
    await inspect(source);expect(dependencies).toEqual([]);
  });
  it('works without any domain skills, extension, browser or Python installation',async()=>{
    const {config,context}=await fixture();config.python='/not-installed/python';
    const session=await open(config,context);
    expect(await tool(session,'skills_list').execute({})).toEqual([]);
    await tool(session,'artifact_write').execute({path:'answer.txt',text:'Hello'});
    expect(await tool(session,'resource_read').execute({root:'workspace',path:'answer.txt'})).toMatchObject({text:'Hello',truncated:false});
    expect(await session.finalizeReport!(report())).toEqual(report());
    expect(session.systemContext).not.toMatch(/PoE|crafting|PoB/i);
  });
  it('exposes only selected skill roots and protects them from writes',async()=>{
    const {root,config,context}=await fixture();const allowed=join(root,'docs'),other=join(root,'other');
    await mkdir(allowed);await mkdir(other);await writeFile(join(allowed,'SKILL.md'),'Document skill');await writeFile(join(other,'SKILL.md'),'Unselected skill');
    config.skills=[{id:'docs',path:allowed}];
    const session=await open(config,context);
    const listing=await tool(session,'skills_list').execute({});
    expect(listing).toStrictEqual([{id:'docs',path:'SKILL.md'}]);
    // This is the actual SDK boundary that rejects undefined-valued properties.
    expect(snapshotJsonValue(listing)).toStrictEqual(listing);
    expect(await tool(session,'resource_read').execute({root:'docs',path:'SKILL.md'})).toMatchObject({text:'Document skill'});
    await expect(tool(session,'resource_read').execute({root:'other',path:'SKILL.md'})).rejects.toThrow('unavailable');
    await expect(tool(session,'artifact_write').execute({root:'docs',path:'SKILL.md',text:'overwrite'})).rejects.toThrow('read-only');
    expect(await readFile(join(allowed,'SKILL.md'),'utf8')).toBe('Document skill');
  });
  it('keeps configured skill descriptions losslessly serializable alongside omitted descriptions',async()=>{
    const {root,config,context}=await fixture();const docs=join(root,'docs');await mkdir(docs);await writeFile(join(docs,'SKILL.md'),'Documentation');
    config.skills=[{id:'plain',path:docs},{id:'described',path:docs,description:'Read supplied documentation'},{id:'empty',path:docs,description:''}];
    const session=await open(config,context),listing=await tool(session,'skills_list').execute({});
    expect(snapshotJsonValue(listing)).toStrictEqual([{id:'plain',path:'SKILL.md'},{id:'described',description:'Read supplied documentation',path:'SKILL.md'},{id:'empty',description:'',path:'SKILL.md'}]);
  });
  it('does not expose run-private files through visible history symlinks',async()=>{
    const {config,context}=await fixture();const prior=join(context.historyWorkspace!,'r-old');await mkdir(join(prior,'.private'),{recursive:true});
    await writeFile(join(prior,'.private','receipt.json'),'private receipt');await symlink(join(prior,'.private','receipt.json'),join(prior,'public.json'));
    const session=await open(config,context);
    await expect(tool(session,'resource_read').execute({root:'history',path:'r-old/public.json'})).rejects.toThrow(/[Pp]rivate/);
  });
  it('does not permit public write aliases into private run directories',async()=>{
    const {config,context}=await fixture();await mkdir(join(context.workspace,'.private'),{recursive:true});await symlink(join(context.workspace,'.private'),join(context.workspace,'alias'));
    const session=await open(config,context);
    await expect(tool(session,'artifact_write').execute({root:'run',path:'alias/injected.txt',text:'bad'})).rejects.toThrow(/[Pp]rivate/);
    await expect(readFile(join(context.workspace,'.private','injected.txt'),'utf8')).rejects.toMatchObject({code:'ENOENT'});
  });
  it('rejects dangling write aliases rather than following them outside the resource root',async()=>{
    const {root,context}=await fixture();await mkdir(context.workspace,{recursive:true});
    const outside=join(root,'outside-new-file');await symlink(outside,join(context.workspace,'dangling'));
    await expect(confinedPath(context.workspace,'dangling',true)).rejects.toMatchObject({code:'ENOENT'});
    await expect(readFile(outside)).rejects.toMatchObject({code:'ENOENT'});
  });
  it('enforces the host cancellation signal even without a per-tool signal',async()=>{
    const {config,context}=await fixture();const abort=new AbortController();context.signal=abort.signal;
    const session=await open(config,context);abort.abort(new Error('Task cancelled'));
    await expect(tool(session,'artifact_write').execute({path:'late.txt',text:'bad'})).rejects.toThrow('cancel');
    await expect(readFile(join(context.artifactWorkspace!,'late.txt'),'utf8')).rejects.toMatchObject({code:'ENOENT'});
  });
  it('prepares generated files for delivery using only current task artifacts',async()=>{
    const {config,context}=await fixture(),session=await open(config,context);
    await tool(session,'artifact_write').execute({path:'translation.md',text:'# Translation\n\nTranslated document.'});
    const prepared=await tool(session,'artifact_publish').execute({path:'translation.md',name:'译文.md'}) as {artifactId:string;name:string};
    const files=await session.resolveFiles!([prepared.artifactId]);
    expect(files[0].name).toBe('译文.md'); expect((await readOutgoingFile(files[0],context.workspace)).toString()).toContain('Translated document.');
    expect(JSON.stringify(prepared)).not.toContain(context.workspace);
    await expect(tool(session,'resource_read').execute({root:'run',path:'.reply-files/'+prepared.artifactId})).rejects.toThrow(/[Pp]rivate/);
    for(const root of ['history','docs','other'])await expect(tool(session,'artifact_publish').execute({root,path:'translation.md'})).rejects.toThrow('Only current task');
    await session.close(); await expect(session.resolveFiles!([prepared.artifactId])).rejects.toThrow('closed');
  });
  it('keeps cancelled file preparation from producing sendable artifacts',async()=>{
    const {config,context}=await fixture(),abort=new AbortController();context.signal=abort.signal;
    const session=await open(config,context);await tool(session,'artifact_write').execute({root:'run',path:'answer.md',text:'# Answer'});
    abort.abort(new Error('Task cancelled'));
    await expect(tool(session,'artifact_publish').execute({root:'run',path:'answer.md'})).rejects.toThrow('cancelled');
    await expect(session.resolveFiles!([])).rejects.toThrow('cancelled');
    expect(await readdir(context.workspace)).toEqual(['answer.md']);
  });
  it('does not initialize extensions for an already cancelled run',async()=>{
    const {root,config,context}=await fixture();const trace=join(root,'started');
    await extension(config,'demo',`import{writeFile}from'node:fs/promises';export async function createSession(options){await writeFile(options.trace,'started');return{${base}}}`,{trace});
    const abort=new AbortController();abort.abort(new Error('Task cancelled'));context.signal=abort.signal;
    await expect(createCapabilitySession(config,context)).rejects.toThrow('cancel');
    await expect(readFile(trace,'utf8')).rejects.toMatchObject({code:'ENOENT'});
  });
  it('closes earlier extensions if later initialization fails',async()=>{
    const {root,config,context}=await fixture();const trace=join(root,'closed.txt');
    await extension(config,'first',`import{appendFile}from'node:fs/promises';export async function createSession(options){return{tools:[],systemContext:'',async close(){await appendFile(options.trace,'closed\\n')}}}`,{trace});
    await extension(config,'second',`export async function createSession(){throw new Error('Cannot initialize')}`);
    await expect(createCapabilitySession(config,context)).rejects.toThrow('Cannot initialize');
    expect(await readFile(trace,'utf8')).toBe('closed\n');
  });
  it('disposes once and forbids extension tool execution after close',async()=>{
    const {root,config,context}=await fixture();const trace=join(root,'closed.txt');
    await extension(config,'demo',`import{appendFile}from'node:fs/promises';export async function createSession(options){return{tools:[{name:'demo',description:'Test',inputSchema:{type:'object'},async execute(){return 'ran'}}],systemContext:'',async close(){await appendFile(options.trace,'closed\\n')}}}`,{trace});
    const session=await open(config,context);expect(await tool(session,'demo').execute({})).toBe('ran');
    await session.close();await session.close();
    expect(await readFile(trace,'utf8')).toBe('closed\n');
    await expect(tool(session,'demo').execute({})).rejects.toThrow('closed');
  });
  it('forbids extension tools after host cancellation',async()=>{
    const {config,context}=await fixture();const abort=new AbortController();context.signal=abort.signal;
    await extension(config,'demo',`export async function createSession(){return{tools:[{name:'demo',description:'Test',inputSchema:{type:'object'},async execute(){return 'ran'}}],systemContext:'',async close(){}}}`);
    const session=await open(config,context);abort.abort(new Error('Task cancelled'));
    await expect(tool(session,'demo').execute({})).rejects.toThrow('cancel');
  });
  it('binds each extension to declared options and this run without passing host credentials',async()=>{
    const {config,context}=await fixture();
    await extension(config,'demo',`export async function createSession(options,context){return{${base},tools:[{name:'inspect',description:'Test',inputSchema:{type:'object'},async execute(){return{options,thread:context.threadId,run:context.runId,revision:context.revision,keys:Object.keys(context)}}}]}}`,{limit:4});
    const session=await open({...config,memoryApiKey:'must-not-pass',apiKey:'must-not-pass'} as CapabilityConfig,context);
    const result=await tool(session,'inspect').execute({});expect(result).toMatchObject({options:{limit:4},thread:'t-1',run:'r-1',revision:2});
    expect(JSON.stringify(result)).not.toContain('must-not-pass');
  });
  it('rejects duplicate tool names and closes created extensions',async()=>{
    const {root,config,context}=await fixture();const trace=join(root,'duplicate-close');
    await extension(config,'demo',`import{writeFile}from'node:fs/promises';export async function createSession(options){return{systemContext:'',tools:[{name:'skills_list'}],async close(){await writeFile(options.trace,'closed')}}}`,{trace});
    await expect(createCapabilitySession(config,context)).rejects.toThrow('Duplicate tool');expect(await readFile(trace,'utf8')).toBe('closed');
  });
});

describe('extension report and routing contracts',()=>{
  it('allows extensions to narrow generic host tools without granting extra tools',async()=>{
    const {config,context}=await fixture();
    await extension(config,'demo',`export async function createSession(){return{${base},hostTools:['artifact_write','unknown']}}`);
    const session=await open(config,context);expect(session.tools.map(tool=>tool.name)).toEqual(['artifact_write']);
    await tool(session,'artifact_write').execute({path:'report.md',text:'Saved locally.'});
    expect(await readFile(join(context.artifactWorkspace!,'report.md'),'utf8')).toBe('Saved locally.');
  });

  it('rejects in-place changes to host report bindings without mutating the caller report',async()=>{
    const {config,context}=await fixture();await extension(config,'demo',`export async function createSession(){return{${base},async finalizeReport(report){report.runId='other';return report}}}`);
    const session=await open(config,context),original=report();
    await expect(session.finalizeReport!(original)).rejects.toThrow('binding');expect(original).toEqual(report());
  });
  it('rejects in-place promotion of a failed report to success',async()=>{
    const {config,context}=await fixture();await extension(config,'demo',`export async function createSession(){return{${base},async finalizeReport(report){report.status='ready';return report}}}`);
    const session=await open(config,context);await expect(session.finalizeReport!(report('failed'))).rejects.toThrow('failed');
  });
  it('propagates finalizer failures and does not silently publish the original report',async()=>{
    const {config,context}=await fixture();await extension(config,'demo',`export async function createSession(){return{${base},async finalizeReport(){throw new Error('Evidence missing')}}}`);
    const session=await open(config,context);await expect(session.finalizeReport!(report())).rejects.toThrow('Evidence missing');
  });
  it('validates registered routing data and rejects unknown namespaces',async()=>{
    const {config}=await fixture();await extension(config,'demo',`export const routingFields={demo:{type:'object',properties:{required:{type:'boolean'}}}};export function validateRoutingMetadata(value){if(value.demo&&typeof value.demo.required!=='boolean')throw new Error('Invalid demo metadata')}export async function createSession(){return{${base}}}`);
    const modules=await loadExtensions(config);
    const action=(metadata:Record<string,unknown>):RouteAction=>({action:'open_thread',sourceMessageIds:['m'],subject:'Review document',routingMetadata:metadata});
    expect(()=>validateRoutingExtensions([action({demo:{required:true}})],modules)).not.toThrow();
    expect(()=>validateRoutingExtensions([action({demo:{required:'yes'}})],modules)).toThrow('Invalid');
    expect(()=>validateRoutingExtensions([action({unknown:{required:true}})],modules)).toThrow('Unregistered');
  });
  it('cannot declare routing metadata while silently omitting runtime validation',async()=>{
    const {config}=await fixture();await extension(config,'demo',`export const routingFields={demo:{type:'boolean'}};export async function createSession(){return{${base}}}`);
    await expect((async()=>{const modules=await loadExtensions(config);validateRoutingExtensions([{action:'open_thread',sourceMessageIds:['m'],subject:'Review',routingMetadata:{demo:'not a boolean'}}],modules);})()).rejects.toThrow();
  });
});
