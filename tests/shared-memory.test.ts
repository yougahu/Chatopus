import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type { Config } from '../src/config.js';
import { bindMemberMemoryUpdates } from '../src/memory/member-updates.js';
import { MEMBER_DIRECTORY, OpenVikingClient, memberMemoryUri, memoryPeerId } from '../src/memory/openviking-client.js';
import { SharedMemoryService, type MemberWriteIntent } from '../src/memory/shared-memory.js';
import { validateMemoryFieldDefinitions, type MemberMemoryUpdate } from '../src/memory/types.js';
import { DEFAULT_BUSINESS_SETTINGS } from '../src/business-config.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const ok = (result: unknown) => Response.json({ status: 'ok', result });
const failure = (status: number, code: string) => Response.json({ status: 'error', error: { code } }, { status });
type WriteBody = { root_uri: string; operations: Array<{ uri: string; content: string; expected_sha256?: string; if_absent?: boolean }>; defer_processing: boolean; wait: boolean };
type RecordedRequest = { account: string; path: string; body?: Record<string, unknown> };

/** In-memory HTTP fixture exercising the actual client serialization, scope and CAS contract. */
class MemoryHttpFixture {
  files = new Map<string, string>();
  requests: RecordedRequest[] = [];
  writes: WriteBody[] = [];
  loseWriteResponse = false;
  acknowledgeWithoutSaving = false;
  failListings = false;
  beforeWrite?: (account: string, body: WriteBody) => void;
  searchOverride?: Array<{ uri: string; abstract: string }>;
  key(account: string, uri: string) { return JSON.stringify([account, uri]); }
  put(account: string, uri: string, content: string) { this.files.set(this.key(account, uri), content); }
  get(account: string, uri: string) { return this.files.get(this.key(account, uri)); }
  fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const account = new Headers(init?.headers).get('X-API-Key') ?? '';
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body)) as Record<string, unknown>;
    this.requests.push({ account, path: url.pathname, body });
    if (url.pathname === '/api/v1/content/read') {
      const value = this.get(account, url.searchParams.get('uri')!);
      return value === undefined ? failure(404, 'NOT_FOUND') : ok(value);
    }
    if (url.pathname === '/api/v1/fs/mkdir') return ok({ uri: body?.uri });
    if (url.pathname === '/api/v1/fs/ls') {
      if (this.failListings) return failure(503, 'UNAVAILABLE');
      const target = url.searchParams.get('uri')!;
      return ok([...this.files.keys()].flatMap(key => {
        const [fileAccount, uri] = JSON.parse(key) as string[];
        return fileAccount === account && uri.startsWith(target + '/') ? [{ uri, isDir: false }] : [];
      }).slice(0, Number(url.searchParams.get('node_limit'))));
    }
    if (url.pathname === '/api/v1/content/batch-write') {
      const write = body as unknown as WriteBody;
      this.writes.push(write); this.beforeWrite?.(account, write);
      const operation = write.operations[0];
      const current = this.get(account, operation.uri);
      if (operation.if_absent && current !== undefined) return failure(409, 'CONFLICT');
      if (operation.expected_sha256 !== undefined && (current === undefined || hash(current) !== operation.expected_sha256)) return failure(409, 'CONFLICT');
      if (!this.acknowledgeWithoutSaving) this.put(account, operation.uri, operation.content);
      if (this.loseWriteResponse) { this.loseWriteResponse = false; throw new TypeError('Connection lost after durable write'); }
      return ok({ completed: true });
    }
    if (url.pathname === '/api/v1/search/find') {
      const target = String(body?.target_uri);
      const memories = (target.includes('/memories/preferences/') ? undefined : this.searchOverride) ?? [...this.files.entries()].flatMap(([key, content]) => {
        const [fileAccount, uri] = JSON.parse(key) as string[];
        return fileAccount === account && uri.startsWith(target + '/') ? [{ uri, abstract: content.slice(0, 24) }] : [];
      });
      return ok({ memories });
    }
    throw new Error(`Unhandled fixture endpoint: ${url.pathname}`);
  };
}

