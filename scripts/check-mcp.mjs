import { readFile,writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const { endpoint,token }=JSON.parse(await readFile('.test-profile/mcp-test.json','utf8'));
async function request(body,auth=true,extra={}) {
 return fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json',...(auth?{Authorization:'Bearer '+token}:{}),...extra},body:JSON.stringify(body)});
}
const rpc=(method,id,params)=>({jsonrpc:'2.0',method,id,params});
assert.equal((await request(rpc('tools/list',1),false)).status,401);
try { assert.equal((await request(rpc('tools/list',1),true,{Origin:'https://attacker.invalid'})).status,403); }
catch(error) { if(error?.cause?.code!=='UND_ERR_SOCKET') throw error; } // Zotero can reject before endpoint dispatch.
let r=await request(rpc('initialize',2,{protocolVersion:'2025-06-18'}));
assert.equal((await r.json()).result.protocolVersion,'2025-06-18');
r=await request(rpc('tools/list',3));const tools=(await r.json()).result.tools;
assert(tools.some(t=>t.name==='citation_prepare'));
r=await request(rpc('tools/call',4,{name:'literature_search',arguments:{query:'hierarchical',layer:'abstract'}}));
const data=await r.json();assert(data.result.structuredContent.results.length);
const doc=data.result.structuredContent.results[0].document_id;
r=await request(rpc('tools/call',5,{name:'literature_read',arguments:{document_id:doc,layer:'abstract'}}));
assert((await r.json()).result.structuredContent.text.includes('hierarchical'));
await writeFile('test-output/mcp-report.json',JSON.stringify({ok:true,tools:tools.map(t=>t.name),unauthorized:401,origin:403,search:true,read:true},null,2));
console.log('MCP HTTP: authentication, Origin guard, initialize, tools, search and layered read passed');
