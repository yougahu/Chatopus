import { expect, it } from 'vitest';
import { Store } from '../src/store.js';

it('selects only the latest confirmed same-room sends before the routing snapshot, with the limit in SQL', () => {
  const store = new Store(':memory:');
  try {
    for (const [id, roomId, status, sentAt] of [
      ['older', 'room', 'sent', 10], ['newer', 'room', 'sent', 20], ['same-time', 'room', 'sent', 20],
      ['foreign', 'other', 'sent', 25], ['pending', 'room', 'pending', 25], ['sending', 'room', 'sending', 25],
      ['unknown', 'room', 'unknown', 25], ['failed', 'room', 'failed', 25], ['future', 'room', 'sent', 31],
    ] as const) store.enqueue({ roomId, replyToMessageId: 'human', text: id }, { id, status, sentAt, platformMessageId: 'platform-' + id });
    store.enqueue({ roomId: 'room', text: 'legacy missing confirmed time' }, { status: 'sent' });
    expect(store.sentReplies('room', 2, 30)).toEqual([
      { messageId: 'platform-newer', replyToMessageId: 'human', text: 'newer', sentAt: 20 },
      { messageId: 'platform-same-time', replyToMessageId: 'human', text: 'same-time', sentAt: 20 },
    ]);
    expect(store.sentReplies('room', 20, 20).map(reply => reply.text)).toEqual(['older', 'newer', 'same-time']);
    expect(store.sentReplies('room', 0, 30)).toEqual([]);
    expect(() => store.sentReplies('room', -1)).toThrow('Invalid sent reply limit');
  } finally { store.close(); }
});

it('retains a confirmed reply without fabricating a missing platform message ID', () => {
  const store = new Store(':memory:');
  try {
    store.enqueue({ roomId: 'room', text: '平台确认已发送但没有提供消息编号' }, { status: 'sent', sentAt: 100 });
    expect(store.sentReplies('room', 1, 100)).toEqual([{ messageId: undefined, replyToMessageId: undefined, text: '平台确认已发送但没有提供消息编号', sentAt: 100 }]);
  } finally { store.close(); }
});
