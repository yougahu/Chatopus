import type { GroupMessage, RouterAddressing } from './types.js';

export interface AddressingBotReply {
  roomId: string;
  messageId: string;
  /** Already verified by the host to refer to a thread in this room. */
  threadId?: string;
}

/** Describe trusted candidates; text and missing references never imply a recipient. */
export function describeAddressing(
  messages: readonly GroupMessage[],
  botUserId: string,
  /** Each candidate was resolved before that individual current message's intake boundary. */
  memberMessages: Readonly<Record<string, GroupMessage | undefined>>,
  sentReplies: readonly AddressingBotReply[],
): Record<string, RouterAddressing> {
  return Object.fromEntries(messages.map(message => {
    const facts: RouterAddressing = {
      mentionsOthers: [...new Set(message.mentions.filter(id => id !== botUserId && id !== 'all'))],
    };
    if (message.replyToMessageId) {
      const bot = sentReplies.find(reply => reply.roomId === message.roomId && reply.messageId === message.replyToMessageId);
      const member = memberMessages[message.id];
      if (bot) facts.replyTo = { kind: 'bot', authorId: botUserId, ...(bot.threadId ? { threadId: bot.threadId } : {}) };
      else if (member?.roomId === message.roomId && member.messageId === message.replyToMessageId) {
        facts.replyTo = { kind: 'member', authorId: member.authorId };
      } else facts.replyTo = { kind: 'unknown' };
    }
    return [message.id, facts];
  }));
}