function setup(recallBytes = 6000) {
  const http = new MemoryHttpFixture();
  const config = { qq: { selfId: 'bot' }, memoryApiKey: 'fixture-root', memory: {
    enabled: true, provider: 'openviking', baseUrl: 'https://memory.invalid', namespace: 'test', rootKeyEnv: 'UNUSED',
    timeoutMs: 1000, recallBytes, ingestBatchSize: 32,
  } } as Config;
  const client = new OpenVikingClient({ baseUrl: config.memory!.baseUrl, credential: async account => account, fetch: http.fetch });
  return { http, config, client, service: new SharedMemoryService(config, client) };
}
function bound(id: string, sourceOrder: number, value: string | null, memberId = 'alice') {
  const update: MemberMemoryUpdate = { kind: 'member', sourceMessageId: id,
    changes: [value === null ? { key: 'preferredName', op: 'clear' } : { key: 'preferredName', op: 'set', value }] };
  return bindMemberMemoryUpdates([update], { actionSourceMessageIds: [id], messages: [{ id, memberId, sourceOrder }] });
}
async function prepare(service: SharedMemoryService, id = 'm1', order = 1, value: string | null = '阿明', roomId = 'room') {
  const intents = await service.prepareMemberWrites(roomId, bound(id, order, value), 'turn-' + id, 100 + order);
  expect(intents).toHaveLength(1);
  // Persistence roundtrip represents the host freezing the exact intent before the write.
  return JSON.parse(JSON.stringify(intents[0])) as MemberWriteIntent;
}

describe('shared member memory writes through the HTTP client', () => {
  it('recovers a lost write response by exact readback without sending a second write', async () => {
    const { service, http } = setup();
    const intent = await prepare(service);
    http.loseWriteResponse = true;
    const saved = await service.applyMemberWrite(intent);
    expect(saved.commitId).toBe(intent.commitId);
    expect(saved.fields.preferredName).toMatchObject({ state: 'set', value: '阿明' });
    expect(http.writes).toHaveLength(1);
    expect(http.writes[0]).toMatchObject({ root_uri: MEMBER_DIRECTORY, defer_processing: true, wait: true,
      operations: [{ uri: memberMemoryUri('alice'), if_absent: true, content: intent.text }] });
    await expect(service.applyMemberWrite(intent)).resolves.toEqual(saved);
    expect(http.writes).toHaveLength(1);
    expect(await service.prepareMemberWrites('room', bound('m1', 1, '阿明'), 'another-turn', 200)).toEqual([]);
  });

  it('does not claim success for an acknowledged write that cannot be read back', async () => {
    const { service, http } = setup();
    const intent = await prepare(service); http.acknowledgeWithoutSaving = true;
    await expect(service.applyMemberWrite(intent)).rejects.toMatchObject({ code: 'WRITE_NOT_VERIFIED', uncertain: true });
    expect(http.writes).toHaveLength(1);
  });

  it('detects a stale prepared hash before writing and preserves the newer document', async () => {
    const { service, http } = setup();
    await service.applyMemberWrite(await prepare(service));
    const older = await prepare(service, 'older', 2, 'Older');
    const newer = await prepare(service, 'newer', 3, 'Newer');
    await service.applyMemberWrite(newer);
    const count = http.writes.length;
    await expect(service.applyMemberWrite(older)).rejects.toMatchObject({ code: 'CONFLICT', status: 409, uncertain: false });
    expect(http.writes).toHaveLength(count);
    expect((await service.readMember('room', 'alice'))?.document.fields.preferredName).toMatchObject({ value: 'Newer' });
  });

  it('lets backend CAS reject a race after preflight without rebasing or blind overwrite', async () => {
    const { service, http } = setup();
    await service.applyMemberWrite(await prepare(service));
    const older = await prepare(service, 'older', 2, 'Older');
    const newer = await prepare(service, 'newer', 3, 'Newer');
    http.beforeWrite = (account, request) => {
      http.beforeWrite = undefined;
      http.put(account, request.operations[0].uri, newer.text);
    };
    const count = http.writes.length;
    await expect(service.applyMemberWrite(older)).rejects.toMatchObject({ code: 'CONFLICT', status: 409 });
    expect(http.writes).toHaveLength(count + 1);
    expect(http.writes.at(-1)?.operations[0].expected_sha256).toBe(older.expectedSha256);
    expect(http.get(newer.accountId, memberMemoryUri('alice'))).toBe(newer.text);
  });

  it('keeps clears across restarts and refuses historical resurrection', async () => {
    const { service, http, config, client } = setup();
    await service.applyMemberWrite(await prepare(service));
    const cleared = await prepare(service, 'clear', 3, null);
    await service.applyMemberWrite(cleared);
    const restarted = new SharedMemoryService(config, client);
    expect(await restarted.prepareMemberWrites('room', bound('old', 2, 'Old'), 'turn-old', 500)).toEqual([]);
    expect(await restarted.project('room', ['alice'], { now: 500 })).toMatchObject([{ memberId: 'alice', fields: { preferredName: { state: 'cleared' } } }]);
    expect(http.writes).toHaveLength(2);
  });

  it('shares current fields between Router and Worker but isolates two groups', async () => {
    const { service: router, config, client, http } = setup();
    const worker = new SharedMemoryService(config, client);
    await router.applyMemberWrite(await prepare(router, 'one', 1, 'Room One', 'room-one'));
    expect(await worker.project('room-one', ['alice', 'alice'])).toMatchObject([{ fields: { preferredName: { value: 'Room One' } } }]);
    expect(await worker.project('room-two', ['alice'])).toMatchObject([{ revision: 0, fields: {} }]);
    await worker.applyMemberWrite(await prepare(worker, 'two', 1, 'Room Two', 'room-two'));
    expect((await router.readMember('room-one', 'alice'))?.document.fields.preferredName).toMatchObject({ value: 'Room One' });
    expect((await router.readMember('room-two', 'alice'))?.document.fields.preferredName).toMatchObject({ value: 'Room Two' });
    expect(router.account('room-one')).not.toBe(router.account('room-two'));
    expect(new Set(http.requests.map(request => request.account)).size).toBe(2);
  });

  it('rejects tampered intents and mismatched stored member identities', async () => {
    const { service, http } = setup();
    const intent = await prepare(service);
    await expect(service.applyMemberWrite({ ...intent, roomId: 'elsewhere' })).rejects.toThrow('identity mismatch');
    await expect(service.applyMemberWrite({ ...intent, text: intent.text + ' ' })).rejects.toThrow('identity mismatch');
    await expect(service.applyMemberWrite({ ...intent, memberId: 'bob' })).rejects.toThrow('content mismatch');
    http.put(intent.accountId, memberMemoryUri('alice'), JSON.stringify({ ...JSON.parse(intent.text), memberId: 'bob' }));
    await expect(service.readMember('room', 'alice')).rejects.toThrow('identity mismatch');
    expect(http.writes).toHaveLength(0);
  });
});

