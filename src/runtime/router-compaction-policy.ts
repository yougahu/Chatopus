export interface RouterCompactionSettings {
  maxTokens?:number;
  thresholdRatio?:number;
  headroomTokens?:number;
  retainRatio?:number;
  /** Optional deployment caps; omitted capacities follow the routed model. */
  thresholdTokens?:number;
  contextTokens?:number;
}
export interface ResolvedRouterCompactionSettings extends RouterCompactionSettings {
  maxTokens:number;thresholdRatio:number;headroomTokens:number;retainRatio:number;
}

export const DEFAULT_ROUTER_SUMMARY_TOKENS=16384;

/** Keep the auxiliary output budget independent from ordinary Router answers. */
export function resolveRouterCompactionSettings(value:unknown):ResolvedRouterCompactionSettings {
  if(value===undefined)value={};
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid routerCompaction');
  const settings=value as Record<string,unknown>;
  if(Object.keys(settings).some(key=>!['maxTokens','thresholdRatio','headroomTokens','retainRatio','thresholdTokens','contextTokens'].includes(key)))throw new Error('Unknown routerCompaction setting');
  const maxTokens=settings.maxTokens===undefined?DEFAULT_ROUTER_SUMMARY_TOKENS:settings.maxTokens;
  if(!Number.isSafeInteger(maxTokens)||Number(maxTokens)<1||Number(maxTokens)>16_384)
    throw new Error('routerCompaction.maxTokens must be an integer between 1 and 16384');
  const thresholdRatio=settings.thresholdRatio===undefined?0.8:settings.thresholdRatio;
  const retainRatio=settings.retainRatio===undefined?0.16:settings.retainRatio;
  for(const [key,n] of Object.entries({thresholdRatio,retainRatio}))
    if(typeof n!=='number'||!Number.isFinite(n)||n<=0||n>=1)throw new Error(`Invalid routerCompaction.${key}`);
  if(Number(retainRatio)>=Number(thresholdRatio))throw new Error('routerCompaction.retainRatio must be below thresholdRatio');
  const headroomTokens=settings.headroomTokens===undefined?65_536:settings.headroomTokens;
  if(!Number.isSafeInteger(headroomTokens)||Number(headroomTokens)<0)throw new Error('Invalid routerCompaction.headroomTokens');
  const thresholdTokens=settings.thresholdTokens,contextTokens=settings.contextTokens;
  for(const [key,n] of Object.entries({thresholdTokens,contextTokens}))
    if(n!==undefined&&(!Number.isSafeInteger(n)||Number(n)<=8000||Number(n)>1_048_576))throw new Error(`Invalid routerCompaction.${key}`);
  if(thresholdTokens!==undefined&&contextTokens!==undefined&&Number(thresholdTokens)>=Number(contextTokens))throw new Error('routerCompaction.thresholdTokens must be below contextTokens');
  return {maxTokens:Number(maxTokens),thresholdRatio:Number(thresholdRatio),headroomTokens:Number(headroomTokens),retainRatio:Number(retainRatio),
    ...(thresholdTokens===undefined?{}:{thresholdTokens:Number(thresholdTokens)}),...(contextTokens===undefined?{}:{contextTokens:Number(contextTokens)})};
}
