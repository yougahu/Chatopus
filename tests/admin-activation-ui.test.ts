import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { parseHTML } from 'linkedom';

const script=readFileSync(new URL('../src/admin/app.js',import.meta.url),'utf8').replace(/initialize\(\); setInterval\([\s\S]*$/,'');
const html=readFileSync(new URL('../src/admin/index.html',import.meta.url),'utf8');
type Reply={ok:boolean;value:unknown};
function setup(names:string[]=['光头','Chris'],respond?:(names:string[])=>Promise<Reply>){
  const {document,Event}=parseHTML(html),calls:{path:string;body:unknown}[]=[];
  const sandbox=createContext({document,window:{addEventListener(){},matchMedia(){return {matches:false};}},location:{search:''},URL,URLSearchParams,AbortController,console,setTimeout,clearTimeout,
    fetch:async(path:string,options:{body:string})=>{
      const body=JSON.parse(options.body);calls.push({path,body});
      const reply=await respond?.(body.botCallNames)??{ok:true,value:{saved:true,appliesTo:'bot-restart',config:{botCallNames:body.botCallNames}}};
      return {ok:reply.ok,text:async()=>JSON.stringify(reply.value)};
    },
  });
  runInContext(script,sandbox);
  document.getElementById('content')!.innerHTML=runInContext(`configPage(${JSON.stringify({botCallNames:names})})`,sandbox);
  const form=document.querySelector('[data-activation-config]') as any;
  return {document,calls,form,input:form.querySelector('textarea') as any,
    save:()=>runInContext("saveActivation(document.querySelector('[data-activation-config]'))",sandbox),
    submit:()=>form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))};
}

describe('activation settings UI',()=>{
  it('displays saved names as escaped text and explains restart and mention-only behavior',()=>{
    const attack='</textarea><img src=x onerror=evil()>',app=setup(['光头',attack]);
    // linkedom does not decode textarea character references as a browser does.
    expect(app.input.value).toContain('光头\n');expect(app.form.innerHTML).toContain('&lt;/textarea&gt;');
    expect(app.form.querySelector('img')).toBeNull();
    expect(app.form.textContent).toContain('清空关键字后仅通过 @ 唤起');
    expect(app.form.textContent).toContain('重启机器人生效');
  });
  it('handles the real submit event, splits separators and deduplicates names without submitting model fields',async()=>{
    const app=setup();app.input.value=' 小助手，Chris\nchris,小助手\r\n向导 ';
    app.submit();
    await vi.waitFor(()=>expect(app.form.querySelector('.form-message').textContent).toBe('已保存，重启机器人后生效。'));
    expect(app.calls).toEqual([{path:'/api/activation-config',body:{botCallNames:['小助手','Chris','向导']}}]);
    expect(app.input.value).toBe('小助手\nChris\n向导');
  });
  it('saves an empty list deliberately and reports mention-only operation after restart',async()=>{
    const app=setup();app.input.value=' \n，,';await app.save();
    expect(app.calls[0].body).toEqual({botCallNames:[]});
    expect(app.form.querySelector('.form-message').textContent).toBe('已保存为空列表，重启机器人后仅通过 @ 唤起。');
  });
  it('keeps invalid input editable and rejects excessive names or length before sending',async()=>{
    const app=setup();
    for(const value of ['a'.repeat(81),Array.from({length:33},(_,i)=>'name'+i).join('\n')]){
      app.input.value=value;await app.save();
      expect(app.input.value).toBe(value);expect(app.input.disabled).not.toBe(true);
      expect(app.form.querySelector('.form-message').classList.contains('error')).toBe(true);
    }
    expect(app.calls).toHaveLength(0);
  });
  it('prevents duplicate submissions and retains unsaved text on server failure',async()=>{
    let resolve!:(reply:Reply)=>void;
    const app=setup(['光头'],()=>new Promise(r=>{resolve=r;}));app.input.value='新称呼';
    const pending=app.save();await app.save();expect(app.calls).toHaveLength(1);
    expect(app.input.disabled).toBe(true);expect(app.form.querySelector('button').disabled).toBe(true);
    resolve({ok:false,value:{error:'保存失败'}});await pending;
    expect(app.input.value).toBe('新称呼');expect(app.input.disabled).toBe(false);
    expect(app.form.querySelector('button').disabled).toBe(false);
    expect(app.form.querySelector('.form-message').textContent).toBe('保存失败');
    expect(app.form.querySelector('.form-message').classList.contains('error')).toBe(true);
  });
});
