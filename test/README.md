# Fixtures

Standalone pages that reproduce Blackboard rendering conditions locally, so the
theme and the content script can be checked without a Blackboard login.

Each fixture stubs the extension APIs (`chrome.storage`, `chrome.runtime`) and
loads `src/content.js` and `src/dark-mode.css` unmodified, then exposes helpers
on `window` for driving and inspecting the result.

## Running

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

The title check matters beyond looks. A gradient clipped to text needs a
transparent fill, so if the gradient ever fails to paint the title disappears
entirely.

## fixture-surfaces.html

Covers the surface ladder in section 1 and the tier assignments in sections 6
and 10.

Two things were wrong before. Elevation was only applied when a rule matched a
hashed class name like `Card__`, which much of Blackboard Ultra does not use.
And the tokens could not express a hierarchy anyway: page to card measured
1.050:1 and card to raised 1.088:1, steps too small to see, so panels read flat
however well the selectors matched.

Each tier is matched three ways in the fixture, by semantic element, by ARIA
role and by the legacy class pattern, because roles are the reliable half of
the net. Blackboard's class names are JSS-generated, but its roles are stable
since assistive technology depends on them.

| Check | Expected |
|---|---|
| page, card, raised backgrounds | three distinct values |
| page to card, card to raised | at least 1.08:1 each, measured |
| Card border against card fill | at least 1.2:1 |
| `article`, `aside`, `[role="region"]`, `Card__` | resolve to the card fill |
| `[role="dialog"]`, `[role="menu"]`, `[role="listbox"]`, MUI paper | resolve to the raised fill |

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
| `tabindex="-1"` | no hover background rule |
| `tabindex="0"` | a hover background rule applies |
| Inline `<a>` | no hover background, hover colour resolves to `--text-link-hover` |

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

Run it against the previous implementation with `?impl=` to see the failure it
was written for: zero stamped, zero pills.

## A note on fixture HTML caching

The fixtures cache-bust the assets they load, but not themselves. After editing
a fixture's own markup or probes, add a throwaway query such as `?v=2`, or the
browser will serve the previous copy and you will be reading stale assertions
against current code.

## contrast.js

Shared WCAG luminance and contrast helper, loaded by the fixtures that assert
accessibility thresholds. Ratios are computed from whatever the page actually
renders, so the assertions keep their meaning if the palette is retuned.

## A note on caching

Both fixtures inject `dark-mode.css` with a timestamp query, because
`python3 -m http.server` lets the browser cache it and you would otherwise be
testing a stale stylesheet without any sign that anything was wrong.
`fixture-stream.html` does the same for `content.js`.
