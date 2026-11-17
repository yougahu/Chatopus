import { createHash, randomUUID } from 'node:crypto';

export interface ReplyLinkBinding {threadId:string;runId:string;revision:number}
export interface ReplyLink extends ReplyLinkBinding {reference:string;url:string;sha256:string}
const tokenPattern = /\[\[link:([a-f0-9]{32})\]\]/g;
const hash = (text:string) => createHash('sha256').update(text).digest('hex');
export function linkError(message:string):Error {
  return Object.assign(new Error(message), {code:'REPLY_LINK_INVALID'});
}
export function linkReferences(text:string):string[] {
  const found=[...text.matchAll(tokenPattern)].map(match=>match[0]);
  if(text.replace(tokenPattern,'').includes('[[link:'))throw linkError('Malformed link reference; use the exact reference returned by the tool');
  return found;
}
function validateUrl(raw:string):void {
  if(typeof raw!=='string'||raw.length>10000||/[\s<>\[\]"\u0000-\u001f]/u.test(raw))throw linkError('Invalid link URL');
  let url:URL;try{url=new URL(raw);}catch{throw linkError('Invalid link URL');}
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw linkError('Invalid link URL');
}
/** Receipts are created only by trusted tools, never from model report fields. */
export class ReplyLinks {
  private readonly links=new Map<string,ReplyLink>();
  constructor(private readonly binding:ReplyLinkBinding) {}
  register(url:string,reference=`[[link:${randomUUID().replaceAll('-','')}]]`):string {
    validateUrl(url);
    if(linkReferences(reference).length!==1||linkReferences(reference)[0]!==reference)throw linkError('Invalid link reference');
    const previous=this.links.get(reference);
    if(previous&&previous.url!==url)throw linkError('Link reference already belongs to another URL');
    this.links.set(reference,{...this.binding,reference,url,sha256:hash(url)});
    return reference;
  }
  resolve(text:string):ReplyLink[] {
    return [...new Set(linkReferences(text))].map(reference=>{
      const link=this.links.get(reference);
      if(!link)throw linkError('Link reference is not active in this run; reuse it through its tool with the current requirements');
      return {...link};
    });
  }
}
/** Runs after all model rewriting. Validates both the template and durable receipts. */
export function renderReplyLinks(text:string,links:ReplyLink[] = [],binding?:Partial<ReplyLinkBinding>):string {
  if(links.length>20)throw linkError('Too many reply links');
  const receipts=new Map<string,ReplyLink>();
  for(const link of links){
    validateUrl(link.url);
    if(linkReferences(link.reference)[0]!==link.reference||link.sha256!==hash(link.url)||receipts.has(link.reference))throw linkError('Invalid link receipt');
    if(!link.threadId||!link.runId||!Number.isSafeInteger(link.revision)||link.revision<1)throw linkError('Invalid link binding');
    for(const key of ['threadId','runId','revision'] as const)if(binding?.[key]!==undefined&&binding[key]!==link[key])throw linkError('Link receipt belongs to another task or revision');
    receipts.set(link.reference,link);
  }
  const references=linkReferences(text);
  if(references.some(reference=>!receipts.has(reference))||[...receipts.keys()].some(reference=>!references.includes(reference)))throw linkError('Missing or unknown link reference');
  for(const match of text.matchAll(tokenPattern)){
    const start=match.index!,end=start+match[0].length;
    const lineStart=text.lastIndexOf('\n',start-1)+1,lineEnd=text.indexOf('\n',end);
    if(text.slice(lineStart,start).trim()||text.slice(end,lineEnd<0?text.length:lineEnd).trim())throw linkError('Place each link reference alone on its own line, without extra characters');
  }
  if(links.some(link=>text.includes(link.url)))throw linkError('Use the link reference instead of copying its URL');
  const rendered=text.replace(tokenPattern,reference=>receipts.get(reference)!.url);
  if(links.length&&rendered.length>12000)throw linkError('Rendered reply exceeds the message limit');
  return rendered;
}
export function assertLinkReferencesUnchanged(before:string,after:string):void {
  if(JSON.stringify(linkReferences(before).sort())!==JSON.stringify(linkReferences(after).sort()))throw linkError('Reply rewriting changed link references');
}
