/** Preserve actual matches in long/minified lines instead of the line's prefix. */
export function searchSnippets(output: string, limit: number) {
  const matches: string[] = [];
  const locations: {path: string; line: number; byteOffset: number; excerpt: string; contextTruncated: boolean}[] = [];
  let more = false;
  for (const line of output.split('\n')) {
    if (!line) continue;
    const event = JSON.parse(line);
    if (event.type !== 'match') continue;
    const data = event.data;
    if (typeof data.lines?.text !== 'string' || typeof data.path?.text !== 'string') continue;
    const bytes = Buffer.from(data.lines.text);
    for (const hit of data.submatches ?? []) {
      if (matches.length >= limit) { more = true; break; }
      // Decode each side separately to keep a multibyte matched string intact.
      const before = bytes.subarray(0, hit.start).toString('utf8');
      const after = bytes.subarray(hit.end).toString('utf8').replace(/\r?\n$/, '');
      const found = bytes.subarray(hit.start, hit.end).toString('utf8');
      const clipped = before.length > 240 || after.length > 500;
      const excerpt = `${before.length > 240 ? '…' : ''}${before.slice(-240)}${found}${after.slice(0, 500)}${after.length > 500 ? '…' : ''}`;
      const location = {path: data.path.text, line: data.line_number, byteOffset: data.absolute_offset + hit.start, excerpt, contextTruncated: clipped};
      locations.push(location); matches.push(`${location.path}:${location.line}:${excerpt}`);
    }
  }
  return { matches, locations, truncated: more || locations.some(x => x.contextTruncated), hasMore: more };
}
