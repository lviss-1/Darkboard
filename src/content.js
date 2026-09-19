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

// ─── Mutation scoping ─────────────────────────────────────────────────────
// Both observers below do work proportional to what actually changed rather
// than rescanning the document. Past this many separate roots the bookkeeping
// costs more than one broad pass, so we widen to <body> instead.
const MAX_ROOTS = 50;

function collectMutationRoots(records, into) {
  for (const record of records) {
    if (record.type === 'characterData') {
      if (record.target.parentElement) into.add(record.target.parentElement);
      continue;
    }

    if (record.type === 'attributes') {
      into.add(record.target);
      continue;
    }

    for (const node of record.addedNodes) {
      if (node.nodeType === Node.ELEMENT_NODE) into.add(node);
      else if (node.parentElement) into.add(node.parentElement);
    }
  }
}

// Drops roots already covered by another root, so a subtree is walked once.
function resolveRoots(pending) {
  const live = [...pending].filter(el => el.isConnected);
  if (live.length === 0) return [];
  if (live.length > MAX_ROOTS) return [document.body];

  return live.filter(el => !live.some(other => other !== el && other.contains(el)));
}

// ─── Stream Row Background Killer ─────────────────────────────────────────
// The activity stream expanded row gets a light background that survives
// CSS overrides, because Blackboard applies it via a high-specificity class
// on the host element rather than an inline style. The only thing that beats
// it is an inline !important of our own.

const DARK_BG = '#0a0a0c';
// A color is "light" if the sum of its RGB channels exceeds this value
// and it isn't a near-black shade.
const LIGHT_THRESHOLD = 180;

const STREAM_SELECTORS = [
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
].join(',');

const STREAM_OBSERVER_CONFIG = {
  childList: true,
  subtree: true,
  attributes: true,
  attributeFilter: ['class', 'style'],
};

// CSSOM re-serializes colors, so the hex we set back reads as "rgb(10, 10, 12)".
// Resolving it through a throwaway element keeps the comparison correct without
// hardcoding a second spelling of DARK_BG that could drift from the first.
let _darkBgSerialized = null;
function darkBgSerialized() {
  if (_darkBgSerialized === null) {
    const probe = document.createElement('div');
    probe.style.backgroundColor = DARK_BG;
    _darkBgSerialized = probe.style.backgroundColor;
  }
  return _darkBgSerialized;
}

function enforceStreamDark(roots) {
  if (!_darkEnabled || !document.body) return;

  const scopes = (roots && roots.length) ? roots : [document.body];
  const alreadyDark = darkBgSerialized();

  for (const scope of scopes) {
    const candidates = [];
    if (scope.matches && scope.matches(STREAM_SELECTORS)) candidates.push(scope);
    candidates.push(...scope.querySelectorAll(STREAM_SELECTORS));

    for (const el of candidates) {
      // Cheaper than getComputedStyle, and reading the inline value rather than
      // the marker means this self-heals if Blackboard replaces the attribute.
      if (el.style.getPropertyValue('background-color') === alreadyDark) continue;

      const computed = window.getComputedStyle(el);
      const m = computed.backgroundColor.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
      if (!m) continue;

      const [r, g, b] = [+m[1], +m[2], +m[3]];
      const isLight = r > 40 && g > 40 && b > 40 && (r + g + b) > LIGHT_THRESHOLD;
      const bgImage = computed.backgroundImage;
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

// Querying for the marker rather than holding a Set of elements avoids
// retaining nodes that Blackboard's SPA has already detached.
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
function runStreamPass(roots) {
  if (!streamObserver) {
    enforceStreamDark(roots);
    return;
  }

  streamObserver.disconnect();
  enforceStreamDark(roots);
  streamObserver.observe(document.body, STREAM_OBSERVER_CONFIG);
}

// ─── Grade Colorizer ──────────────────────────────────────────────────────
// CSS cannot do arithmetic, so JS reads grade strings, calculates the
// percentage, and stamps a data attribute that CSS rules target.

// Scanning is confined to these regions. Most Blackboard pages match none of
// them and cost nothing beyond the lookup. The stream selectors are included
// so a posted grade in the activity feed still gets styled.
const GRADE_ROOTS = [
  'bb-grades-student-attempts',
  'bb-grades-student',
  'bb-grades-base',
  'bb-grades-overview',
  'bb-grades-summary',
  'bb-grade-detail',
  '[class*="grades-"]',
  '[class*="gradebook"]',
  '[class*="Gradebook"]',
  '[class*="grade-value"]',
  '[class*="GradeValue"]',
  '[data-region="gradebook"]',
  '.grader-scaffold',
  '.student-grades-wrapper',
  'bb-activity-stream',
  'li.stream-item-container',
  '[class*="stream-item"]'
].join(',');

function considerGradeText(node) {
  const el = node.parentElement;
  if (!el || el.dataset.gradeStatus) return;

  const text = node.data.replace(/\s+/g, ' ').trim();
  if (!text) return;

  // Two slashes means a date rather than a score.
  if ((text.match(/\//g) || []).length > 1) return;

  // "Score: 95 / 100" is 15 characters; past 25 this is prose, not a value.
  if (text.length > 25) return;

  // Catches a date embedded in a title, e.g. "due by Fri 12/5".
  if (/\b(due|sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tue|wed|thu|fri|sat)\b/i.test(text)) return;

  if (text.includes('@')) return;
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

  if (pct === null) return;

  el.dataset.gradeStatus = pct >= 90 ? 'good' : pct >= 80 ? 'fair' : pct >= 70 ? 'average' : 'poor';
  el.classList.add('darkboard-pill');
}

// Walking text nodes instead of elements is what makes this linear: reading
// textContent on every span/div/td re-walks each subtree once per ancestor.
// It also removes the need to guard against stamping both a parent and its
// child, since text nodes cannot contain one another.
function walkGrades(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) considerGradeText(node);
}

function scanGradesIn(root) {
  if (root.closest && root.closest(GRADE_ROOTS)) {
    walkGrades(root);
    return;
  }

  for (const region of resolveRoots(new Set(root.querySelectorAll(GRADE_ROOTS)))) {
    walkGrades(region);
  }
}

function scanGrades(roots) {
  if (!_darkEnabled || !document.body) return;

  for (const root of (roots && roots.length) ? roots : [document.body]) {
    scanGradesIn(root);
  }
}

function startEnhancements() {
  if (streamObserver || !document.body) return;

  const streamPending = new Set();
  let streamRafPending = false;
  streamObserver = new MutationObserver((records) => {
    collectMutationRoots(records, streamPending);
    if (streamRafPending) return;
    streamRafPending = true;
    requestAnimationFrame(() => {
      streamRafPending = false;
      const roots = resolveRoots(streamPending);
      streamPending.clear();
      if (roots.length) runStreamPass(roots);
    });
  });

  // Also starts the observation, via the reconnect at the end of the pass.
  runStreamPass(null);

  // characterData catches Angular rewriting text in place, which happens in
  // table cells without any element being added or removed.
  const gradePending = new Set();
  let gradeRafPending = false;
  gradeObserver = new MutationObserver((records) => {
    collectMutationRoots(records, gradePending);
    if (gradeRafPending) return;
    gradeRafPending = true;
    requestAnimationFrame(() => {
      gradeRafPending = false;
      const roots = resolveRoots(gradePending);
      gradePending.clear();
      if (roots.length) scanGrades(roots);
    });
  });

  scanGrades(null);
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

init();

whenDomReady(watchForAttributeStrip);
