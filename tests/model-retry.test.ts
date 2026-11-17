import { afterEach, expect, it, vi } from 'vitest';
import { type StreamChunk } from '@deepseek-ai/dsh-llm';
import { retryModelStream } from '../src/runtime/model-retry.js';

afterEach(() => vi.useRealTimers());
const collect = async (stream: AsyncIterable<StreamChunk>) => { const chunks: StreamChunk[] = []; for await (const chunk of stream) chunks.push(chunk); return chunks; };
const finish: StreamChunk = {type:'finish',reason:{kind:'stop'}};

it('retries every model error on the exact schedule, then returns a model error after six attempts', async () => {
  vi.useFakeTimers();
  const calls: number[] = [];
  const errors = ['INVALID_CREDENTIAL', 'INVALID_ARGS', 'QUOTA', 'PI_AI_ERROR', 'TRANSPORT', 'SERVER_ERROR'];
  const result = collect(retryModelStream(async function* () {
    const code = errors[calls.length]; calls.push(Date.now());
    yield {type:'text-delta',index:0,text:'discarded partial response'};
    yield {type:'finish',reason:{kind:'error',failure:{code,message:'last failure '+code}}};
  }));
  await vi.advanceTimersByTimeAsync(0); expect(calls).toHaveLength(1);
  for (const [index, delay] of [1000,5000,10000,10000,30000].entries()) {
    await vi.advanceTimersByTimeAsync(delay - 1); expect(calls).toHaveLength(index + 1);
    await vi.advanceTimersByTimeAsync(1); expect(calls).toHaveLength(index + 2);
  }
  expect(calls.map(at => at - calls[0])).toEqual([0,1000,6000,16000,26000,56000]);
  expect(await result).toEqual([{type:'finish',reason:{kind:'error',failure:{code:'MODEL_RETRIES_EXHAUSTED',message:expect.stringContaining('last failure SERVER_ERROR')}}}]);
  await vi.advanceTimersByTimeAsync(60000); expect(calls).toHaveLength(6);
});

it('discards a broken stream before returning only the successful attempt', async () => {
  let calls=0; const waits:number[]=[];
  const result=await collect(retryModelStream(async function* () {
    calls++;
    yield {type:'text-delta',index:0,text:calls===1?'broken':'complete'};
    yield calls===1?{type:'finish',reason:{kind:'error',failure:{code:'TRANSPORT',message:'connection reset'}}}:finish;
  },undefined,async delay=>{waits.push(delay);}));
  expect(waits).toEqual([1000]);expect(calls).toBe(2);
  expect(result).toEqual([{type:'text-delta',index:0,text:'complete'},finish]);
});

it('cancels during backoff without dispatching another request', async () => {
  vi.useFakeTimers(); const abort=new AbortController();let calls=0;
  const result=collect(retryModelStream(async function* () {calls++;yield {type:'finish',reason:{kind:'error',failure:{code:'PI_AI_ERROR',message:'overloaded'}}};},abort.signal));
  const rejected=expect(result).rejects.toThrow('cancelled');
  await vi.advanceTimersByTimeAsync(0);abort.abort(new Error('cancelled'));await rejected;
  await vi.advanceTimersByTimeAsync(60000);expect(calls).toBe(1);expect(vi.getTimerCount()).toBe(0);
});

it('retries provider timeout errors and incomplete streams', async () => {
  let calls=0;const waits:number[]=[];
  const result=await collect(retryModelStream(async function* () {
    calls++;
    if(calls===1){yield {type:'finish',reason:{kind:'error',failure:{code:'TRANSPORT',message:'Request timed out'}}};return;}
    if(calls===2)return;
    yield finish;
  },undefined,async delay=>{waits.push(delay);}));
  expect(result).toEqual([finish]);expect(calls).toBe(3);expect(waits).toEqual([1000,5000]);
});

it('does not retry host middleware or audit failures',async()=>{
 let calls=0;const wait=vi.fn();
 await expect(collect(retryModelStream(async function*(){calls++;throw new Error('audit unavailable');},undefined,wait))).rejects.toThrow('audit unavailable');
 expect(calls).toBe(1);expect(wait).not.toHaveBeenCalled();
});

it('does not retry an unchanged context-overflow request before the compactor can repair it',async()=>{
 let calls=0;const wait=vi.fn();
 const result=await collect(retryModelStream(async function*(){calls++;yield {type:'text-delta',index:0,text:'discarded partial response'};yield {type:'finish',reason:{kind:'error',failure:{code:'CONTEXT_WINDOW_EXCEEDED',message:'too large'}}};},undefined,wait));
 expect(calls).toBe(1);expect(wait).not.toHaveBeenCalled();expect(result).toHaveLength(1);expect(result[0]).toMatchObject({reason:{failure:{code:'CONTEXT_WINDOW_EXCEEDED'}}});
});
