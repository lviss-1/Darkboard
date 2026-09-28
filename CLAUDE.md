# DarkBoard — working notes for Claude

A Manifest V3 Chrome extension that themes Blackboard Ultra dark at
`https://online.iona.edu/*` and `https://*.blackboardcdn.com/*`. Chrome only.
No build step, no npm, no bundler: plain files, loaded unpacked from the repo
root. Published on the Chrome Web Store as id `ogkjalalkednannikfgjhcnmgcepkeip`;
the current version is whatever `manifest.json` says.

This file is meant to be enough to plan most changes without re-reading the
source. The deep "why" — measured ratios, regressions and their history —
lives in `test/README.md` and in the rationale comments above each block of
`src/`. Read those for the section you are about to touch.

## File map

| Path | Role |
|---|---|
| `manifest.json` | Injects `src/accent.js`, then `src/content.js`, plus `src/dark-mode.css`, at `document_start` in **all frames** |
| `src/content.js` | Gate, preference mirror, observers, inline-style passes, grade colorizer (~1,030 lines) |
| `src/dark-mode.css` | The theme: palette tokens, then sections 1–36 (~2,280 lines, ~340 `!important`) |
| `src/accent.js` | Pure OKLCH maths deriving the accent ramp from one institution colour. Also `require`d by Node |
| `src/background.js` | Service worker: relays toggles to every Blackboard tab, paints the toolbar badge, seeds the default on install |
| `src/popup.js`, `popup.html` | Toggle UI, out-of-scope note, static rating link. Fonts in `src/fonts/` |
| `test/` | Browser fixtures, `accent.test.js` (Node), helpers `contrast.js` and `restyle.js`, and `README.md` (the reference) |
| `test/grades/fixture-gradebook.html` | The one fixture shaped from real-page evidence. **The `/grades` directory name is load-bearing** |
| `promo/*.html` | Store promo tiles rendered as pages, fonts base64-inlined, exported to JPEG/PNG in the browser |
| `icons/` | 16/48/128 PNGs |
| `googlef3331e5ec48014da.html` | Google Search Console verification token. **Never delete** |
| `.claude/launch.json` | The fixture server config (`python3 -m http.server 8899`) |

## Runtime architecture

**The gate.** Every rule in `dark-mode.css` is scoped under `html[data-bb-dark]`.
The attribute is the on/off switch; the palette lives on `:root` ungated.

**Zero flash.** The CSS is injected at `document_start`, but it only helps if
the gate is already up. `content.js` therefore:
1. runs `applyAccent()` (synchronous lookup, no I/O);
2. reads the `localStorage` mirror `darkboard.enabled` **synchronously** and
   sets the gate on the next line (unreadable storage → on);
3. reads `chrome.storage.local.darkModeEnabled` (the single source of truth;
   `!== false` means on, so absent = on) and corrects the gate and mirror;
4. starts enhancements after `DOMContentLoaded` if enabled.

Only `content.js` can write the mirror — the popup runs on the extension origin
and cannot reach Blackboard's `localStorage`. The mirror is stale only when the
preference changed while no tab of that origin was open; that costs one frame.

**Toggle flow.** Popup `change` → `chrome.storage.local.set` +
`runtime.sendMessage({ type: 'BB_DARK_MODE_TOGGLE', enabled })` → background
`tabs.query({ url: BB_ORIGINS })` → `tabs.sendMessage` to each tab (all frames)
→ content listener updates `_darkEnabled`, the mirror, and the gate. The popup
message never reaches content scripts directly; the relay is required.

**Observers** (all in `content.js`):
- attribute-strip guard on `<html>` — re-adds the gate if Blackboard removes it;
- `streamObserver` (`childList`, `subtree`, `class`/`style` attributes) → `runStreamPass`;
- `gradeObserver` (`childList`, `subtree`, `characterData`) → `scanGrades`.

Both work observers debounce through `requestAnimationFrame` and only process
the changed subtrees (`collectMutationRoots` → `resolveRoots`, which drops
nested roots and widens to `<body>` past `MAX_ROOTS = 50`). A
`prefers-reduced-transparency` media listener also triggers `runStreamPass`.

**Inline-style passes.** CSS cannot win some fights (ID-scoped or class rules
from Blackboard, values only knowable by measuring), so three passes write
inline `!important` styles and tag what they touched:

| Pass | Marker attribute | What it does |
|---|---|---|
| `enforceStreamDark` | `data-darkboard-bg` | Paints light/gradient stream rows the canvas colour; skips anything already on a theme surface (`theme()` reads the tokens from CSS) |
| `reconcileScrims` | `data-darkboard-scrim` = `clear` \| `dim` \| `dim-sharp` | Decides per full-viewport fixed/absolute element whether it is an active modal scrim (dim 0.65 + `blur(3px)`; 0.75 no blur under reduced transparency) or must paint nothing |
| `restoreEventDots` | `data-darkboard-dot` | Recolours calendar `.event-dot` from the `border-left-color` of a non-dot `.course-color-N` carrier; falls back to `--text-main` |

