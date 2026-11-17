import {describe,it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {createContext,runInContext} from 'node:vm';
import {parseHTML} from 'linkedom';
const html=readFileSync(new URL('../src/admin/index.html',import.meta.url),'utf8');
const script=readFileSync(new URL('../src/admin/app.js',import.meta.url),'utf8').replace(/initialize\(\); setInterval\([\s\S]*$/,'');
const schedule={id:'s-test',authority:'system',ownerId:null,registeredBy:'admin',roomId:'qq:bot:room',title:'资料整理',content:'核对今日记录',status:'active',version:1,timezone:'Asia/Shanghai',scheduleSpec:{kind:'interval',anchorAt:Date.now()+3_600_000,intervalMs:3_600_000},nextRunAt:Date.now()+3_600_000};
function setup(respond?:(path:string,body:any)=>Promise<any>|any){
  const {document,window,Event}=parseHTML(html),calls:Array<{path:string;body:any}>=[];
  Object.defineProperty(window.HTMLSelectElement.prototype,'value',{configurable:true,get(){return this.querySelector('option[selected]')?.getAttribute('value')??this.querySelector('option')?.getAttribute('value')??'';},set(value){for(const option of this.querySelectorAll('option'))if(option.getAttribute('value')===value)option.setAttribute('selected','');else option.removeAttribute('selected');}});
  const checked=new WeakMap();Object.defineProperty(window.HTMLInputElement.prototype,'checked',{configurable:true,get(){return checked.get(this)??this.hasAttribute('checked');},set(v){checked.set(this,Boolean(v));}});
  Object.assign(window.HTMLElement.prototype,{showModal(this:any){this.open=true;},close(this:any){this.open=false;this.dispatchEvent(new Event('close'));},focus(){}});
  window.matchMedia=()=>({matches:false}) as any;
  const data={items:[schedule],total:1,hasMore:false,available:true,enabled:true,running:false,allowedRoomIds:['qq:bot:room'],defaultTimezone:'Asia/Shanghai'};
  const context=createContext({document,window,location:{search:''},URL,URLSearchParams,AbortController,structuredClone,console,setTimeout,clearTimeout,fetch:async(path:string,options:any)=>{
    const body=options.body?JSON.parse(options.body):undefined;calls.push({path,body});
    const response=await respond?.(path,body);if(response)return {ok:response.ok!==false,status:response.ok===false?409:200,text:async()=>JSON.stringify(response.value)};
    const value=path.includes('/runs?')?{items:[],total:0,hasMore:false}:path.includes('/schedule-permissions')?{allowedRoleGroups:body?.allowedRoleGroups??['group_admin','member'],version:body?2:1}:path.includes('/schedules/s-test')?{schedule,running:false,enabled:true,audits:[]}:data;
    return {ok:true,status:200,text:async()=>JSON.stringify(value)};
  }});
  runInContext(script,context);runInContext(`view='schedules'; scheduleState.data=${JSON.stringify(data)};`,context);
  return {document,window,Event,calls,run:(code:string)=>runInContext(code,context),input:(selector:string)=>document.querySelector(selector) as any,click:(selector:string)=>{const node=document.querySelector(selector);expect(node,selector).not.toBeNull();node!.dispatchEvent(new Event('click',{bubbles:true}));}};
}
async function settle(){await new Promise(resolve=>setTimeout(resolve,0));}
describe('scheduled tasks admin UI',()=>{
 it('edits multiple recipient IDs, keeps them in drafts and clears an existing list',async()=>{
   const app=setup(path=>path.includes('/schedules/s-test')&&!path.includes('/runs?')?{value:{schedule:{...schedule,recipientIds:['301','302']}}}:undefined);
   await app.run("showSchedule('s-test')");expect(app.input('#detail-body').textContent).toContain('收件人：301、302');
   app.click('[data-schedule-op=update]');expect(app.input('[name=recipientIds]').value).toBe('301, 302');
   app.input('[name=recipientIds]').value='301， 303\n301 304';app.run("rememberScheduleDraft(document.querySelector('[data-schedule-editor]'))");
   expect(app.run('scheduleState.draft.recipientIds')).toEqual(['301','303','304']);
   app.run('openScheduleEditor(scheduleState.draft)');expect(app.input('[name=recipientIds]').value).toBe('301, 303, 304');
   app.input('[name=recipientIds]').value='';expect(app.run("readScheduleDraft(document.querySelector('[data-schedule-editor]')).recipientIds")).toEqual([]);
 });
 it('submits merged filters through the form without inheriting another page scope or offset',async()=>{
   const app=setup();app.input('#room').value='qq:unrelated:room';app.input('#status').innerHTML='<option value="failed" selected>失败</option>';app.input('#status').dataset.view='schedules';app.run('offset=200');
   await app.run('render()');const before=new URL(app.calls.find(x=>x.path.startsWith('/api/schedules?'))!.path,'http://fixture');
   expect(before.searchParams.get('room')).toBe('');expect(before.searchParams.get('status')).toBe('');expect(app.input('#filters').hidden).toBe(true);
   app.input('#schedule-query').value='  每日记录  ';app.input('#schedule-room').value='qq:bot:room';app.input('#schedule-authority').value='user';app.input('#schedule-status').value='paused';app.input('#schedule-owner').value='  member-A  ';
   const submitted=new app.Event('submit',{bubbles:true,cancelable:true});app.input('[data-schedule-filters]').dispatchEvent(submitted);await settle();
   expect(submitted.defaultPrevented).toBe(true);const request=new URL(app.calls.filter(x=>x.path.startsWith('/api/schedules?')).at(-1)!.path,'http://fixture');
   expect(Object.fromEntries(request.searchParams)).toMatchObject({offset:'0',q:'每日记录',roomId:'qq:bot:room',room:'qq:bot:room',authority:'user',status:'paused',ownerId:'member-A'});
   expect(app.input('#schedule-query').value).toBe('每日记录');expect(app.input('#schedule-status').value).toBe('paused');expect(app.calls.filter(x=>x.body)).toHaveLength(0);
 });
 it('offers a filter reset for no matches and a create action for a genuinely empty list',async()=>{
   const app=setup(path=>path.startsWith('/api/schedules?')?{value:{items:[],total:0,hasMore:false,available:true,enabled:true,running:true,allowedRoomIds:['qq:bot:room']}}:undefined);
   app.run("scheduleState.filter={authority:'system',ownerId:'member-A',q:'missing',roomId:'qq:bot:room',status:'blocked'};offset=100");await app.run('render()');
   expect(app.input('.schedule-empty').textContent).toContain('没有找到符合条件');app.click('.schedule-empty [data-schedule-reset]');await settle();
   const request=new URL(app.calls.filter(x=>x.path.startsWith('/api/schedules?')).at(-1)!.path,'http://fixture');
   expect(Object.fromEntries(request.searchParams)).toMatchObject({offset:'0',q:'',roomId:'',room:'',authority:'',status:'',ownerId:''});
   expect(app.input('.schedule-empty [data-schedule-reset]')).toBeNull();expect(app.input('.schedule-empty [data-schedule-new]')).not.toBeNull();expect(app.calls.filter(x=>x.body)).toHaveLength(0);
 });
 it('shows exactly two role groups and accurately labels an offline service',async()=>{
   const app=setup();await app.run('render()');const roles=[...app.document.querySelectorAll('[name=role]')];expect(roles.map(x=>x.getAttribute('value'))).toEqual(['group_admin','member']);
   expect(app.document.getElementById('content')!.textContent).toContain('机器人离线');expect(app.document.getElementById('content')!.textContent).toContain('系统任务');
   roles.forEach((x:any)=>x.checked=false);await app.run("saveSchedulePermissions(document.querySelector('[data-schedule-permissions]'))");expect(app.calls.at(-1)?.body).toEqual({allowedRoleGroups:[],expectedVersion:1});expect(app.document.getElementById('content')!.textContent).toContain('群聊登记和管理已关闭');
 });
 it('separates one-shot and recurring fields without imposing an hour delay on one-shot',()=>{
   const app=setup();app.run('openScheduleEditor()');expect(app.input('.schedule-frequency-note').textContent).toContain('单次任务没有周期频率限制');expect(app.input('[data-schedule-when=interval]').hidden).toBe(true);
   app.input('[name=kind]').value='interval';app.input('[name=kind]').dispatchEvent(new app.Event('change',{bubbles:true}));expect(app.input('[data-schedule-when=interval]').hidden).toBe(false);expect(app.input('[name=intervalMinutes]').getAttribute('min')).toBe('60');expect(app.input('.schedule-frequency-note').textContent).toContain('每小时');
 });
 it('previews using the selected zone and sends no owner or authority fields when creating',async()=>{
   const app=setup((path,body)=>path.includes('/preview')?{value:{times:[Date.UTC(2030,0,1,1)],timezone:body.timezone}}:undefined);
   app.run('openScheduleEditor()');app.input('[name=localAt]').value='2030-01-01T09:00';app.input('[name=title]').value='提醒';app.input('[name=content]').value='检查文件';
   await app.run("previewSchedule(document.querySelector('[data-schedule-editor]'))");expect(app.calls.at(-1)?.body).toEqual({scheduleSpec:{kind:'once',at:'2030-01-01T09:00'},timezone:'Asia/Shanghai'});
   const draft=app.run("readScheduleDraft(document.querySelector('[data-schedule-editor]'))");expect(draft).not.toHaveProperty('ownerId');expect(draft).not.toHaveProperty('authority');expect(draft).not.toHaveProperty('registeredBy');expect(app.input('[data-schedule-preview-result]').textContent).toContain('Asia/Shanghai');
 });
 it('keeps a rejected form editable and retains its draft and idempotency key',async()=>{
   const app=setup(()=>({ok:false,value:{error:'任务已被更新，请刷新后重试。'}}));app.run('openScheduleEditor()');app.input('[name=title]').value='未保存';app.input('[name=content]').value='资料';const key=app.input('form').dataset.key;
   await app.run("saveSchedule(document.querySelector('[data-schedule-editor]'))");expect(app.input('[name=title]').value).toBe('未保存');expect(app.input('[name=title]').disabled).toBe(false);expect(app.run('scheduleState.dirty')).toBe(true);expect(app.input('form').dataset.key).toBe(key);expect(app.input('.form-message').textContent).toContain('请刷新');
 });
 it('retains the active source and editor until an in-flight save finishes',async()=>{
   let finish!:(value:any)=>void;const app=setup(()=>new Promise(resolve=>{finish=resolve;}));app.run('openScheduleEditor()');app.input('[name=title]').value='保存中';app.input('[name=content]').value='资料';
   const saving=app.run("saveSchedule(document.querySelector('[data-schedule-editor]'))");app.input('#source').innerHTML='<option value="main">主数据</option><option value="ask-old">历史</option>';app.input('#source').value='ask-old';app.input('#source').onchange();app.input('#close-detail').onclick();app.run("navigate('overview')");
   expect(app.run('source')).toBe('main');expect(app.run('view')).toBe('schedules');expect(app.input('#detail').open).toBe(true);expect(app.input('[name=title]').disabled).toBe(true);
   finish({ok:false,value:{error:'版本冲突'}});await saving;expect(app.input('[name=title]').disabled).toBe(false);expect(app.input('[name=title]').value).toBe('保存中');
 });
 it('does not allow historical sources to write or fall back to the main service',async()=>{
   const app=setup();app.run("source='ask-old'; openScheduleEditor();");expect(app.document.querySelector('[data-schedule-editor]')).toBeNull();await expect(app.run("scheduleApi('schedules',{method:'POST',body:{}})")).rejects.toThrow('只读');expect(app.calls).toHaveLength(0);
 });
 it('escapes schedule content, preserves user ownership and separates delivery from execution',async()=>{
   const own={...schedule,authority:'user',ownerId:'member-A',content:'<img src=x onerror=evil()>'};
   const app=setup((path)=>path.includes('/runs?')?{value:{items:[{id:'run-1',status:'succeeded',scheduledAt:Date.now(),outbox:[{status:'unknown',data:{message:{text:'<script>bad()</script>'}}}]}],total:1,hasMore:false}}:path.includes('/schedules/s-test')?{value:{schedule:own}}:undefined);
   await app.run("showSchedule('s-test')");expect(app.document.querySelector('#detail-body img')).toBeNull();expect(app.document.querySelector('#detail-body script')).toBeNull();expect(app.input('#detail-body').textContent).toContain('用户任务 · member-A');expect(app.input('#detail-body').textContent).toContain('发送结果待确认');
   app.click('[data-schedule-op=update]');expect(app.input('[name=roomId]').disabled).toBe(true);expect(app.input('#detail-body').textContent).toContain('级别和请求人保持不变');
 });
 it('requires a visible confirmation before cancelling and reports a queued command honestly',async()=>{
   const app=setup((path,body)=>body?.op?{value:{command:{id:'cmd-1',status:'pending'},message:'已请求，等待机器人服务启动。'}}:undefined);
   await app.run("showSchedule('s-test')");app.click('[data-schedule-op=cancel]');await settle();expect(app.calls.filter(x=>x.body?.op)).toHaveLength(0);app.click('[data-schedule-confirmed]');await settle();expect(app.calls.filter(x=>x.body?.op)).toHaveLength(1);expect(app.input('[data-schedule-command-message]').textContent).toContain('等待机器人服务启动');expect(app.document.querySelector('[data-schedule-command="cmd-1"]')).not.toBeNull();
 });
});
