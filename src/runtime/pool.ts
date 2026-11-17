import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { PiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai';
import type { Config } from '../config.js';
import type { ModelSelection } from '../types.js';
import { ROUTER_COMPACTION_POLICY } from './router-compaction.js';
import { NativeAgentRuntime } from './native.js';

export type AgentRole='router'|'worker';
const reasoning={off:'none',low:'low',medium:'medium',high:'high',xhigh:'xhigh',max:'max'} as const;
/** Resolve one role independently, including legacy boe-openai declarations. */
export function roleProviderProfile(config:Config,role:AgentRole):PiAiProviderProfile {
  const selection=config[role],declared=config.providers?.[selection.provider];
  if(!declared&&!['boe-openai','boe-router','boe-worker'].includes(selection.provider)&&!selection.api&&!selection.baseUrl)
    throw new Error(`Configure provider route ${selection.provider} with its own protocol, model and credential reference`);
  const profile=structuredClone(declared??{});
  const api=selection.api??profile.api??'openai-responses';
  const declaredModel=profile.models?.find(model=>model.id===selection.model);
  if(profile.models&&!declaredModel)throw new Error(`Model ${selection.model} is not declared for ${role} provider ${selection.provider}`);
  const models=declaredModel?[declaredModel]:[{id:selection.model,input:api==='openai-responses'?['text','image'] as const:['text'] as const,reasoningEfforts:api==='openai-responses'?reasoning:false}];
  return {...profile,api,baseURL:selection.baseUrl??profile.baseURL??config.baseUrl,
    apiKeyEnv:selection.apiKeyEnv??profile.apiKeyEnv??(selection.provider==='boe-openai'?'OPENAI_API_KEY':role.toUpperCase()+'_API_KEY'),
    models:structuredClone(models) as PiAiProviderProfile['models'],modelOverrides:undefined,
    // The shared stream boundary owns the exact bounded retry schedule.
    retryPolicy:{mode:'normal',maxRetries:0}};
}
interface Slot {
  role:AgentRole;signature:string;keyEnv:string;refs:number;retired:boolean;
  native:Promise<NativeAgentRuntime>;closing?:Promise<void>;
}
export interface NativeLease { native:NativeAgentRuntime;model:ModelSelection;release:()=>Promise<void> }

/** Versioned native hosts share durable session storage, never mutable credential references. */
export class NativeRuntimePool {
  private current=new Map<string,Slot>();
  private slots=new Set<Slot>();
  private closed=false;
  constructor(private readonly root:string){}

  async acquire(role:AgentRole,config:Config,options:{memory?:boolean}={}):Promise<NativeLease>{
    if(this.closed)throw new Error('Runtime is closed');
    const profile=roleProviderProfile(config,role),selection=config[role];
    const key=role==='router'?config.routerApiKey:config.workerApiKey;
    if(!key)throw new Error(`Configure ${profile.apiKeyEnv} in the private .env file for ${role}`);
    const signature=createHash('sha256').update(JSON.stringify({profile,selection,key})).digest('hex');
    // Hosts are isolated; the signature remains private instead of entering session metadata.
    const provider=`boe-${role}`;
    const slotKey=role==='router'&&options.memory?'router-memory':role;
    let slot=this.current.get(slotKey);
    if(!slot||slot.signature!==signature){
      const old=slot,keyEnv='BOE2_ROLE_'+randomUUID().replaceAll('-','').toUpperCase();
      process.env[keyEnv]=key;
      slot={role,signature,keyEnv,refs:0,retired:false,native:NativeAgentRuntime.create({
        root:join(this.root,'dsh'),providers:{[provider]:{...profile,apiKeyEnv:keyEnv}},
        ...(role==='router'&&!options.memory?{compactionRole:'router' as const,compactionModel:{provider,model:selection.model,maxTokens:selection.maxTokens}}:{}),
        compaction:options.memory?false:{...(role==='router'?ROUTER_COMPACTION_POLICY:{}),summarizationProvider:provider,summarizationModel:selection.model},
      })};
      this.slots.add(slot);this.current.set(slotKey,slot);
      if(old){old.retired=true;if(!old.refs)void this.dispose(old).catch(()=>{});}
    }
    slot.refs++;
    let released=false;
    const release=async()=>{if(released)return;released=true;slot.refs--;if(slot.retired&&!slot.refs)await this.dispose(slot);};
    try{
      const native=await slot.native;
      if(this.closed)throw new Error('Runtime is closed');
      // Non-reasoning models accept no effort parameter at all, including dsh's UI value "off".
      const reasoningEffort=selection.reasoningEffort==='off'&&profile.models?.[0]?.reasoningEfforts===false?undefined:selection.reasoningEffort;
      return {native,model:{provider,model:selection.model,reasoningEffort,maxTokens:selection.maxTokens},release};
    }catch(error){
      slot.retired=true;if(this.current.get(slotKey)===slot)this.current.delete(slotKey);
      await release();throw error;
    }
  }
  private dispose(slot:Slot):Promise<void>{
    if(!slot.closing)slot.closing=(async()=>{
      try{const native=await slot.native;await native.close();}
      finally{delete process.env[slot.keyEnv];this.slots.delete(slot);}
    })();
    return slot.closing;
  }
  async close(){
    if(this.closed)return;this.closed=true;this.current.clear();
    const results=await Promise.allSettled([...this.slots].map(slot=>{slot.retired=true;return this.dispose(slot);}));
    const failed=results.find(result=>result.status==='rejected');if(failed?.status==='rejected')throw failed.reason;
  }
}
