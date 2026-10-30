var LiteraturePreferences = {
  init() {
    const library = Zotero.LiteratureLibrary.library;
    const refresh = () => {
      const node = document.getElementById('ll-pref-status'); if (!node) return;
      const s = library.credentials.status();
      const labels = { missing: '未配置', configured: '已配置，尚未验证', valid: '已验证有效', expired: 'Key 已过期，请更新', invalid: 'Key 无效，请更新', auth_failed: '鉴权失败，请检查权限' };
      node.textContent = labels[s.state] + (s.expiresAt ? ' · 预计到期 ' + s.expiresAt : ' · 有效期未知');
      for (const [id, value] of [['ll-pref-issued', s.issuedAt], ['ll-pref-expiry', s.expiresAt]]) {
        const input = document.getElementById(id); if (document.activeElement !== input) input.value = value || '';
      }
    };
    this.unsubscribe?.(); this.unsubscribe = library.onChange(refresh);
    window.addEventListener('unload', () => this.unsubscribe?.(), { once: true });
    refresh();
  }
};
document.addEventListener('load', event => {
  if (event.target.id === 'll-preferences') LiteraturePreferences.init();
}, true);
