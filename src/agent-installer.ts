export type AgentTarget = 'codex' | 'claude-code';
const SERVER = 'zotero_literature_library';
const TOML_START = '# >>> Literature Library MCP (managed by Zotero plugin)';
const TOML_END = '# <<< Literature Library MCP';

export function quoteTOML(value: string) { return JSON.stringify(value).replace(/\\u([0-9a-f]{4})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16))); }

export function installCodexBlock(original: string, url: string, token: string) {
  const start = original.indexOf(TOML_START), end = original.indexOf(TOML_END);
  let base = original;
  if (start >= 0 && end >= start) base = original.slice(0, start) + original.slice(end + TOML_END.length);
  const lines = base.split(/\r?\n/);
  const kept: string[] = [];
  let skipping = false;
  for (const line of lines) {
    const header = line.match(/^\s*\[\[?([^\]]+)\]\]?\s*(?:#.*)?$/)?.[1]?.trim();
    if (header) skipping = header === `mcp_servers.${SERVER}` || header.startsWith(`mcp_servers.${SERVER}.`);
    if (!skipping) kept.push(line);
  }
  base = kept.join('\n').trimEnd();
  const block = `${TOML_START}\n[mcp_servers.${SERVER}]\nurl = ${quoteTOML(url)}\nhttp_headers = { Authorization = ${quoteTOML(`Bearer ${token}`)} }\n${TOML_END}`;
  return `${base}${base ? '\n\n' : ''}${block}\n`;
}

export function installClaudeConfig(original: string, url: string, token: string) {
  let config: any = {};
  if (original.trim()) {
    try { config = JSON.parse(original); }
    catch { throw new Error('Claude Code 配置文件不是有效 JSON。文件未修改。'); }
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Claude Code 配置必须是 JSON 对象。文件未修改。');
  const servers = config.mcpServers && typeof config.mcpServers === 'object' && !Array.isArray(config.mcpServers) ? config.mcpServers : {};
  servers[SERVER] = { type: 'http', url, headers: { Authorization: `Bearer ${token}` } };
  config.mcpServers = servers;
  return JSON.stringify(config, null, 2) + '\n';
}

export class AgentInstaller {
  constructor(private home: string, private endpoint: () => Promise<{ url: string; token: string }>) {}
  private async read(path: string) {
    if (!await IOUtils.exists(path)) return '';
    return IOUtils.readUTF8(path);
  }
  private async write(path: string, content: string) {
    await IOUtils.makeDirectory(PathUtils.parent(path), { ignoreExisting: true });
    const original = await this.read(path);
    const backup = path + '.literature-library.bak';
    if (original && !await IOUtils.exists(backup)) await IOUtils.writeUTF8(backup, original);
    const temp = path + '.literature-library.tmp';
    if (await IOUtils.exists(temp)) await IOUtils.remove(temp);
    await IOUtils.writeUTF8(temp, content);
    try {
      if (await IOUtils.exists(path)) await IOUtils.remove(path);
      await IOUtils.move(temp, path);
    } catch (error) {
      try { if (await IOUtils.exists(temp)) await IOUtils.remove(temp); } catch {}
      try {
        if (original) await IOUtils.writeUTF8(path, original);
        else if (await IOUtils.exists(path)) await IOUtils.remove(path);
      } catch {}
      throw new Error(`无法更新 Agent MCP 配置。${original ? `原文件备份：${backup}` : '请检查目录权限。'} ${String(error)}`);
    }
  }
  async install(target: AgentTarget) {
    if (target !== 'codex' && target !== 'claude-code') throw new Error('不支持的 Agent，请使用通用 MCP 配置。');
    const { url, token } = await this.endpoint();
    if (target === 'codex') {
      const path = PathUtils.join(this.home, '.codex', 'config.toml');
      const config = installCodexBlock(await this.read(path), url, token);
      await this.write(path, config);
      return { target, path, backup: await IOUtils.exists(path + '.literature-library.bak') ? path + '.literature-library.bak' : null, server: SERVER };
    }
    const path = PathUtils.join(this.home, '.claude.json');
    const config = installClaudeConfig(await this.read(path), url, token);
    await this.write(path, config);
    return { target, path, backup: await IOUtils.exists(path + '.literature-library.bak') ? path + '.literature-library.bak' : null, server: SERVER };
  }
  async status() {
    const codexPath = PathUtils.join(this.home, '.codex', 'config.toml');
    const claudePath = PathUtils.join(this.home, '.claude.json');
    let codex = false, codexError: string | undefined, claudeError: string | undefined;
    try { codex = (await this.read(codexPath)).includes(`[mcp_servers.${SERVER}]`); } catch { codexError = '无法读取配置，请检查文件权限'; }
    let claude = false;
    try { const raw = await this.read(claudePath); claude = raw.trim() ? !!JSON.parse(raw).mcpServers?.[SERVER] : false; } catch { claudeError = '配置无法读取或不是有效 JSON'; }
    return { codex: { configured: codex, path: codexPath, error: codexError }, claudeCode: { configured: claude, path: claudePath, error: claudeError }, server: SERVER };
  }
}
