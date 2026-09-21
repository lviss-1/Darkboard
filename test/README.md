# Fixtures

Standalone pages that reproduce Blackboard rendering conditions locally, so the
theme and the content script can be checked without a Blackboard login.

Each fixture stubs the extension APIs (`chrome.storage`, `chrome.runtime`) and
loads `src/content.js` and `src/dark-mode.css` unmodified, then exposes helpers
on `window` for driving and inspecting the result.

## Running

Two kinds of test live here. Most are browser fixtures, driven from the
DevTools console against a served copy of the repo. One — `accent.test.js` —
is a plain Node script, because the code it covers is pure and can therefore be
swept far harder than a fixture allows:

```bash
node test/accent.test.js
```


Relative paths need a real HTTP origin, so serve the repo root:

```bash
python3 -m http.server 8899
```

Then open `http://localhost:8899/test/fixture-stream.html` and use the DevTools
console.

## fixture-stream.html

Covers the activity-stream background enforcement in `src/content.js`.

A light background is applied through an id-based rule, which outranks every
selector in `dark-mode.css`. That reproduces the case the stream killer exists
for: CSS alone cannot win, so the script writes an inline `!important`
override. Those inline styles are not gated by `[data-bb-dark]`, so they have
to be removed explicitly when dark mode is switched off.

Add `?off` to the URL to load with the preference already disabled.

```js
__probe()            // { gated, marked, inlineBg, computedBg, controlMarked }
__fireToggle(false)  // simulate the popup toggle
```

Expected:

| Scenario | Result |
|---|---|
| Loaded on | `gated: true`, rows marked, `computedBg` dark |
| Toggled off | `gated: false`, `marked: 0`, `inlineBg: ""`, `computedBg` back to `rgb(255, 255, 255)` |
| Toggled on again | Override re-applied, observer still catches newly injected rows |
| Loaded with `?off` | Nothing ever marked, no observer activity |

## fixture-semantics.html

Covers the semantic state colors in `dark-mode.css` section 28.

The universal rule in section 3 forces `color: inherit !important` onto every
element, which flattens the colors Blackboard uses to carry meaning. This page
applies Blackboard-style light-theme colors to status text and a progress bar,
then checks that the theme restores a distinction.

It also includes guard cases. Substring matching is fragile here: `template`
contains `late`, and `unsubmitted` and `incomplete` invert the states they
contain. None of the three may be recolored.

```js
await __cssReady;
__probe()
```

Expected:

| Element | Result |
|---|---|
| Error, overdue, `role="alert"` | `rgb(248, 113, 113)` |
| Success, submitted | `rgb(74, 222, 128)` |
| Warning, pending | `rgb(251, 191, 36)` |
| Progress fill vs track | different backgrounds |
| Control text and all three guards | `rgb(240, 238, 232)` |

## fixture-grades.html

Covers which strings the colorizer treats as a grade, and how it stamps them.

The matcher anchors the whole string and accepts a leading label only when it
ends in a delimiter, which is what separates `Score: 47 / 50` from
`Question 4 / 10`. Keyword guards reject counter and progress vocabulary that
would otherwise slip through a labelled form such as `Attempt: 1 / 3`.

`9/19` and `9/10` are structurally identical, so context decides: inside a
gradebook the pair is a score, and anywhere else a bare pair in calendar range
with no label and no unit is read as a date.

```js
await window.__scriptReady;
__probe('g-good')    // { status, pill, display }
```

Expected:

| Element | Result |
|---|---|
| `47 / 50`, `Score: 42 / 50`, `36/50`, `20 / 50`, `88%` | stamped and pilled |
| `9/10` in a gradebook | stamped `good` |
| `9/19` in a stream item | untouched |
| `Grade posted: 47 / 50` in a stream item | stamped `good` |
| `Attempt 1 / 3`, `Attempt: 1 / 3`, `Question 4 / 10`, `Page 2 / 10` | untouched |
| `50% complete`, `Progress: 50%`, `due Fri 12/5` | untouched |
| `47 / 50` outside every grade root | stamped; scanning is no longer gated on containers |
| `47 / 50` in a bare table cell | stamped, no pill, `display` still `table-cell` |
| Every pill's text against its fill | at least 4.5:1 |

