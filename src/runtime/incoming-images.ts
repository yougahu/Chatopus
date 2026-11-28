import type { Attachment, GroupMessage } from '../types.js';
import type { NativeImage } from './native.js';

export interface IncomingImageScope {
  roomId:string; role:'router'|'worker'; threadId?:string; runId?:string; routeTurnId?:string;
  phase:'start'|'steer'|'route';
}
export interface IncomingImageContext extends IncomingImageScope { messageId:string; attachmentIndex:number }
export interface IncomingImageEvent extends IncomingImageContext { status:'loaded'|'failed'|'omitted'; code?:string; bytes?:number }
export type ImageResolver=(attachment:Attachment,context:IncomingImageContext,signal?:AbortSignal)=>Promise<Attachment>;

/** Resolve metadata-only Router snapshots against the host's original message. */
export function sourceImage(message:GroupMessage|undefined,context:IncomingImageContext):Attachment {
  const attachment=message?.attachments[context.attachmentIndex];
  if(message?.id!==context.messageId||message.roomId!==context.roomId||attachment?.kind!=='image')throw new Error('image_out_of_scope');
  return attachment;
}

/** Groups are ordered from oldest/lowest priority to newest/highest priority. */
export async function prepareIncomingImages(groups:GroupMessage[][],scope:IncomingImageScope,
  resolveImage:ImageResolver|undefined,onImage:((event:IncomingImageEvent)=>void)|undefined,signal?:AbortSignal) {
  const images:NativeImage[]=[],imageAttachments:Array<{messageId:string;attachmentIndex:number}>=[];
  const attachmentErrors:Array<{messageId:string;attachmentIndex:number;code:string}>=[];
  const attachmentOmissions:Array<{messageId:string;attachmentIndex:number;reason:string}>=[];
  const seen=new Set<string>(),selected:Array<{message:GroupMessage;attachment:Attachment;index:number;group:number;position:number}>=[];
  const emit=(event:IncomingImageEvent)=>{try{onImage?.(event);}catch{/* observer only */}};
  // Reject an invalid scope before any I/O, including lower-priority entries.
  if(groups.flat().some(message=>message.roomId!==scope.roomId))throw new Error('image_out_of_scope');
  for(let group=groups.length-1;group>=0;group--)for(let position=groups[group].length-1;position>=0;position--){
    const message=groups[group][position];
    for(const [index,attachment]of message.attachments.entries()){
      if(attachment.kind!=='image')continue;
      const key=JSON.stringify([message.id,index]);if(seen.has(key))continue;seen.add(key);
      const context={...scope,messageId:message.id,attachmentIndex:index};
      if(selected.length>=4){attachmentOmissions.push({messageId:message.id,attachmentIndex:index,reason:'image_limit'});emit({...context,status:'omitted',code:'image_limit'});continue;}
      selected.push({message,attachment,index,group,position});
    }
  }
  for(const {message,attachment,index}of selected.sort((a,b)=>a.group-b.group||a.position-b.position||a.index-b.index)){
    signal?.throwIfAborted();
    const context={...scope,messageId:message.id,attachmentIndex:index};
    try{
      const resolved=attachment.url?.startsWith('data:')?attachment:await resolveImage?.(attachment,context,signal);
      if(!resolved?.url?.startsWith('data:image/'))throw new Error('image_data_unavailable');
      const match=resolved.url.match(/^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/);
      if(!match)throw new Error('invalid_image_encoding');
      if(match[2].length>14_000_000)throw new Error('image_too_large');
      const data=Buffer.from(match[2],'base64');if(data.length>10*1024*1024)throw new Error('image_too_large');
      images.push({data,mediaType:match[1] as NativeImage['mediaType'],name:`${message.id}:${index}`});
      imageAttachments.push({messageId:message.id,attachmentIndex:index});emit({...context,status:'loaded',bytes:data.length});
    }catch(error){
      signal?.throwIfAborted();
      const candidate=(error as {code?:unknown})?.code??(error instanceof Error?error.message:'');
      const code=typeof candidate==='string'&&/^[a-z][a-z0-9_]{1,63}$/.test(candidate)?candidate:'image_load_failed';
      attachmentErrors.push({messageId:message.id,attachmentIndex:index,code});emit({...context,status:'failed',code});
    }
  }
  signal?.throwIfAborted();return {images,imageAttachments,attachmentErrors,attachmentOmissions};
}
