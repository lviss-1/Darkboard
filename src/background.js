/**
 * background.js — Service Worker
 *
 * Responsibilities:
 *   1. Relay toggle messages from popup.js to ALL open Blackboard tabs
 *      (including tabs the popup can't directly reach).
 *   2. Set the toolbar icon badge so users can see dark mode status at a glance.
 *   3. Keep one runtime content-script registration in step with the schools
 *      the user has enabled from the popup.
 */

// ─── Shared helper: read storage and repaint badge ─────────────────────────
// Extracted so it can be called on install, browser startup, AND service worker
// restart — MV3 workers are terminated after ~30s of inactivity, which wipes
// any in-memory badge state. Calling this at the top level ensures the badge
// is correct every time the script is evaluated, regardless of what triggered
// the restart.
function restoreBadge() {
  chrome.storage.local.get('darkModeEnabled', (result) => {
    const enabled = result.darkModeEnabled !== false;
    chrome.action.setBadgeText({ text: enabled ? 'ON' : '' });
    chrome.action.setBadgeBackgroundColor({ color: enabled ? '#6f2c3e' : '#666' });
  });
}

// ─── Schools enabled at runtime ───────────────────────────────────────────
// Iona is in the manifest. Every other school is an optional host permission
// the user granted from the popup, and the granted permissions are the only
// record of which schools those are: there is no list in storage to drift out
// of step with them. Chrome can change them without the popup (the site-access
// controls on chrome://extensions add and remove origins too), so the
// registration is rebuilt from them whenever they change and whenever this
// worker starts.
//
// The registration reuses the manifest's own content_scripts entry, so a
// school added here gets exactly what Iona gets: the same files, at
// document_start, in every frame.
const SITE_SCRIPT_ID = 'darkboard-sites';
const SITE_PATTERN = /^https:\/\/([^/*:]+)\/\*$/;

const manifestScript = () => chrome.runtime.getManifest().content_scripts[0];

function staticMatches() {
  return chrome.runtime.getManifest().content_scripts.flatMap((script) => script.matches);
}

// content.js throws if it is evaluated twice in one frame, so a granted origin
// the manifest already injects must never be registered again. Matched on
// hosts rather than by string equality because a wildcard static pattern
// covers hosts that are spelled differently: https://x.blackboardcdn.com/*
// is not the string https://*.blackboardcdn.com/* but is the same frames.
function coveredByManifest(hostname) {
  return staticMatches().some((pattern) => {
    const host = /^https:\/\/([^/]+)\//.exec(pattern)?.[1];
    if (!host) return false;
    if (host.startsWith('*.')) {
      const domain = host.slice(2);
      return hostname === domain || hostname.endsWith('.' + domain);
    }
    return hostname === host;
  });
}

function sitePatternsFrom(origins) {
  return origins.filter((origin) => {
    const host = SITE_PATTERN.exec(origin)?.[1];
    return Boolean(host) && !coveredByManifest(host);
  });
}

async function grantedSitePatterns() {
  const { origins = [] } = await chrome.permissions.getAll();
  return sitePatternsFrom(origins);
}

async function writeSiteRegistration() {
  const matches = await grantedSitePatterns();
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [SITE_SCRIPT_ID] });

  if (matches.length === 0) {
    if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: [SITE_SCRIPT_ID] });
    return;
  }

  const base = manifestScript();
  const script = {
    id: SITE_SCRIPT_ID,
    matches,
    js: base.js,
    css: base.css,
    runAt: base.run_at,
    allFrames: base.all_frames,
    persistAcrossSessions: true,
  };

  if (existing.length) {
    await chrome.scripting.updateContentScripts([script]);
  } else {
    await chrome.scripting.registerContentScripts([script]);
  }
}

// Worker start, a grant and a revoke can all land together, and two
// overlapping registers of the same id fail with a duplicate-id error. Each
// sync waits for the previous one.
let siteSync = Promise.resolve();

function syncSiteScripts() {
  siteSync = siteSync
    .then(writeSiteRegistration)
    .catch((error) => console.error('DarkBoard: could not update site registration', error));
  return siteSync;
}

// A registration only applies from the next navigation, so a school enabled
// with its tab already open would stay light until the user reloaded.
// Injecting into the open tabs instead of reloading them means an unsaved
// discussion post or half-written submission in another tab of that school
// survives being enabled. Nothing is injected there yet, because the origin
// was not covered a moment ago, so this is not a second evaluation.
async function injectIntoOpenTabs(patterns) {
  if (patterns.length === 0) return;
  const base = manifestScript();
  const tabs = await chrome.tabs.query({ url: patterns });

  for (const tab of tabs) {
    const target = { tabId: tab.id, allFrames: base.all_frames };
    try {
      await chrome.scripting.insertCSS({ target, files: base.css });
      await chrome.scripting.executeScript({ target, files: base.js });
    } catch (error) {
      // A tab that is mid-navigation or showing an error page refuses
      // injection. The registration covers its next load.
      console.warn('DarkBoard: could not inject into tab', tab.id, error);
    }
  }
}

async function siteMatches() {
  return staticMatches().concat(await grantedSitePatterns());
}

restoreBadge();
syncSiteScripts();

chrome.runtime.onStartup.addListener(restoreBadge);

chrome.permissions.onAdded.addListener(async ({ origins = [] }) => {
  await syncSiteScripts();
  await injectIntoOpenTabs(sitePatternsFrom(origins));
});

// Pages already themed stay themed until they reload; the popup says so.
chrome.permissions.onRemoved.addListener(() => {
  syncSiteScripts();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== 'BB_DARK_MODE_TOGGLE') return;

  const { enabled } = message;

  siteMatches()
    .then((patterns) => chrome.tabs.query({ url: patterns }))
    .then((tabs) => {
      for (const tab of tabs) {
        // Rejects for a tab with no content script yet (still loading, or a
        // school enabled after it opened that refused injection).
        chrome.tabs.sendMessage(tab.id, message).catch(() => {});
      }
    })
    .catch((error) => console.error('DarkBoard: could not relay the toggle', error));

  chrome.action.setBadgeText({ text: enabled ? 'ON' : '' });
  chrome.action.setBadgeBackgroundColor({ color: enabled ? '#6f2c3e' : '#666' });

  sendResponse({ ok: true });
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get('darkModeEnabled', (result) => {
    if (result.darkModeEnabled === undefined) {
      chrome.storage.local.set({ darkModeEnabled: true });
    }
  });
  restoreBadge();
});