`runStreamPass` disconnects `streamObserver`, runs all three, reconnects.
`stopEnhancements` disconnects everything and runs the three `revert*` functions.

**Grade colorizer.** A `TreeWalker` over text nodes (linear; not an element
walk). A string is a grade if it matches `FRACTION` or `PERCENTAGE` (optional
short label only when it ends in `:` or `-`), is not in a heading, and hits
none of `DATE_WORDS` / `COUNTER_WORDS` / `PROGRESS_WORDS`. A bare integer pair
in calendar range (≤12 / ≤31) is a date **unless** `inGradebookContext` — the
URL path contains `/grades` or an ancestor matches `GRADEBOOK_SELECTORS`
(a hint, never a gate). Numeric fragments escalate up to 3 ancestors with ≤4
children to catch `<span>7.5</span> / <span>10</span>`. Status thresholds:
≥90 `good`, ≥80 `fair`, ≥70 `average`, else `poor`, stamped as
`data-grade-status`. Inline hosts (`INLINE_HOSTS`) get `.darkboard-pill`
directly; block hosts get a wrapper `span.darkboard-pill` and **no mark of
their own**. `SKIP_HOSTS` (script, style, textarea…) are never touched.

**Accent.** `DarkboardAccent.baseFor(location.hostname)` looks up
`INSTITUTIONS` (only `online.iona.edu` → `#6f2c3e`) → `derive()` returns eight
custom properties (`--accent-primary/hover/deep/edge`, `--text-on-accent`,
`--border-focus`, `--accent-glow`, `--shadow-maroon`) or `null` if the colour
cannot produce an accessible ramp → written inline on `<html>`. Any failure
leaves the CSS `:root` values, which are the shipped theme. `DarkboardAccent`
is a top-level `const`: shared across content scripts' lexical scope, **not**
a `window` property.

**Background worker.** `restoreBadge()` runs at top level, on startup and on
install (MV3 workers die after ~30 s idle). `onInstalled` seeds
`darkModeEnabled: true` only if unset.

## Stylesheet map (`src/dark-mode.css`)

Unnumbered MUI blocks at the top (floating labels, backdrops/popovers, paper,
menu items), then:

1 palette · 2 gate (header only) · **3 global reset + universal inherit** ·
3b content imagery · 4 typography · 4b muted text tier · 5 high-level
containers · 6 cards & panels · 7 forms · 8 buttons · 9 tables · 10 modals &
overlays · 11 scrollbars · 12 status badges · 13 grade pills · 14 iframes ·
15 color-scheme · 16–17 Iona-specific gradebook / institution page · 18 inline
light-background catchers · 19 stream hover · 20 profile · 21 grades overview ·
22 activity stream zero-white · 23 zero-grey hover & focus (+ inline `rgb(2x`
catchers) · 24 right sidebar · 25 announcements / messages toolbar · 26 global
`bb-*` web-component sweep · 27 ultimate fallback (+ institution maroon sniff) ·
28 semantic state colours · 29 disabled · 30 nav is not primary buttons ·
31 Blackboard's light artwork · 32 focus rings · 33 selection · 34 motion &
forced colours · 35 peek-panel header · 36 calendar week strip.

**Surface ladder** (designed in CIE L*, each tier ≥3 L* from its neighbours;
contrast ratio is the wrong metric between near-blacks):
`--bg-primary #0a0a0c` 2.8 → `--bg-sidebar #131319` 6.1 → `--bg-secondary
#1f1f27` 12.1 → `--bg-row-alt #26262f` 15.5 → `--bg-tertiary #2b2b35` 17.9 →
`--bg-raised #383844` 24.0. `--bg-hover #3f2b3e` is maroon-cast on purpose.

**Section 3 is the root of most bugs.** `html[data-bb-dark] * {
background-color: inherit !important; color: inherit !important; }` means every
element inherits `body`'s opaque canvas. Anything Blackboard left transparent
on purpose (scrims, backdrops) becomes an opaque sheet, and anything whose
colour lives only in `background-color` (event dots) vanishes.

**Specificity.** Most rules sit at (0,1,x)–(0,3,x). Blackboard has ID-scoped
rules that beat all of those. Section 35 reaches ID level with
`:not(#_darkboard)` — it matches every element and exists only to add (1,0,0).
**It is not a typo; deleting it brings back the unreadable panel title.**
A few selectors in sections 5 and 16 name Blackboard IDs directly
(`#main-content`, `#side-panel`, …). Section 35's comment says nothing else
exceeds (0,3,x); those ID selectors make that claim inaccurate.

## Invariants — do not break

