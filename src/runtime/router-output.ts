import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import { parseRoutesForRequest } from '../protocol.js';
import type { RouterRequest } from '../types.js';

const actionNames=new Set(['silence','reply_direct','clarify','open_thread','append_thread','request_status','request_cancel','manage_schedule','publish_result','defer_result']);

/** Accept only complete JSON objects separated by whitespace, never prose or a partial tail. */
function objectSequence(text:string):unknown[]|undefined {
  const objects:unknown[]=[];let start=0,depth=0,quoted=false,escaped=false;
  for(let index=0;index<text.length;index++){
    const char=text[index];
    if(depth===0){if(/\s/.test(char))continue;if(char!=='{'||objects.length>=20)return;start=index;depth=1;continue;}
    if(quoted){if(escaped)escaped=false;else if(char==='\\')escaped=true;else if(char==='"')quoted=false;continue;}
    if(char==='"')quoted=true;
    else if(char==='{')depth++;
    else if(char==='}'&&--depth===0){try{objects.push(JSON.parse(text.slice(start,index+1)));}catch{return;}}
  }
  return depth===0&&!quoted&&objects.length>1?objects:undefined;
}

/** Normalize an unambiguous final action batch through the ordinary scoped validator. */
export function normalizeRouterActionOutput(blocks:readonly ContentBlock[],supplied:RouterRequest):string|undefined {
  const visible=blocks.filter(block=>block.type!=='reasoning'&&(block.type!=='text'||block.text.trim()));
  if(visible.length&&visible.every(block=>block.type==='text')){
    const sequence=objectSequence(visible.map(block=>block.type==='text'?block.text:'').join(''));
    if(!sequence)return;
    try{return JSON.stringify(parseRoutesForRequest(JSON.stringify(sequence),supplied));}catch{return;}
  }
  const actions:Record<string,unknown>[]=[];
  for(const block of blocks){
    if(block.type==='reasoning'||block.type==='text'&&!block.text.trim())continue;
    if(block.type!=='tool-call'||!actionNames.has(block.name))return;
    let args:unknown;try{args=JSON.parse(block.arguments);}catch{return;}
    if(!args||typeof args!=='object'||Array.isArray(args))return;
    const object=args as Record<string,unknown>;
    if(Object.hasOwn(object,'action')&&object.action!==block.name)return;
    actions.push({...object,action:block.name});
  }
  if(!actions.length)return;
  // No execution happens here. DshRuntime and Coordinator retain their ordinary
  // schema, reference, current-ID and explicit-activation checks after this.
  try{return JSON.stringify(parseRoutesForRequest(JSON.stringify(actions),supplied));}catch{return;}
}
