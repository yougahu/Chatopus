import {expect,it} from 'vitest';
import {validatePreferenceRewrite} from '../src/memory/reply-preferences.js';
import type {MemberMemoryProjection} from '../src/memory/member-updates.js';
const profile=(value:string):MemberMemoryProjection=>({memberId:'a',revision:1,fields:{preferredName:{state:'set',value}},omittedKeys:[]});
it('allows a changed numeric salutation without ignoring matching digits inside reported values',()=>{
  expect(()=>validatePreferenceRewrite('0，耗时100，记录数20。','1，耗时100，记录数20。',[profile('0'),profile('1')])).not.toThrow();
  expect(()=>validatePreferenceRewrite('0，耗时100。','1，耗时1。',[profile('0'),profile('1')])).toThrow('protected technical literals');
});
it('rejects moving existing numbers between reported quantities',()=>{
  expect(()=>validatePreferenceRewrite('耗时100，记录数20。','耗时20，记录数100。',[])).toThrow('protected technical literals');
});
it('retains technical links and code verbatim across presentation changes',()=>{
  const text='阿明，第20版数据 `timeout=20` 来源 https://example.test/document';
  expect(()=>validatePreferenceRewrite(text,text.replace('阿明','阿强'),[profile('阿明'),profile('阿强')])).not.toThrow();
  expect(()=>validatePreferenceRewrite(text,text.replace('timeout=20','limit=20'),[])).toThrow('protected technical literals');
  expect(()=>validatePreferenceRewrite(text,text.replace('example.test','different.test'),[])).toThrow('protected technical literals');
  expect(()=>validatePreferenceRewrite('先 `backup` 再 `delete`。','先 `delete` 再 `backup`。',[])).toThrow('protected technical literals');
});
it('does not accept an obsolete leading name after clear, expiry or correction',()=>{
  const before=[profile('阿明')],text='阿明，耗时20。';
  for(const field of [{state:'cleared' as const},{state:'expired' as const},{state:'out_of_scope' as const},{state:'set' as const,value:'阿强'}]){
    const after=[{...profile('阿明'),revision:2,fields:{preferredName:field}}];
    expect(()=>validatePreferenceRewrite(text,text,[...before,...after],{memberId:'a',previous:before,latest:after})).toThrow('obsolete salutation');
    expect(()=>validatePreferenceRewrite(text,'耗时20。',[...before,...after],{memberId:'a',previous:before,latest:after})).not.toThrow();
  }
});
