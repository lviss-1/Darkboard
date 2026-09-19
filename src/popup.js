/**
 * popup.js — Toggle UI & State Management
 *
 */

const toggle    = document.getElementById('darkToggle');
const card      = document.getElementById('mainCard');
const statusEl  = document.getElementById('statusText');
const versionEl = document.getElementById('versionTag');

versionEl.textContent = `v${chrome.runtime.getManifest().version}`;

function updateUI(enabled) {
  toggle.checked = enabled;
  card.classList.toggle('active', enabled);
  statusEl.textContent = enabled ? 'ACTIVE — BLACKBOARD TABS' : 'INACTIVE';
}

chrome.storage.local.get('darkModeEnabled', (result) => {
  const enabled = result.darkModeEnabled !== false;
  updateUI(enabled);
});

toggle.addEventListener('change', () => {
  const enabled = toggle.checked;

  chrome.storage.local.set({ darkModeEnabled: enabled });

  updateUI(enabled);

  chrome.runtime.sendMessage({
    type: 'BB_DARK_MODE_TOGGLE',
    enabled,
  }).catch(() => {
    // Rejects only when nothing is listening. MV3 wakes the service worker to
    // deliver a message, so this is not a cold-start race. Storage is already
    // written above and content.js reads it on load, so the preference survives
    // even when the broadcast finds no receiver.
  });
});
