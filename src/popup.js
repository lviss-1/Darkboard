/**
 * popup.js — Toggle UI & State Management
 *
 */

const toggle    = document.getElementById('darkToggle');
const card      = document.getElementById('mainCard');
const statusEl  = document.getElementById('statusText');
const versionEl = document.getElementById('versionTag');

const ext = (typeof browser !== 'undefined') ? browser : chrome;

versionEl.textContent = `v${ext.runtime.getManifest().version}`;

function updateUI(enabled) {
  toggle.checked = enabled;
  card.classList.toggle('active', enabled);
  statusEl.textContent = enabled ? 'ACTIVE — BLACKBOARD TABS' : 'INACTIVE';
}

ext.storage.local.get('darkModeEnabled', (result) => {
  const enabled = result.darkModeEnabled !== false;
  updateUI(enabled);
});

toggle.addEventListener('change', () => {
  const enabled = toggle.checked;

  ext.storage.local.set({ darkModeEnabled: enabled });

  updateUI(enabled);

  ext.runtime.sendMessage({
    type: 'BB_DARK_MODE_TOGGLE',
    enabled,
  }).catch(() => {
    // Background may not be awake yet on first click — safe to ignore.
    // content.js also reads storage directly, so state will sync on next load.
  });
});
