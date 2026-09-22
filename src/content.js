/**
 * content.js — Blackboard Ultra Dark Mode
 *
 * Runs at document_start (before any HTML is painted) to prevent FOUC.
 *
 * Flow:
 *   1. Stamp [data-bb-dark] onto <html> synchronously, from a local mirror of
 *      the preference, before anything can paint.
 *   2. Read chrome.storage for the authoritative value and correct the gate
 *      if the mirror was stale.
 *   3. Start the DOM-mutating enhancements only when dark mode is actually on.
 *   4. Listen for toggle messages from the popup (cross-tab sync).
 *   5. Observe <html> attribute changes to keep the toggle in sync
 *      if another script removes our attribute.
 */

const ATTR = 'data-bb-dark';

// ─── The preference mirror ────────────────────────────────────────────────
// The stylesheet is injected by the manifest at document_start, so it is
// ready before first paint — but every rule in it is gated on [data-bb-dark],
// and that attribute used to be set inside the callback of an async
// chrome.storage read. The CSS was in place before the first frame; the
// switch that turns it on was not. It won the race nearly always, which is
// why nobody caught it, but "nearly always" is not the claim, and the load
// most likely to lose the race is a cold profile on a busy machine at night,
// which is the exact case this extension exists for.
//
// A content script has no synchronous access to chrome.storage, but it does
// have synchronous access to localStorage on the page's own origin. So the
// preference is mirrored there and read on the next line rather than the next
// tick. chrome.storage stays the single source of truth; this is a cache and
// is consulted for one thing only — the value to use before the real one
// arrives.
//
// Unreadable storage (blocked cookies, a partitioned iframe, a private
// window) falls back to on, which matches the install default.
const MIRROR_KEY = 'darkboard.enabled';

function readMirror() {
  try {
    return localStorage.getItem(MIRROR_KEY) !== 'off';
  } catch (e) {
    return true;
  }
}

function writeMirror(enabled) {
  const value = enabled ? 'on' : 'off';
  try {
    // Checked first because this runs on every page load in every frame, and
    // all_frames means a page with several embedded frames would otherwise
    // rewrite an unchanged value once per frame per load.
    if (localStorage.getItem(MIRROR_KEY) !== value) {
      localStorage.setItem(MIRROR_KEY, value);
    }
  } catch (e) {
    // Nothing to do. The mirror is an optimisation; storage still decides.
  }
}

// Stamped on every element whose background we override inline, so the
// override can be found and undone when dark mode is switched off.
const MARK = 'data-darkboard-bg';
const SCRIM_MARK = 'data-darkboard-scrim';
const DOT_MARK = 'data-darkboard-dot';

// Kept in sync by init() and the message listener so the observers can
// read it synchronously without an async storage round-trip. Seeded from the
// mirror below before either of those runs, so it is never wrong for longer
// than one storage round-trip and never merely assumed to be false.
let _darkEnabled = false;

let streamObserver = null;
let gradeObserver = null;
let transparencyQuery = null;
let onTransparencyChange = null;

function setDarkMode(enabled) {
  // Guarded because this now runs as the very first thing the script does,
  // in every frame, rather than inside a callback that could only fire once
  // the document was well underway.
  const root = document.documentElement;
  if (!root) return;

  if (enabled) {
    root.setAttribute(ATTR, '');
  } else {
    root.removeAttribute(ATTR);
  }
}

function whenDomReady(fn) {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', fn, { once: true });
  } else {
    fn();
  }
}

// ─── The institution accent ───────────────────────────────────────────────
// The accent ramp used to be one hand-tuned maroon spelled out in the
// stylesheet, which is correct for Iona and wrong for every other university,
// whose own brand colour it would fight on every page. accent.js turns the
// whole ramp into a function of a single base colour; this applies it.
//
// Runs in the same synchronous block as the gate below, and can, because the
// source is a lookup with no I/O. When logo extraction replaces that lookup it
// will need an image load and therefore a cached value to paint from on the
// first frame — the localStorage mirror above is the pattern to reuse.
//
// Everything here is best-effort. The stylesheet's own :root values are the
// fallback, so an unknown host, an unusable brand colour, or this file failing
// to load at all leaves the theme exactly as it ships.
function applyAccent() {
  if (typeof DarkboardAccent === 'undefined') return;

  const base = DarkboardAccent.baseFor(location.hostname);
  if (!base) return;

  const ramp = DarkboardAccent.derive(base);
  if (!ramp) return;

  const root = document.documentElement;
  if (!root) return;

  for (const [token, value] of Object.entries(ramp)) {
    root.style.setProperty(token, value);
  }
}

