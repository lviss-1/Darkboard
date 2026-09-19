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

Covers the semantic state colors in `dark-mode.css` section 31.

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

## A note on caching

Both fixtures inject `dark-mode.css` with a timestamp query, because
`python3 -m http.server` lets the browser cache it and you would otherwise be
testing a stale stylesheet without any sign that anything was wrong.
`fixture-stream.html` does the same for `content.js`.
