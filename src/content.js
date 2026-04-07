/**
 * content.js — Blackboard Ultra Dark Mode
 *
 * Runs at document_start (before any HTML is painted) to prevent FOUC.
 * I will be using these notes to make sure I can look back at any function I may need to change in the future
 *
 * Flow:
 *   1. Immediately read storage for the saved preference.
 *   2. If enabled, stamp [data-bb-dark] onto <html> right away.
 *   3. Listen for toggle messages from the popup (cross-tab sync).
 *   4. Observe <html> attribute changes to keep the toggle in sync
 *      if another script removes our attribute.
 */

const ATTR = 'data-bb-dark';

// ─── Helper: apply or remove the dark-mode gate attribute ─────────────────
function setDarkMode(enabled) {
  if (enabled) {
    document.documentElement.setAttribute(ATTR, '');
  } else {
    document.documentElement.removeAttribute(ATTR);
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
    setDarkMode(enabled);
  });
}

// ─── Step 2: Listen for toggle messages from popup.js ─────────────────────
// When the user flips the switch in the popup, popup.js broadcasts a message
// to ALL matching tabs (including iframes via all_frames: true).
const runtime = (typeof browser !== 'undefined') ? browser.runtime : chrome.runtime;

runtime.onMessage.addListener((message) => {
  if (message.type === 'BB_DARK_MODE_TOGGLE') {
    setDarkMode(message.enabled);
  }
});

// ─── Step 3: Guard against Blackboard's own JS removing our attribute ─────
// Blackboard's SPA sometimes re-renders <html>. A MutationObserver acts like
// a security guard — if our attribute gets removed, it puts it right back.
function watchForAttributeStrip() {
  const observer = new MutationObserver(() => {
    const shouldBeDark = document.documentElement.hasAttribute(ATTR);
    // Re-check storage and re-apply if needed
    const storage = (typeof browser !== 'undefined') ? browser.storage : chrome.storage;
    storage.local.get('darkModeEnabled', (result) => {
      const enabled = result.darkModeEnabled !== false;
      if (enabled && !shouldBeDark) {
        setDarkMode(true);
      }
    });
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
// Solution: a requestAnimationFrame loop that runs every frame and force-
// paints any light element dark. Like a security guard doing rounds every
// second — the moment a light color appears, it's gone before the next
// frame renders to the screen.

const DARK_BG = '#0a0a0c';
// A color is "light" if the sum of its RGB channels exceeds this value
// and it isn't a near-black shade.
const LIGHT_THRESHOLD = 180;

function enforceStreamDark() {
  if (!document.body) return;

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
      
      // Destroy it if the color is light OR if Blackboard injected a gradient
      const isLight = r > 40 && g > 40 && b > 40 && (r + g + b) > LIGHT_THRESHOLD;
      const hasGradient = bgImage && bgImage !== 'none' && bgImage.includes('gradient');

      if (isLight || hasGradient) {
        el.style.setProperty('background', DARK_BG, 'important');
        el.style.setProperty('background-image', 'none', 'important');
        el.style.setProperty('background-color', DARK_BG, 'important');
      }
    }
  }
}

function initStreamBackgroundKiller() {
  // Run once immediately to catch anything already in the DOM
  enforceStreamDark();

  // Then re-run only when Blackboard actually mutates the DOM — zero cost at idle
  const streamObserver = new MutationObserver(() => enforceStreamDark());
  streamObserver.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class', 'style'],
  });
}



// ─── Boot ──────────────────────────────────────────────────────────────────
init();

// Wait for DOM to be available before setting up the observer
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    watchForAttributeStrip();
    initGradeColorizer();
    initStreamBackgroundKiller();
  });
} else {
  watchForAttributeStrip();
  initGradeColorizer();
  initStreamBackgroundKiller();
}

// ─── Grade Colorizer ───────────────────────────────────────────────────────
// CSS cannot do arithmetic, so we use JS to read "63 / 65" style grade
// strings, calculate the percentage, and stamp a data attribute that our
// CSS rules can target for green / yellow / red coloring.
//
// Analogy: CSS is the painter, JS is the foreman who reads the blueprint
// and tells the painter which color goes where.

function colorizeAllGrades() {
  // Grab all spans, divs, and table cells, and reverse the list.
  const elements = Array.from(document.querySelectorAll('span, div, td')).reverse();

  elements.forEach(el => {
    // Skip parent wrappers if we already pillified a child inside them
    if (el.querySelector('.darkboard-pill')) return;

    // Squash hidden newlines and tabs into single spaces for the regex
    const text = el.textContent.replace(/\s+/g, ' ').trim();

    // Ignore dates (they have two slashes)
    if ((text.match(/\//g) || []).length > 1) return;

    // Skip long strings — grade values are short ("84 / 100"), titles are not
    if (text.length > 40) return;

    // Skip date/time patterns like "12/5 @ 11:59"
    if (text.includes('@')) return;

    // Skip elements inside headings (announcement and discussion titles)
    if (el.closest('h1, h2, h3, h4, h5, h6')) return;

    // Catch formats like "95/100", "95 / 100", and "Score: 95 / 100"
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

function initGradeColorizer() {
  colorizeAllGrades();

  // Supercharged Observer: By adding 'characterData: true' and removing 
  // the addedNodes check, we force the script to evaluate grades even 
  // when Angular silently rewrites the text in the table cells.
  const gradeObserver = new MutationObserver(() => {
    colorizeAllGrades();
  });

  gradeObserver.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true 
  });
}

