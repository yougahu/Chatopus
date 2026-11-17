import { afterEach, describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { parseHTML } from 'linkedom';

const script = readFileSync(new URL('../src/admin/app.js', import.meta.url), 'utf8').replace(/initialize\(\); setInterval\([\s\S]*$/, '');
const html = readFileSync(new URL('../src/admin/index.html', import.meta.url), 'utf8');
const rooms = [{id:'room-a',name:'群 A',memberCount:2},{id:'room-b',name:'群 B',memberCount:1}];
const profile = (name: string) => ({room:'room-a',member:name,exists:true,revision:1,updatedAt:1,fields:[{key:'preferredName',state:'set',value:name,updatedAt:1,sourceMessageId:'message-1',sourceAvailable:true,expired:false}]});
function setup(override?: (url: URL) => unknown | Promise<unknown>, mobile = false) {
  const {document} = parseHTML(html), calls: URL[] = [];
  const detail = document.getElementById('detail') as any;
  detail.showModal = () => {detail.open = true;}; detail.close = () => {detail.open = false;};
  const sandbox = createContext({document,window:{addEventListener(){},matchMedia(){return {matches:mobile};}},location:{search:''},URL,URLSearchParams,AbortController,console,setTimeout,clearTimeout,
    fetch: async (path: string) => {
      const url = new URL(path,'http://localhost'); calls.push(url);
      const value = await override?.(url);
      let data = value;
      if (value === undefined) {
        if (url.pathname === '/api/memory') data = {enabled:true,available:true,connection:'not_checked',rooms,ingestion:{laneCount:0,blocked:0,retrying:0,pending:0}};
        else if (url.pathname === '/api/memory/members') data = {room:url.searchParams.get('room'),members:[{id:'A',name:'A',lastSeen:1},{id:'B',name:'B',lastSeen:2}],offset:Number(url.searchParams.get('offset')),hasMore:false,nextOffset:null};
        else if (url.pathname === '/api/memory/status') data = {room:url.searchParams.get('room'),tracked:false,lanes:[]};
        else data = [];
      }
      return {ok:true,text:async()=>JSON.stringify(data)};
    },
  });
  runInContext(script, sandbox);
  return {document,calls,run:(code: string) => runInContext(code,sandbox)};
}
function deferred() {let resolve!:(data:unknown)=>void;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};}
const memberPage = (ids: string[], nextOffset: number | null = null) => ({members:ids.map(id=>({id,name:id,lastSeen:1})),hasMore:nextOffset!==null,nextOffset});

afterEach(()=>{vi.useRealTimers();});

describe('memory admin UI',()=>{
  it('renders inert profile values and clear/expired field states with source buttons',async()=>{
    const app=setup();await app.run("view='memory'; render()");
    const rendered=app.run(`profileText(${JSON.stringify({...profile('<img src=x onerror=evil()>'),fields:[...profile('<img src=x onerror=evil()>').fields,{key:'language',state:'cleared',updatedAt:2,sourceAvailable:false},{key:'retiredTag',state:'set',value:'expired retiredTag',expired:true,updatedAt:3,sourceAvailable:false}]})})`);
    app.document.getElementById('memory-profile')!.innerHTML=rendered;
    expect(app.document.querySelector('#memory-profile img')).toBeNull();
    expect(app.document.getElementById('memory-profile')!.textContent).toContain('<img src=x onerror=evil()>');
    expect(app.document.getElementById('memory-profile')!.textContent).toContain('已清除');
    expect(app.document.getElementById('memory-profile')!.textContent).toContain('已过期');
    expect(app.document.querySelector('[data-memory-source]')!.getAttribute('data-memory-source')).toBe('message-1');
    expect(app.document.getElementById('content')!.textContent).not.toContain('已连接');
  });
  it('never calls live memory children or displays retained results in historical sources',async()=>{
    const app=setup();await app.run("view='memory'; memoryState.results=[{uri:'secret',text:'old result'}]; source='ask-old'; render()");
    expect(app.calls.map(x=>x.pathname)).toEqual(['/api/memory']);
    expect(app.document.getElementById('content')!.textContent).toContain('历史数据源不提供在线记忆');
    expect(app.document.getElementById('content')!.textContent).not.toContain('old result');
  });
  it('shows automatic-only profiles, escaped content and source labels without claiming user confirmation',async()=>{
    const uri='viking://user/group/peers/member_a/memories/profile.md';
    const value={...profile('A'),exists:false,fields:[],automatic:{entries:[{uri,type:'profile',text:'<img src=x onerror=evil()>',
      verification:'unverified',sources:[],truncated:true},{uri:uri+'2',type:'preferences',text:'已绑定来源的提炼',verification:'source_verified',
      sourceCreatedAt:Date.parse('2026-11-08T07:00:00Z'),sources:[{id:'source-a',available:true},{id:'source-b',available:false}],truncated:false}],truncated:true}};
    const app=setup(url=>url.pathname==='/api/memory/profile'?value:undefined);
    await app.run("view='memory'; render()");await app.run("selectMemoryMember('A')");
    await vi.waitFor(()=>expect(app.document.querySelector('.memory-automatic-field')).not.toBeNull());
    const panel=app.document.getElementById('memory-profile')!;
    expect(panel.textContent).toContain('尚未保存该成员明确表达的画像字段');
    expect(panel.textContent).toContain('<img src=x onerror=evil()>');
    expect(panel.querySelector('img')).toBeNull();
    expect(panel.textContent).toContain('待核对');
    expect(panel.textContent).toContain('来源已核对');
    expect(panel.textContent).toContain('来源核对不代表成员已确认');
    expect(panel.textContent).toContain('历史自述可能已变化');
    expect(panel.querySelectorAll('.memory-source-time')).toHaveLength(1);
    expect(panel.querySelector('.memory-source-time')!.textContent).toContain('来源记录时间：2026');
    expect(panel.textContent).toContain('当前展示已截断');
    expect(panel.textContent).toContain('当前展示部分条目');
    expect(panel.querySelectorAll('[data-memory-source]')).toHaveLength(1);
    expect(panel.querySelector('[data-memory-source]')!.getAttribute('data-memory-source')).toBe('source-a');
  });
  it('retains explicit fields when automatic records are unavailable',async()=>{
    const app=setup(url=>url.pathname==='/api/memory/profile'?{...profile('A'),automatic:{entries:[],truncated:false,unavailable:true}}:undefined);
    await app.run("view='memory'; render()");await app.run("selectMemoryMember('A')");
    const panel=app.document.getElementById('memory-profile')!;
    expect(panel.querySelector('[aria-label="成员明确表达"]')!.textContent).toContain('A');
    expect(panel.querySelector('[aria-label="自动提炼"]')!.textContent).toContain('自动提炼内容暂不可用');
    expect(panel.querySelector('[data-memory-source]')).not.toBeNull();
  });
  it('opens and pages an automatic record by its URI without depending on search results',async()=>{
    const uri='viking://user/group/peers/member_a/memories/preferences/topic.md';
    const app=setup(url=>{
      if(url.pathname==='/api/memory/profile')return {...profile('A'),automatic:{entries:[{uri,type:'preferences',text:'preview',verification:'unverified',sources:[],truncated:true}],truncated:false}};
      if(url.pathname==='/api/memory/content')return {uri,text:url.searchParams.get('offset')==='0'?'first':'second',offset:Number(url.searchParams.get('offset')),nextOffset:url.searchParams.get('offset')==='0'?5:null,totalCharacters:11};
    });
    await app.run("view='memory'; render()");await app.run("selectMemoryMember('A')");
    app.run("document.querySelector('[data-memory-uri]').click()");
    await vi.waitFor(()=>expect(app.document.getElementById('detail-body')!.textContent).toContain('first'));
    app.run("document.querySelector('[data-memory-content-offset=\"5\"]').click()");
    await vi.waitFor(()=>expect(app.document.getElementById('detail-body')!.textContent).toContain('second'));
    const calls=app.calls.filter(url=>url.pathname==='/api/memory/content');
    expect(calls.map(url=>url.searchParams.get('uri'))).toEqual([uri,uri]);
    expect(calls.map(url=>url.searchParams.get('offset'))).toEqual(['0','5']);
    expect(app.run('memoryState.results.length')).toBe(0);
  });
  it('does not query children when disabled and omits generic audit filters from memory requests',async()=>{
    const app=setup(url=>url.pathname==='/api/memory'?{enabled:false,available:false,reason:'尚未启用',rooms:[]}:undefined);
    await app.run("view='memory'; offset=100; $('room').value='old-filter'; render()");
    expect(app.calls).toHaveLength(1);
    expect([...app.calls[0].searchParams.keys()]).toEqual(['source']);
    expect(app.document.getElementById('content')!.textContent).toContain('持久记忆未启用');
    expect(app.document.querySelector('#memory-query')).toBeNull();
  });
  it('ignores an older profile response after selecting a newer member',async()=>{
    const a=deferred(),b=deferred();const app=setup(url=>url.pathname==='/api/memory/profile'?(url.searchParams.get('member')==='A'?a.promise:b.promise):undefined);
    await app.run("view='memory'; render()");const first=app.run("selectMemoryMember('A')"),second=app.run("selectMemoryMember('B')");
    b.resolve(profile('B'));await second;a.resolve(profile('A'));await first;
    expect(app.document.querySelector('.memory-profile-head strong')!.textContent).toBe('B');
  });
  it('ignores a search completing after switching rooms and resets stored results',async()=>{
    const search=deferred();const app=setup(url=>url.pathname==='/api/memory/search'?search.promise:undefined);
    await app.run("view='memory'; render()");
    const pending=app.run("$('memory-query').value='old'; searchMemory({preventDefault(){},target:$('memory-search')})");
    await app.run("resetMemory('room-b'); render()");
    search.resolve({hits:[{uri:'viking://user/old',text:'stale result'}]});await pending;
    expect(app.document.getElementById('memory-results')!.textContent).not.toContain('stale result');
    expect(app.run('memoryState.results.length')).toBe(0);
  });
  it('does not replace a historical page when an earlier members request completes',async()=>{
    const members=deferred();const app=setup(url=>url.pathname==='/api/memory/members'?members.promise:undefined);
    const first=app.run("view='memory'; render()");
    await new Promise(resolve=>setTimeout(resolve,0));
    await app.run("source='ask-old'; resetMemory(); render()");
    members.resolve({members:[],offset:0,hasMore:false,nextOffset:null});await first;
    expect(app.document.getElementById('content')!.textContent).toContain('历史数据源不提供在线记忆');
  });
  it('appends unique members without replacing the list or active profile and suppresses concurrent loads',async()=>{
    const more=deferred();
    const app=setup(url=>{
      if(url.pathname==='/api/memory/members') return url.searchParams.get('offset')==='0'?memberPage(['A','B'],50):more.promise;
      if(url.pathname==='/api/memory/profile') return profile('A');
    });
    await app.run("view='memory'; render()");
    await app.run("selectMemoryMember('A')");
    const list=app.document.getElementById('memory-member-list')!;
    const selected=app.document.querySelector('[data-memory-member="A"]')!;
    const activeProfile=app.document.querySelector('.memory-profile-head')!;
    list.scrollTop=160;
    const first=app.run('loadMemoryMembers()');
    await app.run('loadMemoryMembers()');
    expect(app.calls.filter(url=>url.pathname==='/api/memory/members')).toHaveLength(2);
    more.resolve(memberPage(['B','C','C','D']));await first;
    expect([...app.document.querySelectorAll('[data-memory-member]')].map(button=>button.getAttribute('data-memory-member'))).toEqual(['A','B','C','D']);
    expect(app.document.getElementById('memory-member-list')).toBe(list);
    expect(list.scrollTop).toBe(160);
    expect(app.document.querySelector('[data-memory-member="A"]')).toBe(selected);
    expect(selected.getAttribute('aria-pressed')).toBe('true');
    expect(app.document.querySelector('.memory-profile-head')).toBe(activeProfile);
    expect(app.document.querySelector('.memory-profile-head strong')!.textContent).toBe('A');
    await app.run('loadMemoryMembers()');
    expect(app.calls.filter(url=>url.pathname==='/api/memory/members')).toHaveLength(2);
  });
  it('debounces member searches and queries the server from the first page',async()=>{
    vi.useFakeTimers();
    const app=setup(url=>url.pathname==='/api/memory/members'&&url.searchParams.get('q')?memberPage(['member-outside-first-page']):undefined);
    await app.run("view='memory'; render()");
    const input=app.document.getElementById('memory-member-query')!;
    await app.run("$('memory-member-query').value='旧昵称'; $('memory-member-query').dispatchEvent(new document.defaultView.Event('input',{bubbles:true}))");
    await vi.advanceTimersByTimeAsync(100);
    await app.run("$('memory-member-query').value='  新昵称  '; $('memory-member-query').dispatchEvent(new document.defaultView.Event('input',{bubbles:true}))");
    await vi.advanceTimersByTimeAsync(199);
    expect(app.calls.filter(url=>url.pathname==='/api/memory/members')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    const requests=app.calls.filter(url=>url.pathname==='/api/memory/members');
    expect(requests).toHaveLength(2);
    expect(requests[1].searchParams.get('q')).toBe('新昵称');
    expect(requests[1].searchParams.get('room')).toBe('room-a');
    expect(requests[1].searchParams.get('offset')).toBe('0');
    expect(requests[1].searchParams.get('limit')).toBe('50');
    expect(app.document.getElementById('memory-member-query')).toBe(input);
    expect([...app.document.querySelectorAll('[data-memory-member]')].map(button=>button.getAttribute('data-memory-member'))).toEqual(['member-outside-first-page']);
  });
  it('ignores an earlier load-more response after a member search starts',async()=>{
    vi.useFakeTimers();
    const oldPage=deferred(),search=deferred();
    const app=setup(url=>{
      if(url.pathname!=='/api/memory/members') return;
      if(url.searchParams.get('q')) return search.promise;
      return url.searchParams.get('offset')==='0'?memberPage(['A','B'],50):oldPage.promise;
    });
    await app.run("view='memory'; render()");
    const pending=app.run('loadMemoryMembers()');
    app.run("searchMemoryMembers('new')");
    await vi.advanceTimersByTimeAsync(200);
    oldPage.resolve(memberPage(['stale-member'],100));await pending;
    expect(app.document.getElementById('memory-member-items')!.textContent).not.toContain('stale-member');
    // The stale request must not unlock another request while the search is pending.
    await app.run('loadMemoryMembers(true)');
    expect(app.calls.filter(url=>url.pathname==='/api/memory/members')).toHaveLength(3);
    search.resolve(memberPage(['new-member']));
    await vi.advanceTimersByTimeAsync(0);
    expect([...app.document.querySelectorAll('[data-memory-member]')].map(button=>button.getAttribute('data-memory-member'))).toEqual(['new-member']);
  });
  it.each(['room','source'])('ignores a pending load-more response after switching %s',async(change)=>{
    const oldPage=deferred();
    const app=setup(url=>{
      if(url.pathname!=='/api/memory/members') return;
      if(url.searchParams.get('room')==='room-b') return memberPage(['room-b-member']);
      return url.searchParams.get('offset')==='0'?memberPage(['A','B'],50):oldPage.promise;
    });
    await app.run("view='memory'; render()");
    const pending=app.run('loadMemoryMembers()');
    await app.run(change==='room'?"resetMemory('room-b'); render()":"source='ask-old'; resetMemory(); render()");
    oldPage.resolve(memberPage(['stale-member'],100));await pending;
    expect(app.document.getElementById('content')!.textContent).not.toContain('stale-member');
    if(change==='room') {
      expect([...app.document.querySelectorAll('[data-memory-member]')].map(button=>button.getAttribute('data-memory-member'))).toEqual(['room-b-member']);
      expect(app.run('memoryState.room')).toBe('room-b');
    } else {
      expect(app.document.getElementById('content')!.textContent).toContain('历史数据源不提供在线记忆');
      expect(app.run('memoryState.memberItems.length')).toBe(0);
    }
    expect(app.run('memoryState.memberNextOffset')).toBeNull();
  });
  it('retains loaded members and retries a failed page at the same offset',async()=>{
    let attempts=0;
    const retry=deferred();
    const app=setup(url=>{
      if(url.pathname!=='/api/memory/members') return;
      if(url.searchParams.get('offset')==='0') return memberPage(['A','B'],50);
      if(++attempts===1) throw new Error('Temporary member failure');
      return retry.promise;
    });
    await app.run("view='memory'; render()");
    const firstMember=app.document.querySelector('[data-memory-member="A"]');
    await app.run('loadMemoryMembers()');
    expect([...app.document.querySelectorAll('[data-memory-member]')].map(button=>button.getAttribute('data-memory-member'))).toEqual(['A','B']);
    expect(app.document.getElementById('memory-member-footer')!.textContent).toContain('Temporary member failure');
    app.run("document.querySelector('[data-memory-retry]').click()");
    expect(app.calls.filter(url=>url.pathname==='/api/memory/members').map(url=>url.searchParams.get('offset'))).toEqual(['0','50','50']);
    retry.resolve(memberPage(['C']));
    await vi.waitFor(()=>expect(app.document.querySelector('[data-memory-member="C"]')).not.toBeNull());
    expect(app.document.querySelector('[data-memory-member="A"]')).toBe(firstMember);
    expect(app.document.querySelector('[data-memory-retry]')).toBeNull();
    expect([...app.document.querySelectorAll('[data-memory-member]')].map(button=>button.getAttribute('data-memory-member'))).toEqual(['A','B','C']);
  });
  it('keeps the mobile member list open when a profile response arrives after going back',async()=>{
    const pendingProfile=deferred();
    const app=setup(url=>url.pathname==='/api/memory/profile'?pendingProfile.promise:undefined,true);
    await app.run("view='memory'; render()");
    const pending=app.run("selectMemoryMember('A')");
    expect(app.document.getElementById('memory-workspace')!.classList.contains('has-selection')).toBe(true);
    app.run("document.querySelector('[data-memory-back]').click()");
    expect(app.document.getElementById('memory-workspace')!.classList.contains('has-selection')).toBe(false);
    pendingProfile.resolve(profile('A'));await pending;
    expect(app.document.querySelector('.memory-profile-head strong')!.textContent).toBe('A');
    expect(app.document.getElementById('memory-workspace')!.classList.contains('has-selection')).toBe(false);
    expect(app.run('memoryState.profileOpen')).toBe(false);
    expect(app.document.querySelector('[data-memory-member="A"]')!.getAttribute('aria-pressed')).toBe('true');
  });
  it('opens search hits through content only and requests bounded member pages',async()=>{
    const app=setup(url=>{
      if(url.pathname==='/api/memory/content') return {room:'room-a',uri:'viking://user/test',text:'<script>evil</script>',offset:0,nextOffset:null,totalCharacters:21};
      if(url.pathname==='/api/memory/members') return url.searchParams.get('offset')==='0'?memberPage(['A','B'],50):memberPage(['C']);
    });
    await app.run("view='memory'; render()");
    await app.run('loadMemoryMembers()');
    await app.run("memoryState.results=[{uri:'viking://user/test',text:'preview'}]; showMemoryContent(0)");
    expect(app.calls.some(url=>url.pathname==='/api/memory/content')).toBe(true);
    expect(app.calls.some(url=>url.pathname==='/api/memory/source')).toBe(false);
    expect(app.calls.filter(url=>url.pathname==='/api/memory/members').at(-1)!.searchParams.get('offset')).toBe('50');
    expect(app.calls.filter(url=>url.pathname==='/api/memory/members').at(-1)!.searchParams.get('limit')).toBe('50');
    expect(app.document.querySelector('#detail-body script')).toBeNull();
    expect(app.document.getElementById('detail-body')!.textContent).toContain('<script>evil</script>');
  });
});
