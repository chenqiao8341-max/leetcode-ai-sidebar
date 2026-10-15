async function initialize() {
  await chrome.storage.local.setAccessLevel({accessLevel: 'TRUSTED_CONTEXTS'});
  await chrome.storage.session.setAccessLevel({accessLevel: 'TRUSTED_CONTEXTS'});
  await chrome.sidePanel.setPanelBehavior({openPanelOnActionClick: true});
}
initialize().catch(console.error);
chrome.runtime.onInstalled.addListener(() => initialize().catch(console.error));
chrome.runtime.onStartup.addListener(() => initialize().catch(console.error));
