import { expect, it } from 'vitest';
import { ReplyLinks, renderReplyLinks, assertLinkReferencesUnchanged } from '../src/tools/reply-links.js';
import { parseReport, reportSchema } from '../src/protocol.js';

const binding={threadId:'t1',runId:'r1',revision:1};
it('only accepts tool receipts bound to the current task and preserves URLs byte for byte',()=>{
 const registry=new ReplyLinks(binding),url='https://example.test/a%20b/H4sIabc_-123';
 const ref=registry.register(url),text='链接：\n'+ref,links=registry.resolve(text);
 expect(renderReplyLinks(text,links,binding)).toBe('链接：\n'+url);
 expect(()=>renderReplyLinks(text,links,{...binding,revision:2})).toThrow('revision');
 expect(()=>renderReplyLinks(text,[{...links[0],url:url+'Za'}],binding)).toThrow('receipt');
 expect(()=>renderReplyLinks(text,[],binding)).toThrow('unknown');
 expect(()=>renderReplyLinks('链接已删',links,binding)).toThrow('Missing');
 expect(()=>renderReplyLinks(text+'\n'+url,links,binding)).toThrow('copying');
 expect(()=>renderReplyLinks(text+'Za',links,binding)).toThrow('own line');
 expect(()=>assertLinkReferencesUnchanged(text,text+ref)).toThrow('changed');
 expect(()=>assertLinkReferencesUnchanged(text,text.replace(ref,ref.replace('link:','link:x')))).toThrow();
});
it('strips forged model link receipts but retains trusted receipts in internal reports',()=>{
 const registry=new ReplyLinks(binding),ref=registry.register('https://example.test/result');
 const report={...binding,basedOnRevision:1,coveredInputSeq:1,status:'ready',shortAnswer:ref,hostLinks:registry.resolve(ref)};
 expect(parseReport(JSON.stringify(report)).hostLinks).toBeUndefined();
 expect(reportSchema.parse(report).hostLinks).toHaveLength(1);
});
