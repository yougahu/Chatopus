import {isAbsolute} from 'node:path';

/** Deployment contract, pinned to the bridge version verified by its operator. */
export interface PrivateFileContract {
  implementation:string;
  version:string;
  transport:'base64'|'shared_path';
  receipt:'file_id'|'synchronous';
  source:'message'|'offline_file';
  sharedRoot?:string;
}
export function privateFileContract(value:unknown):PrivateFileContract|undefined {
  if(value===undefined)return;
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid qq.privateFiles');
  const v=value as PrivateFileContract;
  if(Object.keys(v).some(k=>!['implementation','version','transport','receipt','source','sharedRoot'].includes(k))
    ||![v.implementation,v.version].every(x=>typeof x==='string'&&x.length>0&&x.length<=100)
    ||!['base64','shared_path'].includes(v.transport)||!['file_id','synchronous'].includes(v.receipt)
    ||!['message','offline_file'].includes(v.source)
    ||v.transport==='shared_path'&&(typeof v.sharedRoot!=='string'||!isAbsolute(v.sharedRoot)))throw new Error('Invalid qq.privateFiles contract');
  // The synchronous empty-data and offline_file contracts are documented by
  // go-cqhttp. Other implementations must return a concrete file receipt.
  if((v.receipt==='synchronous'||v.source==='offline_file')&&v.implementation!=='go-cqhttp')throw new Error('Unsupported private file contract');
  return {...v};
}
