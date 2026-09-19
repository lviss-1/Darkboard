/**
 * content.js — Blackboard Ultra Dark Mode
 *
 * Runs at document_start (before any HTML is painted) to prevent FOUC.
 *
 * Flow:
 *   1. Read storage for the saved preference and stamp [data-bb-dark] onto
 *      <html> as soon as it resolves.
 *   2. Start the DOM-mutating enhancements only when dark mode is actually on.
 *   3. Listen for toggle messages from the popup (cross-tab sync).
 *   4. Observe <html> attribute changes to keep the toggle in sync
 *      if another script removes our attribute.
 */

const ATTR = 'data-bb-dark';

// Stamped on every element whose background we override inline, so the
// override can be found and undone when dark mode is switched off.
const MARK = 'data-darkboard-bg';

// Kept in sync by init() and the message listener so the observers can
// read it synchronously without an async storage round-trip.
let _darkEnabled = false;

let streamObserver = null;
let gradeObserver = null;

function setDarkMode(enabled) {
  if (enabled) {
    document.documentElement.setAttribute(ATTR, '');
  } else {
    document.documentElement.removeAttribute(ATTR);
  }
}

function whenDomReady(fn) {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', fn, { once: true });
  } else {
    fn();
  }
}

// ─── Step 1: Read saved preference and apply IMMEDIATELY ──────────────────
// chrome.storage.local.get is async, but because our CSS file is already
// injected by the manifest at document_start, the styles are ready the
// moment the attribute lands on <html>. The storage read is fast enough
// (~1–3ms) that users never see a flash.
function init() {
  // Unified API — works in Chrome, Edge, and Firefox (with webextension-polyfill)
  const storage = (typeof browser !== 'undefined') ? browser.storage : chrome.storage;

  storage.local.get('darkModeEnabled', (result) => {
    // Default to TRUE on first install — users expect dark mode to just work
    const enabled = result.darkModeEnabled !== false;
    _darkEnabled = enabled;
    setDarkMode(enabled);

    // The storage read can resolve either side of DOMContentLoaded, so the
    // enhancements are deferred rather than assuming <body> exists yet.
    if (enabled) whenDomReady(startEnhancements);
  });
}

const runtime = (typeof browser !== 'undefined') ? browser.runtime : chrome.runtime;

runtime.onMessage.addListener((message) => {
  if (message.type !== 'BB_DARK_MODE_TOGGLE') return;

  _darkEnabled = message.enabled;

  if (message.enabled) {
    setDarkMode(true);
    whenDomReady(startEnhancements);
  } else {
    // Order matters: our inline overrides carry !important and are NOT gated
    // by [data-bb-dark], so they must be undone before the gate is dropped.
    // Reversing these two lines leaves a frame of black rows on a light page.
    stopEnhancements();
    setDarkMode(false);
  }
});

// ─── Step 3: Guard against Blackboard's own JS removing our attribute ─────
// Blackboard's SPA sometimes re-renders <html>. A MutationObserver acts like
// a security guard — if our attribute gets removed, it puts it right back.
// We read _darkEnabled synchronously instead of doing an async storage lookup,
// which avoids a race condition where the user could toggle off between the
// observer firing and the callback completing.
function watchForAttributeStrip() {
  const observer = new MutationObserver(() => {
    if (_darkEnabled && !document.documentElement.hasAttribute(ATTR)) {
      setDarkMode(true);
    }
  });

  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: [ATTR],
  });
}

// ─── Stream Row Background Killer ─────────────────────────────────────────
// The activity stream expanded row gets a light background that survives
// both CSS overrides and MutationObserver style watching. This is because
// Blackboard applies it via a high-specificity class added to the host
// element, not an inline style.
//
// Solution: a MutationObserver that fires whenever Blackboard mutates class
// or style attributes. Only re-runs enforceStreamDark() when the DOM actually
// changes — zero CPU cost at idle. Debounced with requestAnimationFrame so
// rapid SPA re-renders collapse into a single pass per animation frame.

const DARK_BG = '#0a0a0c';
// A color is "light" if the sum of its RGB channels exceeds this value
// and it isn't a near-black shade.
const LIGHT_THRESHOLD = 180;

const STREAM_OBSERVER_CONFIG = {
  childList: true,
  subtree: true,
  attributes: true,
  attributeFilter: ['class', 'style'],
};