The cell case matters because the pill sets `display: inline-flex`, which
collapses a cell and breaks the row. Block hosts get the status attribute only
and render as coloured bold text through rules already in the stylesheet.

Pill contrast is measured through `contrast.js` rather than asserted against
fixed colors. White text on the fills measured 1.4:1 on the lime and 1.7:1 on
the green and amber; dark text now measures 13.1, 11.9, 11.4 and 7.2 to one.

## fixture-buttons.html

Covers section 8. The theme used to give every non-primary button a filled grey
box with a border, which turned close buttons, kebab menus and chevrons into
chips. Labelled buttons are now outline only and icon-only controls are flat.

`svg:only-child` is what separates the two, since Blackboard wraps button text
in its own span and a labelled button therefore has two element children. The
fixture records the known limitation: a bare text node beside an icon still
counts as icon-only, because `:only-child` ignores text nodes.

The outline color is asserted by measured ratio, not by value. WCAG 1.4.11 asks
for 3:1 against the adjacent surface for a component boundary, and
`--border-strong` managed only 1.47:1, which is why `--border-interactive`
exists.

| Case | Expected |
|---|---|
| Icon-only, `<svg>` sole child | transparent, no border |
| Class containing `icon` | transparent, no border |
| `[role="button"]` with an icon class | transparent, no border |
| Bare text beside an icon | transparent, no border (known limitation) |
| Text button, text-and-icon, `Button--secondary` | transparent, 1px solid border |
| Text button border vs page | at least 3:1 |
| Primary button | maroon fill, unchanged |

## fixture-perf.html

Measures what the grade and stream passes cost on a large page.

Builds a deep synthetic DOM, puts the only grade-shaped text inside a region
the colorizer scopes to, then rewrites a text node outside that region once per
round to imitate an exam countdown ticking. Steady-state cost per round is the
number that matters; the initial scan is dominated by one-time work.

`?depth=` and `?breadth=` size the tree. `?impl=` points at an alternative
content script, which is how a change gets compared against the version before
it:

```bash
git show HEAD:src/content.js > test/.tmp-old-content.js
```

Then load `?impl=.tmp-old-content.js` and compare. Keep that file untracked.

```js
await window.__initialScanMs
await window.__run(50)
```

Always check `stamped` matches between runs. A faster pass that stamps fewer
nodes is not faster, it is broken.

Measured on 16,423 nodes when the scoped incremental scan replaced the
full-document sweep:

| | before | after |
|---|---|---|
| Steady state per round | 30.0 ms | 4.0 ms |
| 50 rounds | 1501 ms | 202 ms |
| Nodes stamped | 20 | 20 |

## A note on visibility

Browsers pause `requestAnimationFrame` in a hidden tab, and both observers in
`content.js` debounce through it. Run in a hidden tab without accounting for
that and the extension does no work at all, so the stream fixture fails every
assertion and the perf fixture reports a meaningless zero. Both pages shim
`requestAnimationFrame` onto `setTimeout` when `document.hidden` is set. The
shim uses a zero delay rather than 16 ms so a frame floor does not swamp the
work being measured.

A hidden tab has a second, quieter failure mode, and this one does not make
assertions fail — it makes them **pass for the wrong reason**. Chrome also
defers style recalculation while a tab is hidden, so `getComputedStyle` hands
back the user-agent value for any node that existed before the stylesheet
attached. Links read `rgb(0, 0, 238)` and themed buttons `rgb(239, 239, 239)`
with the correct rule sitting right there in the sheet, `document.styleSheets`
fully populated and `element.matches()` agreeing it applies.

The tell is that a node created *after* the stylesheet loads styles correctly,
so it is a recalculation that never ran rather than a cascade that lost.
Toggling `display` does not force it either, because an inherited property
like `color` resolves against an ancestor the toggle never dirties.

`restyle.js` is the answer; see below. **Any assertion reading a computed
style should go through it.** The fixtures that currently do are
`fixture-focus.html` and `fixture-hover.html`; the others read computed styles
too and should be moved over the next time they are touched.

