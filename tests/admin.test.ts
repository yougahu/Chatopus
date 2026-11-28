import { describe,it,expect,afterEach,vi } from 'vitest';
import { mkdtempSync,rmSync,mkdirSync,writeFileSync,readFileSync,statSync,existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { AdminServer,redactAudit } from '../src/admin/server.js';
import { AdminMemoryApi,AdminMemoryError } from '../src/admin/memory.js';
import { DEFAULT_BUSINESS_SETTINGS } from '../src/business-config.js';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/store.js';
import type { GroupMessage } from '../src/types.js';
const cleanup:(()=>Promise<void>)[]=[];
afterEach(async()=>{vi.restoreAllMocks();for(const fn of cleanup.splice(0).reverse())await fn();});
async function setup(){
  const dir=mkdtempSync(join(tmpdir(),'boe-admin-'));cleanup.push(async()=>rmSync(dir,{recursive:true,force:true}));
  const config=loadConfig(dir,{apiKey:'test-secret-key',stateDir:dir});
  const store=new Store(join(dir,'state.sqlite'));cleanup.push(async()=>store.close());
  const server=new AdminServer(config,0);const url=await server.start();cleanup.push(()=>server.close());
  return{config,store,server,url};
}
describe('read-only audit console',()=>{
 it('awaits memory results, hides configured root credentials and applies normal access restrictions',async()=>{
  const{url,config}=await setup();config.memoryApiKey='memory-root-private-value';
  const read=vi.spyOn(AdminMemoryApi.prototype,'data').mockImplementation(async()=>({text:'memory-root-private-value',entries:[]}));
  const response=await fetch(url+'/api/memory/search?room=room&q=document');
  expect(response.status).toBe(200);expect(await response.json()).toEqual({text:'[redacted]',entries:[]});
  expect(read.mock.calls[0][0].searchParams.get('room')).toBe('room');
  expect((await fetch(url+'/api/memory/search',{method:'POST'})).status).toBe(405);
  expect((await fetch(url+'/api/memory',{headers:{Origin:'https://foreign.invalid'}})).status).toBe(403);
  expect(read).toHaveBeenCalledTimes(1);
 });
 it('exposes safe memory API errors and hides unexpected backend internals',async()=>{
  const{url}=await setup();
  const read=vi.spyOn(AdminMemoryApi.prototype,'data');
  read.mockRejectedValueOnce(new AdminMemoryError(404,'来源消息不存在。'));
  const missing=await fetch(url+'/api/memory/source?room=room&id=missing');
  expect(missing.status).toBe(404);expect(await missing.json()).toEqual({error:'来源消息不存在。'});
  read.mockRejectedValueOnce(new Error('private-user-key backend.internal /secret/path'));
  const failed=await fetch(url+'/api/memory/profile?room=room&member=user');
  expect(failed.status).toBe(503);expect(await failed.json()).toEqual({error:'记忆服务暂时不可用，请稍后重试。'});
 });
 it('keeps memory requests and redaction available while configuration is being edited',async()=>{
  const{url,config}=await setup();
  vi.spyOn(AdminMemoryApi.prototype,'data').mockResolvedValue({text:'test-secret-key'});
  writeFileSync(join(config.root,'config.local.json'),'{"memory":');
  const response=await fetch(url+'/api/memory');
  expect(response.status).toBe(200);expect(await response.json()).toEqual({text:'[redacted]'});
 });
 it('previews a large live JSONL tail even when the final append is incomplete',async()=>{
  const {config,url}=await setup();const dir=join(config.stateDir,'dsh/sessions/work/large-session');mkdirSync(dir,{recursive:true});
  const event=(text:string)=>JSON.stringify({type:'assistant/message',data:{message:{content:[{type:'text',text}]}}})+'\n';
  writeFileSync(join(dir,'session.v4.jsonl'),event('old'.repeat(7_000_000))+event('最新完整记录')+'{"type":');
  const response=await fetch(url+'/api/sessions/large-session');expect(response.status).toBe(200);
  const events=await response.json();expect(events[0]).toMatchObject({type:'audit/preview',data:{skipped:1}});
  expect(events.at(-1).data.message.content[0].text).toBe('最新完整记录');
 });
 it('preserves ask source identities while redacting actual API keys',()=>{
  expect(redactAudit({id:'ask-1793810100',text:'token sk-secret987'})).toEqual({id:'ask-1793810100',text:'token [redacted]'});
 });
 it('allows direct access without a token and rejects cross-site origins, hosts and unsupported writes',async()=>{
  const{url,config}=await setup();expect((await fetch(url+'/api/overview')).status).toBe(200);
  expect(existsSync(join(config.stateDir,'admin-token'))).toBe(false);
  const foreignHostStatus=await new Promise<number|undefined>((resolve,reject)=>{
   const req=request(url+'/api/overview',{headers:{Host:'foreign.invalid'}},res=>{res.resume();resolve(res.statusCode);});
   req.on('error',reject);req.end();
  });
  expect(foreignHostStatus).toBe(403);
  expect((await fetch(url+'/api/overview',{headers:{Origin:'https://foreign.invalid'}})).status).toBe(403);
  expect((await fetch(url+'/api/overview',{method:'POST'})).status).toBe(405);
  expect((await fetch(url+'/api/model-config',{method:'POST',body:'{}'})).status).toBe(415);
 });
 it('joins input, routing, worker report and outbox without modifying state',async()=>{
  const{store,url}=await setup();
  const message:GroupMessage={id:'room:1',roomId:'room',messageId:'1',platform:'replay',authorId:'A',authorName:'A',text:'文档如何整理',timestamp:1,mentions:[],attachments:[],isMentioned:false,isAdmin:false};
  store.ingest(message);const t=store.createThread(message,'整理',false);store.recordDecision('messages',[{action:'open_thread',sourceMessageIds:[message.id],subject:'整理'}],message.id);
  store.enqueue({roomId:'room',text:'答案'},{threadId:t.id});
  const detail=await(await fetch(url+'/api/threads/'+t.id)).json();
  expect(detail.inputs[0].data.message.text).toBe('文档如何整理');expect(detail.decisions).toHaveLength(1);expect(detail.outbox).toHaveLength(1);
  expect(store.thread(t.id)?.status).toBe('queued');
 });
 it('shows only final image input failures as overview alerts, retaining other operational failures',async()=>{
  const{store,url}=await setup();
  for(const status of ['hit','success','miss','failed','skipped'])store.telemetry('image_receive',{threadId:'t-image',stage:'download',status});
  for(const status of ['loaded','failed','omitted'])store.telemetry('image_input',{threadId:'t-image',messageId:'image-1',status});
  store.telemetry('model',{role:'worker'});store.telemetry('run_failed',{error:'existing worker failure'});
  const overview=await(await fetch(url+'/api/overview')).json();
  expect(overview.errors.map((item:{kind:string})=>item.kind)).toEqual(['run_failed','image_input']);
  expect(overview.errors[1].data.status).toBe('failed');
  expect(overview.metrics).toHaveLength(1);
 });
 it('includes the latest 200 image events in thread audit order with exact thread isolation',async()=>{
  const{store,url}=await setup();
  for(let index=0;index<205;index++)store.telemetry(index%2?'image_receive':'image_input',{threadId:'t-image',index,status:index%2?'hit':'loaded'});
  store.telemetry('image_input',{threadId:'t-image-other',status:'failed',index:'foreign'});
  store.telemetry('model',{threadId:'t-image',role:'worker',index:'not-image'});
  const detail=await(await fetch(url+'/api/threads/t-image')).json();
  expect(detail.imageEvents).toHaveLength(200);
  expect(detail.imageEvents.map((item:{data:{index:number}})=>item.data.index)).toEqual(Array.from({length:200},(_,index)=>index+5));
  expect(detail.imageEvents.every((item:{data:{threadId:string}})=>item.data.threadId==='t-image')).toBe(true);
  expect((await(await fetch(url+'/api/threads/no-images')).json()).imageEvents).toEqual([]);
 });
 it('keeps domain-tool audit out of operational alerts and aggregates the full topic beyond preview limits',async()=>{
  const{store,url}=await setup();
  for(let i=0;i<205;i++)store.telemetry('domain_tool',{threadId:'t-resource',tool:'resource_catalogue',category:'catalogue',status:i===0?'error':'ok',truncated:false,repeatedRequest:i>0,elapsedMs:10,responseCharacters:100});
  store.telemetry('domain_tool',{threadId:'t-other',tool:'resource_catalogue',status:'error'});
  const detail=await(await fetch(url+'/api/threads/t-resource')).json();
  expect(detail.domainEvents).toHaveLength(200);expect(detail.domainSummary).toEqual([expect.objectContaining({tool:'resource_catalogue',calls:205,errors:1,repeated:204,elapsedMs:2050,responseCharacters:20500})]);
  expect((await(await fetch(url+'/api/overview')).json()).errors).toEqual([]);
 });
 it('counts batch items separately and only attributes recovery within the same run, revision, tool and request',async()=>{
  const{store,url}=await setup();
  const emit=(status:string,extra:Record<string,unknown>={})=>store.telemetry('domain_tool',{threadId:'batch-topic',runId:'run-a',revision:1,tool:'read_batch',category:'batch',requestFingerprint:'fp-a',status,repeatedRequest:false,elapsedMs:2,responseCharacters:10,...extra});
  emit('partial',{items:[{status:'ok'},{status:'error'},{status:'empty'}]});
  emit('ok',{items:[{status:'ok'},{status:'ok'},{status:'empty'}],repeatedRequest:true});
  emit('ok',{items:[{status:'ok'}],repeatedRequest:true});
  emit('error',{requestFingerprint:'fp-b',items:[{status:'error'},{status:'error'}]});
  emit('ok',{requestFingerprint:'fp-b',runId:'run-b',items:[{status:'ok'}]});
  emit('ok',{requestFingerprint:'fp-b',revision:2,items:[{status:'ok'}]});
  emit('ok',{requestFingerprint:'fp-c',items:[{status:'ok'}]});
  emit('error',{requestFingerprint:null});emit('ok',{requestFingerprint:null});
  emit('partial',{requestFingerprint:'fp-d',items:[{status:'error'}]});
  emit('ok',{requestFingerprint:'fp-d',tool:'different_tool',category:'reference',itemCount:999});
  emit('error',{threadId:'other-topic',requestFingerprint:'fp-e'});emit('ok',{requestFingerprint:'fp-e'});
  const detail=await(await fetch(url+'/api/threads/batch-topic')).json();
  expect(detail.domainSummary.find((r:any)=>r.tool==='read_batch')).toMatchObject({calls:11,errors:2,partial:2,repeated:2,itemsTotal:13,itemsOk:7,itemsErrors:4,itemsEmpty:2,recoveredRetries:1,elapsedMs:22,responseCharacters:110});
  expect(detail.domainSummary.find((r:any)=>r.tool==='different_tool')).toMatchObject({calls:1,itemsTotal:0,itemsErrors:0,recoveredRetries:0});
  expect((await(await fetch(url+'/api/overview')).json()).errors).toEqual([]);
 });
 it('does not infer successful retries from incomplete or malformed audit identities',async()=>{
  const{store,url}=await setup();
  const variants=[{revision:undefined},{revision:null},{revision:'1'},{revision:0},{tool:null},{tool:''},{runId:123},{requestFingerprint:null}];
  for(const [index,variant] of variants.entries())for(const status of ['error','ok'])store.telemetry('domain_tool',{threadId:'incomplete',runId:'run-'+index,revision:1,tool:'reader',requestFingerprint:'fingerprint',category:'batch',status,items:null,...variant});
  const detail=await(await fetch(url+'/api/threads/incomplete')).json();
  expect(detail.domainSummary.reduce((n:number,r:any)=>n+r.calls,0)).toBe(16);
  expect(detail.domainSummary.every((r:any)=>r.recoveredRetries===0&&r.itemsTotal===0)).toBe(true);
 });
 it('redacts credentials and omits thinking from actual session previews',async()=>{
  const{config,url}=await setup();const dir=join(config.stateDir,'dsh/sessions/work/test-session');mkdirSync(dir,{recursive:true});
  writeFileSync(join(dir,'session.v4.jsonl'),JSON.stringify({type:'assistant/message',data:{message:{content:[{type:'thinking',thinking:'private reasoning'},{type:'reasoning',text:'private reasoning'},{type:'text',text:'test-secret-key sk-secret987'}]},stream:['private'],authorization:'Bearer abc'}})+'\n');
  const r=await fetch(url+'/api/sessions/test-session');const text=await r.text();expect(text).not.toContain('test-secret-key');expect(text).not.toContain('private reasoning');expect(text).not.toContain('sk-secret987');
  const c=await(await fetch(url+'/api/config')).text();expect(c).not.toContain('test-secret-key');
  expect((await fetch(url+'/api/sessions/'+encodeURIComponent('../secret'))).status).toBe(400);
 });
 it('serves isolated frontend assets with no external scripts',async()=>{
  const{url}=await setup();const response=await fetch(url);expect(response.headers.get('content-security-policy')).toContain("script-src 'self'");expect(await response.text()).toContain('运行概览');
  expect((await fetch(url+'/app.js')).status).toBe(200);expect((await fetch(url+'/.env')).status).toBe(404);
 });
 it('keeps persona configuration in business settings and permits repairing an unavailable file',async()=>{
  const{config,url}=await setup();const business=structuredClone(DEFAULT_BUSINESS_SETTINGS);
  business.profiles.default.personaFile='missing-persona.md';
  writeFileSync(join(config.root,'config.local.json'),JSON.stringify({business}));
  const response=await fetch(url+'/api/config');expect(response.status).toBe(200);
  const current=await response.json();
  for(const key of ['personaFile','roomPersonaFiles','personaInfo'])expect(current).not.toHaveProperty(key);
  const settings=await(await fetch(url+'/api/business-config')).json();
  expect(settings.settings.profiles.default.personaFile).toBe('missing-persona.md');
  const preview=await fetch(url+'/api/business-config/preview',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({settings:business,profileId:'default'})});
  expect((await preview.json()).personaError).toContain('人格文件不可用');
 });
 it('saves independent model credentials without echoing or erasing them on blank input',async()=>{
  const{config,url}=await setup();const request={router:{model:'router-model',baseUrl:'https://router.example/v1',api:'openai-responses',reasoningEffort:'low',apiKey:'router-private-value'},worker:{model:'worker-model',baseUrl:'https://worker.example/v1',api:'openai-completions',reasoningEffort:'high',apiKey:'worker-private-value'}};
  const saved=await fetch(url+'/api/model-config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(request)});expect(saved.status).toBe(200);const body=await saved.text();expect(body).not.toContain('router-private-value');expect(body).not.toContain('worker-private-value');
  const env=readFileSync(join(config.root,'.env'),'utf8');expect(env).toContain('ROUTER_API_KEY="router-private-value"');expect(env).toContain('WORKER_API_KEY="worker-private-value"');expect(statSync(join(config.root,'.env')).mode&0o777).toBe(0o600);
  const disk=JSON.parse(readFileSync(join(config.root,'config.local.json'),'utf8'));expect(disk.router.model).toBe('router-model');expect(disk.worker.baseUrl).toBe('https://worker.example/v1');expect(JSON.stringify(disk)).not.toContain('private-value');
  const again=await fetch(url+'/api/model-config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({router:{model:'router-new',apiKey:''}})});expect(again.status).toBe(200);expect(readFileSync(join(config.root,'.env'),'utf8')).toContain('router-private-value');
  expect((await fetch(url+'/api/model-config',{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://other.example'},body:'{}'})).status).toBe(403);
 });
 it('saves normalized call names without altering other settings or credentials, and applies them on restart',async()=>{
  const{config,url}=await setup(),file=join(config.root,'config.local.json'),envFile=join(config.root,'.env');
  const prior={router:{model:'custom-router'},qq:{allowedGroupIds:['123']},custom:{preserved:true}};
  writeFileSync(file,JSON.stringify(prior));writeFileSync(envFile,'ROUTER_API_KEY=private-router-key\n');
  const post=(botCallNames:string[])=>fetch(url+'/api/activation-config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({botCallNames})});
  const saved=await post([' 小助手 ','Chris','chris','小助手']);expect(saved.status).toBe(200);
  expect(await saved.json()).toEqual({saved:true,appliesTo:'bot-restart',config:{botCallNames:['小助手','Chris']}});
  expect(JSON.parse(readFileSync(file,'utf8'))).toEqual({...prior,botCallNames:['小助手','Chris']});
  expect(readFileSync(envFile,'utf8')).toBe('ROUTER_API_KEY=private-router-key\n');
  expect(statSync(file).mode&0o777).toBe(0o600);
  expect((await(await fetch(url+'/api/config')).json()).botCallNames).toEqual(['小助手','Chris']);
  expect(config.botCallNames).toEqual(['机器人']);expect(loadConfig(config.root).botCallNames).toEqual(['小助手','Chris']);
  expect((await post([])).status).toBe(200);expect(loadConfig(config.root).botCallNames).toEqual([]);
 });
 it('rejects invalid call names and unrelated writes without modifying saved configuration',async()=>{
  const{config,url}=await setup(),file=join(config.root,'config.local.json');
  const original=JSON.stringify({botCallNames:['小助手'],worker:{model:'kept'}});writeFileSync(file,original);
  const invalid=[{},null,[],{botCallNames:'Chris'},{botCallNames:['']},{botCallNames:[1]},{botCallNames:['a'.repeat(81)]},{botCallNames:Array(33).fill('a')},{botCallNames:['line\nbreak']},{botCallNames:['bad\0name']},{botCallNames:[],qq:{enabled:false}}];
  for(const body of invalid){
   const response=await fetch(url+'/api/activation-config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
   expect(response.status).toBe(400);expect(readFileSync(file,'utf8')).toBe(original);
  }
  for(const body of ['{',' '.repeat(16_001)])expect((await fetch(url+'/api/activation-config',{method:'POST',headers:{'Content-Type':'application/json'},body})).status).toBe(400);
  expect(readFileSync(file,'utf8')).toBe(original);
 });
 it('enforces same-origin JSON writes for activation settings',async()=>{
  const{url}=await setup();
  expect((await fetch(url+'/api/activation-config')).status).toBe(405);
  expect((await fetch(url+'/api/activation-config',{method:'POST',body:'{}'})).status).toBe(415);
  expect((await fetch(url+'/api/activation-config',{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://other.example'},body:'{"botCallNames":[]}'})).status).toBe(403);
 });
});
it('shows durable Router recovery counters and failed-summary usage without flagging healthy lifecycle events',async()=>{
 const {store,url}=await setup();store.routerSessions.ensureSession({roomId:'room',sessionId:'native',configHash:'config'});
 const turn=store.routerSessions.beginTurn({roomId:'room',trigger:{kind:'messages',key:'one'},inputs:[{kind:'message',id:'one'}],request:{}});
 store.routerSessions.bindBudget(turn.id,Date.now()+60_000);store.routerSessions.consumeModelCall(turn.id,true);
 store.telemetry('router_context_lifecycle',{kind:'context_seed',roomId:'room'});store.telemetry('router_model_call',{turnId:turn.id,purpose:'compaction',code:'max-tokens',inputTokens:100,outputTokens:20});
 const overview=await (await fetch(url+'/api/overview')).json();
 expect(overview.router.turns[0]).toMatchObject({id:turn.id,model_calls:1,summary_calls:1,state:'pending'});
 expect(overview.router.calls[0].data).toMatchObject({code:'max-tokens',outputTokens:20});
 expect(overview.errors.some((row:{kind:string})=>row.kind==='router_context_lifecycle')).toBe(false);
 expect(overview.errors.some((row:{kind:string})=>row.kind==='router_model_call')).toBe(true);
});

it('separates routine continuation events from alerts and exposes delivery attempts',async()=>{
 const {store,url}=await setup();
 for(const kind of ['input_committed','run_started','run_supersede_requested','run_superseded','handoff_reply_queued','delivery_attempt_started'])store.telemetry(kind,{threadId:'t',outboxId:'reply'});
 store.telemetry('delivery_attempt_settled',{threadId:'t',outboxId:'reply',status:'sent'});
 store.telemetry('delivery_attempt_settled',{threadId:'t',outboxId:'reply',status:'unknown',platformCode:1200,reason:'send_result_unknown'});
 store.telemetry('worker_cleanup_blocked',{threadId:'t'});
 store.enqueue({roomId:'room',text:'handoff'},{id:'reply',kind:'handoff',associationThreadId:'t'});
 const overview=await(await fetch(url+'/api/overview')).json();
 expect(overview.errors.map((event:any)=>event.kind)).toEqual(['worker_cleanup_blocked','delivery_attempt_settled']);
 const rows=await(await fetch(url+'/api/outbox')).json();expect(rows[0].deliveryEvents).toHaveLength(3);
 const detail=await(await fetch(url+'/api/threads/t')).json();expect(detail.outbox).toHaveLength(1);
 expect(detail.lifecycleEvents.some((event:any)=>event.kind==='run_superseded')).toBe(true);
});

describe('private conversation administration',()=>{
 it('saves the four settings with revision checking without claiming service application',async()=>{
  const f=await setup();writeFileSync(join(f.config.root,'config.local.json'),JSON.stringify({qq:{selfId:'900',allowedGroupIds:['100']},custom:{keep:true}}));
  const before=await (await fetch(f.url+'/api/config')).json();expect(before.privateChatStatus.settings.enabled).toBe(false);
  const body={revision:before.privateChatStatus.revision,settings:{enabled:true,allowedUserIds:['901'],maxMessagesPerMinute:20,replyMode:'plain'}};
  const response=await fetch(f.url+'/api/config',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}),saved=await response.json();
  expect(response.status).toBe(200);expect(saved.saved).toBe(true);expect(saved.applied).toBeNull();expect(saved.running).toBe(false);
  expect(JSON.parse(readFileSync(join(f.config.root,'config.local.json'),'utf8'))).toMatchObject({custom:{keep:true},qq:{allowedGroupIds:['100'],privateChat:body.settings}});
  expect((await fetch(f.url+'/api/config',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})).status).toBe(409);
 });
 it('shows invalid disk configuration while retaining the last application evidence',async()=>{
  const f=await setup();f.store.telemetry('private_config_applied',{digest:'old',settings:{enabled:false},appliedAt:123});writeFileSync(join(f.config.root,'config.local.json'),'{ invalid');
  const response=await fetch(f.url+'/api/config'),value=await response.json();expect(response.status).toBe(200);expect(value.privateChatStatus.applied.digest).toBe('old');expect(value.privateChatStatus.error.code).toBe('private_config_invalid');
 });
 it('filters private messages before pagination and keeps full room identities',async()=>{
  const f=await setup();for(let i=0;i<120;i++)f.store.ingest({id:'m'+i,roomId:i<105?'qq:900:100':'qq:900:private:100',platform:'qq',messageId:String(i),authorId:'100',authorName:'Member',text:'hello',timestamp:i,mentions:[],attachments:[],isMentioned:false,isAdmin:false});
  const privateRows=await (await fetch(f.url+'/api/messages?kind=private&offset=10')).json();expect(privateRows).toHaveLength(5);expect(privateRows.every((r:any)=>r.room==='qq:900:private:100')).toBe(true);
  const groups=await (await fetch(f.url+'/api/messages?kind=group&offset=100')).json();expect(groups).toHaveLength(5);expect(groups.every((r:any)=>r.room==='qq:900:100')).toBe(true);
 });
 it('resolves delivery uncertainty through the shared transaction without rewriting platform facts',async()=>{
  const f=await setup();const id=f.store.enqueue({roomId:'room',text:'result'},{id:'uncertain',status:'unknown'});
  const response=await fetch(f.url+'/api/deliveries/resolve',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({outboxId:id,decision:'received',expectedResolutionVersion:0,key:'admin-resolution'})});
  expect(response.status).toBe(200);expect((await response.json()).closed).toBe(true);expect(f.store.outbox()[0]).toMatchObject({status:'unknown',deliveryResolutions:[{reason:'confirmed_received',actor:{kind:'admin',id:'local-admin'}}]});
 });
});
