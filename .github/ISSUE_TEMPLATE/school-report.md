---
name: Problem at my school
about: Something is hard to read on your school's Blackboard (DarkBoard beta)
title: "[school] "
labels: school-beta
---

**School's Blackboard address** (e.g. `learn.school.edu`):

**Which page** (stream, a course, grades, calendar, a test…):

**What's wrong** (unreadable text, a white box, something missing). A screenshot helps. Crop out names and grades first.

**Page details.** On the page with the problem, open DevTools (⌥⌘I on Mac, Ctrl+Shift+I on Windows), go to Console, type `allow pasting` and press Enter, then paste this and press Enter. It copies a short summary to your clipboard; paste it below. It reads the address, the page path and which frames are embedded, nothing else.

```js
copy(JSON.stringify({
  host: location.host,
  path: location.pathname,
  frames: [...document.querySelectorAll('iframe')].map((f) => {
    try { const u = new URL(f.src, location.href); return u.origin + u.pathname; } catch { return f.src; }
  }),
  paletteMain: getComputedStyle(document.documentElement).getPropertyValue('--palette-primary-main').trim(),
}, null, 2));
```

```json
paste here
```
