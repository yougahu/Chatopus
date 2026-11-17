import { describe, expect, it } from 'vitest';
import { describeAddressing } from '../src/router-context.js';
import type { GroupMessage } from '../src/types.js';

const message: GroupMessage = {
  id: 'qq:bot:room:question', platform: 'qq', roomId: 'qq:bot:room', messageId: 'question',
  authorId: 'player', authorName: '成员', text: '给群友说的话', timestamp: 0,
  mentions: ['other', 'bot', 'all', 'other'], attachments: [], isMentioned: true, isAdmin: false,
};

describe('describeAddressing', () => {
  it('preserves full source IDs and only describes structural mentions', () => {
    const original = structuredClone(message);
    expect(describeAddressing([message], 'bot', {}, [])).toEqual({
      [message.id]: { mentionsOthers: ['other'] },
    });
    expect(message).toEqual(original);
  });

  it('does not infer a reply from text or reuse another source message candidate', () => {
    const other = { ...message, id: 'qq:bot:room:other', messageId: 'other', authorId: 'friend' };
    const quoted = { ...message, replyToMessageId: 'other', text: '@bot 继续刚才的任务' };
    expect(describeAddressing([quoted], 'bot', { differentSource: other }, [
      { roomId: 'foreign', messageId: 'other', threadId: 'foreign-thread' },
    ])[message.id].replyTo).toEqual({ kind: 'unknown' });
    expect(describeAddressing([{ ...message, text: '回复机器人：继续' }], 'bot', {}, [
      { roomId: message.roomId, messageId: 'other' },
    ])[message.id].replyTo).toBeUndefined();
  });

  it('uses only the quoted member identity or the host-confirmed bot binding', () => {
    const quoted = { ...message, replyToMessageId: 'source' };
    const source = { ...message, id: 'qq:bot:room:source', messageId: 'source', authorId: 'friend' };
    expect(describeAddressing([quoted], 'bot', { [message.id]: source }, [])[message.id].replyTo).toEqual({ kind: 'member', authorId: 'friend' });
    expect(describeAddressing([quoted], 'bot', {}, [{ roomId: message.roomId, messageId: 'source', threadId: 'same-room-thread' }])[message.id].replyTo)
      .toEqual({ kind: 'bot', authorId: 'bot', threadId: 'same-room-thread' });
    expect(describeAddressing([quoted], 'bot', { [message.id]: { ...source, roomId: 'foreign' } }, [])[message.id].replyTo).toEqual({ kind: 'unknown' });
  });
});
