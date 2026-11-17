import {it,expect} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PrivateMcp} from '../src/tools/mcp.js';

it('caches a private server catalog, isolates returned values and invalidates on list change',async()=>{
 const workspace=await mkdtemp(join(tmpdir(),'mcp-catalog-'));
 const script=`let calls=0,changed=false;const emit=v=>process.stdout.write(JSON.stringify(v)+'\\n');
 require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const r=JSON.parse(line);if(r.id===undefined)return;
 let result;if(r.method==='initialize')result={protocolVersion:'2024-11-05',capabilities:{tools:{listChanged:true}},serverInfo:{name:'fixture',version:'1'}};
 else if(r.method==='tools/list')result={tools:[{name:changed?'second':'first',description:String(++calls),inputSchema:{type:'object'}},{name:'hidden',inputSchema:{type:'object'}}]};
 else if(r.method==='tools/call'){changed=true;emit({jsonrpc:'2.0',method:'notifications/tools/list_changed'});result={content:[]};}
 emit({jsonrpc:'2.0',id:r.id,result});});`;
 const client=new PrivateMcp({command:process.execPath,args:['-e',script],allowedTools:['first','second','change'],timeoutMs:1000},workspace,'fixture');
 try{
  const [a,b]=await Promise.all([client.list(),client.list()]);expect(a).toEqual(b);expect(a.map(tool=>tool.name)).toEqual(['first']);expect(a[0].description).toBe('1');
  a[0].description='mutated';expect((await client.list())[0].description).toBe('1');
  await client.call('change',{});expect(await client.list()).toMatchObject([{name:'second',description:'2'}]);
  await client.close();await expect(client.list()).rejects.toThrow();
 }finally{await client.close();await rm(workspace,{recursive:true,force:true});}
});
