import { build } from 'esbuild';
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { zipSync } from 'fflate';

const out = 'build/addon';
const { version } = JSON.parse(await readFile('package.json', 'utf8'));
await mkdir(out, { recursive: true });
await cp('addon', out, { recursive: true });
await build({ entryPoints: ['src/plugin.ts'], bundle: true, outfile: `${out}/content/plugin.js`,
  format: 'iife', globalName: 'LiteratureLibrary', platform: 'browser', target: 'firefox115' });
await build({ entryPoints: ['src/ui.ts'], bundle: true, outfile: `${out}/content/ui.js`,
  format: 'iife', platform: 'browser', target: 'firefox115' });
await build({ entryPoints: ['src/inference-worker.ts'], bundle: true,
  define: { 'import.meta.url': 'self.location.href' },
  outfile: `${out}/content/inference-worker.js`, format: 'iife', platform: 'browser', target: 'firefox115' });
await mkdir(`${out}/content/vendor`, { recursive: true });
await mkdir(`${out}/licenses`, { recursive: true });
for (const pkg of ['@huggingface/transformers', 'lucide', 'parse5', 'entities'])
  await cp(`node_modules/${pkg}/LICENSE`, `${out}/licenses/${pkg.replaceAll('/', '-')}.txt`);
await cp('THIRD_PARTY_NOTICES.md', `${out}/THIRD_PARTY_NOTICES.md`);
const hf = 'node_modules/@huggingface/transformers/dist';
await cp(`${hf}/transformers.web.js`, `${out}/content/vendor/transformers.web.js`);
for (const name of await readdir(hf)) {
  if (name.endsWith('.wasm') || name.startsWith('ort-wasm') && name.endsWith('.mjs'))
    await cp(join(hf, name), join(out, 'content/vendor', name));
}
const files = {};
async function collect(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await collect(path);
    else files[relative(out, path).replaceAll('\\', '/')] = new Uint8Array(await readFile(path));
  }
}
await collect(out);
await mkdir('dist', { recursive: true });
await writeFile(`dist/literature-library-${version}.xpi`, zipSync(files, { level: 6 }));
console.log(`Built dist/literature-library-${version}.xpi`);
