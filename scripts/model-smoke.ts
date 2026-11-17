import { loadConfig } from '../src/config.js';
import { DshRuntime } from '../src/dsh-runtime.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const config=loadConfig();
const metrics:unknown[]=[];
const runtime=await DshRuntime.create(config,{onMetrics:m=>metrics.push(m)});
try{
  const message={id:'smoke:1',platform:'replay' as const,roomId:'smoke',messageId:'1',authorId:'tester',authorName:'验证',text:'你好，能帮我整理一份待办清单吗？',timestamp:Date.now(),mentions:[],attachments:[],isMentioned:false,isAdmin:false};
  const actions=await runtime.route({roomId:'smoke',event:'messages',messages:[message],recentMessages:[],threads:[]});
  const report={time:new Date().toISOString(),model:config.router.model,endpoint:config.baseUrl,actions,metrics};
  mkdirSync(join(config.stateDir,'verification'),{recursive:true});
  writeFileSync(join(config.stateDir,'verification/model-smoke.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
  if(actions.length!==1||actions[0].action!=='open_thread')throw new Error('Smoke did not route professional question to Worker');
}finally{await runtime.close();}