## fixture-popup.html

Covers the popup's accent, contrast, type sizes and copy.

The popup cannot be loaded and probed directly: `popup.js` calls
`chrome.runtime.getManifest()` at the top level and throws without the
extension APIs. The fixture fetches the page and re-renders it through an
iframe `srcdoc` with a stub injected ahead of it. `srcdoc` resolves relative
URLs against the fixture, so a `<base href="../">` is what keeps the icon,
fonts and script pointing at the repo root.

The focus ring is asserted through the custom property rather than a computed
style, because `:focus-visible` does not reliably match on programmatic focus
for a checkbox. The fixture also confirms the rule actually references that
token, so the two cannot drift apart.

| Check | Expected |
|---|---|
| Muted text, footer link vs background | at least 4.5:1 |
| Focus ring vs background | at least 3:1 |
| Every element carrying its own text | at least 11px |
| Logo | an `img` whose src ends `icon48.png` |
| Title | `-webkit-text-fill-color` not transparent |
| Scope pills | contain `online.iona.edu` |
| Whole popup | no emoji |
| Version tag | non-empty — proof `popup.js` survived load at all |
| Out-of-scope note | hidden by default, shown under `?offscope` |
| The toggle | enabled either way |
| `.toggle-title` | labels `darkToggle`, so the text is a hit target |
| Status text | carries `aria-live="polite"` |
| Rating prompt | shown, pointing at `/detail/<runtime.id>/reviews` |
| Rating prompt under `?noid` | hidden — an unpacked build has no id and must not link to `/detail/undefined/reviews` |
| Rating prompt colour | at least 4.5:1 |

The title check matters beyond looks. A gradient clipped to text needs a
transparent fill, so if the gradient ever fails to paint the title disappears
entirely.

**The stub has to answer everything `popup.js` touches at load.** It now reads
`content_scripts[0].matches` out of the manifest and calls `chrome.tabs.query`
with them to decide whether the active tab is one the extension themes; either
one missing throws at the top level and takes the whole popup script with it,
leaving every assertion above measuring a blank page. That is what the version
tag check is for — it is the cheapest possible canary for "the script ran".

`?offscope` makes the stubbed `tabs.query` return an empty list, which is how
the popup concludes the tab is out of scope. Without it that branch is never
exercised. `?noid` drops `chrome.runtime.id` from the stub, which is what an
unpacked build looks like — the rating prompt reads that id to build its link
and has to stay hidden rather than send anyone to a listing that is not this
one.

## fixture-surfaces.html

Covers the surface ladder in section 1 and the tier assignments in sections 6
and 10.

Two things were wrong before. Elevation was only applied when a rule matched a
hashed class name like `Card__`, which much of Blackboard Ultra does not use.
And the tokens could not express a hierarchy anyway: page to card measured
1.050:1 and card to raised 1.088:1, steps too small to see, so panels read flat
however well the selectors matched.

The selector half was fixed first and the tokens after, but the threshold the
fixture asserted — 1.08:1 per step — was set below the visibility floor, so a
ladder nobody could see still passed. **Contrast ratio is the wrong metric for
a step between two near-blacks:** it compresses hard at the bottom of the
range, and 1.08:1 and 1.21:1 look far more alike as numbers than the surfaces
they describe do on screen. The ladder is designed in CIE L\* instead, where
each tier is at least 3 L\* clear of its neighbours, and the ratios below are
recorded as consequences rather than targets.

| Tier | Token | L\* | step |
|---|---|---|---|
| page | `--bg-primary` | 2.8 | — |
| sidebar | `--bg-sidebar` | 6.1 | +3.3 |
| card | `--bg-secondary` | 12.1 | +9.3 on page |
| row stripe | `--bg-row-alt` | 15.5 | +3.4 on card |
| input | `--bg-tertiary` | 17.9 | +5.8 on card |
| raised | `--bg-raised` | 24.0 | +6.0 on input |

