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
