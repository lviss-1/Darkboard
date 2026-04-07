# Darkboard — Dark Mode for Blackboard Ultra

> A Chrome extension built for Iona University students who are tired of staring at a blinding white learning management system.

---

## Why I Built This

Blackboard Ultra does not offer a native dark mode, and there is no setting to change it. As an Iona University student, I found myself spending hours every week on `online.iona.edu` — reading course content, checking grades, submitting assignments — all on a harsh white interface with no way to reduce the glare.

Eye strain from prolonged screen exposure is a real problem, especially for students who use Blackboard late at night or in low-light environments. After repeated headaches from the unchangeable light theme, I decided to build the solution myself.

Darkboard is the result: a lightweight, purpose-built browser extension that applies a polished dark theme to Blackboard Ultra at Iona University, with zero configuration required.

---

## Who This Is For

**Darkboard is built specifically for Iona University students** who access Blackboard through `online.iona.edu`.

If you:
- Experience eye strain or headaches from extended Blackboard sessions
- Study or do coursework at night or in low-light settings
- Prefer dark interfaces across your apps and want Blackboard to match
- Are frustrated that Blackboard gives you no way to change the theme yourself

— this extension was made for you.
(PSA. Although this extension is currently only for Iona students I am looking forward to trying to distribute it to all Universities that use Blackboard as well)

---

## Install from the Chrome Web Store

**No developer mode or manual setup required.**

1. Open the [Chrome Web Store listing](https://chromewebstore.google.com/detail/dark-mode-for-blackboard/ogkjalalkednannikfgjhcnmgcepkeip?authuser=0&hl=en) and search for **"Darkboard"** or **"Dark Mode for Blackboard Ultra"**
2. Click **Add to Chrome**
3. Confirm the permissions prompt
4. Navigate to [online.iona.edu](https://online.iona.edu) — dark mode is on by default
5. Click the Darkboard icon in your toolbar to toggle it on or off at any time

> Compatible with Chrome and any Chromium-based browser (Edge, Brave, Arc, etc.) that supports Chrome Web Store extensions.

---

## Features

| Feature | Detail |
|---|---|
| Zero flash of white | CSS is injected at `document_start` — the dark theme is already applied before the page paints |
| iFrame support | `all_frames: true` ensures every embedded Blackboard panel is covered, not just the top-level page |
| Persistent preference | Your toggle choice survives browser restarts via `chrome.storage.local` |
| Cross-tab sync | A background service worker broadcasts state changes to every open Blackboard tab simultaneously |
| Grade colorizer | Grades are visually color-coded green, yellow, or red based on percentage — without touching any Blackboard data |
| Scoped exclusively | Only activates on `online.iona.edu` and `*.blackboardcdn.com` — no other sites are touched |

---

## How It Works

Blackboard Ultra is a React-based single-page application. Applying a dark theme to it requires solving three specific problems: flash of white on load, Blackboard's own JavaScript undoing style changes, and embedded iframes that live in separate document contexts.

**1. Zero FOUC (Flash of Unstyled Content)**

The extension uses `"run_at": "document_start"` in the manifest, which causes `dark-mode.css` to be injected before the browser paints anything. A `[data-bb-dark]` attribute is stamped onto `<html>` within ~1–3ms of the storage read, so the dark theme is active before any white background can flash on screen.

**2. Attribute Guard**

Blackboard's SPA sometimes re-renders the `<html>` element, which can strip custom attributes. A `MutationObserver` watches for this and immediately restores the `[data-bb-dark]` attribute if it is removed, keeping the theme persistent throughout navigation.

**3. Stream Background Enforcement**

The activity stream in Blackboard Ultra injects light-colored backgrounds via high-specificity class names that survive standard CSS overrides. A DOM mutation observer monitors the document for these elements and force-applies dark backgrounds whenever they appear, before the next frame renders.

**4. Cross-Tab State Sync**

When you toggle dark mode in the popup, `popup.js` sends a message to `background.js` (the service worker). The service worker queries all open Blackboard tabs and broadcasts the new state to each one. Every tab updates instantly — no page refresh required.

**5. Grade Colorizer**

CSS cannot do arithmetic, so `content.js` reads grade strings like `"63 / 65"` from the DOM, calculates the percentage, and stamps a `data-grade-status` attribute (`good`, `average`, or `poor`) onto the element. The CSS then uses that attribute as a hook to apply green, yellow, or red pill styling.

---

## Project Structure

```
iona-darkmode/
├── manifest.json          # Extension config (Manifest V3)
├── popup.html             # Toggle UI — rendered when you click the extension icon
├── icons/                 # Extension icons at 16, 48, and 128 px
└── src/
    ├── content.js         # Injected into every Blackboard page at document_start
    ├── dark-mode.css      # Full dark theme built on CSS custom properties
    ├── background.js      # Service worker — handles cross-tab broadcast and badge
    └── popup.js           # Toggle logic, state persistence, and UI updates
```

---

## Loading Unpacked (Developer / Testing)

To run the extension directly from source without installing from the store:

1. Go to `chrome://extensions`
2. Enable **Developer Mode** (toggle in the top-right corner)
3. Click **Load unpacked**
4. Select this project folder
5. Navigate to any `online.iona.edu` page

---

## Customising the Theme

All color values are defined as CSS custom properties in [src/dark-mode.css](src/dark-mode.css). To change any color, edit the `:root` block — every rule in the stylesheet reads from these variables, so no other changes are needed.

```css
:root {
  --bg-primary:     #0f1117;   /* Page background */
  --accent-primary: #5c7cfa;   /* Buttons and focus rings */
  /* ... */
}
```

---

## Permissions

| Permission | Reason |
|---|---|
| `storage` | Saves your dark mode toggle preference across sessions |
| `tabs` | Allows the background service worker to broadcast state to all open Blackboard tabs |
| `host_permissions` on `online.iona.edu` and `*.blackboardcdn.com` | Scopes the extension strictly to Blackboard — no access to any other website |

---

*Built by an Iona University student for Iona University students. Scoped exclusively to Iona's Blackboard instance.*