Each tier is matched three ways in the fixture, by semantic element, by ARIA
role and by the legacy class pattern, because roles are the reliable half of
the net. Blackboard's class names are JSS-generated, but its roles are stable
since assistive technology depends on them.

| Check | Expected | Measured |
|---|---|---|
| page, card, raised backgrounds | three distinct values | — |
| page to card | at least 1.15:1 | 1.21:1 |
| card to raised | at least 1.30:1 | 1.42:1 |
| Card border against card fill | at least 1.6:1 | 1.76:1 |
| `article`, `aside`, `[role="region"]`, `Card__` | resolve to the card fill | — |
| `[role="dialog"]`, `[role="menu"]`, `[role="listbox"]`, MUI paper | resolve to the raised fill | — |

Dialogs and menus carry `--border-raised` rather than `--border-strong`. One
border token cannot serve both a near-black canvas and a `#383844` dialog:
`--border-strong` measures 1.03:1 against the raised fill, which is no border
at all.

## fixture-hover.html

Covers which elements the zero-grey block treats as hoverable, and the anchors
Blackboard styles as buttons.

Synthesising a real pointer hover is unreliable, so the fixture asks the
cascade directly. For every rule whose selector contains `:hover` it strips the
`:hover` and tests `element.matches()` against the remainder, which is exactly
the set of rules that would apply while hovered. The comma split respects
nesting depth, since a comma inside `:is()` or `:has()` is not a selector
boundary.

`?css=` points at an alternative stylesheet, which is how a change gets
compared against the version before it:

```bash
git show HEAD:src/dark-mode.css > test/.tmp-old.css
```

| Element | Expected |
|---|---|
| Plain `<li>` bullet | no hover background rule |
| `<li>` containing a link, `<li role>` | a hover background rule applies |
| `arrow-icon`, `narrow-column`, `grow-wrap` | no hover background rule |
| `table-row`, `DataRow`, `[role="row"]` | a hover background rule applies |
| `tabindex="-1"`, `tabindex="0"` | no hover background rule |
| Inline `<a>` | no hover background, hover colour resolves to `--text-link-hover` |
| A wrapper: `tabindex="0"`, `message-Rows-container`, `listItems-scroller` | no hover background rule |
| The row inside each of those wrappers | a hover background rule applies |
| `<a><span>label</span></a>` | the span resolves to `--text-link`, not `--text-main` |

### Why the wrappers matter

Section 3 gives every element `background-color: inherit !important`, which
leaves a descendant with no background of its own to fall back to. A fill
landing on a container therefore **floods its entire subtree** — measured on a
bare `<div class="message-Row" tabindex="0">`, the container, its child, its
grandchild and its sibling all resolved to the hover fill. On the live pages
that washed whole regions of the activity stream in one colour.

Two selectors were doing it. `[tabindex]:not([tabindex="-1"])` is now gone
outright, because Blackboard puts `tabindex="0"` on scroll regions and it
matched wrappers the size of a page column. **That is a deliberate coverage
loss:** a genuinely interactive `<div tabindex="0">` with no other signal no
longer gets a hover. Every discriminator tried for keeping it — requiring no
focusable descendant, requiring no element children — either still matched
scroll regions or excluded real controls, and the other selectors in the block
(rows, list items, `clickable`, `li`, `[role]`) already cover the realistic
cases. The remaining substring selectors keep their coverage and instead carry
a `:not(:has(...))` guard so only the innermost match paints.

This went unnoticed for so long because the old grey hover measured 1.09:1
against the surface beneath it, so the flood was invisible. Retuning the
palette did not cause the bug; it revealed it.

Against the previous stylesheet every one of those "no hover" elements had a
hover background, and the inline link matched two colour rules with
`--text-main` winning, which is why the link hover token never applied.

The same page covers anchors styled as buttons. Section 8 already handled the
`Button--primary` and `Button--secondary` spellings, so the gap was anchors
named some other way, `btn-primary` being the common one, which took the link
colour and rendered as plain text with no affordance.

