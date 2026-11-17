import { loadConfig } from '../src/config.js';
import { DshRuntime } from '../src/dsh-runtime.js';
import { mkdirSync,writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { GroupMessage,RouterRequest } from '../src/types.js';
const config=loadConfig();const id=randomUUID();const root=join(config.stateDir,'verification','clarification-'+id);mkdirSync(root,{recursive:true});
const runtime=await DshRuntime.create({...config,stateDir:root});
const message=(n:number,text:string):GroupMessage=>({id:'clarify:'+id+':'+n,roomId:'clarify:'+id,messageId:String(n),platform:'replay',authorId:'A',authorName:'A',text,timestamp:Date.now(),mentions:[],attachments:[],isMentioned:true,isAdmin:false});
const initial=message(1,'请看看这个角色防御有什么短板。');
const records:unknown[]=[];const checks:Record<string,boolean>={};
try{
 const base:RouterRequest={roomId:initial.roomId,event:'messages',messages:[initial],recentMessages:[],threads:[]};
 // Explicit fixture premise: this clarification was already confirmed delivered.
 // This check isolates how the real model uses recentReplies, not how it chooses
 // the initial professional/clarification branch (covered separately in replay).
 const sent={messageId:'bot-1',replyToMessageId:'1',text:'请发一下项目的文档链接，我在等你补充后再核对需求。',sentAt:Date.now()};
 records.push({fixture:'already-delivered-clarification',input:initial,sent});
 const status=message(2,'我还没给链接，现在是不是在等我补充材料？');
 const second=await runtime.route({...base,messages:[status],recentMessages:[initial],recentReplies:[sent]});records.push({input:status,previousReply:sent,actions:second});
 checks.acknowledgesWaiting=second.some(x=>(x.action==='reply_direct'||x.action==='clarify')&&/等|补充|提供|发/.test(x.text));
 checks.noImaginaryStatusThread=second.every(x=>x.action!=='request_status'&&x.action!=='open_thread');
 const cancelled=message(3,'好的，今天不查了，先不用继续。');
 const third=await runtime.route({...base,messages:[cancelled],recentMessages:[initial,status],recentReplies:[sent]});records.push({input:cancelled,actions:third});
 checks.noWorkAfterWithdrawal=third.every(x=>['reply_direct','silence'].includes(x.action));
 const report={time:new Date().toISOString(),status:Object.values(checks).every(Boolean)?'passed':'failed',checks,records};writeFileSync(join(root,'result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
 if(report.status!=='passed')process.exitCode=2;
}catch(error){writeFileSync(join(root,'result.json'),JSON.stringify({time:new Date().toISOString(),status:'failed',checks,records,error:String(error).replaceAll(config.apiKey||'\0','[redacted]')},null,2));throw error;}finally{await runtime.close();}