applyAccent();

// ─── Step 1: Apply the gate synchronously, before anything paints ─────────
// This is the whole of the zero-flash guarantee. Everything below it is
// correction.
_darkEnabled = readMirror();
setDarkMode(_darkEnabled);

// ─── Step 2: Read the authoritative preference and correct if needed ──────
// The mirror is only stale in one situation: the preference was changed while
// this origin had no tab open to hear about it. That costs a single frame of
// the wrong theme on the next load, after which the mirror is rewritten and
// every load thereafter is clean.
function init() {
  chrome.storage.local.get('darkModeEnabled', (result) => {
    // Default to TRUE on first install — users expect dark mode to just work
    const enabled = result.darkModeEnabled !== false;
    writeMirror(enabled);

    if (enabled !== _darkEnabled) {
      _darkEnabled = enabled;
      if (enabled) {
        setDarkMode(true);
      } else {
        // Same ordering as the message listener below, and for the same
        // reason: the inline overrides carry !important and are not gated by
        // the attribute, so they have to go first. Nothing has started this
        // early, which makes it a no-op today — but writing it the other way
        // round would leave a trap for whoever changes the timing later.
        stopEnhancements();
        setDarkMode(false);
      }
    }

    // The storage read can resolve either side of DOMContentLoaded, so the
    // enhancements are deferred rather than assuming <body> exists yet.
    if (enabled) whenDomReady(startEnhancements);
  });
}

