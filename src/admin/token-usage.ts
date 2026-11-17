import type { DatabaseSync } from 'node:sqlite';

interface TokenTotals {
  /** Total model input, including the separately reported cache categories. */
  inputTokens: number;
  uncachedInputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  recordCount: number;
  incompleteRecords?:number;
  unknownRecords?:number;
}
export interface RunTokenUsage extends TokenTotals { runId: string | null; status: string | null }
export interface ThreadTokenUsage extends TokenTotals { missingRuns: number; runs?: RunTokenUsage[] }

const emptyTotals = (): TokenTotals => ({ inputTokens: 0, uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, recordCount: 0 });
const sumTokens = (key: string) => `SUM(CASE WHEN json_type(data,'$.${key}') IN ('integer','real') AND json_extract(data,'$.${key}') >= 0 THEN json_extract(data,'$.${key}') ELSE 0 END)`;

/** Use all recorded Worker turns, not the overview's recent-metrics window.
 * A model row already includes its summary usage; never add compaction twice.
 * Router and independent memory work cannot be attributed to one task.
 */
export function readThreadTokenUsage(db: DatabaseSync, threadIds: string[], includeRuns = false): Map<string, ThreadTokenUsage> {
  const ids = [...new Set(threadIds)], result = new Map<string, ThreadTokenUsage>();
  if (!ids.length) return result;
  const placeholders = ids.map(() => '?').join(',');
  const groups = db.prepare(`SELECT json_extract(data,'$.threadId') AS threadId,
      CASE WHEN json_type(data,'$.runId')='text' THEN NULLIF(trim(json_extract(data,'$.runId')),'') END AS runId,
      ${sumTokens('inputTokens')} AS uncachedInputTokens, ${sumTokens('outputTokens')} AS outputTokens,
      ${sumTokens('cacheReadTokens')} AS cacheReadTokens, ${sumTokens('cacheWriteTokens')} AS cacheWriteTokens,
      count(*) AS recordCount,
      SUM(CASE WHEN json_extract(data,'$.usageStatus') IN ('partial','unknown') THEN 1 ELSE 0 END) AS incompleteRecords,
      SUM(CASE WHEN json_extract(data,'$.usageStatus')='unknown' THEN 1 ELSE 0 END) AS unknownRecords
    FROM telemetry WHERE kind='model' AND json_extract(data,'$.role')='worker'
      AND json_extract(data,'$.threadId') IN (${placeholders}) GROUP BY threadId,runId`).all(...ids);
  const runs = db.prepare(`SELECT id,thread_id,status FROM runs WHERE thread_id IN (${placeholders}) ORDER BY rowid`).all(...ids);
  const byThread = new Map(ids.map(id => [id, new Map<string | null, RunTokenUsage>()]));
  for (const run of runs) byThread.get(String(run.thread_id))!.set(String(run.id), { ...emptyTotals(), runId: String(run.id), status: String(run.status) });
  for (const group of groups) {
    const runId = typeof group.runId === 'string' ? group.runId : null, entries = byThread.get(String(group.threadId))!;
    const uncachedInputTokens = Number(group.uncachedInputTokens), cacheReadTokens = Number(group.cacheReadTokens), cacheWriteTokens = Number(group.cacheWriteTokens);
    entries.set(runId, { runId, status: entries.get(runId)?.status ?? null,
      inputTokens: uncachedInputTokens + cacheReadTokens + cacheWriteTokens, uncachedInputTokens,
      outputTokens: Number(group.outputTokens), cacheReadTokens, cacheWriteTokens, recordCount: Number(group.recordCount),
      ...(Number(group.incompleteRecords)?{incompleteRecords:Number(group.incompleteRecords)}:{}),
      ...(Number(group.unknownRecords)?{unknownRecords:Number(group.unknownRecords)}:{}) });
  }
  for (const id of ids) {
    const entries = [...byThread.get(id)!.values()], total = emptyTotals();
    for (const run of entries) for (const key of Object.keys(run) as Array<keyof TokenTotals>) {
      if(key in emptyTotals()||key==='incompleteRecords'||key==='unknownRecords')total[key]=(total[key]??0)+(run[key]??0);
    }
    result.set(id, { ...total, missingRuns: entries.filter(run => run.recordCount === 0).length, ...(includeRuns ? { runs: entries } : {}) });
  }
  return result;
}