describe('shared memory tools are bound to one request', () => {
  it('accepts the exact all-fields Worker payloads while rejecting meaningful irrelevant fields and scope escapes', async () => {
    const { service, http } = setup();
    await service.applyMemberWrite(await prepare(service));
    const tool = service.createReadTool('room', ['alice']);
    expect(await tool.execute({ action: 'profile', memberId: 'alice', keys: ['preferredName'], offset: 0, query: '', uri: '' }))
      .toMatchObject({ profile: { fields: { preferredName: { value: '阿明' } } }, automatic: { entries: [] } });
    expect(await tool.execute({ action: 'profile', memberId: 'alice', keys: [], offset: null, query: null, uri: null }))
      .toMatchObject({ profile: { fields: { preferredName: { value: '阿明' } } } });
    const uri = `viking://user/group/peers/${memoryPeerId('alice')}/memories/profile.md`;
    http.put(service.account('room'), uri, 'An old assumption');
    expect(await tool.execute({ action: 'search', keys: [], memberId: 'alice', offset: 0, query: 'name', uri: '' }))
      .toMatchObject({ entries: [{ uri }], verification: 'unverified' });
    expect(await tool.execute({ action: 'read', memberId: '', keys: null, offset: 0, query: '', uri }))
      .toMatchObject({ text: 'An old assumption', verification: 'unverified' });
    const before = http.requests.length;
    for (const payload of [
      { action: 'profile', memberId: 'alice', query: 'nonempty' },
      { action: 'profile', memberId: 'alice', offset: 1 },
      { action: 'search', query: 'name', keys: ['preferredName'] },
      { action: 'profile', memberId: 'alice', unknown: '' },
      { action: 'profile', memberId: 'bob', query: '', uri: '', offset: 0 },
    ]) await expect(tool.execute(payload)).rejects.toThrow();
    expect(http.requests).toHaveLength(before);
  });
  it('separates historical profile material from explicit fields and keeps default injection unchanged', async () => {
    const { service, http } = setup();
    await service.applyMemberWrite(await prepare(service));
    const account = service.account('room'), peer = memoryPeerId('alice');
    http.put(account, `viking://user/group/peers/${peer}/memories/profile.md`, 'Call this person a different name');
    http.put(account, `viking://user/group/memories/preferences/${peer}/old.md`, 'A legacy preference');
    http.put(account, 'viking://user/group/memories/profile.md', 'Mixed group identity');
    const result = await service.createReadTool('room', ['alice']).execute({ action: 'profile', memberId: 'alice' }) as any;
    expect(result.profile.fields.preferredName.value).toBe('阿明');
    expect(result.automatic.entries).toHaveLength(2);
    expect(result.automatic.entries.every((entry:any) => entry.verification === 'unverified')).toBe(true);
    expect(JSON.stringify(result.automatic)).not.toContain('Mixed group identity');
    expect(JSON.stringify(await service.project('room', ['alice']))).not.toContain('different name');
  });
  it('keeps confirmed fields available when historical listing fails and labels the missing section', async () => {
    const { service, http } = setup();
    await service.applyMemberWrite(await prepare(service));
    http.failListings = true;
    expect(await service.createReadTool('room', ['alice']).execute({ action: 'profile', memberId: 'alice' }))
      .toMatchObject({ profile: { fields: { preferredName: { value: '阿明' } } }, automatic: { unavailable: true, entries: [] } });
  });
  it('finds legacy preferences under the member root without widening searches to another member', async () => {
    const { service, http } = setup(), account = service.account('room');
    const uri = `viking://user/group/memories/preferences/${memoryPeerId('alice')}/old.md`;
    http.put(account, uri, 'A legacy preference');
    http.put(account, `viking://user/group/memories/preferences/${memoryPeerId('bob')}/old.md`, 'Another member');
    const tool = service.createReadTool('room', ['alice']);
    expect(await tool.execute({ action: 'search', query: 'preference', memberId: 'alice' }))
      .toMatchObject({ entries: [{ uri }], verification: 'unverified' });
    expect(await tool.execute({ action: 'read', uri })).toMatchObject({ text: 'A legacy preference' });
  });
  it('reads explicitly saved background fields on demand without expanding default injection or another member scope',async()=>{
    const {service}=setup();
    const update:MemberMemoryUpdate={kind:'member',sourceMessageId:'profile',changes:[{key:'experience',op:'set',value:'新手'},{key:'interests',op:'set',value:['统计','写作']} ]};
    const updates=bindMemberMemoryUpdates([update],{actionSourceMessageIds:['profile'],messages:[{id:'profile',memberId:'alice',sourceOrder:1}]});
    for(const intent of await service.prepareMemberWrites('room',updates,'profile-turn'))await service.applyMemberWrite(intent);
    expect((await service.project('room',['alice']))[0].fields.experience).toBeUndefined();
    const tool=service.createReadTool('room',['alice']);
    expect(await tool.execute({action:'profile',memberId:'alice',keys:['experience','interests']})).toMatchObject({kind:'current_member_profile',profile:{fields:{experience:{state:'set',value:'新手'},interests:{value:['统计','写作']}}}});
    await expect(tool.execute({action:'profile',memberId:'bob'})).rejects.toThrow('outside this request');
    expect(await service.createReadTool('other-room',['alice']).execute({action:'profile',memberId:'alice'})).toMatchObject({profile:{revision:0,fields:{}}});
  });
  it('allows only current-member filters and URIs returned to this tool instance', async () => {
    const { service, http } = setup();
    const account = service.account('room');
    const uri = `viking://user/group/peers/${memoryPeerId('alice')}/memories/profile.md`;
    http.put(account, uri, 'Long-term history');
    const routerTool = service.createReadTool('room', ['alice']);
    const workerTool = service.createReadTool('room', ['alice']);
    const signal = new AbortController().signal;
    await expect(routerTool.execute({ action: 'read', uri }, signal)).rejects.toThrow('returned by this request');
    await expect(routerTool.execute({ action: 'search', query: 'preferences', memberId: 'bob' }, signal)).rejects.toThrow('outside this request');
    expect(await routerTool.execute({ action: 'search', query: 'preferences', memberId: 'alice' }, signal)).toMatchObject({ entries: [{ uri }] });
    expect(await routerTool.execute({ action: 'read', uri }, signal)).toMatchObject({ text: 'Long-term history' });
    await expect(workerTool.execute({ action: 'read', uri }, signal)).rejects.toThrow('returned by this request');
    expect(http.requests.find(request => request.path === '/api/v1/search/find')?.body).toMatchObject({
      target_uri: `viking://user/group/peers/${memoryPeerId('alice')}/memories`, context_type: 'memory', read_content: false,
    });
  });

  it('rejects a backend result outside the member prefix instead of granting read access', async () => {
    const { service, http } = setup();
    const uri = `viking://user/group/peers/${memoryPeerId('bob')}/memories/profile.md`;
    http.searchOverride = [{ uri, abstract: 'Bob private preference' }];
    const tool = service.createReadTool('room', ['alice']);
    const signal = new AbortController().signal;
    await expect(tool.execute({ action: 'search', query: 'name', memberId: 'alice' }, signal)).rejects.toThrow('out-of-scope');
    await expect(tool.execute({ action: 'read', uri }, signal)).rejects.toThrow('returned by this request');
  });

  it('bounds reads by bytes, preserves complete Unicode and supports continuation', async () => {
    const { service, http } = setup(8);
    const uri = `viking://user/group/peers/${memoryPeerId('alice')}/memories/profile.md`;
    http.put(service.account('room'), uri, '中文😀abcdef');
    http.searchOverride = [{ uri, abstract: '短' }];
    const tool = service.createReadTool('room', ['alice']);
    const signal = new AbortController().signal;
    await tool.execute({ action: 'search', query: 'name', memberId: 'alice' }, signal);
    const first = await tool.execute({ action: 'read', uri }, signal) as { text: string; nextOffset: number };
    expect(first).toMatchObject({ text: '中文', nextOffset: 2 });
    expect(Buffer.byteLength(first.text)).toBeLessThanOrEqual(8);
    const second = await tool.execute({ action: 'read', uri, offset: first.nextOffset }, signal);
    expect(second).toMatchObject({ text: '😀abcd', nextOffset: 8 });
    await expect(tool.execute({ action: 'read', uri, offset: 100 }, signal)).rejects.toThrow('outside source');
    await expect(tool.execute({ action: 'write', uri, value: 'unauthorized' }, signal)).rejects.toThrow();
  });
});


