import { HarnessError } from '@deepseek-ai/dsh-llm';
import { readableSource, type ReadableSource } from './source-text.js';

/** Inspect transport/envelope layers, not arbitrary records in a data array. */
export function toolFailureReason(value:unknown,depth=0):string|undefined {
  if(depth>12||value==null)return;
  if(typeof value==='string'){
    if(!/^[\s]*[\[{]/.test(value))return;
    try{return toolFailureReason(JSON.parse(value),depth+1);}catch{return;}
  }
  if(typeof value!=='object'||Array.isArray(value))return;
  const v=value as Record<string,unknown>;
  if(v.isError===true||v.success===false||v.ok===false||v.status==='error'||v.status==='failed'||v.error)return 'upstream_error';
  for(const key of ['status','statusCode','httpStatus']){
    const status=v[key];
    if(typeof status==='number'&&(status<200||status>=300))return `http_${status}`;
  }
  for(const key of ['structuredContent','result','response','data','body']){
    const reason=toolFailureReason(v[key],depth+1);if(reason)return reason;
  }
  if(Array.isArray(v.content))for(const part of v.content){
    if(part?.type==='text'){const reason=toolFailureReason(part.text,depth+1);if(reason)return reason;}
  }
}

export function assertToolResult(value:unknown):void {
  const reason=toolFailureReason(value);
  if(reason)throw new HarnessError(JSON.stringify({isError:true,reason,evidenceAvailable:false}), 'TOOL_RESULT_ERROR');
}

export const SOURCE_EVIDENCE_RULE = 'Only acquired, relevant source content supports citations and verified factual claims. HTTP errors, nested error results, empty responses, CAPTCHA/access challenges and Loading pages provide no evidence, even with HTTP 200. After a failed fetch use the configured browser to read the actual body, or try another relevant source. A navigation success, title, URL or search snippet alone does not verify the claims attributed to that source. If recovery fails, state the evidence gap and distinguish inferences or prior knowledge from verified facts; never cite the failed page as if read.';

export function checkedSource(input:{url:string;status:number;text:string;contentType:string;retryAfter?:string|null}):ReadableSource {
  const readable=readableSource(input.text,input.contentType);
  let reason=toolFailureReason({status:input.status})??toolFailureReason(input.text);
  const title=readable.title??'',body=readable.text.trim();
  if(!reason&&(/^(?:just a moment|attention required|access denied|verify (?:you are|your identity)|security (?:check|verification))(?:[.!\s]|$)/i.test(title)
    ||/^captcha(?: verification)?[.!…\s]*$/i.test(title)
    ||(body.length<2000&&/(?:verify (?:that )?you(?:'re| are) (?:a )?human|checking your browser|enable javascript and cookies to continue|complete the (?:security check|captcha))/i.test(body))))reason='access_challenge';
  if(!reason&&(!body||/^(?:[\w .-]{0,50}\s+is\s+)?(?:loading|please wait|正在加载|加载中)[.\s…!]*$/i.test(body)))reason=body?'loading_shell':'empty_body';
  if(reason)throw new HarnessError(JSON.stringify({isError:true,code:'SOURCE_UNAVAILABLE',url:input.url,status:input.status,reason,
    evidenceAvailable:false,...(input.retryAfter?{retryAfter:input.retryAfter}:{}),next:'Read the actual body with a configured browser or another source. If unavailable, disclose the evidence gap; do not present unsupported claims as verified or cite this failed response.'}), 'SOURCE_UNAVAILABLE');
  return readable;
}
