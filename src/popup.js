/**
 * popup.js — Toggle UI & State Management
 *
 */

const toggle    = document.getElementById('darkToggle');
const card      = document.getElementById('mainCard');
const statusEl  = document.getElementById('statusText');
const versionEl = document.getElementById('versionTag');
const scopeNote = document.getElementById('scopeNote');
const rateLink  = document.getElementById('rateLink');

versionEl.textContent = `v${chrome.runtime.getManifest().version}`;

// ─── Rating prompt ────────────────────────────────────────────────────────
// The extension id is read at runtime rather than pasted in. The published id
// already appears in README.md, and a second copy here would be one more
// thing to get wrong — and it would be wrong silently, sending people to a
// listing that is not this one.
//
// Hidden by default in the markup and only revealed once there is a real id
// to link to, so an unpacked build or a stubbed environment shows nothing
// rather than a link to /detail/undefined/reviews.
if (chrome.runtime.id) {
  rateLink.href = `https://chromewebstore.google.com/detail/${chrome.runtime.id}/reviews`;
  rateLink.hidden = false;
}

function updateUI(enabled) {
  toggle.checked = enabled;
  card.classList.toggle('active', enabled);
  statusEl.textContent = enabled ? 'ACTIVE — BLACKBOARD TABS' : 'INACTIVE';
}

chrome.storage.local.get('darkModeEnabled', (result) => {
  if (chrome.runtime.lastError) {
    // Reading the preference is the only thing that can fail here, and the
    // default is the same one content.js applies, so the popup stays honest
    // about what the page is actually doing rather than showing a blank card.
    updateUI(true);
    return;
  }
  const enabled = result.darkModeEnabled !== false;
  updateUI(enabled);
});

// ─── Is the tab you are looking at one this extension themes? ─────────────
// Opened anywhere else the popup used to show a live-looking switch and
// nothing visible would happen, which reads as a broken extension rather
// than one that is scoped.
//
// The switch stays enabled regardless. The preference is global and the
// service worker broadcasts it to every Blackboard tab, so flipping it from
// an unrelated tab is a real action with a real effect — it just is not one
// you can see from here. What was missing is the sentence saying so.
//
// The match patterns are read back out of the manifest rather than spelled
// again. They already appear there twice and in background.js as BB_ORIGINS,
// and a fourth copy is one more place to forget when the host list grows to
// other universities. chrome.tabs.query takes match patterns directly, so
// there is no pattern parsing here either.
function checkScope() {
  const scripts = chrome.runtime.getManifest().content_scripts;
  const patterns = scripts && scripts[0] && scripts[0].matches;

  // No tabs API or no patterns means no answer, and no answer must not look
  // like a warning — the note stays hidden as it is in the markup.
  if (!chrome.tabs || !patterns || !patterns.length) return;

  chrome.tabs.query({ active: true, currentWindow: true, url: patterns }, (tabs) => {
    if (chrome.runtime.lastError) return;
    scopeNote.hidden = tabs.length > 0;
  });
}

checkScope();

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