function enforceStreamDark() {
  if (!_darkEnabled || !document.body) return;

  const SELECTORS = [
    'li.stream-item-container',
    'li[class*="stream-item"]',
    'div.stream-item',
    'div[class*="stream-item"]',
    'div.activity-group',
    'ul.activity-group',
    '[class*="activity-group"]',
    '[class*="previousStreamEntries"]',
    '[class*="streamEntries"]',
    '.main-column',
    '[class*="base-recent-activity"]',
    '[class*="activity-stream"]',
    'bb-activity-stream',
    'bb-stream',
    '.activity-group > li',
    '.activity-stream > li',
    '[class*="notification"]',
    '[class*="Notification"]'
  ];

  const candidates = document.body.querySelectorAll(SELECTORS.join(','));
  for (const el of candidates) {
    const computed = window.getComputedStyle(el);
    const bgColor = computed.backgroundColor;
    const bgImage = computed.backgroundImage;

    const m = bgColor.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (m) {
      const [r, g, b] = [+m[1], +m[2], +m[3]];

      const isLight = r > 40 && g > 40 && b > 40 && (r + g + b) > LIGHT_THRESHOLD;
      const hasGradient = bgImage && bgImage !== 'none' && bgImage.includes('gradient');

      if (isLight || hasGradient) {
        el.style.setProperty('background', DARK_BG, 'important');
        el.style.setProperty('background-image', 'none', 'important');
        el.style.setProperty('background-color', DARK_BG, 'important');
        el.setAttribute(MARK, '');
      }
    }
  }
}

// Undoes every inline override enforceStreamDark() applied. Querying the DOM
// for the marker (rather than holding a Set of elements) avoids retaining
// nodes that Blackboard's SPA has already detached.
function revertStreamDark() {
  for (const el of document.querySelectorAll('[' + MARK + ']')) {
    el.style.removeProperty('background');
    el.style.removeProperty('background-image');
    el.style.removeProperty('background-color');
    el.removeAttribute(MARK);
  }
}

// enforceStreamDark() writes to the style attribute, which is exactly what
// streamObserver watches — so each pass would schedule a redundant follow-up.
// Detaching for the duration of the write loop breaks that cycle.
function runStreamPass() {
  if (!streamObserver) {
    enforceStreamDark();
    return;
  }

  streamObserver.disconnect();
  enforceStreamDark();
  streamObserver.observe(document.body, STREAM_OBSERVER_CONFIG);
}

function startEnhancements() {
  if (streamObserver || !document.body) return;

  let streamRafPending = false;
  streamObserver = new MutationObserver(() => {
    if (streamRafPending) return;
    streamRafPending = true;
    requestAnimationFrame(() => {
      streamRafPending = false;
      runStreamPass();
    });
  });

  // Also starts the observation, via the reconnect at the end of the pass.
  runStreamPass();

  // characterData: true catches Angular silently rewriting text in table cells.
  // Debounced with rAF: colorizeAllGrades queries all span/div/td elements which
  // can number in the thousands on a Blackboard page. Without debouncing, rapid
  // DOM mutations (keystrokes, React reconciles) trigger back-to-back full-DOM
  // scans. rAF collapses them into at most one scan per animation frame.
  let gradeRafPending = false;
  gradeObserver = new MutationObserver(() => {
    if (gradeRafPending) return;
    gradeRafPending = true;
    requestAnimationFrame(() => {
      gradeRafPending = false;
      colorizeAllGrades();
    });
  });

  colorizeAllGrades();
  gradeObserver.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
  });
}

function stopEnhancements() {
  if (streamObserver) {
    streamObserver.disconnect();
    streamObserver = null;
  }
  if (gradeObserver) {
    gradeObserver.disconnect();
    gradeObserver = null;
  }

  revertStreamDark();
}

// CSS cannot do arithmetic, so we use JS to read grade strings, calculate
// the percentage, and stamp a data attribute that CSS rules can target.
function colorizeAllGrades() {
  if (!_darkEnabled) return;

  const elements = Array.from(document.querySelectorAll('span, div, td')).reverse();

  elements.forEach(el => {
    if (el.querySelector('.darkboard-pill')) return;

    // Squash hidden newlines and tabs into single spaces for the regex
    const text = el.textContent.replace(/\s+/g, ' ').trim();

    // Ignore dates (they have two slashes)
    if ((text.match(/\//g) || []).length > 1) return;

    // Skip long strings — grade values are short ("Score: 95 / 100" = 15 chars max);
    // anything over 25 chars is almost certainly a title or description, not a score.
    if (text.length > 25) return;

    // Skip if text contains scheduling/calendar keywords — these signal a date
    // embedded in an assignment title (e.g. "due by Fri 12/5", "BY FRIDAY 12/5").
    if (/\b(due|sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tue|wed|thu|fri|sat)\b/i.test(text)) return;

    // Skip date/time patterns like "12/5 @ 11:59"
    if (text.includes('@')) return;

    // Skip elements inside headings (announcement and discussion titles)
    if (el.closest('h1, h2, h3, h4, h5, h6')) return;

    const fractional = text.match(/(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/);
    const percentage = text.match(/(\d+(?:\.\d+)?)%/);

    let pct = null;
    if (fractional) {
      const earned = parseFloat(fractional[1]);
      const total  = parseFloat(fractional[2]);
      if (total > 0) pct = (earned / total) * 100;
    } else if (percentage) {
      pct = parseFloat(percentage[1]);
    }

    if (pct !== null) {
      const status = pct >= 90 ? 'good' : pct >= 80 ? 'fair' : pct >= 70 ? 'average' : 'poor';
      el.dataset.gradeStatus = status;
      el.classList.add('darkboard-pill');
    }
  });
}

init();

whenDomReady(watchForAttributeStrip);
