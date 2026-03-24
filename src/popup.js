/**
 * popup.js — Toggle UI & State Management
 *
 */

const toggle   = document.getElementById('darkToggle');
const card     = document.getElementById('mainCard');
const statusEl = document.getElementById('statusText');

// ─── Normalise browser API (Firefox uses `browser`, Chrome uses `chrome`) ──
const ext = (typeof browser !== 'undefined') ? browser : chrome;

// ─── Reflect state onto the popup UI ────────────────────────────────────────
function updateUI(enabled) {
  toggle.checked = enabled;
  card.classList.toggle('active', enabled);
  statusEl.textContent = enabled ? 'ACTIVE — ALL TABS' : 'INACTIVE';
}

// ─── Read current state from storage and render ──────────────────────────────
ext.storage.local.get('darkModeEnabled', (result) => {
  const enabled = result.darkModeEnabled !== false; // default: true
  updateUI(enabled);
});

// ─── Handle toggle interaction ───────────────────────────────────────────────
toggle.addEventListener('change', () => {
  const enabled = toggle.checked;

  // 1. Persist the new preference
  ext.storage.local.set({ darkModeEnabled: enabled });

  // 2. Update popup UI immediately (no waiting for round-trip)
  updateUI(enabled);

  // 3. Tell background.js to broadcast to all open Blackboard tabs
  ext.runtime.sendMessage({
    type: 'BB_DARK_MODE_TOGGLE',
    enabled,
  }).catch(() => {
    // Background may not be awake yet on first click — safe to ignore.
    // content.js also reads storage directly, so state will sync on next load.
  });
});
