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

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== 'BB_DARK_MODE_TOGGLE') return;

  const { enabled } = message;

  // ─── Broadcast to all matching tabs ────────────────────────────────────
  chrome.tabs.query({ url: BB_ORIGINS }, (tabs) => {
    for (const tab of tabs) {
      chrome.tabs.sendMessage(tab.id, message).catch(() => {
        // Tab may not have the content script yet (e.g., still loading) — safe to ignore
      });
    }
  });

  // ─── Update the action badge ────────────────────────────────────────────
  chrome.action.setBadgeText({ text: enabled ? 'ON' : '' });
  chrome.action.setBadgeBackgroundColor({ color: enabled ? '#5c7cfa' : '#666' });

  sendResponse({ ok: true });
});

// ─── On install: set default storage value ─────────────────────────────────
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get('darkModeEnabled', (result) => {
    if (result.darkModeEnabled === undefined) {
      chrome.storage.local.set({ darkModeEnabled: true });
    }
  });
});
