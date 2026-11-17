import { describe, expect, it } from 'vitest';
import { parseRoutesForRequest } from '../src/protocol.js';
import type { GroupMessage, RouteAction, RouterRequest, ThreadCard } from '../src/types.js';

const roomId='qq:bot:room';
function message(id:string,authorId='player'):GroupMessage {
  return {id:`${roomId}:${id}`,platform:'qq',roomId,messageId:id,authorId,authorName:authorId,
    text:'继续刚才的问题',timestamp:1,mentions:[],attachments:[],isMentioned:false,isAdmin:false};
}
const current=message('current'),old=message('old');
const thread:ThreadCard={id:'current-thread',roomId,subject:'方案分析',ownerId:'player',sourceMessageId:'old',
  explicit:true,participants:['player'],status:'idle',revision:2,latestInputSeq:2,sessionId:'worker-session',epoch:2,summary:'已回答'};
function request(overrides:Partial<RouterRequest>={}):RouterRequest {
  return {roomId,event:'messages',messages:[current],recentMessages:[old],recentReplies:[{messageId:'bot-reply',text:'已回答',sentAt:1}],threads:[thread],...overrides};
}
function parse(actions:RouteAction[],input=request()) {return parseRoutesForRequest(JSON.stringify(actions),input);}

describe('Router actions are bound to the current request',()=>{
  it('rejects remembered sources, platform-only IDs and prior bot replies as new requests',()=>{
    for(const id of [old.id,current.messageId,'bot-reply']){
      expect(()=>parse([{action:'open_thread',sourceMessageIds:[id],subject:'旧请求'}])).toThrow('Uncovered or duplicate source messages');
    }
  });

  it('requires each current source once and permits a single action for a current batch',()=>{
    const second=message('second'),batch=request({messages:[current,second]});
    expect(()=>parse([{action:'silence',sourceMessageIds:[current.id]}],batch)).toThrow('Uncovered or duplicate source messages');
    expect(()=>parse([{action:'silence',sourceMessageIds:[current.id,current.id]}],batch)).toThrow('Uncovered or duplicate source messages');
    const actions:RouteAction[]=[{action:'open_thread',sourceMessageIds:[current.id,second.id],subject:'共同的当前问题'}];
    expect(parse(actions,batch)).toEqual(actions);
  });

  it('rejects threads absent from the latest snapshot or belonging to another room',()=>{
    for(const action of ['append_thread','request_status','request_cancel'] as const){
      expect(()=>parse([{action,sourceMessageIds:[current.id],threadId:'remembered-thread'}])).toThrow('Thread outside supplied room scope');
      expect(()=>parse([{action,sourceMessageIds:[current.id],threadId:thread.id}],request({threads:[{...thread,roomId:'other-room'}]}))).toThrow('Thread outside supplied room scope');
      expect(parse([{action,sourceMessageIds:[current.id],threadId:thread.id}])).toHaveLength(1);
    }
  });

  it('identifies missing, duplicate and unexpected sources without treating history as current input',()=>{
    const second=message('second'),batch=request({messages:[current,second]});
    expect(()=>parse([{action:'silence',sourceMessageIds:[current.id,current.id,old.id]}],batch))
      .toThrow(`Uncovered or duplicate source messages: ${JSON.stringify({missing:[second.id],unexpected:[old.id],duplicates:[current.id]})}`);
  });

  it('accepts supplied historical context without routing that old message again',()=>{
    const actions:RouteAction[]=[{action:'append_thread',sourceMessageIds:[current.id],threadId:thread.id,contextMessageIds:[old.id]}];
    expect(parse(actions)).toEqual(actions);
    expect(()=>parse(actions,request({recentMessages:[]}))).toThrow('Image context outside supplied source scope');
    expect(()=>parse([{...actions[0],sourceMessageIds:[current.id,old.id]} as RouteAction])).toThrow('Uncovered or duplicate source messages');
  });

  it('keeps authorship and room boundaries while allowing an explicit quote of another member',()=>{
    const other=message('other','friend');
    const actions:RouteAction[]=[{action:'open_thread',sourceMessageIds:[current.id],subject:'解释引用的内容',contextMessageIds:[other.id]}];
    expect(parse(actions,request({recentMessages:[other]}))).toEqual(actions);
    expect(()=>parse(actions,request({recentMessages:[{...other,attachments:[{kind:'image',file:'other.png'}]}]}))).toThrow('Image context outside supplied source scope');
    expect(parse(actions,request({messages:[{...current,replyToMessageId:other.messageId}],recentMessages:[other]}))).toEqual(actions);
    expect(()=>parse(actions,request({messages:[{...current,replyToMessageId:other.messageId}],recentMessages:[{...other,roomId:'other-room'}]}))).toThrow('Image context outside supplied source scope');
  });

  it('limits publication and deferral to the one current result',()=>{
    const result:NonNullable<RouterRequest['result']>={id:'current-result',threadId:thread.id,explicit:true,
      report:{threadId:thread.id,runId:'current-run',coveredInputSeq:2,basedOnRevision:2,status:'ready',shortAnswer:'当前结论',assumptions:[],evidenceRefs:[],openQuestions:[]}};
    for(const event of ['worker_result','timer'] as const){
      const input=request({event,messages:[],result});
      expect(parse([{action:'publish_result',resultId:result.id}],input)).toHaveLength(1);
      expect(parse([{action:'defer_result',resultId:result.id,delayMs:100}],input)).toHaveLength(1);
      expect(()=>parse([{action:'publish_result',resultId:'remembered-result'}],input)).toThrow('Invalid result decision');
      expect(()=>parse([{action:'silence',sourceMessageIds:[old.id]}],input)).toThrow('Invalid result decision');
      expect(()=>parse([{action:'publish_result',resultId:result.id},{action:'publish_result',resultId:result.id}],input)).toThrow('Invalid result decision');
    }
    expect(()=>parse([{action:'publish_result',resultId:result.id}])).toThrow('Result action for user message');
  });
});
