/** Real model + browser screenshot through OneBot, with a local protocol peer instead of QQ. */
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { loadConfig } from '../src/config.js';
import { Coordinator } from '../src/coordinator.js';
import { DshRuntime, type RuntimeMetrics } from '../src/dsh-runtime.js';
import { OneBotAdapter } from '../src/platform/onebot.js';
import { Store } from '../src/store.js';
import { imageMime } from '../src/output-images.js';

const root=resolve('.');
const stateDir=join(root,'.runtime','verification','image-reply-'+randomUUID());
mkdirSync(stateDir,{recursive:true,mode:0o700});
const config=loadConfig(root,{stateDir});
const store=new Store(join(stateDir,'state.sqlite'));
const metrics:RuntimeMetrics[]=[];
const wireMessages:Record<string,unknown>[]=[];
const startedAt=Date.now();
const report:Record<string,unknown>={status:'running',stateDir,startedAt:new Date(startedAt).toISOString(),
  scope:'Real Router, Worker, browser and OneBot encoding. Local authenticated WebSocket peer only; no QQ recipients.',
  question:'帮我打开 https://nodejs.org/api/fs.html ，截一张说明正文顶部的图发给我，配一句说明就好。',
  models:{router:config.router,worker:config.worker},metrics,wireMessages};
const save=()=>writeFileSync(join(stateDir,'result.json'),JSON.stringify(report,null,2),{mode:0o600});
const runtime=await DshRuntime.create(config,{onMetrics:metric=>{metrics.push(metric);save();}});
let coordinator:Coordinator;
const accessToken=randomUUID();
const adapter=new OneBotAdapter({selfId:'900',accessToken,allowedGroupIds:['100'],port:0,
  outputRoot:join(stateDir,'workspaces'),onMessage:message=>coordinator.receive(message),
  onError:code=>store.telemetry('test-platform',{code})});
coordinator=new Coordinator(config,store,runtime,adapter);
let client:WebSocket|undefined;
async function waitFor(check:()=>boolean,timeout:number){
  const until=Date.now()+timeout;
  while(Date.now()<until){if(check())return;await new Promise(resolve=>setTimeout(resolve,50));}
  throw new Error('Timed out waiting for message intake/routing');
}
function collectTraces(directory:string):Record<string,unknown>[] {
  return readdirSync(directory,{withFileTypes:true}).flatMap(entry=>{
    const file=join(directory,entry.name);
    if(entry.isDirectory())return collectTraces(file);
    if(entry.name!=='session.v4.jsonl')return [];
    const events=readFileSync(file,'utf8').split('\n').filter(Boolean).map(line=>JSON.parse(line));
    return [{file,tools:events.filter(e=>e.type==='tool/call').map(e=>({name:e.data.name,arguments:e.data.arguments})),
      errors:events.filter(e=>e.type==='turn/end'&&e.data.reason?.kind==='error').map(e=>e.data.reason.error)}];
  });
}
save();
try {
  await adapter.start();await coordinator.start();
  client=new WebSocket(`ws://127.0.0.1:${adapter.port}/onebot/v11/ws`,{headers:{Authorization:'Bearer '+accessToken,'X-Self-ID':'900'}});
  await once(client,'open');
  client.on('message',raw=>{
    const packet=JSON.parse(raw.toString());
    if(packet.action!=='send_group_msg')throw new Error('Unexpected protocol action');
    const images:Array<Record<string,unknown>>=[];
    for(const segment of packet.params.message){
      if(segment.type!=='image')continue;
      if(!segment.data.file.startsWith('base64://'))throw new Error('Image was not sent as bytes');
      const bytes=Buffer.from(segment.data.file.slice(9),'base64');
      const mimeType=imageMime(bytes);const sha256=createHash('sha256').update(bytes).digest('hex');
      const file=join(stateDir,`wire-image-${wireMessages.length}-${images.length}.${mimeType==='image/png'?'png':'jpg'}`);
      writeFileSync(file,bytes,{mode:0o600});images.push({file,bytes:bytes.length,mimeType,sha256});
    }
    const item={at:Date.now(),elapsedMs:Date.now()-startedAt,groupId:packet.params.group_id,
      text:packet.params.message.filter((segment:{type:string})=>segment.type==='text').map((segment:{data:{text:string}})=>segment.data.text).join(''),images};
    wireMessages.push(item);save();console.log(JSON.stringify({event:'local_wire_message',...item}));
    client!.send(JSON.stringify({echo:packet.echo,status:'ok',retcode:0,data:{message_id:1000+wireMessages.length}}));
  });
  client.send(JSON.stringify({post_type:'message',message_type:'group',self_id:900,user_id:901,group_id:100,message_id:101,
    time:Math.floor(Date.now()/1000),sender:{nickname:'图片验收成员',role:'member'},
    message:[{type:'at',data:{qq:'900'}},{type:'text',data:{text:report.question}}]}));
  await waitFor(()=>!!store.message('qq:900:100:101'),10_000);
  await waitFor(()=>store.db.prepare("SELECT status FROM messages WHERE id='qq:900:100:101'").get()?.status==='routed',100_000);
  await coordinator.drain(config.workerTimeoutMs*2+180_000);
  const outgoing=store.outbox('sent').filter(row=>row.message.attachments?.length);
  const wireImages=wireMessages.flatMap(item=>item.images as Array<{sha256:string}>);
  if(outgoing.length!==1||wireImages.length!==1)throw new Error('Expected one actual image reply on the local OneBot wire');
  if(outgoing[0].message.attachments![0].sha256!==wireImages[0].sha256)throw new Error('Wire bytes differ from the recorded screenshot');
  if(store.threads().some(thread=>thread.status==='failed'))throw new Error('Worker failed');
  report.status='passed';
}catch(error){report.status='failed';report.error=String(error).replace(/(?:sk-|Bearer\s+)[A-Za-z0-9_\-.]+/gi,'[redacted]');process.exitCode=1;}
finally {
  await coordinator.close();await adapter.close();client?.terminate();
  report.decisions=store.decisions();report.outbox=store.outbox();
  report.runs=store.db.prepare('SELECT status,data FROM runs ORDER BY rowid').all().map(row=>({status:row.status,data:JSON.parse(String(row.data))}));
  report.telemetry=store.db.prepare('SELECT kind,data FROM telemetry ORDER BY id').all().map(row=>({kind:row.kind,data:JSON.parse(String(row.data))}));
  report.traces=collectTraces(join(stateDir,'dsh/sessions'));report.elapsedMs=Date.now()-startedAt;
  report.completedAt=new Date().toISOString();save();store.close();
  console.log(JSON.stringify({status:report.status,evidence:join(stateDir,'result.json'),elapsedMs:report.elapsedMs,error:report.error}));
}
