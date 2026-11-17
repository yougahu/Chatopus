import { type StreamChunk } from '@deepseek-ai/dsh-llm';
import { waitForModelRetry } from './retry-delay.js';

export const MODEL_RETRY_DELAYS_MS = [1000, 5000, 10000, 10000, 30000] as const;
export const MODEL_RETRIES_EXHAUSTED = 'MODEL_RETRIES_EXHAUSTED';
export const MODEL_ERROR_REPLY = '模型调用失败：已重试 5 次仍未成功，本次处理未能完成。请稍后再试。';
export const modelRetriesExhausted = (error: unknown) => (error as {code?: unknown})?.code === MODEL_RETRIES_EXHAUSTED;
/** Preserve the existing per-attempt allowance while making room for all six attempts. */
export const modelRetryTimeout = (timeoutMs: number) => timeoutMs * 6 + MODEL_RETRY_DELAYS_MS.reduce((sum, delay) => sum + delay, 0);

/** Retry the model request only: failed partial text/tool calls never reach the Agent loop. */
export async function* retryModelStream(
  next: () => AsyncIterable<StreamChunk>, signal?: AbortSignal,
  wait: typeof waitForModelRetry = waitForModelRetry,
): AsyncIterable<StreamChunk> {
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    const chunks: StreamChunk[] = [];
    // dsh converts adapter throws (including transport timeouts) into terminal
    // failure chunks. Thrown middleware/audit errors belong to the host.
    for await (const chunk of next()) {
      signal?.throwIfAborted();
      chunks.push(chunk);
    }
    signal?.throwIfAborted();
    const finish = chunks.findLast(chunk => chunk.type === 'finish');
    const failure = !finish ? {code:'INCOMPLETE_RESPONSE',message:'Model stream ended without a terminal response'}
      : finish.reason.kind === 'error' || finish.reason.kind === 'aborted' ? finish.reason.failure : undefined;
    if (!failure) { yield* chunks; return; }
    // Context overflow requires a different model surface; replaying the same request
    // six times cannot repair it. Let the official compactor / host rebuild own recovery.
    if(['CONTEXT_WINDOW_EXCEEDED','context-length-exceeded','CONTEXT_LIMIT','ROUTER_CALL_LIMIT','ROUTER_DEADLINE'].includes(failure.code)){
      yield {type:'finish',reason:{kind:'error',failure}};return;
    }
    if (attempt === MODEL_RETRY_DELAYS_MS.length) {
      const detail = `${failure.code}: ${failure.message}`;
      yield {type: 'finish', reason: {kind: 'error', failure: {
        code: MODEL_RETRIES_EXHAUSTED, message: `Model call failed after 5 retries (6 attempts): ${detail}`,
      }}};
      return;
    }
    await wait(MODEL_RETRY_DELAYS_MS[attempt], signal);
  }
}
