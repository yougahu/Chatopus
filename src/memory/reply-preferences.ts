import type { MemberMemoryProjection } from './member-updates.js';

const expressionKeys=['preferredName','language','responseDetail','formatPreference','terminology'] as const;
export function expressionPreferences(profiles:readonly MemberMemoryProjection[]){
  return profiles.map(profile=>({memberId:profile.memberId,fields:Object.fromEntries(expressionKeys
    .filter(key=>profile.fields[key]!==undefined).map(key=>[key,profile.fields[key]]))})).sort((a,b)=>a.memberId.localeCompare(b.memberId));
}
/** A presentation refresh cannot silently drop or invent technical literals. */
export function validatePreferenceRewrite(original:string,rewritten:string,profiles:readonly MemberMemoryProjection[],current?:{
  memberId?:string;previous:readonly MemberMemoryProjection[];latest:readonly MemberMemoryProjection[];
}):void{
  if(!rewritten.trim()||Buffer.byteLength(rewritten)>96_000)throw new Error('Invalid preference rendering');
  const names=profiles.flatMap(profile=>{
    const field=profile.fields.preferredName;return field?.state==='set'&&typeof field.value==='string'?[field.value]:[];
  }).filter(Boolean).sort((a,b)=>b.length-a.length);
  // A numeric nickname is exempt only in a leading salutation, never throughout
  // technical prose (nickname "0" must not hide changing a value from 100 to 1).
  const withoutName=(text:string)=>{
    const trimmed=text.trimStart(),name=names.find(name=>trimmed.startsWith(name)&&/^[，,：:！!\s]/u.test(trimmed.slice(name.length)));
    return name?trimmed.slice(name.length):text;
  };
  const literals=(text:string)=>({
    numbers:[...withoutName(text).matchAll(/[-+]?\d+(?:,\d{3})*(?:\.\d+)?%?/g)].map(match=>match[0]),
    urls:[...text.matchAll(/https?:\/\/[^\s<>\]\)"']+/g)].map(match=>match[0]),
    code:[...text.matchAll(/```[\s\S]*?```|`[^`\n]+`/g)].map(match=>match[0]),
  });
  if(JSON.stringify(literals(original))!==JSON.stringify(literals(rewritten)))
    throw Object.assign(new Error('Preference rendering changed protected technical literals'),{code:'PREFERENCE_CONTENT_CHANGED'});
  const memberId=current?.memberId??(current?.latest.length===1?current.latest[0].memberId:undefined);
  const old=current?.previous.find(profile=>profile.memberId===memberId)?.fields.preferredName;
  const latest=current?.latest.find(profile=>profile.memberId===memberId)?.fields.preferredName;
  if(old?.state==='set'&&typeof old.value==='string'&&(latest?.state!=='set'||latest.value!==old.value)){
    const candidate=rewritten.trimStart();
    if(candidate.startsWith(old.value)&&/^[，,：:！!\s]/u.test(candidate.slice(old.value.length)))
      throw Object.assign(new Error('Preference rendering retained an obsolete salutation'),{code:'PREFERENCE_CONTENT_CHANGED'});
  }
}
