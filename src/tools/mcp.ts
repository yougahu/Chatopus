import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ErrorCode, McpError, ToolListChangedNotificationSchema, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { HarnessError } from '@deepseek-ai/dsh-llm';
import { promises as fs } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

export interface McpConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  timeoutMs?: number;
  allowedTools?: string[];
}

const STDERR_CHARS = 4096;
const INLINE_RESULT_CHARS = 12_000;
const SECRET_KEY = /(?:token|secret|password|passwd|api[_-]?key|credential|authorization|cookie)/i;

export interface McpDiagnostics {
  processState: 'not_started' | 'starting' | 'connected' | 'closed';
  pid?: number;
  /** The SDK exposes transport closure, but not the subprocess exit code/signal. */
  exitCode: null;
  exitCodeAvailable: false;
  stderr: string;
  stderrTruncated: boolean;
  transportError?: string;
}
export interface McpFailureReport {
  code: string;
  server: string;
  operation: string;
  message: string;
  diagnostics: McpDiagnostics;
  result?: unknown;
  evidence?: { path: string; sha256: string };
  evidenceWriteError?: string;
}

/** dsh's native tool loop preserves HarnessError.code and marks thrown calls isError=true. */
export class McpOperationError extends HarnessError {
  constructor(readonly report: McpFailureReport) {
    super(JSON.stringify(report), report.code);
  }
}

/** One private process per domain session. A promise queue serializes ALL calls. */
export class PrivateMcp {
  private client?: Client;
  private transport?: StdioClientTransport;
  private tail: Promise<unknown> = Promise.resolve();
  private closed = false;
  private processState: McpDiagnostics['processState'] = 'not_started';
  private pid?: number;
  private stderr = '';
  private stderrTruncated = false;
  private transportError?: string;
  private catalog?:Tool[];
  private catalogRevision=0;
  private readonly decoder = new StringDecoder('utf8');
  constructor(private config: McpConfig, private workspace: string, private role: string) {}

