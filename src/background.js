/**
 * background.js — Service Worker
 *
 * Responsibilities:
 *   1. Relay toggle messages from popup.js to ALL open Blackboard tabs
 *      (including tabs the popup can't directly reach).
 *   2. Set the toolbar icon badge so users can see dark mode status at a glance.
 *
 */

const BB_ORIGINS = ['https://online.iona.edu/*', 'https://*.blackboardcdn.com/*'];

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
    chrome.action.setBadgeBackgroundColor({ color: enabled ? '#5c7cfa' : '#666' });
  });
}

restoreBadge();

chrome.runtime.onStartup.addListener(restoreBadge);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== 'BB_DARK_MODE_TOGGLE') return;

  const { enabled } = message;

  chrome.tabs.query({ url: BB_ORIGINS }, (tabs) => {
    for (const tab of tabs) {
      chrome.tabs.sendMessage(tab.id, message).catch(() => {
      });
    }
  });

  chrome.action.setBadgeText({ text: enabled ? 'ON' : '' });
  chrome.action.setBadgeBackgroundColor({ color: enabled ? '#5c7cfa' : '#666' });

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
