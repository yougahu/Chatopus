import { expect,it } from 'vitest';
import { enforceExplicitActivation,hasWakeCandidate } from '../src/activation.js';
import type { GroupMessage,RouteAction } from '../src/types.js';
const message:GroupMessage={id:'current',messageId:'current',platform:'replay',roomId:'room',authorId:'a',authorName:'A',text:'缓存过期会清除已有连接吗',timestamp:1,mentions:[],attachments:[],isMentioned:false,isAdmin:false};
const names=['光头','Chris','机器人','C++'];
it('requires an actual mention or a configured name in the current text',()=>{
  for(const text of ['缓存过期会清除已有连接吗','帮我查一下','继续','这是你要的日志','@all 在吗','Christmas','https://example.com/Chris'])
    expect(hasWakeCandidate({...message,text,replyToMessageId:'bot-reply'},names),text).toBe(false);
  for(const text of ['光头，帮我查一下','pn几点发，光头','CHRIS在吗','机器人在吗','C++，看一下'])
    expect(hasWakeCandidate({...message,text},names),text).toBe(true);
  expect(hasWakeCandidate({...message,isMentioned:true,text:''},[])).toBe(true);
  // Mentioning a name reaches semantic Router validation, which must decide silence for third-person discussion.
  expect(hasWakeCandidate({...message,text:'光头又插嘴了'},names)).toBe(true);
});
it('suppresses uncalled sources in every action of a mixed batch without changing result delivery',()=>{
  const called={...message,id:'called',isMentioned:true};
  const actions:RouteAction[]=[{action:'open_thread',sourceMessageIds:['current','called'],subject:'问题'},
    {action:'publish_result',resultId:'finished'}];
  expect(enforceExplicitActivation(actions,[message,called],names)).toEqual([
    {action:'open_thread',sourceMessageIds:['called'],subject:'问题'},
    {action:'silence',sourceMessageIds:['current'],reason:expect.any(String)},
    {action:'publish_result',resultId:'finished'},
  ]);
});