describe('historical memory speaker identity', () => {
  const directories:string[]=[];
  afterEach(()=>{for(const dir of directories.splice(0))rmSync(dir,{recursive:true,force:true});});
  function sourceFixture(recallBytes=6000) {
    const fixture=setup(recallBytes),stateDir=mkdtempSync(join(tmpdir(),'memory-speaker-'));
    directories.push(stateDir);fixture.config.stateDir=stateDir;
    const message={id:'qq:9000:1000:1',roomId:'qq:9000:1000',authorId:'2000',authorName:'小林',
      text:'请在周六早上提醒大家参加读书会',timestamp:1_000};
    const db=new DatabaseSync(join(stateDir,'state.sqlite'));
    db.exec('CREATE TABLE messages(id TEXT PRIMARY KEY,room TEXT NOT NULL,data TEXT NOT NULL)');
    db.prepare('INSERT INTO messages VALUES (?,?,?)').run(message.id,message.roomId,JSON.stringify(message));db.close();
    const service=new SharedMemoryService(fixture.config,fixture.client),peer=memoryPeerId(message.authorId);
    const uri=`viking://user/group/peers/${peer}/memories/events/fact_meeting.md`;
    function putFact(overrides:Record<string,unknown>={},body=message.text) {
      fixture.http.put(service.account(message.roomId),uri,body+'\n\n<!-- MEMORY_FIELDS\n'+JSON.stringify({peer_id:peer,boe_provenance:{
        version:1,peer_id:peer,source_role:'user',verification:'source_verified',source_message_ids:[message.id],
        quote:body,content_sha256:hash(body),source_created_at:new Date(message.timestamp).toISOString(),...overrides,
      }})+'\n-->');
    }
    function updateSource(changes:Record<string,unknown>,room=message.roomId) {
      const db=new DatabaseSync(join(stateDir,'state.sqlite'));
      try{db.prepare('UPDATE messages SET room=?,data=? WHERE id=?').run(room,JSON.stringify({...message,...changes}),message.id);}
      finally{db.close();}
    }
    putFact();
    return {...fixture,service,message,uri,putFact,updateSource};
  }
  async function read(fixture:ReturnType<typeof sourceFixture>) {
    const tool=fixture.service.createReadTool(fixture.message.roomId,['requester']);
    await tool.execute({action:'search',query:'读书会'});
    return {tool,result:await tool.execute({action:'read',uri:fixture.uri}) as any};
  }
  it('resolves the historical speaker from the original message without granting their profile',async()=>{
    const fixture=sourceFixture(),{tool,result}=await read(fixture);
    expect(result).toMatchObject({verification:'unverified',sources:[{id:fixture.message.id,authorId:'2000',authorName:'小林',timestamp:1_000,verification:'source_verified'}]});
    await expect(tool.execute({action:'profile',memberId:'2000'})).rejects.toThrow('outside this request');
    await expect(tool.execute({action:'profile',memberId:memoryPeerId('2000')})).rejects.toThrow('outside this request');
  });
  it.each([
    ['cross-room source',{roomId:'qq:9000:other'},'qq:9000:other'],
    ['inconsistent stored room',{roomId:'qq:9000:other'},undefined],
    ['wrong speaker',{authorId:'3000'},undefined],
    ['different original text',{text:'请取消读书会'},undefined],
    ['different timestamp',{timestamp:2_000},undefined],
    ['wrong stored message ID',{id:'qq:9000:1000:other'},undefined],
  ] as const)('does not attach identity from a %s',async(_name,changes,room)=>{
    const fixture=sourceFixture();fixture.updateSource(changes,room);
    expect((await read(fixture)).result.sources).toEqual([]);
  });
  it('does not use unverified, mismatched-owner or forged provenance to disclose a speaker',async()=>{
    const fixture=sourceFixture();
    for(const overrides of [{verification:'unverified'},{peer_id:memoryPeerId('3000')},{content_sha256:hash('wrong')},
      {source_message_ids:['missing']},{source_role:'assistant'}]){
      fixture.putFact(overrides);expect((await read(fixture)).result.sources).toEqual([]);
    }
    fixture.putFact({},'另一段原文');expect((await read(fixture)).result.sources).toEqual([]);
  });
  it('does not disclose messages ingested after this tool was created',async()=>{
    const fixture=sourceFixture(),tool=fixture.service.createReadTool(fixture.message.roomId,['requester']);
    const future={...fixture.message,id:'qq:9000:1000:2'};
    const db=new DatabaseSync(join(fixture.config.stateDir,'state.sqlite'));
    db.prepare('INSERT INTO messages VALUES (?,?,?)').run(future.id,future.roomId,JSON.stringify(future));db.close();
    fixture.putFact({source_message_ids:[future.id]});
    await tool.execute({action:'search',query:'读书会'});
    expect(await tool.execute({action:'read',uri:fixture.uri})).toMatchObject({sources:[]});
  });
  it('keeps source identity available across bounded read pages and falls back to the platform ID for a missing name',async()=>{
    const fixture=sourceFixture(500);fixture.updateSource({authorName:''});
    const {tool,result}=await read(fixture);
    expect(result.sources).toMatchObject([{authorId:'2000',authorName:'2000'}]);
    expect(Buffer.byteLength(result.text)+Buffer.byteLength(JSON.stringify(result.sources))).toBeLessThanOrEqual(500);
    expect(result.nextOffset).toBeGreaterThan(0);
    expect(await tool.execute({action:'read',uri:fixture.uri,offset:result.nextOffset})).toMatchObject({sources:result.sources});
  });
});

