import { promises as fs } from 'node:fs';

type Scalar = string | number | boolean | null;
export interface JsonQuery {
  pointer?: string;
  where?: Record<string, Scalar>;
  fields?: string[];
  offset?: number;
  limit?: number;
}
const own = (value: unknown, key: string): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && Object.hasOwn(value, key);

/** RFC 6901 selection, with no expressions, coercion, or inherited properties. */
function select(value: unknown, pointer: string): unknown {
  if (!pointer) return value;
  if (!pointer.startsWith('/') || /~(?![01])/u.test(pointer)) throw new Error('pointer must be an RFC 6901 JSON pointer, e.g. /lines');
  for (const token of pointer.slice(1).split('/')) {
    const key = token.replace(/~1/g, '/').replace(/~0/g, '~');
    if (!own(value, key)) throw new Error(`JSON pointer does not exist: ${pointer}`);
    value = value[key];
  }
  return value;
}
function bound(value: unknown, fallback: number, max: number) {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > max) throw new Error('Invalid JSON pagination bound');
  return value;
}
export async function queryJson(file: string, query: JsonQuery) {
  const stat = await fs.stat(file);
  if (!stat.isFile() || stat.size > 20_000_000) throw new Error('JSON source must be a regular file of at most 20 MB');
  if (query.pointer !== undefined && typeof query.pointer !== 'string') throw new Error('pointer must be a string');
  if (query.where !== undefined && (query.where === null || typeof query.where !== 'object' || Array.isArray(query.where) || Object.keys(query.where).length > 20 || Object.values(query.where).some(v => v !== null && !['string', 'number', 'boolean'].includes(typeof v)))) throw new Error('where must contain at most 20 exact scalar field filters');
  if (query.fields !== undefined && (!Array.isArray(query.fields) || query.fields.length === 0 || query.fields.length > 50 || query.fields.some(v => typeof v !== 'string'))) throw new Error('fields must contain 1–50 property names');
  const offset = bound(query.offset, 0, 1_000_000), limit = bound(query.limit, 20, 100);
  if (!limit) throw new Error('JSON limit must be at least 1');
  const selected = select(JSON.parse(await fs.readFile(file, 'utf8')), query.pointer ?? '');
  const source = Array.isArray(selected) ? selected : [selected];
  const filters = Object.entries(query.where ?? {});
  const matches = source.filter(row => filters.every(([key, value]) => own(row, key) && row[key] === value));
  const rows: unknown[] = []; let characters = 0;
  for (const row of matches.slice(offset, offset + limit)) {
    const projected = query.fields ? Object.fromEntries(query.fields.filter(key => own(row, key)).map(key => [key, (row as Record<string, unknown>)[key]])) : row;
    const size = JSON.stringify(projected).length;
    if (characters + size > 40_000) {
      if (!rows.length) throw new Error('One JSON record exceeds the output budget; select fewer fields or a narrower pointer');
      break;
    }
    rows.push(projected); characters += size;
  }
  const next = offset + rows.length;
  const hasMore = next < matches.length;
  return { pointer: query.pointer ?? '', totalRecords: source.length, totalMatches: matches.length, offset, rows,
    hasMore, nextOffset: hasMore ? next : null, truncated: hasMore };
}
