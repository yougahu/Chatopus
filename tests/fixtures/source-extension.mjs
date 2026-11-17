/** Repository-owned fixture for the host SDK's source and audit contracts.
 * Tests supply mocked HTTP responses; no installed skill or service is used.
 */
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export async function createSession(_options, context, host) {
  const seen = new Set();
  return {
    systemContext: 'Use acquired source content as evidence.',
    tools: [{
      name: 'fixture_fetch',
      description: 'Read a mocked public source through the host SDK.',
      inputSchema: { type: 'object', properties: { url: { type: 'string' }, saveAs: { type: 'string' } }, required: ['url'], additionalProperties: false },
      async execute(args, signal) {
        const started = Date.now(), fingerprint = createHash('sha256').update(JSON.stringify(args)).digest('hex');
        const repeatedRequest = seen.has(fingerprint); seen.add(fingerprint);
        let result, status = 'error';
        try {
          const response = await fetch(args.url, { signal, redirect: 'error' }), text = await response.text();
          const source = host.checkedSource({ url: args.url, status: response.status, text,
            contentType: response.headers.get('content-type') ?? '', retryAfter: response.headers.get('retry-after') });
          if (args.saveAs) {
            const target = await host.confinedPath(context.artifactWorkspace ?? context.workspace, args.saveAs, true);
            await mkdir(dirname(target), { recursive: true });
            await writeFile(target, text, { mode: 0o600 });
          }
          result = { ...source, url: args.url, status: response.status, evidenceAvailable: true };
          status = 'ok'; return result;
        } finally {
          context.onAudit?.({ threadId: context.threadId, runId: context.runId, revision: context.revision,
            tool: 'fixture_fetch', category: 'source-fixture', requestFingerprint: fingerprint, repeatedRequest,
            elapsedMs: Date.now() - started, responseCharacters: result ? JSON.stringify(result).length : 0, status, truncated: false });
        }
      },
    }],
    async close() {},
  };
}