| Element | Expected |
|---|---|
| Plain inline `<a>` | link colour, no border |
| `<a class="btn">`, `<a role="button">` | not the link colour, visible border, transparent background |
| `<a class="btn btn-primary">` | maroon fill, white text, at least 4.5:1 |
| `<a class="Button--primary">` | still maroon, to catch a regression from the new rules outranking section 8 |

## grades/fixture-gradebook.html

The first fixture built from how Blackboard actually renders, rather than from
a guess. It exists because the colorizer was scoped to container class names
that do not appear on the real gradebook, so the walk reached nothing and the
feature died silently while every other fixture kept passing.

It reproduces the two conditions that caused that, deliberately: no element
carries a class the stylesheet recognises, and every cell is a `div` rather
than a `span`.

**The directory name is load-bearing.** The page sits under `test/grades/`
because the colorizer reads `location.pathname` to decide whether a bare
integer pair like `9 / 10` is a score or a calendar date. Moving this file out
of a `/grades` path changes what it tests.

```js
await window.__scriptReady;
__probe('cell-partial')   // { hostTag, hostDisplay, pillTag, status, ... }
```

| Check | Expected |
|---|---|
| `7.5 / 10`, `10.5 / 10` in a class-less div | stamped and pilled |
| `9 / 10` on a `/grades` path | scored, not rejected as a date |
| `80%` in a span | pill applied to the host directly |
| Block host | keeps `display: block`, carries no attribute itself |
| The pill | a wrapper `span` rendering `inline-flex` |
| `Not graded` | untouched |
| `<span>8</span> / <span>10</span>` | stamped; no single text node holds the value |
| The same split one level deeper | stamped |
| A split value inside an inline host | pill applied to the host directly |

Run it against an earlier implementation with `?impl=` to see the failures it
was written for. Against the version before the container gate was dropped it
reports zero stamped and zero pills. Against the version after that, the three
split-value rows are the ones left unstamped.

The split rows matter most. Reading whole elements with `textContent` was what
made the published 1.1.1 handle them, and switching to a text-node walk for
speed silently dropped that ability. The walk is still what runs first; an
ancestor's combined text is only read when a node looks like a fragment of a
number, which keeps the quadratic cost from coming back.

## A note on fixture HTML caching

The fixtures cache-bust the assets they load, but not themselves. After editing
a fixture's own markup or probes, add a throwaway query such as `?v=2`, or the
browser will serve the previous copy and you will be reading stale assertions
against current code.

## fixture-focus.html

Covers section 32 (focus), 33 (selection), 34 (motion and forced colours),
the scrollbar in section 11 and the CTA rim in section 8. None of that tier
had any coverage at all, and most of it had no implementation either.