- **The gate is set synchronously** at top level (right after `applyAccent()`).
  Never move it into a callback, a `whenDomReady`, or after an `await`.
- **Turning off: `stopEnhancements()` before `setDarkMode(false)`.** Inline
  `!important` styles are not gated by the attribute; reversing the order
  leaves a frame of black rows on a light page.
- **Every inline write has a marker attribute and a revert** called from
  `stopEnhancements`. Revert by querying the marker, not by holding element
  references (the SPA detaches nodes).
- **Observers disconnect around their own writes.** Style writes are exactly
  what `streamObserver` watches; writing while connected loops.
- **Scrims are decided by measurement and modality, never by name.** Names only
  *find* candidates. Uncertain cases fall toward painting less (a missed dim is
  cheap; a false dim blacks out the page). Deepest candidate first; an ancestor
  of something dimmed clears. `visibility`, `display`, `opacity` are never
  overridden by modality. **The CSS must not set `pointer-events` or
  `visibility` on real elements** — `reconcileScrims` reads them as signals.
- **Pills never go on block hosts** (`inline-flex` collapses table cells), and
  block hosts are never marked, so a wrapper the framework reconciles away gets
  re-wrapped on the next pass.
- **`accent.js` stays pure** — no DOM, no `chrome.*`, no module system. Its
  `SURFACES` list must equal the CSS ladder plus `--bg-hover`;
  `accent.test.js` checks this.
- **Accessibility thresholds are measured, not hardcoded**: 4.5:1 text
  (1.4.3), 3:1 control boundaries and focus rings (1.4.11). The focus ring
  must be an `outline`, not a `box-shadow` (section 22 forces `box-shadow:
  none` in the stream).
- **`content.js` throws if evaluated twice** (top-level `const`s). Anything
  that loads it more than once needs a fresh frame, as `fixture-fouc` does.

Duplicated values — change every copy together:
- Host patterns: `manifest.json` `host_permissions` and `content_scripts.matches`,
  and `BB_ORIGINS` in `background.js`. (`popup.js` reads the manifest.)
- Iona maroon `#6f2c3e`: CSS `:root`, `accent.js` `INSTITUTIONS`,
  `background.js` badge (×2), `popup.html` `--c-accent`. The
  `[style*="#6f2c3e"]` selector in section 27 *matches* Blackboard's inline
  value and is not a copy of the token.
- Message type `BB_DARK_MODE_TOGGLE` and storage key `darkModeEnabled`: popup,
  background, content, and the stubs in every fixture.
- Surface tokens: CSS `:root`, `accent.js` `SURFACES`, `THEME_SURFACE_TOKENS`
  in `content.js`.

## Side-effect traps — check these in every plan

If you touch… | …also check
---|---
Any rule that sets `background-color` | Section 3 inheritance: a fill on a container **floods its whole subtree**. Guard substring/row selectors with `:not(:has(…))` so only the innermost match paints (see section 23 and the calendar `tr:hover` flood)
A transparent/overlay rule | Sections 18, 26 (`[class*="bb-"]` matches `bb-offcanvas-overlay`), 27 — later equal-specificity rules win on source order and have undone fixes before (section 10 vs 26)
A `:hover` or `:focus-within` rule | `:focus-within` propagates to every ancestor, so a flood *persists*. FullCalendar rows must not hover
Section 8 buttons | Calendar day buttons (section 36), `svg:only-child` icon detection, anchors styled as buttons, the primary CTA rim
A palette token | Every measured ratio in `test/README.md`, `accent.js` `SURFACES`, the `theme()` surface set in `content.js` (it skips surfaces the theme already painted)
Grade regexes or guards | Date/counter/progress words, heading exclusion, `/grades` path rule; both `fixture-grades.html` and `grades/fixture-gradebook.html`
How `content.js` finds anything in the DOM | Blackboard's real DOM differs from every fixture except the gradebook one. Ask for a live-page diagnostic first
A new inline-style pass | Add it inside `runStreamPass`'s disconnect window, give it a marker, add its revert to `stopEnhancements`, make it idempotent (mark + priority check)
Observer config or debounce | Hidden tabs pause rAF; `MAX_ROOTS` widening; `characterData` is how Angular text rewrites are seen
Host patterns, message type, storage key | Every copy listed above, the popup scope note, fixture stubs
`popup.js` top level | The fixture stub must answer everything it calls at load, or the whole script dies and the fixture measures a blank page
Anything shipped | `src/` and `popup.html` land in the next store zip; behaviour changes want a version bump at release

## Testing and verification

- **Node:** `node test/accent.test.js` — must end `PASS — no failures`.
  Sweeps 14 real brand colours and 1,080 synthetic ones, checks Iona has not
  drifted (OKLab ΔE), and checks `SURFACES` against the CSS.