chrome.runtime.onMessage.addListener((message) => {
  if (message.type !== 'BB_DARK_MODE_TOGGLE') return;

  _darkEnabled = message.enabled;
  // Keeps the next load's first frame correct. This is the only place the
  // mirror can be written from when the user acts: popup.js runs on the
  // extension origin, not Blackboard's, so it cannot reach this localStorage.
  writeMirror(message.enabled);

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

// Every surface the stylesheet paints, resolved from the stylesheet rather
// than spelled again here so the two cannot drift apart.
const THEME_SURFACE_TOKENS = [
  '--bg-primary',
  '--bg-sidebar',
  '--bg-secondary',
  '--bg-row-alt',
  '--bg-tertiary',
  '--bg-raised',
  '--bg-hover',
];

const CANVAS_FALLBACK = '#0a0a0c';

// CSSOM re-serializes colors, so a hex written here comes back out of a
// computed style as "rgb(10, 10, 12)". Both spellings are resolved through a
// throwaway element so the comparisons below stay correct without hardcoding a
// second spelling of anything.
let _theme = null;
function theme() {
  if (_theme === null) {
    const probe = document.createElement('div');
    const serialize = (value) => {
      probe.style.backgroundColor = '';
      probe.style.backgroundColor = value;
      return probe.style.backgroundColor;
    };

    const root = getComputedStyle(document.documentElement);
    const read = (token) => root.getPropertyValue(token).trim();

    const canvas = read('--bg-primary') || CANVAS_FALLBACK;
    _theme = {
      canvas,
      canvasSerialized: serialize(canvas),
      // Anything already painted one of our own surfaces is left alone, which
      // is what keeps the killer from fighting the stylesheet. Without this the
      // only thing separating a themed dialog from a Blackboard light panel is
      // the brightness threshold below, and --bg-raised sums to 180 against a
      // previous threshold of exactly 180 — a one-unit margin.
      surfaces: new Set(
        THEME_SURFACE_TOKENS
          .map(read)
          .filter(Boolean)
          .map(serialize)
      ),
    };
  }
  return _theme;
}

function darkBg() {
  return theme().canvas;
}

// A color is "light" if the sum of its RGB channels exceeds this value and it
// isn't a near-black shade. With the palette excluded outright above, this only
// has to separate light from dark rather than also clearing our own surfaces,
// so it stays low enough to catch a mid grey: 250 reaches down to #545454.
const LIGHT_THRESHOLD = 250;

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

function enforceStreamDark(roots) {
  if (!_darkEnabled || !document.body) return;

  const scopes = (roots && roots.length) ? roots : [document.body];
  const { canvasSerialized, surfaces } = theme();

  for (const scope of scopes) {
    const candidates = [];
    if (scope.matches && scope.matches(STREAM_SELECTORS)) candidates.push(scope);
    candidates.push(...scope.querySelectorAll(STREAM_SELECTORS));

    for (const el of candidates) {
      // Cheaper than getComputedStyle, and reading the inline value rather than
      // the marker means this self-heals if Blackboard replaces the attribute.
      if (el.style.getPropertyValue('background-color') === canvasSerialized) continue;

      const computed = window.getComputedStyle(el);

      // A surface the stylesheet painted is already correct; repainting it
      // with the canvas would flatten the elevation the theme just built.
      if (surfaces.has(computed.backgroundColor)) continue;

      const m = computed.backgroundColor.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
      if (!m) continue;

      const [r, g, b] = [+m[1], +m[2], +m[3]];
      const isLight = r > 40 && g > 40 && b > 40 && (r + g + b) > LIGHT_THRESHOLD;
      const bgImage = computed.backgroundImage;
      const hasGradient = bgImage && bgImage !== 'none' && bgImage.includes('gradient');

      if (isLight || hasGradient) {
        el.style.setProperty('background', darkBg(), 'important');
        el.style.setProperty('background-image', 'none', 'important');
        el.style.setProperty('background-color', darkBg(), 'important');
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
    reconcileScrims();
    restoreEventDots();
    return;
  }

  streamObserver.disconnect();
  enforceStreamDark(roots);
  // Inside the same detached window, and for the same reason: this writes to
  // the style attribute too. It ignores `roots` because a scrim's state
  // changes through a class on an ancestor as often as through its own
  // mutation, and the candidate set is small enough that scoping it would buy
  // nothing but a way to miss one.
  reconcileScrims();
  restoreEventDots();
  streamObserver.observe(document.body, STREAM_OBSERVER_CONFIG);
}

// ─── Scrim Reconciliation ─────────────────────────────────────────────────
// A modal backdrop is transparent until its modal opens. The universal rule in
// section 3 of the stylesheet — `background-color: inherit !important` on `*` —
// does not know that, so a mounted-but-closed scrim inherits the dark canvas
// and becomes an opaque sheet over a page that is otherwise perfectly healthy.
//
// Measured on the live site rather than in a fixture: a fixed, full-viewport,
// transparent div computes to rgb(10, 10, 12) with NO CLASS AT ALL. Names
// carrying "overlay" or "backdrop" escape, because those are the two words
// section 3 happens to list; `modal-dialog`, `bb-dialog-container` and
// `modal-mask` all come out opaque page-black, and `ReactModal__Overlay` comes
// out --bg-raised because section 10 mistakes it for the dialog itself.
//
// That exclusion list has been patched four times now — MUI backdrops, peek
// backdrops, the bb- sweep, and modal scrims — and it cannot converge, because
// the theme is being asked to enumerate names it has never seen. So this
// decides by measurement instead, the same way enforceStreamDark does for
// stream rows: look at the element, act only on what it actually is.

// Finding candidates by name is fine. Name matching was only ever wrong as a
// way to DECIDE about them; the geometric test below is what rules.
const SCRIM_HINTS = [
  '[class*="overlay" i]', '[class*="backdrop" i]', '[class*="scrim" i]',
  '[class*="modal" i]', '[class*="dialog" i]', '[class*="mask" i]',
  '[class*="peek" i]', '[class*="offcanvas" i]', '[class*="flyout" i]',
  '[aria-modal="true"]',
].join(',');

const DIALOG_SELECTORS = '[role="dialog"],[role="alertdialog"],[aria-modal="true"],dialog';

// A scrim covers the viewport. Anything smaller is a panel, a card or a
// sliver, and none of those are this pass's business. Checked live: on a
// normal course page with no modal open, zero elements clear this bar, so the
// pass has nothing to get wrong until a real overlay appears.
const SCRIM_COVERAGE = 0.85;

// Light mode's own scrim measures 45% black — sampled from a screenshot of
// this exact dialog, where Blackboard's white page renders at (139, 139, 139).
// This goes further than that on purpose: 45% over white removes 116 levels of
// brightness, while 45% over our near-black canvas removes four. At 0.65 the
// text behind drops from 232 to 81, which is the part of the effect a dark
// canvas can still deliver.
const SCRIM_DIM = 'rgba(0, 0, 0, 0.65)';

// Darkening alone cannot reach light mode's separation, and it is worth being
// precise about why rather than tuning the alpha forever. Dialog against the
// backdrop behind it: light mode measures 3.41:1; dark mode reaches 1.75:1 at
// 0.45, 1.77:1 at 0.65, and 1.82:1 at FULLY OPAQUE BLACK. The canvas is already
// near black, so there is no luminance headroom left to spend.
//
// Blur is the lever that does not depend on that headroom. It is applied only
// to a scrim confirmed active — section 10's original sin was blurring closed
// ones, which is what made the black screen read as soft blobs rather than
// flat black.
const SCRIM_BLUR = 'blur(3px)';

// What a reader who has asked for reduced transparency gets instead: the blur
// removed, and the wash raised a little to make up the separation it was
// carrying. Text behind lands at 58 rather than 81.
//
// The blur is the part that matters here — it is the layer effect the
// preference is named for, and dropping it is most of the job. The wash stays
// deliberately short of opaque. An earlier draft used 0.92 to read as a solid
// surface, which honours the preference more literally and is the wrong trade:
// it makes the page behind a modal all but disappear, which is the thing this
// file spent three commits fixing, and the setting turns out to be far more
// common than a strict reading assumes — it is on for this project's own
// author, who approved the blurred look while running it. A preference to
// avoid see-through panels is not a request to lose the page.
const SCRIM_DIM_SHARP = 'rgba(0, 0, 0, 0.75)';

// Read per pass rather than cached, so the value is always current and so the
// fixture can stub it. The query is absent in older Chrome, where `matches` is
// false — which is the right default.
function reducedTransparency() {
  try {
    return !!window.matchMedia
      && window.matchMedia('(prefers-reduced-transparency: reduce)').matches;
  } catch (e) {
    return false;
  }
}

// An open modal, as opposed to a menu or a popup. This is the signal that
// decides whether a full-viewport element is a scrim, because modality is what
// a scrim actually expresses. `dialog` needs [open] here: a closed <dialog> is
// still in the DOM and still matches DIALOG_SELECTORS.
const MODAL_SELECTORS = '[role="dialog"],[role="alertdialog"],[aria-modal="true"],dialog[open]';

function scrimCandidates() {
  const found = new Set();
  if (!document.body) return found;

  for (const el of document.body.querySelectorAll(SCRIM_HINTS)) found.add(el);

  // The name-free tier. A scrim is nearly always a sibling or an ancestor of
  // the dialog it sits behind, so an open dialog leads straight to it whatever
  // it happens to be called. Bounded to the depth of one subtree.
  for (const dialog of document.querySelectorAll(DIALOG_SELECTORS)) {
    for (let el = dialog; el && el !== document.body; el = el.parentElement) {
      found.add(el);
      if (el.parentElement) {
        for (const sibling of el.parentElement.children) found.add(sibling);
      }
    }
  }

  for (const el of document.body.children) found.add(el);
  return found;
}

// Whether an element shares a parent with an open dialog — the portal pattern
// where the scrim and the dialog are rendered side by side.
function besideDialog(el, selector) {
  const parent = el.parentElement;
  if (!parent) return false;
  for (const sibling of parent.children) {
    if (sibling !== el && sibling.matches(selector || DIALOG_SELECTORS)) return true;
  }
  return false;
}

// Whether this element is serving one of the open modals: it either wraps the
// modal or sits beside it. Either way it is the sheet between that modal and
// the page, which is the definition of a scrim.
function servesModal(el, modals) {
  if (modals.length === 0) return false;
  if (besideDialog(el, MODAL_SELECTORS)) return true;
  for (const modal of modals) {
    if (el.contains(modal)) return true;
  }
  return false;
}

// Depth from <html>, used to settle overlapping candidates innermost-first.
function depthOf(el) {
  let n = 0;
  for (let p = el.parentElement; p; p = p.parentElement) n++;
  return n;
}

function reconcileScrims() {
  if (!_darkEnabled || !document.body) return;

  const vw = window.innerWidth;
  const vh = window.innerHeight;
  if (!vw || !vh) return;

  const modals = document.querySelectorAll(MODAL_SELECTORS);
  const sharp = reducedTransparency();

  // Deepest first, so that when several nested elements all qualify, the one
  // closest to the modal claims the dim and its ancestors are cleared behind
  // it. Two stacked 0.65 washes composite to 0.88 and put us most of the way
  // back to the black screen, so exactly one element may paint.
  const candidates = [...scrimCandidates()].sort((a, b) => depthOf(b) - depthOf(a));

  // A list rather than one element: two unrelated modals can be open at once,
  // and each is entitled to its own wash. Only an ANCESTOR of something already
  // dimmed has to stand down.
  const dimmed = [];

  for (const el of candidates) {
    if (!el.isConnected) continue;

    // The dialog is what the scrim sits behind. Clearing its background would
    // hand back the white panel the theme exists to remove.
    if (el.matches(DIALOG_SELECTORS)) continue;

    const computed = window.getComputedStyle(el);
    if (computed.position !== 'fixed' && computed.position !== 'absolute') continue;

    const rect = el.getBoundingClientRect();
    if (rect.width < vw * SCRIM_COVERAGE || rect.height < vh * SCRIM_COVERAGE) continue;

    // Modality is what decides. An element on an open modal's path IS that
    // modal's scrim, whatever it is called, whatever text it carries and
    // whatever it does with pointer-events — and judging it by shape instead
    // is why the dim never appeared: a scrim that wraps its dialog carries the
    // dialog's text, was read as a layer host, and was cleared.
    const serves = servesModal(el, modals);

    // A bare scrim is empty: it exists only to put a wash over the page.
    // A layer HOST carries the overlay's own content. Fluent UI's ms-Layer is
    // the shape, and it is not hypothetical — Blackboard portals its menus and
    // dialogs into one, as a direct child of body, fixed, full-viewport, and
    // painted opaque rgb(10, 10, 12) by this theme until this pass clears it.
    // A host holding a MENU still clears: a context menu has no business
    // dimming the page behind it. A host holding a MODAL does not.
    const host = !serves && (el.textContent || '').trim() !== '';

    // An `absolute` full-viewport element carrying content is a layout
    // container — an app shell root that happens to be positioned — and
    // repainting it would be this same blanket mistake in a new place. A
    // `fixed` one is a viewport-level layer by definition, which is what a
    // portal is.
    if (host && computed.position !== 'fixed' && !besideDialog(el)) continue;

    // An app shell wrapping the whole page is an ancestor of anything rendered
    // inside it, including a modal, so `serves` alone would hand it the dim.
    // A scrim is a layer over the page, not the page's own container.
    if (serves && computed.position !== 'fixed' && !besideDialog(el, MODAL_SELECTORS)) continue;

    // These four properties are safe to read because the stylesheet never
    // touches pointer-events or visibility on a real element, and sets opacity
    // and display only on ::before/::after pseudo-elements. Verified against
    // the live page before this was written; if that ever changes, this pass
    // starts guessing.
    //
    // pointer-events is the one term modality overrides. Some modals let clicks
    // through the scrim and trap interaction on the dialog instead, and reading
    // that as "closed" is the second way the dim could go missing. The rest are
    // not overridden: visibility, display and opacity mean the thing genuinely
    // is not on screen, and honouring them is what keeps a mounted-but-closed
    // backdrop from painting — the bug 4befd52 fixed.
    const inert = computed.visibility === 'hidden'
      || computed.display === 'none'
      || parseFloat(computed.opacity) <= 0.01
      || (!serves && computed.pointerEvents === 'none')
      || (!serves && el.getAttribute('aria-hidden') === 'true');

    // An inert scrim paints nothing; an active one dims. A host paints nothing
    // either — the panel inside draws its own surface. And once something has
    // dimmed, everything wrapped around it clears, so the wash is applied once.
    //
    // Note which way the uncertain cases fall: something we wrongly call inert
    // costs a dim, and something we wrongly call active costs the whole page.
    // Every signal above is a reason to paint less.
    const covered = dimmed.some((inner) => el.contains(inner));
    // The flavour is carried in the mark rather than kept beside it, so that
    // toggling the preference changes `want` and the idempotence check below
    // repaints on its own. A mark of 'dim' alone would match either flavour and
    // the scrim would keep whichever one it was first given.
    const want = (host || inert || covered) ? 'clear' : (sharp ? 'dim-sharp' : 'dim');
    if (want !== 'clear') dimmed.push(el);

    // The mark records the decision; the priority check confirms our own
    // declaration is still on the element, so this self-heals if Blackboard
    // rewrites the style attribute.
    if (el.getAttribute(SCRIM_MARK) === want
        && el.style.getPropertyPriority('background-color') === 'important') continue;

    // Inline, and important. That is the strongest declaration available to
    // the author origin, so it beats the universal rule, section 18's inline
    // catch-all and section 26's sweep without any of them being edited —
    // confirmed live, where both 'transparent' and the dim survive the whole
    // stylesheet. Reordering rules in a 2,200-line cascade is how this file
    // grew its last three bugs.
    const fill = want === 'clear' ? 'transparent'
      : want === 'dim-sharp' ? SCRIM_DIM_SHARP
      : SCRIM_DIM;
    el.style.setProperty('background-color', fill, 'important');
    el.style.setProperty('background-image', 'none', 'important');
    // Only the default flavour blurs. Blur is the layer effect the preference
    // is named for, so 'dim-sharp' goes without it.
    el.style.setProperty('backdrop-filter', want === 'dim' ? SCRIM_BLUR : 'none', 'important');
    el.setAttribute(SCRIM_MARK, want);
  }
}

// Inline styles are not gated by [data-bb-dark], so switching dark mode off
// has to take them back off by hand.
function revertScrims() {
  for (const el of document.querySelectorAll('[' + SCRIM_MARK + ']')) {
    el.style.removeProperty('background-color');
    el.style.removeProperty('background-image');
    el.style.removeProperty('backdrop-filter');
    el.removeAttribute(SCRIM_MARK);
  }
}

// ─── Calendar Event Dots ──────────────────────────────────────────────────
// The week strip carries a dot under any date with something due, coloured per
// course. They are still in the DOM in dark mode and still the right size and
// place — they are just invisible, because Blackboard sets only
// `background-color` on `.course-color-N` and section 3's universal
// `background-color: inherit !important` erases it. Measured live, every dot
// computes to rgb(10, 10, 12): exactly --bg-primary, the canvas behind it.
//
// This is in script rather than CSS for one reason: the colour is knowable, but
// only from a DIFFERENT element. Blackboard's stylesheets are cross-origin, so
// cssRules throws SecurityError and the value cannot be looked up — but the
// page carries a hidden `li.course-color-N` legend, and on those elements the
// same class also sets `border-left-color`, which the theme does not override.
// CSS cannot copy a computed value across the DOM. So: read it there, write it
// here, which is the same measure-then-apply shape as the two passes above.

const COURSE_COLOR = /(?:^|\s)(course-color-\d+)(?:\s|$)/;

// Fallback when no carrier is on the page. An uncoloured dot beats an invisible
// one: what the strip is communicating is "something is due on this day", and
// which course it belongs to is the smaller half of that.
const DOT_FALLBACK_TOKEN = '--text-main';

function courseClassOf(el) {
  const m = COURSE_COLOR.exec(' ' + (el.getAttribute('class') || '') + ' ');
  return m ? m[1] : null;
}

// The authentic colour for one course class, or null. Resolved from the first
// element wearing that class that is NOT a dot and carries a real left border:
// a dot's own border-color resolves to currentColor, which the theme has
// already forced to --text-main, so a dot can never answer this about itself.
function courseColor(cls, themeText) {
  for (const el of document.querySelectorAll('.' + cls)) {
    if (el.classList.contains('event-dot')) continue;
    const computed = window.getComputedStyle(el);
    if (parseFloat(computed.borderLeftWidth) <= 0) continue;
    const color = computed.borderLeftColor;
    if (!color || color === themeText) continue;
    if (/rgba\(\s*0,\s*0,\s*0,\s*0\s*\)/.test(color)) continue;
    return color;
  }
  return null;
}

function restoreEventDots() {
  if (!_darkEnabled || !document.body) return;

  const dots = document.querySelectorAll('.event-dot');
  if (!dots.length) return;

  const root = window.getComputedStyle(document.documentElement);
  const themeText = root.getPropertyValue('color') || '';
  const fallback = root.getPropertyValue(DOT_FALLBACK_TOKEN).trim();

  // One lookup per course class, not per dot: the carrier scan is a document
  // query and a week can hold a dozen dots across four courses.
  const resolved = new Map();

  for (const dot of dots) {
    const cls = courseClassOf(dot);
    const key = cls || '';
    if (!resolved.has(key)) {
      resolved.set(key, (cls && courseColor(cls, themeText)) || fallback || null);
    }
    const color = resolved.get(key);
    if (!color) continue;

    if (dot.getAttribute(DOT_MARK) === color
        && dot.style.getPropertyPriority('background-color') === 'important') continue;

    dot.style.setProperty('background-color', color, 'important');
    dot.setAttribute(DOT_MARK, color);
  }
}

function revertEventDots() {
  for (const dot of document.querySelectorAll('[' + DOT_MARK + ']')) {
    dot.style.removeProperty('background-color');
    dot.removeAttribute(DOT_MARK);
  }
}

// ─── Grade Colorizer ──────────────────────────────────────────────────────
// CSS cannot do arithmetic, so JS reads grade strings, calculates the
// percentage, and stamps a data attribute that CSS rules target.

// A hint, not a gate. These were guesses at Blackboard's class names, and when
// they matched nothing the walk reached nothing and the feature silently died.
// They now only help answer whether a bare integer pair is a score or a date,
// alongside the URL check below.
const GRADEBOOK_SELECTORS = [
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
  '.student-grades-wrapper'
];

const GRADEBOOK_ROOTS = GRADEBOOK_SELECTORS.join(',');

// A leading label is accepted only when it ends in a delimiter. That is what
// separates "Score: 47 / 50" from "Question 4 / 10", and it does the work the
// old length, slash-count and "@" guards were approximating.
const FRACTION = /^(?:[a-z ]{0,12}[:\-]\s*)?(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)\s*(?:points?|pts?)?$/i;
const PERCENTAGE = /^(?:[a-z ]{0,12}[:\-]\s*)?(\d+(?:\.\d+)?)\s*%$/i;

const DATE_WORDS = /\b(due|sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tue|wed|thu|fri|sat)\b/i;
const COUNTER_WORDS = /\b(attempts?|questions?|pages?|steps?|items?|modules?|slides?|versions?|try|tries|credits?|characters?|words?)\b/i;
const PROGRESS_WORDS = /\b(complete|completed|progress|remaining|attendance|viewed|watched)\b/i;

// The pill sets display: inline-flex, which would collapse a block host such
// as a table cell. Inline hosts take the pill directly; block hosts get a
// wrapper instead, below.
const INLINE_HOSTS = new Set(['SPAN', 'B', 'STRONG', 'EM', 'I', 'A', 'LABEL', 'SMALL', 'MARK']);

// Scanning is no longer confined to known containers, so the walk now reaches
// text that is not rendered prose. Wrapping a node inside one of these would be
// invisible at best and would corrupt inline JSON at worst.
const SKIP_HOSTS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'TITLE']);

// Whether a bare integer pair should read as a score rather than a date. The
// URL is the durable signal: Blackboard's gradebook lives at a /grades path,
// where a JSS-generated container class name can be renamed at any time. The
// container match stays as a fallback for grade widgets on other pages.
function inGradebookContext(el) {
  return /\/grades(\/|$)/.test(location.pathname) || !!el.closest(GRADEBOOK_ROOTS);
}

// "9/19" and "9/10" are structurally identical; only context separates a date
// from a quiz score. Inside a gradebook it is a score. Anywhere else a bare
// pair in calendar range, with no label and no unit, is read as a date.
function looksLikeDate(text, earned, total) {
  if (!Number.isInteger(earned) || !Number.isInteger(total)) return false;
  if (/[:\-]/.test(text) || /\b(points?|pts?)\b/i.test(text)) return false;
  return earned >= 1 && earned <= 12 && total >= 1 && total <= 31;
}

// A value split across elements, such as <span>7.5</span> / <span>10</span>,
// never appears whole in any single text node. Reading the combined text of an
// ancestor recovers it, but doing that for every element is the quadratic cost
// the text walk was introduced to avoid. Escalation is therefore gated on the
// node looking like a piece of a number, which is rare, and on the ancestor
// holding only a handful of children.
const NUMERIC_FRAGMENT = /^[\d.,\s\/%]+$/;
const MAX_FRAGMENT_LENGTH = 8;
const MAX_SPLIT_CHILDREN = 4;
const MAX_ESCALATION = 3;

function gradeStatusFor(el, text) {
  if (!text) return null;
  if (DATE_WORDS.test(text) || COUNTER_WORDS.test(text) || PROGRESS_WORDS.test(text)) return null;
  if (el.closest('h1, h2, h3, h4, h5, h6')) return null;

  const fractional = text.match(FRACTION);
  let pct;

  if (fractional) {
    const earned = parseFloat(fractional[1]);
    const total = parseFloat(fractional[2]);
    if (total <= 0) return null;
    if (!inGradebookContext(el) && looksLikeDate(text, earned, total)) return null;
    pct = (earned / total) * 100;
  } else {
    const percentage = text.match(PERCENTAGE);
    if (!percentage) return null;
    pct = parseFloat(percentage[1]);
  }

  return pct >= 90 ? 'good' : pct >= 80 ? 'fair' : pct >= 70 ? 'average' : 'poor';
}

// A block host carries no mark of its own, so the wrapper is what says "done".
function alreadyPilled(el) {
  if (el.dataset.gradeStatus) return true;
  const first = el.firstElementChild;
  return !!first && first.classList.contains('darkboard-pill');
}

function stampGrade(el, status, node) {
  if (INLINE_HOSTS.has(el.tagName)) {
    el.dataset.gradeStatus = status;
    el.classList.add('darkboard-pill');
    return;
  }

  // Nothing is stamped on a block host itself. If the framework reconciles the
  // wrapper away, the host is left unmarked and the next pass re-wraps it;
  // marking the host would make that repair impossible.
  const pill = document.createElement('span');
  pill.className = 'darkboard-pill';
  pill.dataset.gradeStatus = status;

  if (node) {
    node.replaceWith(pill);
    pill.appendChild(node);
    return;
  }

  while (el.firstChild) pill.appendChild(el.firstChild);
  el.appendChild(pill);
}

function considerGradeText(node) {
  const el = node.parentElement;
  if (!el || SKIP_HOSTS.has(el.tagName)) return;

  const text = node.data.replace(/\s+/g, ' ').trim();
  if (!text) return;

  if (!alreadyPilled(el)) {
    const status = gradeStatusFor(el, text);
    if (status) {
      stampGrade(el, status, node);
      return;
    }
  }

  if (text.length > MAX_FRAGMENT_LENGTH || !NUMERIC_FRAGMENT.test(text)) return;

  let ancestor = el.parentElement;
  for (let depth = 0; depth < MAX_ESCALATION && ancestor; depth++) {
    if (SKIP_HOSTS.has(ancestor.tagName)) return;
    if (ancestor.childElementCount > MAX_SPLIT_CHILDREN) return;

    if (!alreadyPilled(ancestor)) {
      const combined = ancestor.textContent.replace(/\s+/g, ' ').trim();
      const status = gradeStatusFor(ancestor, combined);
      if (status) {
        stampGrade(ancestor, status, null);
        return;
      }
    }

    ancestor = ancestor.parentElement;
  }
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

function scanGrades(roots) {
  if (!_darkEnabled || !document.body) return;

  for (const root of (roots && roots.length) ? roots : [document.body]) {
    walkGrades(root);
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

  // Nothing in the DOM changes when the reader flips this preference, so
  // without a listener an open modal would keep the flavour it was given until
  // the next unrelated mutation happened to run a pass.
  if (window.matchMedia && !transparencyQuery) {
    try {
      transparencyQuery = window.matchMedia('(prefers-reduced-transparency: reduce)');
      onTransparencyChange = () => runStreamPass(null);
      transparencyQuery.addEventListener('change', onTransparencyChange);
    } catch (e) {
      transparencyQuery = null;
      onTransparencyChange = null;
    }
  }

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

  if (transparencyQuery && onTransparencyChange) {
    transparencyQuery.removeEventListener('change', onTransparencyChange);
  }
  transparencyQuery = null;
  onTransparencyChange = null;

  revertStreamDark();
  revertScrims();
  revertEventDots();
}

init();

whenDomReady(watchForAttributeStrip);