Before this, the only focusable thing on the page that showed where the
keyboard was, was a text input. Everything else — buttons, links, tabs, menu
items, options — had nothing, and inside the activity stream section 22
actively removed the browser's own ring by forcing `outline-color:
transparent` onto every descendant. Tabbing through a course was invisible.

Two constraints on the fix are what the fixture actually guards:

The ring has to be an **outline**, not a box-shadow, because that same section
22 rule forces `box-shadow: none` and would erase a shadow-based ring exactly
where it matters most. And it has to outrank (0,2,1), which is why the rule
leads with `body` and lands at (0,2,2).

Selectors are interrogated rather than focused, the same way
`fixture-hover.html` does it: strip the pseudo-class and test
`element.matches()` against the remainder. Two traps live in that technique
and both are handled here —

- The CSSOM normalises `body *:focus-visible` to `body :focus-visible`, so
  naively removing the pseudo leaves a dangling descendant combinator.
  `html[data-bb-dark] body` matches only `<body>`, not the button inside it,
  and every assertion silently reports "no ring". The universal selector goes
  back in wherever the strip leaves a trailing combinator.
- A `CSSStyleRule` now carries its own empty `cssRules` list so CSS nesting
  works, so `if (rule.cssRules)` recurses into every ordinary rule and yields
  nothing. Only rules with `cssRules.length` are grouping rules.

Declared values are read out of `cssText`, not `getPropertyValue`: a shorthand
whose value contains `var()` — `outline: 2px solid var(--border-focus)` — is
stored as a pending substitution and `getPropertyValue` returns `""`.

| Check | Expected | Measured |
|---|---|---|
| button, link, `[role="tab"]`, `[role="option"]`, `[role="menuitem"]`, `[tabindex]` | a focus ring rule applies | — |
| a button and a link **inside `.activity-stream`** | a ring too — section 22 must not win | — |
| Ring vs all seven surfaces and the CTA fill | at least 3:1 | 5.47:1 worst |
| Scrollbar thumb vs track | at least 3:1 | 5.48:1 |
| `scrollbar-color` / `scrollbar-width` | present for non-Chromium | — |
| `::selection` fill vs its text | at least 4.5:1 | 8.86:1 |
| Primary CTA rim vs page | at least 3:1 | 3.57:1 |
| A plain `div` and a `.darkboard-pill` | no transition rule |  — |
| button, link, row | a transition rule applies | — |

The pill exclusion is deliberate rather than incidental. The content script
stamps those after a re-render, and a pill fading up from the page colour
reads as a bug rather than a grade.

## fixture-panel.html

Covers section 35, and the reason it needs to exist.

Blackboard's slide-in panel — announcements, discussion threads, item details
— puts its title in `h1.panel-title` inside a wrapper it names
`black-header-contents`. The name is the intent: black text on a header bar
that is light in Blackboard's own theme. On this canvas the bar went dark and
the title stayed `rgb(38, 38, 38)`, so an announcement opened as a 30px
heading nobody could read.

**This is the first confirmed case of Blackboard outranking the entire
stylesheet.** Section 4 already sets `h1 { color: var(--text-heading) }` and
loses. Escalated against the live page:

| Selector | Specificity | Result |
|---|---|---|
| `html[data-bb-dark] h1` | (0,1,2) | loses |
| `html[data-bb-dark] body h1` | (0,1,3) | loses |
| `html[data-bb-dark] h1.panel-title` | (0,2,2) | loses |
| `html[data-bb-dark] body h1.panel-title` | (0,2,3) | loses |
| `html[data-bb-dark] body [class*="black-header"] h1` | (0,3,3) | loses |
| the same plus one `:not(#id)` | (1,2,3) | **wins** |

Blackboard has an ID-scoped colour rule here; there is an `id="site-wrap"`
ancestor and their sheets are cross-origin, so it cannot be read directly.
**Nothing else in `dark-mode.css` exceeds (0,3,x)**, which means any
ID-scoped rule of theirs beats all of it. `:not(#_darkboard)` is how section
35 reaches ID level — it matches everything and exists only to add (1,0,0).
It is not a typo, and deleting it silently reintroduces the bug.

The fixture loads a simulated Blackboard rule **after** the theme, so source
order cannot be what saves us — only specificity can.

| Check | Expected | Measured |
|---|---|---|
| Header bar | the brand maroon | `rgb(111, 44, 62)` |
| Title on the bar | at least 4.5:1 | 9.97:1 |
| Eyebrow on the bar | at least 4.5:1 | 9.97:1 |
| Panel body copy | untouched | `--text-main` |

Run it with `?css=` against the previous stylesheet and the title measures
**1.22:1** — a black heading on the dark bar, which is the bug as reported.

A first draft of this fixture also gave Blackboard the header *background*.
That was wrong, and worth recording: the live panel computes its bar as
`rgb(19, 19, 25)`, our own `--bg-sidebar`, so the theme already wins there
and only loses the text. With the invented rule in place the pre-fix
stylesheet rendered black-on-white and scored 15:1 — the fixture passed on a
fight that does not happen. **Reproduce the real cascade, not a harder
invented one**, or the fixture certifies the bug.

## fixture-fouc.html

Covers the extension's headline claim: `[data-bb-dark]` is on `<html>` before
first paint.

Half of it was already true — the manifest injects `dark-mode.css` at
`document_start`. The other half was not. Every rule in the stylesheet is
gated on that attribute, and it used to be set inside the callback of an
**async** `chrome.storage.local.get`. The stylesheet was fully loaded before
the first frame with nothing to switch it on.

The race was nearly always won, which is precisely why this fixture has to
exist and why none of the others caught it: they stub storage with
`setTimeout(…, 0)`, far too fast to ever expose the gap. This one resolves
after **300 ms**, which makes "synchronous" and "one tick later" impossible to
confuse.

`content.js` runs in an iframe per scenario so each gets a clean global scope —
the script declares `const`s at top level and throws on a second evaluation.

**The load-bearing detail:** the gate is read on the line immediately after
the script's `onload`, synchronously. Deferring that read to a timeout or a
frame would let the storage callback land first, and the assertion would prove
nothing while still passing.

| Scenario | Expected |
|---|---|
| Fresh profile, preference on | gate up **before** the read resolves, mirror written `on` |
| Mirror says `off` | no gate at any point — no dark flash for someone who turned it off |
| Mirror `on`, storage says `off` | optimistic gate, then corrected, mirror rewritten `off` |
| `localStorage` throws | gate up anyway, nothing escapes — a throw here would kill `content.js` at `document_start` and take the theme with it |
| Toggle message | mirror tracks the new value both ways |

`?impl=` points at an alternative content script, the same convention
`fixture-perf.html` uses:

```bash
git show HEAD:src/content.js > test/.tmp-old-content.js
```

Against the version before the fix it reports **7 failures**, led by
`gate not set synchronously`.

### The mirror

A content script has no synchronous access to `chrome.storage`, but it does
have synchronous access to `localStorage` on the page's own origin. The
preference is mirrored to `darkboard.enabled` there and read on the next line
rather than the next tick.

`chrome.storage` remains the single source of truth; the mirror is consulted
for exactly one thing, the value to use before the real one arrives. It is
written from `content.js` only — `popup.js` runs on the extension origin and
cannot reach Blackboard's `localStorage`.

It goes stale in one case: the preference changed while this origin had no tab
open. That costs a single frame of the wrong theme on the next load, after
which it is rewritten and every load thereafter is clean.

**`fixture-stream.html` clears that key on load.** It survives between runs on
this origin, so without clearing it a previous `?off` run would decide the
opening frame of the next default run and the fixture would report whatever it
was last asked to do.

## accent.test.js

Not a fixture. `src/accent.js` derives the whole accent ramp from a single
institution colour, and it is pure — no DOM, no `chrome.*` — so it can be run
over a thousand colours in a second. That matters more here than anywhere else
in this repo: the schools this has to work for are ones nobody can look at, so
"it looks right at Iona" is not evidence of anything.

The rule is that for every input the ramp either meets **every** constraint or
is explicitly rejected. There is no silent middle where something almost
readable ships.

| Section | What it covers |
|---|---|
| Real institution colours | 14 actual university brand colours |
| Hue / saturation / lightness sweep | 1,080 colours — 874 derive, 206 correctly rejected |
| Rejections | `#262626`, black, white, mid grey, malformed input, `null` |
| Iona must not move | derived ramp vs the shipped one, in OKLab ΔE |
| Source resolution | the curated map, including prototype-chain leaks |
| Surfaces agree with the CSS | the ring is only trustworthy if this list is the real ladder |

### Three bugs this caught that a fixture would not have

**A hover nobody can see.** For very light, high-chroma fills the accent sits
at the lightness ceiling, so "lighten for hover" clamped and produced a hover
*identical to the fill*. 65 colours in the sweep, all yellows and greens near
white. Hover now tries the other direction when the preferred one has no room.

**A distinctness check that could not see.** That bug was originally measured
in contrast ratio, which compresses at both ends: it scored a clearly visible
step between two pale yellows at 1.00 and an invisible one between two
near-blacks at 1.10. Both the module and the test now measure in OKLab
lightness, which is the whole reason the module is in OKLCH.

**A drift check that could not see either.** The Iona comparison first used a
contrast ratio too, and passed `#c02e5e → #9b5364` at "1.01" — two colours can
share a luminance and look nothing alike. It uses ΔE in OKLab now, which
immediately showed the rim drifting 0.087 and led to the chroma boost that
brought it to 0.011.

## fixture-accent.html

The half Node cannot see: that the derived values actually reach `<html>`, that
the stylesheet consumes them, and that every failure path leaves the theme as
it ships.

| Scenario | Expected |
|---|---|
| Curated host | derived ramp on `<html>`, primary button wears `rgb(111, 44, 62)` |
| Unknown host | nothing written inline; CSS defaults stand |
| `accent.js` absent entirely | `content.js` survives, gate still goes on, CSS defaults stand |

`location` is non-configurable, so rather than mocking the hostname the fixture
registers its own in the curated map — which exercises the real
`baseFor → derive → setProperty` path with nothing stubbed.

**A top-level `const` is a lexical binding, not a property of `window`.** The
first version registered through `win.DarkboardAccent`, which is `undefined`,
so it silently tested the fallback path twice and passed. It reaches the module
through the frame's own `eval` now. `content.js` sees it because content
scripts share one lexical scope — which is exactly how the manifest loads the
two files — but nothing outside that scope can.

## fixture-overlay.html

Covers the black screen: every page of Blackboard rendering as a dark sheet
with no content, on one machine, with the extension on.

It never reproduced on the developer's machine, and checking the live DOM
explained why — none of the backdrop selectors in section 10 match anything on
that Blackboard build. The rules were inert there and catastrophic elsewhere.

**Two rules were painting elements that should paint nothing**, and the second
one is the one that actually blacked out the page:

- Section 10 forced eleven backdrop selectors to `rgba(0, 0, 0, 0.65)` plus a
  2px blur, with `!important` and no condition on the panel being open.
  Blackboard keeps its peek backdrop mounted when closed, hidden only by being
  transparent.
- Section 26's `[class*="bb-"]` sweep forces an **opaque** page-black fill, and
  that substring matches Blackboard's own `bb-offcanvas-overlay` and
  `bb-slideout-backdrop`. Sitting late in the file at equal specificity, it beat
  the transparent rules on source order — so fixing section 10 alone moved the
  failure count from 18 to 2 and left the screen just as black.

The fixture models both states of every affected selector. **The closed state
is the whole point**: mounted, full-viewport, and transparent, which is exactly
how a closed backdrop hides itself.

| Check | Expected |
|---|---|
| Ten closed backdrops | paint nothing, blur nothing |
| Three open backdrops | never show Blackboard's pale scrim |
| The heading behind them | still readable against the page |

Against the build before the fix it reports **18 failures**; after, zero. The
two `Overlay__` / `Backdrop__` cases are worth reading in the pre-fix output —
they land on fully opaque `rgb(10, 10, 12)` with no blur at all, which is
precisely "the screen just turns black".

### What the fix gives up

An open panel no longer gets a dimmed scrim behind it. That is a real loss and
a small one: the panel still sits on a dark page, and on every build we can
observe, the scrim was not being drawn anyway. Restoring it safely means
deciding per element whether the backdrop is genuinely open — a question only
the computed style can answer, which is what `enforceStreamDark` in
`content.js` already does for stream rows.

The fixture asserts the open state is *not pale* rather than *is dark*, so it
encodes that trade rather than quietly forbidding it.

## restyle.js

Forces a genuine style resolution on an element before it is measured, which
a hidden tab otherwise defers. See **A note on visibility** for the symptom;
it is the one that makes assertions pass for the wrong reason rather than
fail, so it is worth knowing by sight.

```js
__restyle(el)       // re-insert in place — same identity, same position
__restyleTree(el)   // settle the whole subtree, for inherited properties
__computed(el, 'color')
```

Re-inserting a node is what forces it. Toggling `display` is not enough for
an inherited property, because the ancestor it descends from is never
dirtied.

## contrast.js

Shared WCAG luminance and contrast helper, loaded by the fixtures that assert
accessibility thresholds. Ratios are computed from whatever the page actually
renders, so the assertions keep their meaning if the palette is retuned.

## A note on caching

Both fixtures inject `dark-mode.css` with a timestamp query, because
`python3 -m http.server` lets the browser cache it and you would otherwise be
testing a stale stylesheet without any sign that anything was wrong.
`fixture-stream.html` does the same for `content.js`.
