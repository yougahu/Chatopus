import { describe, expect, it } from 'vitest';
import { enforceReferenceThreads, parseRoutesForRequest } from '../src/protocol.js';
import { enforceExplicitActivation } from '../src/activation.js';
import type { GroupMessage, RouterRequest, ThreadCard } from '../src/types.js';
const original:GroupMessage={id:'room:origin',messageId:'origin',roomId:'room',platform:'replay',authorId:'member',authorName:'成员',text:'核查版本20的模块行为。',timestamp:1,mentions:['bot'],isMentioned:true,isAdmin:false,attachments:[]};
const current:GroupMessage={...original,id:'room:followup',messageId:'followup',text:'结论呢？',replyToMessageId:'confirmation',timestamp:3};
const thread:ThreadCard={id:'thread',roomId:'room',subject:'模块行为核查',ownerId:'member',sourceMessageId:'origin',explicit:true,participants:['member'],status:'idle',revision:1,latestInputSeq:1,sessionId:'session',epoch:1,summary:'仅核查版本20的模块行为'};
const request:RouterRequest={roomId:'room',event:'messages',messages:[current],recentMessages:[original],recentReplies:[{messageId:'confirmation',text:'收到，只核查版本20的模块行为。',sentAt:2}],threads:[thread],references:{[current.id]:{status:'resolved',threadId:thread.id,chain:['confirmation']}},memoryAvailable:false};
describe('router intent protocol boundaries',()=>{
 it('preserves continuation without manufacturing correction metadata',()=>{
  const output=[{action:'append_thread',sourceMessageIds:[current.id],threadId:thread.id,kind:'supplement',resolvedRequest:'核查版本20的模块行为。',contextMessageIds:[original.id],contextReplyIds:['confirmation']}];
  const actions=enforceReferenceThreads(parseRoutesForRequest(JSON.stringify(output),request),request);
  expect(actions).toEqual(output);expect(actions[0]).not.toHaveProperty('correctionTarget');
 });
 it('preserves a sourced correction and a status query as distinct actions',()=>{
  const correction={action:'append_thread',sourceMessageIds:[current.id],threadId:thread.id,kind:'correction',resolvedRequest:'核查版本20的模块行为。',correctionTarget:'此前回复使用版本22；用户原文指定版本20。'};
  const correctionRequest={...request,messages:[{...current,text:'我指定的是版本20，不是22。'}],recentReplies:[{messageId:'confirmation',text:'我按版本22核查。',sentAt:2}]};
  expect(parseRoutesForRequest(JSON.stringify([correction]),correctionRequest)).toEqual([correction]);
  const status={action:'request_status',sourceMessageIds:[current.id],threadId:thread.id};
  expect(parseRoutesForRequest(JSON.stringify([status]),{...request,messages:[{...current,text:'处理到哪了？'}]})).toEqual([status]);
 });
 it('does not convert missing-object clarification into a task even with a resolved reference',()=>{
  const clarify={action:'clarify',sourceMessageIds:[current.id],text:'你想比较的两个对象是什么？'};
  expect(enforceReferenceThreads(parseRoutesForRequest(JSON.stringify([clarify]),request),request)).toEqual([clarify]);
 });
 it('does not inherit activation from an earlier question or quote',()=>{
  const noWake={...current,text:'结论呢？',mentions:[],isMentioned:false};
  const actions=parseRoutesForRequest(JSON.stringify([{action:'append_thread',sourceMessageIds:[current.id],threadId:thread.id,kind:'supplement',resolvedRequest:'继续核查原问题'}]),{...request,messages:[noWake]});
  expect(enforceExplicitActivation(actions,[noWake],['助手'])).toMatchObject([{action:'silence',sourceMessageIds:[current.id]}]);
 });
});
