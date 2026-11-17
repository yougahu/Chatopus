import { OpenVikingError } from './openviking-client.js';

export interface OpenVikingCredentialsOptions {
  baseUrl: string;
  rootKey: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

/** Root is used only for provisioning. All content operations receive the group's USER key. */
export class OpenVikingCredentials {
  private readonly keys = new Map<string, string>();
  private readonly loading = new Map<string, Promise<string>>();
  private readonly base: string;
  constructor(private readonly options: OpenVikingCredentialsOptions) {
    const url = new URL(options.baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !options.rootKey)
      throw new Error('Invalid OpenViking provisioning configuration');
    this.base = url.toString().replace(/\/$/, '');
  }
  get(account: string): Promise<string> {
    if (!/^boe_[a-f0-9]{40}$/.test(account)) return Promise.reject(new Error('Invalid memory account'));
    const cached = this.keys.get(account); if (cached) return Promise.resolve(cached);
    const prior = this.loading.get(account); if (prior) return prior;
    const task = this.provision(account).then(key => { this.keys.set(account, key); return key; }).finally(() => this.loading.delete(account));
    this.loading.set(account, task); return task;
  }
  /** Administrative readers must never create an account or identity as a side effect. */
  lookupExisting(account: string): Promise<string | null> {
    if (!/^boe_[a-f0-9]{40}$/.test(account)) return Promise.reject(new Error('Invalid memory account'));
    return this.lookup(account);
  }
  invalidate(account: string): void { this.keys.delete(account); }
  private async admin(account: string, suffix: string, body?: unknown): Promise<unknown> {
    const path = suffix === 'create-account' ? '/api/v1/admin/accounts' : `/api/v1/admin/accounts/${account}${suffix}`;
    let response: Response;
    try {
      response = await (this.options.fetch ?? fetch)(this.base + path, {
        method: body === undefined ? 'GET' : 'POST', redirect: 'error',
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 15_000),
        headers: { 'X-API-Key': this.options.rootKey, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch { throw new OpenVikingError('PROVISION_TRANSPORT', 0, body !== undefined); }
    const reader = response.body?.getReader(); let bytes = 0; const chunks: Uint8Array[] = [];
    try {
      if (!reader) throw new Error('No body');
      for (;;) {
        const { value, done } = await reader.read(); if (done) break;
        bytes += value.byteLength;
        if (bytes > 128_000) { await reader.cancel(); throw new Error('Too large'); }
        chunks.push(value);
      }
      const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!response.ok || result.status !== 'ok') {
        const code = result.error?.code;
        throw new OpenVikingError(typeof code === 'string' && /^[A-Z_]{1,64}$/.test(code) ? code : 'PROVISION_FAILED', response.status, body !== undefined && response.status >= 500);
      }
      return result.result;
    } catch (error) {
      if (error instanceof OpenVikingError) throw error;
      throw new OpenVikingError('INVALID_PROVISION_RESPONSE', response.status, body !== undefined);
    }
  }
  private async lookup(account: string): Promise<string | null> {
    try {
      const result = await this.admin(account, '/users?include_credentials=true');
      if (!Array.isArray(result)) throw new OpenVikingError('INVALID_PROVISION_RESPONSE', 200, false);
      const user = result.find(value => value?.user_id === 'group');
      if (!user) return null;
      // An existing overprivileged identity is a configuration error, not permission to reuse it.
      if (user.role !== 'user' || typeof user.api_key !== 'string' || !user.api_key) throw new Error('OpenViking group identity must be USER with a key');
      return user.api_key;
    } catch (error) {
      if (error instanceof OpenVikingError && error.status === 404 && error.code === 'NOT_FOUND') return null;
      throw error;
    }
  }
  private async provision(account: string): Promise<string> {
    const prior = await this.lookup(account); if (prior) return prior;
    try { await this.admin(account, '', undefined); }
    catch (error) {
      if (!(error instanceof OpenVikingError) || error.status !== 404 || error.code !== 'NOT_FOUND') throw error;
      try { await this.admin(account, 'create-account', { account_id: account, admin_user_id: 'bootstrap' }); }
      catch (createError) {
        // A lost response can mean the account exists. Verify it without rotating credentials.
        await this.admin(account, '', undefined).catch(() => { throw createError; });
      }
    }
    try { await this.admin(account, '/users', { user_id: 'group', role: 'user' }); }
    catch (error) { const recovered = await this.lookup(account); if (recovered) return recovered; throw error; }
    const key = await this.lookup(account);
    if (!key) throw new Error('OpenViking group key was not created');
    return key;
  }
}
