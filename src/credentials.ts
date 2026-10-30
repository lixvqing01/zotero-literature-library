import { AppError, credentialDisplay, expiryDates, type CredentialInfo } from './core';
import type { Store } from './store';
const HOST = 'chrome://literature-library';
const REALM = 'MinerU API';
const EMPTY: CredentialInfo = { state: 'missing', revision: 0, issuedAt: null, expiresAt: null, checkedAt: null };
export class Credentials {
  private info: CredentialInfo = { ...EMPTY };
  constructor(private store: Store, private changed: () => void) {}
  private logins() { return Services.logins.findLogins(HOST, null, REALM); }
  async init() {
    this.info = await this.store.get('credentials', { ...EMPTY });
    if (!this.logins().length) this.info.state = 'missing';
    await this.persist();
  }
  status() { return credentialDisplay(this.info); }
  async read() {
    if (['expired', 'invalid', 'auth_failed'].includes(this.info.state)) {
      const expired = this.info.state === 'expired';
      throw new AppError({ code: expired ? 'MINERU_TOKEN_EXPIRED' : this.info.state === 'invalid' ? 'MINERU_TOKEN_INVALID' : 'MINERU_AUTH_FAILED',
        provider: 'mineru', provider_code: this.info.providerCode,
        message: expired ? 'MinerU Key 已过期，请在设置中更新。' : 'MinerU Key 鉴权失败，请在设置中更新。',
        retryable: false, requires_user_action: true, action: 'update_mineru_key' });
    }
    const found = this.logins()[0];
    if (!found) throw new AppError({ code: 'MINERU_KEY_MISSING', message: '尚未配置 MinerU Key。',
      retryable: false, requires_user_action: true, action: 'update_mineru_key' });
    return { key: found.password, revision: this.info.revision };
  }
  async save(input: { key?: string; issuedAt?: string | null; expiresAt?: string | null; clear?: boolean }) {
    const dates = expiryDates(input.issuedAt || null, input.expiresAt || null);
    if (input.clear) {
      for (const login of this.logins()) Services.logins.removeLogin(login);
      this.info = { ...EMPTY, revision: this.info.revision + 1 };
    } else if (input.key?.trim()) {
      const key = input.key.trim().replace(/^Bearer\s+/i, '');
      if (/\s/.test(key) || key.length < 12 || key.length > 4096) throw new Error('Key 格式不正确。');
      const login = Cc['@mozilla.org/login-manager/loginInfo;1'].createInstance(Ci.nsILoginInfo);
      login.init(HOST, null, REALM, 'mineru', key, '', '');
      const old = this.logins()[0];
      if (old) Services.logins.modifyLogin(old, login); else await Services.logins.addLoginAsync(login);
      this.info = { state: 'configured', revision: this.info.revision + 1, ...dates, checkedAt: null };
    } else {
      this.info = { ...this.info, ...dates };
    }
    await this.persist(); this.changed(); return this.status();
  }
  async report(revision: number, error: AppError | null) {
    if (revision !== this.info.revision) return;
    if (!error) this.info = { ...this.info, state: 'valid', checkedAt: new Date().toISOString(), providerCode: undefined };
    else if (['MINERU_TOKEN_EXPIRED', 'MINERU_TOKEN_INVALID', 'MINERU_AUTH_FAILED'].includes(error.detail.code)) {
      this.info = { ...this.info, state: error.detail.code === 'MINERU_TOKEN_EXPIRED' ? 'expired'
        : error.detail.code === 'MINERU_TOKEN_INVALID' ? 'invalid' : 'auth_failed',
        checkedAt: new Date().toISOString(), providerCode: error.detail.provider_code };
    } else return;
    await this.persist(); this.changed();
  }
  async allowRecheck() {
    if (this.logins().length) { this.info.state = 'configured'; await this.persist(); }
  }
  private async persist() { await this.store.set('credentials', this.info); }
}
