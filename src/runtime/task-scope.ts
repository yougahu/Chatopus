import type { ThreadInput,ScheduledExecutionInput } from '../types.js';
/** Current resolved request is a hint; attributed original inputs remain authoritative. */
export function currentTaskQuestion(inputs:ThreadInput[],scheduledInput?:ScheduledExecutionInput):string {
  if(scheduledInput)return scheduledInput.instructions;
  const latest=inputs.at(-1);if(!latest)return '';
  if(latest.routingContext?.resolvedRequest)return latest.routingContext.resolvedRequest;
  return inputs.filter(input=>input.message.authorId===latest.message.authorId).map(input=>input.message.text).join('\n');
}
