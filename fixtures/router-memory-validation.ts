import type {GroupMessage,RouterRequest} from '../src/types.js';

export interface MemoryValidationTurn {
 id:string;request:RouterRequest;restartBefore?:boolean;
 expectedSources:Array<{id:string;action:'reply_direct'|'silence'}>;
 expectedFields?:Record<string,string>;
}
const time=1_795_000_000_000,roomId='validation:room-memory';
function msg(id:string,authorId:string,text:string,isMentioned=true):GroupMessage{return{
 id:roomId+':'+id,platform:'replay',roomId,messageId:id,authorId,authorName:'成员'+authorId,text,timestamp:time,
 mentions:isMentioned?['bot']:[],attachments:[],isMentioned,isAdmin:false,
};}
function turn(id:string,author:string,text:string):MemoryValidationTurn{
 const m=msg(id,author,text);
 return{id,request:{roomId,event:'messages',botUserId:'bot',currentTime:time,messages:[m],recentMessages:[],threads:[]},expectedSources:[{id:m.id,action:'reply_direct'}]};
}
/** Small continuity probe; no external analysis, tool execution or public messages. */
export function roomMemoryValidationTurns():MemoryValidationTurn[]{
 const a=turn('a-initial','A','请记住这组测试条件：我的预算10元，保留键盘。这里只记住条件，不用执行分析任务；之后问到我时按这两个值。');
 const b=turn('b-independent','B','也请记住我的测试条件：预算80元，保留鼠标。我的条件和成员A独立；这里只记住，不用执行分析任务。');
 const chatter=msg('third-person-chatter','C','光头又插嘴了，大家继续聊自己的',false);
 b.request.messages.push(chatter);b.expectedSources.push({id:chatter.id,action:'silence'});
 const correction=turn('a-correction','A','更正我的测试条件：预算由10元改为7元，仍保留键盘。成员B的条件不变。只确认记住，不用执行分析任务。');
 correction.request.messages[0].replyToMessageId=a.request.messages[0].messageId;
 correction.request.references={[correction.request.messages[0].id]:{status:'unbound',message:structuredClone(a.request.messages[0]),chain:[a.request.messages[0].messageId]}};
 correction.request.addressing={[correction.request.messages[0].id]:{mentionsOthers:[],replyTo:{kind:'member',authorId:'A'}}};
 const recall=turn('after-restart','A','请只回复刚才保存的四项最新测试条件，格式：A预算=；A保留=；B预算=；B保留=。不要执行分析任务，也不要把两个人的条件合并。');
 recall.restartBefore=true;recall.expectedFields={'A预算':'7元','A保留':'键盘','B预算':'80元','B保留':'鼠标'};
 return[a,b,correction,recall].map((t,index)=>{
  t.request.currentTime=time+index*1000;
  for(const m of t.request.messages)m.timestamp=t.request.currentTime;
  return t;
 });
}
