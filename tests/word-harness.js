// Called only by the isolated test harness, against a self-created Word fixture.
(async()=>{
  const lib=Zotero.LiteratureLibrary.library;
  const resultPath=PathUtils.join(Services.dirsvc.get('ProfD',Ci.nsIFile).path,'word-report.json');
  const bridge=lib.citations, original=bridge.original;
  let doc;
  try {
    const app=Zotero.Integration.getApplication('WinWord','addEditCitation');
    doc=await app.getActiveDocument();
    const data=new Zotero.Integration.DocumentData();
    const styles=await lib.styles();
    const style=styles.find(s=>s.id.endsWith('/apa'))||styles[0];
    data.sessionID=Zotero.Utilities.randomString();
    data.style={styleID:style.id,locale:'en-US',hasBibliography:true,bibliographyStyleHasBeenSet:false};
    data.prefs={fieldType:'Field',noteType:0,automaticJournalAbbreviations:false,delayCitationUpdates:false};
    await doc.setDocumentData(data.serialize());
    const documents=await lib.list();
    await bridge.prepare({document_ids:[documents.find(d=>!d.attachmentKey).id]});
    bridge.original=function(url,options,io,type){
      if(type!=='citation') throw Error('Unexpected integration dialog: '+type);
      io.accept(()=>{}); return Promise.resolve();
    };
    await Zotero.Integration.execCommand('WinWord','addEditCitation',null,1);
    const fields=await doc.getFields('Field');
    const codes=[]; for(const field of fields) codes.push(await field.getCode());
    if(!codes.some(code=>code.includes('CSL_CITATION')))throw Error('No CSL citation field created');
    await Zotero.Integration.execCommand('WinWord','refresh',null,1);
    const after=await doc.getFields('Field');
    const afterCodes=[]; for(const field of after)afterCodes.push(await field.getCode());
    if(!afterCodes.some(code=>code.includes('CSL_CITATION')))throw Error('Refresh lost fields');
    await IOUtils.writeJSON(resultPath,{ok:true,fieldCount:afterCodes.length,nativeRefresh:true,handoff:bridge.status()});
  } catch(e) {
    await IOUtils.writeJSON(resultPath,{ok:false,error:String(e)+' '+String(e.stack||'')});
  } finally { bridge.original=original; }
})();