describe('configured member field registry', () => {
  function setupRegistry() {
    const fixture=setup();
    fixture.config.memory!.fields=[{key:'docs.project',label:'当前项目',type:'text',maxLength:20,scopeKeys:['workspace']}];
    fixture.config.business=structuredClone(DEFAULT_BUSINESS_SETTINGS);
    fixture.config.business.profiles.docs={...fixture.config.business.profiles.default,name:'文档助手',memoryFields:['docs.project']};
    fixture.config.business.roomProfiles={room:'docs'};
    fixture.service.reloadConfiguration(fixture.config);
    return fixture;
  }
  function proposal(key:string,value:string|string[],scope?:Record<string,string>) {
    return bindMemberMemoryUpdates([{kind:'member',sourceMessageId:'custom-1',changes:[{key,op:'set',value}]}],
      {actionSourceMessageIds:['custom-1'],messages:[{id:'custom-1',memberId:'alice',sourceOrder:1,...(scope?{scope}:{})}]});
  }
  it('registers non-game fields per room and exposes only approved definitions', async()=>{
    const {service,http}=setupRegistry();
    expect(service.fieldDefinitions('room').find(field=>field.key==='docs.project')).toMatchObject({label:'当前项目',maxLength:20});
    expect(service.fieldDefinitions('other').map(field=>field.key)).not.toContain('docs.project');
    const [intent]=await service.prepareMemberWrites('room',proposal('docs.project','Migration'),'custom-turn');
    await service.applyMemberWrite(intent);
    expect((await service.project('room',['alice']))[0].fields['docs.project']).toBeUndefined();
    expect(await service.createReadTool('room',['alice']).execute({action:'profile',memberId:'alice',keys:['docs.project']}))
      .toMatchObject({profile:{fields:{'docs.project':{state:'set',value:'Migration'}}}});
    await expect(service.createReadTool('other',['alice']).execute({action:'profile',memberId:'alice',keys:['docs.project']})).rejects.toThrow('Unregistered');
    await expect(service.prepareMemberWrites('other',proposal('docs.project','Migration'),'bad-turn')).rejects.toThrow('Unregistered');
    await expect(service.prepareMemberWrites('room',proposal('arbitrary','value'),'bad-turn')).rejects.toThrow('Unregistered');
    expect(http.writes).toHaveLength(1);
  });
  it('checks type, length and declared scope dimensions before saving',async()=>{
    const {service,http}=setupRegistry();
    await expect(service.prepareMemberWrites('room',proposal('docs.project',['Wrong type']),'t')).rejects.toThrow('Invalid value');
    await expect(service.prepareMemberWrites('room',proposal('docs.project','x'.repeat(21)),'t')).rejects.toThrow('Invalid value');
    await expect(service.prepareMemberWrites('room',proposal('docs.project','Docs',{unknown:'scope'}),'t')).rejects.toThrow('scope dimension');
    const [intent]=await service.prepareMemberWrites('room',proposal('docs.project','Docs',{workspace:'W1'}),'t');
    await service.applyMemberWrite(intent);
    expect((await service.project('room',['alice'],{relevantKeys:['docs.project'],scope:{workspace:'W2'}}))[0].fields['docs.project']).toEqual({state:'out_of_scope'});
    expect((await service.project('room',['alice'],{relevantKeys:['docs.project'],scope:{workspace:'W1'}}))[0].fields['docs.project']).toMatchObject({state:'set',value:'Docs'});
    expect(http.writes).toHaveLength(1);
  });
  it('retains unknown legacy v1 fields without injecting or permitting updates to them',async()=>{
    const {service,http,config}=setupRegistry();
    const legacy={schemaVersion:1,memberId:'alice',revision:4,commitId:'old',updatedAt:10,fields:{
      retiredTag:{state:'set',value:'Legacy retiredTag',sourceMessageId:'old-message',sourceOrder:0,updatedAt:10,scope:{retiredTag:'Old',retiredNote:'Old retiredNote'}},
      retiredNote:{state:'cleared',sourceMessageId:'old-message',sourceOrder:0,updatedAt:10},
    }};
    http.put(service.account('room'),memberMemoryUri('alice'),JSON.stringify(legacy));
    expect((await service.readMember('room','alice'))?.document).toEqual(legacy);
    expect((await service.project('room',['alice']))[0].fields).toEqual({});
    expect(await service.createReadTool('room',['alice']).execute({action:'profile',memberId:'alice'})).toMatchObject({profile:{fields:{}}});
    await expect(service.prepareMemberWrites('room',proposal('retiredTag','New'),'not-enabled')).rejects.toThrow('Unregistered');
    const [intent]=await service.prepareMemberWrites('room',proposal('preferredName','Alice'),'general-change');
    const saved=await service.applyMemberWrite(intent);
    expect(saved.fields.retiredTag).toEqual(legacy.fields.retiredTag);
    expect(saved.fields.retiredNote).toEqual(legacy.fields.retiredNote);
    expect(saved.revision).toBe(5);
    config.memory!.fields!.push({key:'retiredTag',label:'旧标签',type:'text',maxLength:80,scopeKeys:['retiredTag','retiredNote']});
    config.business!.profiles.docs.memoryFields!.push('retiredTag');
    service.reloadConfiguration(config);
    expect((await service.project('room',['alice'],{relevantKeys:['retiredTag'],scope:{retiredTag:'Old',retiredNote:'Old retiredNote'}}))[0].fields.retiredTag).toMatchObject({state:'set',value:'Legacy retiredTag'});
    config.business!.profiles.docs.memoryFields=[];service.reloadConfiguration(config);
    expect(await service.createReadTool('room',['alice']).execute({action:'profile',memberId:'alice'})).toMatchObject({profile:{fields:{preferredName:{state:'set',value:'Alice'}}}});
    expect((await service.readMember('room','alice'))?.document.fields.retiredTag).toEqual(legacy.fields.retiredTag);
  });
  it('keeps already created tool field snapshots when config changes',async()=>{
    const {service,config}=setupRegistry();
    const [intent]=await service.prepareMemberWrites('room',proposal('docs.project','Frozen'),'turn');await service.applyMemberWrite(intent);
    const frozen=service.snapshot(),prior=frozen.createReadTool('room',['alice']),account=service.account('room');
    config.business!.profiles.docs.memoryFields=[];config.memory!.namespace='ignored-new-identity';service.reloadConfiguration(config);
    expect(service.account('room')).toBe(account);
    expect(frozen.fieldDefinitions('room').map(field=>field.key)).toContain('docs.project');
    expect(await prior.execute({action:'profile',memberId:'alice',keys:['docs.project']})).toMatchObject({profile:{fields:{'docs.project':{value:'Frozen'}}}});
    await expect(service.createReadTool('room',['alice']).execute({action:'profile',memberId:'alice',keys:['docs.project']})).rejects.toThrow('Unregistered');
  });
  it('rejects malformed registries and missing profile references',()=>{
    for(const fields of [
      [{key:'preferredName',label:'override',type:'text',maxLength:400}],
      [{key:'custom',label:'Custom',type:'number',maxLength:20}],
      [{key:'custom',label:'Custom',type:'text',maxLength:401}],
      [{key:'custom',label:'Custom',type:'text',maxLength:20,scopeKeys:['workspace','workspace']}],
      [{key:'custom',label:'One',type:'text',maxLength:20},{key:'custom',label:'Two',type:'text',maxLength:20}],
    ]) expect(()=>validateMemoryFieldDefinitions(fields)).toThrow();
    const {service,config}=setupRegistry();config.business!.profiles.docs.memoryFields=['missing'];service.reloadConfiguration(config);
    expect(()=>service.fieldDefinitions('room')).toThrow('unregistered');
  });
});

it('stops a revoked member write after a delayed directory response',async()=>{
 const {service,http,client}=setup(),intent=await prepare(service),controller=new AbortController();
 client.ensureMemberDirectory=async()=>{controller.abort();};
 await expect(service.applyMemberWrite(intent,controller.signal)).rejects.toThrow();expect(http.writes).toHaveLength(0);
});
