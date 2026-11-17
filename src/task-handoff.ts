import type { Store } from './store.js';
import type { ThreadInput } from './types.js';

export function handoffRecord(threadId:string,input:ThreadInput){
  return {threadId,roomId:input.message.roomId,seq:input.seq,revision:input.revision,sourceId:input.message.id,authorId:input.message.authorId,
    text:input.routingContext?input.routingContext.resolvedRequest+(input.routingContext.correctionTarget?'\n更正内容：'+input.routingContext.correctionTarget:''):'此版本未保存交接解释。'};
}

/** Render only persisted, same-room task interpretations at this input boundary. */
export function taskHandoff(store:Store,roomId:string,threadId:string,sourceId:string,view:'current'|'previous'|'changes'='current',throughInputSeq?:number):string {
  const thread=store.thread(threadId);
  if(!thread||thread.roomId!==roomId)throw new Error('Handoff outside current room');
  const rows=store.db.prepare(`SELECT i.data FROM inputs i JOIN messages m ON m.id=i.message_id
    WHERE i.thread_id=? AND m.room=? AND m.rowid<=(SELECT rowid FROM messages WHERE id=? AND room=?)
    AND i.seq<=? ORDER BY i.seq DESC LIMIT 2`).all(threadId,roomId,sourceId,roomId,throughInputSeq??thread.latestInputSeq);
  const inputs=rows.map(row=>JSON.parse(String(row.data)) as ThreadInput);
  if(!inputs.length)return '这个任务没有保存可查看的交接解释。';
  const render=(input:ThreadInput,label:string)=>{
    const context=input.routingContext;
    return `${label}（版本 ${input.revision}）：\n${context?.resolvedRequest??'此版本未保存交接解释。'}`
      +(context?.correctionTarget?`\n更正内容：${context.correctionTarget}`:'');
  };
  if(view==='previous')return inputs[1]?render(inputs[1],'上一次保存的交接内容'):'这个任务没有更早的交接记录。';
  const current=inputs[0];
  const run=thread.activeRunId?store.db.prepare('SELECT data FROM runs WHERE id=? AND thread_id=?').get(thread.activeRunId,thread.id):undefined;
  const bound=run?Number(JSON.parse(String(run.data)).revision):undefined;
  const state=bound===current.revision?'该版本已绑定到当前运行。':bound&&bound<current.revision?'新条件已保存，等待切换到新的运行。':'此处展示的是已保存的交接解释。';
  return (view==='changes'&&inputs[1]?render(inputs[1],'上一次保存的交接内容')+'\n\n':'')
    +render(current,'本次查询边界内保存的交接内容')+'\n\n'+state;
}
