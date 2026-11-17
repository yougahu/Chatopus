import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

/** Save only call names; the running bot retains its startup configuration until restarted. */
export function saveActivationSettings(root:string,value:unknown):{botCallNames:string[]} {
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>key!=='botCallNames'))
    throw new Error('仅支持修改唤起关键字。');
  const input=(value as {botCallNames?:unknown}).botCallNames;
  if(!Array.isArray(input)||input.length>32)throw new Error('唤起关键字须为列表，最多 32 个。');
  const botCallNames:string[]=[],seen=new Set<string>();
  for(const entry of input){
    if(typeof entry!=='string'||!entry.trim()||entry.trim().length>80||/[\u0000-\u001f\u007f]/.test(entry))
      throw new Error('每个关键字须为 1–80 个字符，且不能包含换行或控制字符。');
    const name=entry.trim(),key=name.toLowerCase();
    if(!seen.has(key)){seen.add(key);botCallNames.push(name);}
  }
  const file=join(root,'config.local.json');
  const disk=existsSync(file)?JSON.parse(readFileSync(file,'utf8')):{};
  if(!disk||typeof disk!=='object'||Array.isArray(disk))throw new Error('本地配置格式无效，未保存。');
  const temp=file+'.'+randomUUID()+'.tmp';
  try{
    writeFileSync(temp,JSON.stringify({...disk,botCallNames},null,2)+'\n',{mode:0o600});
    renameSync(temp,file);
  }finally{try{unlinkSync(temp);}catch{}}
  return {botCallNames};
}