  private redact(text: string): string {
    const secrets = Object.entries(this.config.env ?? {}).filter(([key, value]) => SECRET_KEY.test(key) && value)
      .map(([, value]) => value).sort((a, b) => b.length - a.length);
    for (const secret of secrets) text = text.replaceAll(secret, '[redacted]');
    return text.replace(/\bBearer\s+[^\s"',;]+/gi, 'Bearer [redacted]')
      .replace(/\bsk-[A-Za-z0-9_-]+/g, '[redacted]')
      .replace(/(["']?(?:[A-Za-z0-9_-]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API[_-]?KEY|CREDENTIAL|AUTHORIZATION|COOKIE)[A-Za-z0-9_-]*)["']?\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;}]+)/gi, '$1[redacted]');
  }

  private redactValue(value: unknown): unknown {
    if (typeof value === 'string') return this.redact(value);
    if (Array.isArray(value)) return value.map(item => this.redactValue(item));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
      .map(([key, item]) => [key, SECRET_KEY.test(key) ? '[redacted]' : this.redactValue(item)]));
    return value;
  }

  diagnostics(): McpDiagnostics {
    const oversizedSecret = Object.entries(this.config.env ?? {}).some(([key, value]) => SECRET_KEY.test(key) && value.length > 32_768);
    const stderr = oversizedSecret ? '[stderr omitted: configured credential exceeds redaction window]' : this.redact(this.stderr);
    return { processState: this.processState, ...(this.pid ? { pid: this.pid } : {}), exitCode: null, exitCodeAvailable: false,
      stderr: stderr.slice(-STDERR_CHARS), stderrTruncated: this.stderrTruncated || stderr.length > STDERR_CHARS,
      ...(this.transportError ? { transportError: this.redact(this.transportError).slice(0, 1000) } : {}) };
  }

  private captureStderr(chunk: Buffer | string) {
    const text = typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    // Keep overlap for redaction across stream chunks; never expose the raw buffer.
    this.stderr += text;
    const retained = STDERR_CHARS + Math.min(32_768, Math.max(1024, ...Object.entries(this.config.env ?? {})
      .filter(([key]) => SECRET_KEY.test(key)).map(([, value]) => value.length)));
    if (this.stderr.length > retained) { this.stderrTruncated = true; this.stderr = this.stderr.slice(-retained); }
  }

  private async failure(operation: string, error: unknown, signal?: AbortSignal, result?: unknown): Promise<McpOperationError> {
    if (error instanceof McpOperationError) return error;
    const code = result !== undefined ? 'MCP_TOOL_ERROR'
      : signal?.aborted ? (signal.reason?.name === 'TimeoutError' ? 'MCP_TIMEOUT' : 'MCP_CANCELLED')
      : error instanceof McpError && error.code === ErrorCode.RequestTimeout ? 'MCP_TIMEOUT'
      : error instanceof McpError && error.code === ErrorCode.ConnectionClosed ? 'MCP_CONNECTION_CLOSED'
      : error instanceof McpError ? 'MCP_PROTOCOL_ERROR' : 'MCP_TRANSPORT_ERROR';
    const detail = this.redact(error instanceof Error ? error.message : String(error));
    // Preserve the decoded MCP response, including structuredContent, without copying credentials.
    const rawResult = result === undefined ? undefined : this.redactValue(result);
    const full = { code, server: this.role, operation, message: detail, diagnostics: this.diagnostics(),
      ...(rawResult === undefined ? {} : { result: rawResult }) };
    const report: McpFailureReport = { ...full, message: detail.slice(0, 2000) };
    const encodedResult = rawResult === undefined ? '' : JSON.stringify(rawResult);
    if (encodedResult.length > INLINE_RESULT_CHARS) report.result = { truncated: true, preview: encodedResult.slice(0, INLINE_RESULT_CHARS) };
    try {
      const root = await fs.realpath(this.workspace), directory = join(root, '.mcp-diagnostics');
      try { await fs.mkdir(directory, { mode: 0o700 }); }
      catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause; }
      const stat = await fs.lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('MCP diagnostics directory must not be a symlink');
      const file = join(directory, `${this.role}-${randomUUID()}.json`), bytes = JSON.stringify(full, null, 2) + '\n';
      await fs.writeFile(file, bytes, { flag: 'wx', mode: 0o600 });
      report.evidence = { path: file, sha256: createHash('sha256').update(bytes).digest('hex') };
    } catch (cause) { report.evidenceWriteError = this.redact(cause instanceof Error ? cause.message : String(cause)).slice(0, 500); }
    return new McpOperationError(report);
  }

  private async connect(signal?: AbortSignal) {
    if (this.closed) throw new Error('MCP session is closed');
    if (this.client) {
      // Never silently replace a crashed server and imply its in-memory state survived.
      if (this.processState === 'closed') throw new McpError(ErrorCode.ConnectionClosed, 'MCP transport closed; server state is unavailable');
      return this.client;
    }
    const env: Record<string, string> = {};
    for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG']) if (process.env[key]) env[key] = process.env[key]!;
    Object.assign(env, this.config.env);
    this.transport = new StdioClientTransport({ command: this.config.command, args: this.config.args,
      env, cwd: this.workspace, stderr: 'pipe' });
    this.processState = 'starting';
    this.transport.stderr?.on('data', chunk => this.captureStderr(chunk));
    const client = new Client({ name: 'chat-agent-host', version: '0.1.0' });
    client.onclose = () => { this.processState = 'closed'; this.catalog=undefined; this.catalogRevision++; };
    client.setNotificationHandler(ToolListChangedNotificationSchema,()=>{this.catalog=undefined;this.catalogRevision++;});
    client.onerror = error => { this.transportError = error.message; };
    try {
      await client.connect(this.transport, { timeout: this.config.timeoutMs ?? 90_000, signal });
      this.pid = this.transport.pid ?? undefined; this.processState = 'connected'; this.client = client; return client;
    } catch (error) { this.pid = this.transport.pid ?? undefined; await this.transport.close(); this.processState = 'closed'; throw error; }
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn);
    this.tail = next.catch(() => undefined);
    return next;
  }

  list(signal?: AbortSignal) {
    return this.serial(async () => {
      try {
        signal?.throwIfAborted();
        const client = await this.connect(signal);
        if(this.catalog)return structuredClone(this.catalog.filter(tool=>!this.config.allowedTools||this.config.allowedTools.includes(tool.name)));
        const revision=this.catalogRevision,all:Tool[] = [],seen=new Set<string>();
        let cursor: string | undefined;
        do {
          const page = await client.listTools({ cursor }, { timeout: this.config.timeoutMs ?? 90_000, signal }); all.push(...page.tools); cursor = page.nextCursor;
          if(cursor){if(seen.has(cursor)||seen.size>=100)throw new Error('MCP catalog pagination did not terminate');seen.add(cursor);}
        } while (cursor);
        const allowed=all.filter(tool => !this.config.allowedTools || this.config.allowedTools.includes(tool.name));
        if(revision===this.catalogRevision)this.catalog=all;
        return structuredClone(allowed);
      } catch (error) { throw await this.failure('tools/list', error, signal); }
    });
  }

  call(name: string, args: Record<string, unknown>, signal?: AbortSignal) {
    return this.serial(async () => {
      if (this.config.allowedTools && !this.config.allowedTools.includes(name)) throw new Error('MCP tool is not enabled');
      try {
        signal?.throwIfAborted();
        const client = await this.connect(signal);
        const result = await client.callTool({ name, arguments: args }, undefined, { timeout: this.config.timeoutMs ?? 90_000, signal });
        // This is the parsed MCP protocol flag, never a guess from text or nested user data.
        if (result.isError === true) throw await this.failure(name, new Error('MCP tool reported isError=true'), signal, result);
        return result;
      } catch (error) { throw await this.failure(name, error, signal); }
    });
  }

  async close() {
    this.closed = true;
    // Abort transport immediately; do not await a hung tool before releasing the process.
    if (this.client) await this.client.close();
    else if (this.transport) await this.transport.close();
    this.processState = 'closed';
    await this.tail.catch(() => undefined);
  }
}
