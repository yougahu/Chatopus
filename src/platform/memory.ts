import type { OutgoingMessage, PublisherPort, SendReceipt } from '../types.js';

/** Local replay publisher. No external effects. */
export class MemoryPublisher implements PublisherPort {
  readonly messages: Array<{ message: OutgoingMessage; dedupeKey: string }> = [];
  private receipts = new Map<string, { signature: string; receipt: SendReceipt }>();
  async send(message: OutgoingMessage, dedupeKey: string): Promise<SendReceipt> {
    const signature = JSON.stringify(message), prior = this.receipts.get(dedupeKey);
    if (prior) return prior.signature === signature ? prior.receipt : { status: 'failed', reason: 'dedupe_key_conflict' };
    const receipt: SendReceipt = { status: 'sent', platformMessageId: `local-${this.messages.length + 1}` };
    this.messages.push({ message: structuredClone(message), dedupeKey });
    this.receipts.set(dedupeKey, { signature, receipt });
    return receipt;
  }
}
