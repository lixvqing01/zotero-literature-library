(async () => {
  const path = PathUtils.join(PathUtils.profileDir || Services.dirsvc.get('ProfD', Ci.nsIFile).path, 'integration-report.json');
  const results = [];
  const check = async (name, fn) => {
    try { results.push({ name, ok: true, value: await fn() }); }
    catch (e) { results.push({ name, ok: false, error: String(e) + ' ' + String(e.stack || '') }); }
    await IOUtils.writeJSON(path, { complete: false, results });
  };
  const lib = Zotero.LiteratureLibrary.library;
  await check('plugin-startup-and-database', async () => ({ status: await lib.status(), root: lib.root }));
  await check('required-mineru-setting-and-atomic-agent-config', async () => {
    if (!lib.settings.cloudEnabled) throw new Error('MinerU cloud parsing must always be enabled');
    await lib.saveSettings({cloudEnabled:false});
    if (!lib.settings.cloudEnabled) throw new Error('Cloud setting must not be disableable');
    const root=PathUtils.join(Services.dirsvc.get('ProfD',Ci.nsIFile).path,'agent-config-fixture');
    const AgentInstaller=lib.agentInstaller.constructor;
    const installer=new AgentInstaller(root,async()=>({url:'http://127.0.0.1:23129/literature-library/mcp',token:'fixture-only-agent-token'}));
    await IOUtils.makeDirectory(PathUtils.join(root,'.claude'),{ignoreExisting:true});
    const claudePath=PathUtils.join(root,'.claude.json');
    await IOUtils.writeUTF8(claudePath,JSON.stringify({theme:'dark',mcpServers:{other:{type:'http',url:'https://example.invalid'}}}));
    const claude=await installer.install('claude-code');
    const config=JSON.parse(await IOUtils.readUTF8(claudePath));
    if(config.theme!=='dark'||!config.mcpServers.other||config.mcpServers.zotero_literature_library.headers.Authorization!=='Bearer fixture-only-agent-token')
      throw new Error('Claude config merge failed');
    const codex=await installer.install('codex');await installer.install('codex');
    const codexText=await IOUtils.readUTF8(PathUtils.join(root,'.codex','config.toml'));
    if((codexText.match(/\[mcp_servers\.zotero_literature_library\]/g)||[]).length!==1||!codexText.includes('fixture-only-agent-token'))
      throw new Error('Codex config was not installed idempotently');
    const status=await installer.status();
    if(!status.codex.configured||!status.claudeCode.configured)throw new Error('Agent installer status not detected');
    return {codex:true,claudeCode:true,existingSettingsPreserved:true,repeatInstall:true,backup:claude.backup};
  });
  await check('summary-migration-and-atomic-updates', async () => {
    const full = await lib.store.documents(), summaries = await lib.store.summaries();
    if (full.length !== summaries.length || summaries.some(d => d.chunks || d.markdown || d.sections))
      throw Error('Existing library summary migration is inconsistent');
    const source = full[0];
    if (!source) return { existingDocuments: 0 };
    const temporary = { ...source, id: 'fixture-summary-migration' };
    try {
      await lib.store.putDocument(temporary);
      if (!(await lib.store.summaries()).some(d => d.id === temporary.id && d.title === source.title)) throw Error('Summary not written');
    } finally { await lib.store.removeDocument(temporary.id); }
    if ((await lib.store.summaries()).some(d => d.id === temporary.id)) throw Error('Summary not removed');
    return { existingDocuments: full.length, summaries: summaries.length, writeAndRemove: true };
  });
  await check('secure-credential-lifecycle', async () => {
    await lib.credentials.save({ key: 'fixture-not-a-real-mineru-key', issuedAt: '2026-08-01' });
    const before = lib.credentials.status();
    if (before.expiresAt !== '2026-10-30') throw new Error('Incorrect expiry');
    await lib.credentials.report(before.revision, { detail: { code: 'MINERU_TOKEN_EXPIRED', provider_code: 'A0211' } });
    if (lib.credentials.status().state !== 'expired') throw new Error('Expiry not propagated');
    await lib.credentials.save({ key: 'fixture-new-not-real-mineru-key' });
    await lib.credentials.report(before.revision, { detail: { code: 'MINERU_TOKEN_EXPIRED' } });
    if (lib.credentials.status().state !== 'configured') throw new Error('Stale response overwrote new key');
    await lib.credentials.save({ clear: true });
    return { tested: true, state: lib.credentials.status() };
  });
  await check('embedding-api-http-and-secure-key', async () => {
    const saved = { ...lib.settings }, endpoint = '/test/literature-library/embeddings';
    const handler = function() {};
    handler.prototype = { supportedMethods: ['POST'], supportedDataTypes: ['application/json'], permitBookmarklet: false,
      async init(request) {
        const headers = request.headers, auth = headers.get ? headers.get('authorization') : headers.authorization;
        if (auth !== 'Bearer fixture-embedding-api-key') return [401, 'application/json', '{}'];
        return [200, 'application/json', JSON.stringify({ data: request.data.input.map((_, index) => ({ index, embedding: [3, 4] })) })];
      } };
    Zotero.Server.Endpoints[endpoint] = handler;
    try {
      await lib.embeddingCredentials.save({ key: 'fixture-embedding-api-key' });
      await lib.saveSettings({ embeddingProvider: 'api', embeddingApiBaseUrl: 'http://127.0.0.1:23129/test/literature-library', embeddingApiModel: 'fixture-model' });
      const result = await lib.testEmbeddingModel();
      const vectors = await lib.embedTexts(['fixture input']);
      if (result.dimension !== 2 || vectors[0][0] !== 0.6 || vectors[0][1] !== 0.8) throw new Error('API vector test failed');
      if (JSON.stringify(await lib.status()).includes('fixture-embedding-api-key')) throw new Error('API key exposed in status');
      return { http: true, credentials: true, dimensions: result.dimension, normalized: true };
    } finally {
      delete Zotero.Server.Endpoints[endpoint];
      await lib.embeddingCredentials.save({ clear: true }); await lib.saveSettings(saved);
    }
  });
  await check('zotero-item-ingestion', async () => {
    const item = new Zotero.Item('journalArticle');
    item.setField('title', 'Fixture: Layered scientific retrieval');
    item.setField('abstractNote', 'A reproducible test for hierarchical literature retrieval.');
    item.setField('publicationTitle', 'Fixture Journal');
    item.setField('date', '2026');
    item.setCreators([{ firstName: 'Test', lastName: 'Researcher', creatorType: 'author' }]);
    await item.saveTx();
    await lib.saveSettings({ embeddingsEnabled: false, mcpEnabled: true });
    const enqueued = await lib.enqueueItem(item);
    await lib.tick();
    const docs = await lib.list();
    const ingested = docs.find(d => d.itemKey === item.key);
    if (!ingested) throw new Error('New fixture item missing');
    const read = await lib.read({ document_id: ingested.id, layer: 'abstract' });
    if (!read.text.includes('hierarchical')) throw new Error('Missing abstract');
    const search = await lib.search({ query: 'hierarchical', layer: 'abstract' });
    if (!search.results.length) throw new Error('Search returned no results');
    return { jobs: enqueued, documents: docs, search };
  });
  await check('mcp-http-enabled', async () => ({ endpoint: (await lib.status()).endpoint }));
  await check('mineru-mock-expiry-resume-and-dedup', async()=> {
    const win=Zotero.getMainWindow(), transport=lib.mineru.transport, originalFetch=win.fetch;
    const profile=Services.dirsvc.get('ProfD',Ci.nsIFile).path;
    let expired=true, creates=0, uploads=0;
    const item=new Zotero.Item('journalArticle'); item.setField('title','Fixture PDF lifecycle'); await item.saveTx();
    const attachment=await Zotero.Attachments.importFromFile({file:PathUtils.join(profile,'fixture.pdf'),parentItemID:item.id});
    let dataID;
    try {
      await lib.saveSettings({cloudEnabled:true,embeddingsEnabled:false});
      await lib.credentials.save({key:'fixture-expired-not-real-token'});
      lib.mineru.transport=async(method,url,body)=> {
        if(expired) return {status:200,body:{code:'A0211'}};
        if(method==='POST') { creates++; dataID=body.files[0].data_id;
          return {status:200,body:{code:0,data:{batch_id:'fixture-batch',file_urls:['https://mineru.net/fixture-upload']}}}; }
        return {status:200,body:{code:0,data:{extract_result:[{state:'done',data_id:dataID,full_zip_url:'https://mineru.net/fixture-result'}]}}};
      };
      win.fetch=async(url,options)=> {
        if(String(url)==='https://mineru.net/fixture-upload') {uploads++;return new win.Response('',{status:200});}
        if(String(url)==='https://mineru.net/fixture-result')return new win.Response(await IOUtils.read(PathUtils.join(profile,'fixture-result.zip')),{status:200});
        return originalFetch.call(win,url,options);
      };
      const [queued]=await lib.enqueueItem(item);
      const [duplicateActive]=await lib.enqueueItem(item,true);
      if(duplicateActive.state!=='already_queued')throw Error('Force overwrote an active job');
      const wait=async(states)=> {
        for(let i=0;i<100;i++) {
          const job=(await lib.store.jobs()).find(j=>j.id===queued.job_id);
          if(states.includes(job?.state))return job;
          if(job && ['failed','blocked_model'].includes(job.state)) throw Error(JSON.stringify(job.error));
          if(job) {job.nextRun=0;await lib.store.putJob(job);} await lib.tick();
          await new Promise(r=>win.setTimeout(r,100));
        } throw Error('Fixture queue timeout');
      };
      await wait(['blocked_credentials']);
      if(lib.credentials.status().state!=='expired')throw Error('API expiry not reflected in credentials');
      expired=false; await lib.credentials.save({key:'fixture-renewed-not-real-token'});await lib.resume();
      await wait(['done']);
      const read=await lib.read({document_id:queued.document_id,layer:'fulltext',page:2});
      if(!read.text.includes('Second page'))throw Error('PDF page provenance lost');
      await lib.enqueueItem(item);await wait(['skipped']);
      if(creates!==1||uploads!==1)throw Error('Duplicate source was uploaded');
      const originalJob=(await lib.store.jobs()).find(j=>j.id===queued.job_id);
      await lib.store.putJob({...originalJob,state:'failed',retryState:'queued',error:{code:'MINERU_SUBMISSION_UNCERTAIN',message:'Fixture uncertain submission',retryable:false}});
      await lib.resume('credentials'); await lib.resume();
      const [automatic]=await lib.enqueueItem(item,false,true);
      const [manual]=await lib.enqueueItem(item);
      if(automatic.state!=='failed'||manual.state!=='failed')throw Error('Uncertain task was automatically resubmitted');
      await lib.store.putJob(originalJob);
      const originalEmbed=lib.inference.embed;
      try {
        const saved=await lib.store.document(queued.document_id);saved.modelFingerprint='previous-layer-schema';await lib.store.putDocument(saved);
        lib.inference.embed=async(_model,texts)=>texts.map(()=>Array.from({length:1024},(_,i)=>i===0?1:0));
        await lib.saveSettings({embeddingsEnabled:true});
        await lib.enqueueItem(item);await wait(['done']);
        if(creates!==1||uploads!==1)throw Error('Model upgrade uploaded an unchanged PDF');
        const upgraded=await lib.store.document(queued.document_id);
        if(!upgraded.chunks.some(c=>c.layer==='metadata'&&c.vector?.length===1024))throw Error('Metadata embedding layer missing');
      }finally {lib.inference.embed=originalEmbed;await lib.saveSettings({embeddingsEnabled:false});}
      return {expired:true,resumed:true,page:2,creates,uploads,duplicate:'skipped',uncertainNotResubmitted:true,modelUpgradeReusedMarkdown:true};
    } finally {
      lib.mineru.transport=transport;win.fetch=originalFetch;
      await lib.credentials.save({clear:true}); await lib.saveSettings({cloudEnabled:false});
    }
  });
  await IOUtils.writeJSON(PathUtils.join(Services.dirsvc.get('ProfD',Ci.nsIFile).path,'mcp-test.json'),
    { endpoint:(await lib.status()).endpoint, token:await lib.store.get('mcpToken','') });
  Zotero.LiteratureLibrary.openManager();
  await new Promise(r=>Zotero.getMainWindow().setTimeout(r, 1000));
  await check('manager-window', async () => {
    const wins = [...Services.wm.getEnumerator(null)];
    const manager = wins.find(w=>w.location.href.includes('literature-library/content/manager'));
    if (!manager || !manager.document.body.textContent.includes('知识库')) throw Error('Manager not rendered');
    return { title: manager.document.title, text: manager.document.body.textContent.slice(0, 400) };
  });
  await check('addon-manager-gui-entry', async()=> {
    const args={uri:'about:addons',options:{}};args.wrappedJSObject=args;
    const viewer=Zotero.getMainWindow().openDialog('chrome://zotero/content/standalone/basicViewer.xhtml',
      '', 'chrome,dialog=no,width=1000,height=800', args);
    try {
      for(let i=0;i<150;i++) {
        const doc=viewer.document.querySelector('browser')?.contentDocument;
        const button=doc?.querySelector('[data-literature-manager]');
        if(button) {button.click();return {button:button.textContent,url:doc.documentURI};}
        await new Promise(r=>Zotero.getMainWindow().setTimeout(r,100));
      }
      throw Error('Add-on manager entry not available: '+viewer.document.querySelector('browser')?.contentDocument?.documentURI);
    }finally {viewer.close();}
  });
  await check('native-preferences-key-status', async()=> {
    const pane=Zotero.PreferencePanes.pluginPanes.find(p=>p.pluginID==='literature-library@local.zotero');
    const prefs=Zotero.Utilities.Internal.openPreferences(pane.id);
    try {
      for(let i=0;i<100;i++) {
        for(const win of Services.wm.getEnumerator(null)) {
          const node=win.document.getElementById('ll-pref-status');
          if(node?.textContent && win.document.getElementById('ll-pref-key')?.type==='password')
            return {passwordField:true,status:node.textContent};
        }
        await new Promise(r=>Zotero.getMainWindow().setTimeout(r,100));
      }throw Error('Native preferences key status was not initialized');
    }finally {prefs?.close?.();}
  });
  await IOUtils.writeJSON(PathUtils.join(Services.dirsvc.get('ProfD', Ci.nsIFile).path, 'console.json'),
    Services.console.getMessageArray().map(m=>m.message||String(m)).filter(m=>/literature|inference|worker|onnx/i.test(m)));
  await IOUtils.writeJSON(path, { complete: false, version: Zotero.version, results });
  if (await IOUtils.exists(PathUtils.join(Services.dirsvc.get('ProfD', Ci.nsIFile).path, 'run-word-test'))) {
    const root=await Zotero.Plugins.getRootURI('literature-library@local.zotero');
    Services.scriptloader.loadSubScript(root+'content/word-harness.js', { Zotero, Services, PathUtils, IOUtils, Ci });
  }
  for (const model of ['e5', 'qwen']) await check('local-embedding-' + model, async () => {
    const timer=Zotero.getMainWindow().setInterval(async()=> {
      await IOUtils.writeJSON(PathUtils.join(Services.dirsvc.get('ProfD', Ci.nsIFile).path, 'model-progress.json'),
        { state: lib.inference.state, frames: [...Zotero.getMainWindow().document.querySelectorAll('iframe')].map(f=>({src:f.src, ready:f.contentDocument?.readyState, hostReady:f.contentWindow?.__literatureReady, worker:typeof f.contentWindow?.Worker, text:f.contentDocument?.documentElement?.outerHTML?.slice(-800)})),
          console: Services.console.getMessageArray().map(m=>m.message||String(m)).filter(m=>/inference|worker|onnx|transformer/i.test(m)) });
    },5000);
    try {
    const vectors = await lib.inference.embed(model, ['中文文献检索。 Scientific literature retrieval.'], false, 'modelscope');
    if (!vectors[0]?.length || !vectors[0].every(Number.isFinite)) throw Error('Invalid vectors');
    return { dimensions: vectors[0].length, norm: Math.sqrt(vectors[0].reduce((s,v)=>s+v*v,0)) };
    } finally { Zotero.getMainWindow().clearInterval(timer); }
  });
  await check('qwen-vector-index-and-search',async()=> {
    await lib.saveSettings({model:'qwen',modelSource:'huggingface',embeddingsEnabled:true});
    const doc=(await lib.list()).find(d=>!d.attachmentKey);
    const item=await lib.resolve(doc.libraryID,doc.itemKey);
    const [queued]=await lib.enqueueItem(item);
    for(let i=0;i<150;i++) {
      await lib.tick();
      const job=(await lib.store.jobs()).find(j=>j.id===queued.job_id);
      if(job?.state==='done'||job?.state==='skipped')break;
      if(job?.error)throw Error(JSON.stringify(job.error));
      await new Promise(r=>Zotero.getMainWindow().setTimeout(r,100));
    }
    const saved=await lib.store.document(doc.id);
    if(saved.chunks[0]?.vector?.length!==1024)throw Error('Qwen vectors not stored');
    const result=await lib.search({query:'hierarchical scientific literature',layer:'abstract',mode:'semantic'});
    if(!result.results.length)throw Error('Semantic query returned no results');
    return {dimensions:saved.chunks[0].vector.length,hits:result.results.length};
  });
  await check('modelscope-cache-persistence', async () => {
    for (const repo of ['Xenova/multilingual-e5-small', 'onnx-community/Qwen3-Embedding-0.6B-ONNX']) {
      const hash = await lib.hashText(`https://www.modelscope.cn/models/${repo}/resolve/master/onnx/model_quantized.onnx`);
      if (!await IOUtils.exists(PathUtils.join(lib.root, 'models', hash))) throw Error('ModelScope weight cache missing: ' + repo);
    }
    lib.inference.close();
    const vectors = await lib.inference.embed('e5', ['缓存重载测试。'], false, 'modelscope');
    if (vectors[0]?.length !== 384) throw Error('Cached model failed to reload');
    return { qwenPersisted: true, e5Persisted: true, e5Reloaded: true };
  });
  await check('automatic-item-notification',async()=> {
    await lib.saveSettings({autoIndex:true,embeddingsEnabled:false});
    try {
      const item=new Zotero.Item('journalArticle');item.setField('title','Fixture automatic ingestion');
      item.setField('abstractNote','Automatically indexed abstract.');await item.saveTx();
      for(let i=0;i<150;i++) {
        if((await lib.list()).some(d=>d.itemKey===item.key&&d.state==='ready'))return {notifier:true};
        await new Promise(r=>Zotero.getMainWindow().setTimeout(r,100));
      }throw Error('Automatic notifier did not ingest new item');
    }finally {await lib.saveSettings({autoIndex:false});}
  });
  await IOUtils.writeJSON(path, { complete: true, version: Zotero.version, pluginVersion: Zotero.LiteratureLibrary.version, results });
})().catch(async e => {
  await IOUtils.writeJSON(PathUtils.join(Services.dirsvc.get('ProfD', Ci.nsIFile).path, 'integration-fatal.json'), { error: String(e.stack || e) });
});
