import { expect,it } from 'vitest';
import { currentTaskQuestion } from '../src/runtime/task-scope.js';
import type { ThreadInput } from '../src/types.js';
function input(text:string,kind:ThreadInput['kind']='supplement',authorId='a',resolvedRequest?:string,required?:boolean):ThreadInput {
  return {seq:1,revision:1,kind,message:{id:text,messageId:text,roomId:'room',platform:'replay',authorId,authorName:authorId,text,timestamp:0,mentions:[],attachments:[],isMentioned:true,isAdmin:false},
    ...(resolvedRequest?{routingContext:{resolvedRequest,routingMetadata:{calculation:{required}},sourceMessageIds:[text]}}:{})};
}
it('uses the corrected current request without the obsolete calculation requirement',()=>{
 expect(currentTaskQuestion([input('文档审核通过率是多少？','question'),input('先不算成本了，只解释缓存的过期机制。','correction','a','解释缓存的过期机制，暂不进行成本计算',false)])).toBe('解释缓存的过期机制，暂不进行成本计算');
});
it('retains calculation intent for supplements and resolved budget corrections',()=>{
 expect(currentTaskQuestion([input('文档审核通过率是多少？','question'),input('文档页数85')])).toContain('文档审核通过率');
 expect(currentTaskQuestion([input('文档审核通过率是多少？','question'),input('预算改20元','correction')])).toContain('文档审核通过率');
 expect(currentTaskQuestion([input('文档审核通过率是多少？','question'),input('预算改20元','correction','a','按20元预算计算文档审核通过率',true)])).toBe('按20元预算计算文档审核通过率');
});
it('does not inherit a different member’s calculation intent from the shared topic',()=>{
 expect(currentTaskQuestion([input('文档审核通过率是多少？','question'),input('缓存过期时间怎么算','supplement','b')])).toBe('缓存过期时间怎么算');
});
