import { readFile,writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { unzipSync,strFromU8 } from 'fflate';
const path='dist/literature-library-0.1.0.xpi';
const bytes=await readFile(path), files=unzipSync(bytes), names=Object.keys(files);
assert(!names.some(name=>/harness|fixture|\.test-profile|node_modules|\.node$/.test(name)));
for(const [name,data] of Object.entries(files)) {
 if(!/\.(js|json|md|xhtml|html|txt)$/.test(name))continue;
 assert(!/(?:^|[^A-Za-z0-9])sk-[A-Za-z0-9_-]{32,}/.test(strFromU8(data)),`Credential-like content found in ${name}`);
}
const manifest=JSON.parse(strFromU8(files['manifest.json']));
assert.equal(manifest.version,'0.1.0');
assert(names.some(name=>name.endsWith('.wasm')));
const hash=createHash('sha256').update(bytes).digest('hex');
await writeFile(path+'.sha256',hash+'  literature-library-0.1.0.xpi\n');
console.log(JSON.stringify({version:manifest.version,files:names.length,bytes:bytes.length,sha256:hash,noHarness:true,noEmbeddedKey:true}));
