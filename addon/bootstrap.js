var chromeHandle;
var scope;

async function startup({ id, version, rootURI }) {
  var aomStartup = Cc["@mozilla.org/addons/addon-manager-startup;1"]
    .getService(Ci.amIAddonManagerStartup);
  chromeHandle = aomStartup.registerChrome(Services.io.newURI(rootURI + "manifest.json"), [
    ["content", "literature-library", rootURI + "content/"]
  ]);
  scope = { Zotero, ChromeUtils, Cc, Ci, Cu, Services, IOUtils, PathUtils,
    TextEncoder, TextDecoder, URL, URLSearchParams };
  Services.scriptloader.loadSubScript(rootURI + "content/plugin.js", scope);
  await scope.LiteratureLibrary.start({ id, version, rootURI });
}

async function shutdown() {
  if (scope?.LiteratureLibrary) await scope.LiteratureLibrary.stop();
  chromeHandle?.destruct();
  chromeHandle = scope = null;
}

function install() {}
function uninstall() {}
