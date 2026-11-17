import { describe,it,expect } from 'vitest';
import { Store } from '../src/store.js';
import type { Config } from '../src/config.js';
import type { GroupMessage,RouteAction,RouterRequest } from '../src/types.js';
import { SharedMemoryService } from '../src/memory/shared-memory.js';
import { OpenVikingClient,memberMemoryUri } from '../src/memory/openviking-client.js';
import { applyMemberCommit,enqueueMemberConfirmations,prepareMemberCommit } from '../src/memory/member-commit.js';
import { createHash } from 'node:crypto';
const message=(id:string,authorId:string):GroupMessage=>({id,messageId:id,roomId:'r',authorId,authorName:authorId,platform:'replay',text:'以后叫我阿明并查方案',mentions:['bot'],isMentioned:true,isAdmin:false,timestamp:1,attachments:[]});

describe('Router member commit boundary',()=>{
  it('freezes intents before remote effects and resumes a partially saved multi-member turn before confirmations',async()=>{
    const store=new Store(':memory:'),files=new Map<string,string>();let failBob=true,writes=0;
    const config={qq:{selfId:'bot'},memoryApiKey:'k',memory:{enabled:true,provider:'openviking',baseUrl:'http://localhost:1933',namespace:'test',timeoutMs:1000,recallBytes:6000}} as Config;
    const client=new OpenVikingClient({baseUrl:'http://localhost:1933',credential:async()=> 'user',fetch:(async(url,init)=>{
      const u=new URL(String(url));
      const ok=(result:unknown)=>Response.json({status:'ok',result});
      if(u.pathname.endsWith('/read')){
        const text=files.get(u.searchParams.get('uri')!);
        return text===undefined?Response.json({status:'error',error:{code:'NOT_FOUND'}},{status:404}):ok(text);
      }
      if(u.pathname.endsWith('/mkdir'))return ok({});
      const op=JSON.parse(String(init?.body)).operations[0];
      expect(store.routerSessions.pendingTurns()[0].actions).toHaveProperty('memoryIntents');
      if(op.uri===memberMemoryUri('bob')&&failBob)throw new Error('offline');
      const prior=files.get(op.uri);
      if((op.if_absent&&prior!==undefined)||(op.expected_sha256&&createHash('sha256').update(prior??'').digest('hex')!==op.expected_sha256))
        return Response.json({status:'error',error:{code:'CONFLICT'}},{status:409});
      files.set(op.uri,op.content);writes++;return ok({});
    }) as typeof fetch});
    const memory=new SharedMemoryService(config,client);
    const messages=[message('a','alice'),message('b','bob')];messages.forEach(m=>store.ingest(m));
    const request:RouterRequest={roomId:'r',event:'messages',messages,recentMessages:[],threads:[],memoryAvailable:true};
    const actions:RouteAction[]=messages.map(m=>({action:'open_thread',sourceMessageIds:[m.id],subject:'方案',memoryUpdates:[{kind:'member',sourceMessageId:m.id,changes:[{key:'preferredName',op:'set',value:m.authorId}]}]}));
    store.routerSessions.ensureSession({roomId:'r',sessionId:'s',configHash:'h'});
    const turn=store.routerSessions.beginTurn({roomId:'r',trigger:{kind:'messages',key:'batch'},inputs:messages.map(m=>({kind:'message',id:m.id})),request});
    const proposal=await prepareMemberCommit(store,memory,turn,request,actions);
    await expect(applyMemberCommit(memory,proposal)).rejects.toThrow();
    expect(files.has(memberMemoryUri('alice'))).toBe(true);expect(store.outbox()).toHaveLength(0);
    expect(store.routerSessions.turn(turn.id)?.state).toBe('pending');
    failBob=false;
    const resumed=await prepareMemberCommit(store,new SharedMemoryService(config,client),store.routerSessions.turn(turn.id)!,request,[]);
    expect(resumed).toEqual(proposal);
    const receipts=await applyMemberCommit(memory,resumed);expect(writes).toBe(2);
    store.routerSessions.commitTurn({turnId:turn.id,generation:turn.generation,actions},()=>{
      enqueueMemberConfirmations(store,request,proposal,receipts);return {memory:receipts};
    });
    expect(store.outbox('pending')).toHaveLength(2);
    // Confirmations are independent of task cancellation and carry no worker revision gate.
    expect(store.outbox('pending').every(row=>row.threadId===undefined)).toBe(true);
    store.routerSessions.commitTurn({turnId:turn.id,generation:turn.generation,actions},()=>{throw new Error('Duplicate commit executed');});
    expect(store.outbox('pending')).toHaveLength(2);store.close();
  });
});
