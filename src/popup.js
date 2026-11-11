/**
 * popup.js — Toggle UI & State Management
 *
 */

const toggle    = document.getElementById('darkToggle');
const card      = document.getElementById('mainCard');
const statusEl  = document.getElementById('statusText');
const versionEl = document.getElementById('versionTag');
const scopeNote = document.getElementById('scopeNote');

versionEl.textContent = `v${chrome.runtime.getManifest().version}`;

// The rating prompt is a plain static link in popup.html now. It used to be
// built here from chrome.runtime.id, on the reasoning that a pasted id is one
// more thing to get wrong — which was true, and still sent people nowhere.
// chrome.runtime.id is the published id only when the extension was installed
// FROM the store; an unpacked build gets a locally generated one, so the link
// pointed at a listing that does not exist on every development install. The
// store slug cannot be read at runtime at any rate, so there is nothing left
// for script to contribute.

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
// Four answers:
//   static     — the manifest covers it (Iona).
//   granted    — another school the user enabled; shown as beta.
//   candidate  — looks like Blackboard and is not covered; offer to enable.
//   other      — anything else; the scope note.
//
// The static patterns are read back out of the manifest rather than spelled
// again, and chrome.tabs.query matches them, so there is no pattern parsing
// here. Granted schools are asked of chrome.permissions, which is what the
// service worker builds its registration from, so the two cannot disagree.
const sitePanel  = document.getElementById('sitePanel');
const siteTitle  = document.getElementById('siteTitle');
const siteDetail = document.getElementById('siteDetail');
const siteAction = document.getElementById('siteAction');
const siteReport = document.getElementById('siteReport');
const scopeInfo  = document.getElementById('scopeInfo');

// Ultra serves every page under /ultra (checked on Iona's course outline).
// /webapps/ is Learn's older path space: Original course view and the classic
// login page. A false positive costs one button the user ignores; Chrome's
// own prompt still names the site before anything is granted.
const BLACKBOARD_PATH = /^\/(ultra|webapps)(\/|$)/;

const sitePatternFor = (url) => `https://${url.hostname}/*`;

async function activeTabUrl() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url) return null;
  try {
    return new URL(tab.url);
  } catch (e) {
    return null;
  }
}

async function coveredByManifest() {
  const scripts = chrome.runtime.getManifest().content_scripts;
  const patterns = scripts && scripts[0] && scripts[0].matches;
  if (!patterns || !patterns.length) return false;
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true, url: patterns });
  return tabs.length > 0;
}

async function resolveSite() {
  const url = await activeTabUrl();
  if (!url) return { kind: 'other' };
  if (await coveredByManifest()) return { kind: 'static', url };
  if (url.protocol !== 'https:') return { kind: 'other' };
  if (await chrome.permissions.contains({ origins: [sitePatternFor(url)] })) return { kind: 'granted', url };
  if (BLACKBOARD_PATH.test(url.pathname)) return { kind: 'candidate', url };
  return { kind: 'other' };
}

function setPills(labels) {
  scopeInfo.replaceChildren(...labels.map((label) => {
    const pill = document.createElement('div');
    pill.className = 'scope-pill';
    pill.textContent = label;
    return pill;
  }));
  scopeInfo.hidden = labels.length === 0;
}

function showPanel({ title, detail, action = null, report = false }) {
  sitePanel.hidden = false;
  siteTitle.textContent = title;
  siteDetail.textContent = detail;
  siteAction.hidden = !action;
  siteAction.disabled = false;
  if (action) {
    siteAction.textContent = action.label;
    siteAction.className = 'site-action' + (action.secondary ? ' secondary' : '');
    siteAction.onclick = action.run;
  }
  siteReport.hidden = !report;
}

function renderSite(site, notice) {
  scopeNote.hidden = site.kind !== 'other';
  sitePanel.hidden = true;
  setPills([]);

  if (site.kind === 'static') {
    setPills([site.url.hostname, 'Embedded frames']);
    return;
  }

  if (site.kind === 'granted') {
    setPills([site.url.hostname, 'Beta']);
    showPanel({
      title: 'Your school is in beta',
      detail: notice || 'DarkBoard is built and tested on Iona’s Blackboard. If a page here is hard to read, report it.',
      action: { label: 'REMOVE THIS SCHOOL', secondary: true, run: () => removeSite(site) },
      report: true,
    });
    return;
  }

  if (site.kind === 'candidate') {
    showPanel({
      title: `${site.url.hostname} looks like Blackboard`,
      detail: notice || 'Turn DarkBoard on for this school (beta). Chrome will ask to allow this one site.',
      action: { label: 'ENABLE ON THIS SCHOOL', run: () => enableSite(site) },
    });
  }
}

// permissions.request has to run inside the click, which is why this is not
// routed through the service worker. Chrome may close the popup while its
// prompt is open, and the rest of this function never runs; that is fine,
// because the worker hears the grant through permissions.onAdded and does the
// registering and injecting itself.
async function enableSite(site) {
  siteAction.disabled = true;
  let granted = false;
  try {
    granted = await chrome.permissions.request({ origins: [sitePatternFor(site.url)] });
  } catch (e) {
    granted = false;
  }

  if (granted) {
    renderSite({ kind: 'granted', url: site.url }, 'Turned on in this tab. Something hard to read? Report it.');
  } else {
    renderSite(site, 'Chrome didn’t allow access, so nothing changed.');
  }
}

async function removeSite(site) {
  siteAction.disabled = true;
  let removed = false;
  try {
    removed = await chrome.permissions.remove({ origins: [sitePatternFor(site.url)] });
  } catch (e) {
    removed = false;
  }

  if (!removed) {
    renderSite(site, 'Chrome couldn’t remove access. Try again from chrome://extensions.');
    return;
  }

  setPills([]);
  showPanel({
    title: `Removed ${site.url.hostname}`,
    detail: 'Reload this tab to switch DarkBoard off here.',
  });
}

// No answer must not look like a warning: the note and panel stay hidden as
// they are in the markup.
resolveSite().then(renderSite).catch(() => {});

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
