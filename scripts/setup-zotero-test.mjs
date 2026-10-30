import { mkdir, readFile, writeFile, cp, unlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { readdir } from 'node:fs/promises';
import { zipSync, strToU8 } from 'fflate';
const root = resolve('.test-profile');
const data = resolve('.test-data');
await mkdir(join(root, 'extensions'), { recursive: true });
await mkdir(data, { recursive: true });
await writeFile(join(root,'fixture-result.zip'),zipSync({
 'full.md':strToU8('# Methods\nFirst page fixture evidence.\n\n# Results\nSecond page fixture evidence.'),
 'fixture_content_list.json':strToU8(JSON.stringify([
  {type:'text',text_level:1,text:'Methods',page_idx:0}, {type:'text',text:'First page fixture evidence.',page_idx:0},
  {type:'text',text_level:1,text:'Results',page_idx:1}, {type:'text',text:'Second page fixture evidence.',page_idx:1}
 ]))
}));
await writeFile(join(root,'fixture.pdf'),'%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Count 0/Kids[]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n');
for (const name of ['extensions.json', 'addonStartup.json.lz4']) {
  try { await unlink(join(root, name)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
}
const addon = resolve('build/test-addon');
await cp('build/addon', addon, { recursive: true });
await cp('tests/zotero-harness.js', join(addon, 'content/zotero-harness.js'));
await cp('tests/word-harness.js', join(addon, 'content/word-harness.js'));
let bootstrap = await readFile(join(addon, 'bootstrap.js'), 'utf8');
bootstrap = bootstrap.replace('await scope.LiteratureLibrary.start({ id, version, rootURI });',
  'await scope.LiteratureLibrary.start({ id, version, rootURI });\n  Services.scriptloader.loadSubScript(rootURI + "content/zotero-harness.js", scope);');
bootstrap = bootstrap.replace('async function startup({ id, version, rootURI }) {', 'async function startup({ id, version, rootURI }) { try {');
bootstrap = bootstrap.replace('\n}\n\nasync function shutdown()', '\n} catch(e) { dump("LL_STARTUP_ERROR: " + String(e) + " " + String(e.stack || "") + "\\n"); }\n}\n\nasync function shutdown()');
await writeFile(join(addon, 'bootstrap.js'), bootstrap);
const packed = {};
async function collect(dir, prefix = '') {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const name = prefix + entry.name;
    if (entry.isDirectory()) await collect(join(dir, entry.name), name + '/');
    else packed[name] = new Uint8Array(await readFile(join(dir, entry.name)));
  }
}
await collect(addon);
await writeFile(join(root, 'extensions/literature-library@local.zotero.xpi'), zipSync(packed));
const prefs = {
  'extensions.zotero.firstRun': false,
  'extensions.zotero.useDataDir': true,
  'extensions.zotero.dataDir': data,
  'extensions.zotero.httpServer.localAPI.enabled': true,
  'extensions.zotero.httpServer.port': 23129,
  'extensions.zotero.debug.log': true,
  'extensions.zotero.debug.level': 3,
  'extensions.autoDisableScopes': 0,
  'extensions.enabledScopes': 15,
  'extensions.checkCompatibility': false,
  'extensions.logging.enabled': true,
  'browser.dom.window.dump.enabled': true,
  'xpinstall.signatures.required': false,
  'app.update.enabled': false,
  'browser.shell.checkDefaultBrowser': false
};
await writeFile(join(root, 'user.js'), Object.entries(prefs).map(([k, v]) => `user_pref(${JSON.stringify(k)}, ${JSON.stringify(v)});`).join('\n'));
console.log(JSON.stringify({ profile: root, data, addon }));
