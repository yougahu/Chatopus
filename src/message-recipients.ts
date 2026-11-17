import { z } from 'zod';

export const MAX_MESSAGE_RECIPIENTS = 50;
/** Platform member identities, resolved before delivery; display names are not IDs. */
export const recipientIdsSchema = z.array(z.string().trim().min(1).max(200)).max(MAX_MESSAGE_RECIPIENTS);