- **Fixtures:** serve the repo root with `python3 -m http.server 8899`, open
  `http://localhost:8899/test/<fixture>.html`, and call the `window.__*`
  helpers from DevTools or via claude-in-chrome `javascript_tool`. Most expose
  `__cssReady` / `__scriptReady` promises; await them before `__probe()`.
  Each fixture's expected results are tabled in `test/README.md`.

| Fixture | Covers |
|---|---|
| `fixture-fouc` | Gate before first paint, the mirror (`__scenario`) |
| `fixture-stream` | Stream row killer on/off (`__fireToggle`, `?off`) |
| `fixture-scrim`, `fixture-overlay` | Scrim modality, closed backdrops (`__setReducedTransparency`) |
| `fixture-grades`, `grades/fixture-gradebook` | What counts as a grade; split values; block vs inline hosts |
| `fixture-calendar` | Event dots, today fill, hover flood (`__calibrate`, `__checkHover`) |
| `fixture-surfaces`, `fixture-panel` | Surface ladder tiers; ID-level panel header |
| `fixture-buttons`, `fixture-hover`, `fixture-focus` | Button shapes; which elements hover; focus/selection/motion/scrollbar |
| `fixture-semantics`, `fixture-overrides` | Status colours; inline catchers, striping, MUI label |
| `fixture-accent`, `fixture-popup`, `fixture-perf` | Accent reaches `<html>`; popup contrast/copy (`await __probe()`); scan cost (`__run`) |

- **Before/after comparisons:** `git show HEAD:src/content.js > test/.tmp-old-content.js`
  then `?impl=.tmp-old-content.js` (fouc, perf, gradebook); or
  `git show HEAD:src/dark-mode.css > test/.tmp-old.css` then `?css=.tmp-old.css`
  (hover, focus, overrides, panel, overlay). `test/.tmp-*` is gitignored.
- **Caching:** fixtures cache-bust their assets but not themselves — add
  `?v=N` after editing a fixture's own HTML.
- **Hidden tabs lie.** Chrome defers style recalculation in a hidden tab, so
  `getComputedStyle` returns user-agent values and assertions can **pass for
  the wrong reason**. Read computed styles through `restyle.js`
  (`__restyle`, `__restyleTree`, `__computed`). Exception: never restyle while
  measuring a real hover — reinserting the node cancels it.
- **`:hover` cannot be synthesised** by `dispatchEvent`. The calendar fixture
  drives a real pointer and calibrates with two points (the pane is scaled).
- **Fixtures are not proof.** They build invented markup, and a green suite has
  coexisted with a dead feature on the real site. Never report something as
  working on Blackboard because fixtures pass. State what was verified and name
  the live page as unconfirmed. Chrome blocks pasting into DevTools until the
  user types `allow pasting` — say so whenever asking for console output.

## Planning protocol

Every non-trivial plan in this repo contains:

1. **A dependency-ordered step list.** For each step, say what it depends on
   and why the order is safe, so no later step undoes or invalidates an
   earlier one. Mark steps that are independent.
2. **Non-obvious side effects per step**, starting from the traps table above
   and adding anything new: other rules the cascade will now reach, other
   copies of a value, fixtures whose meaning changes, what ships.
3. **Verification per step**: which fixture or test proves it, what the
   expected output is, and what remains unverified on the live site.
4. **Whether this file needs updating.**

Before editing any code: read the rationale comment above the block being
changed (these comments record past regressions), and run
`git log -S '<selector or constant>' --oneline` to see why it is the way it
is. Ask when a decision is the user's to make.

## Conventions

- Comments explain a non-obvious *why* — a cascade argument, a constraint from
  Blackboard, a regression — and never restate the next line. Strip
  restatement comments from functions you touch anyway.
- Name colours by token; literal colours in CSS appear only inside selectors
  that sniff Blackboard's inline styles.
- Commit subjects are imperative and describe the user-visible effect ("Stop
  the…", "Make the…", "Give the calendar back…"); the body explains the cause
  and what was measured.
- **Release:** bump `manifest.json` `version` and the README badge, then zip
  `manifest.json popup.html icons/ src/` into `darkboard-<version>.zip`
  (gitignored — never commit it).
- Promo tiles: nothing real (course or student names) goes on them.

Known, deliberate limitations: a bare text node beside an icon counts as
icon-only (`:only-child` ignores text); `div[tabindex="0"]` gets no hover
(it matched page-sized scroll regions); inline-style prefix catchers cannot
tell `rgb(20, …)` from `rgb(200, …)`; only Iona is in `INSTITUTIONS` —
multi-institution support (broader host patterns, logo-derived accent cached
like the mirror) is the planned v2.

## Keeping this file true

Every session trusts this file, so a wrong line here becomes a wrong
instruction. Any change that invalidates a statement above updates
`CLAUDE.md` in the same commit.
