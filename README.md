# Darkboard — Dark Mode for Blackboard Ultra

A polished, zero-FOUC dark theme for Blackboard Ultra (Iona University). Built with Manifest V3, CSS variables, and zero dependencies.

## Install from the Chrome Web Store

**Darkboard is published on the Chrome Web Store — no developer mode or manual setup required.**

1. Open the [Chrome Web Store listing](https://chromewebstore.google.com/detail/dark-mode-for-blackboard/ogkjalalkednannikfgjhcnmgcepkeip?authuser=0&hl=en) and search for **"Darkboard"** or **"Dark Mode for Blackboard Ultra"**
2. Click **Add to Chrome**
3. Confirm the permissions prompt
4. Navigate to [online.iona.edu](https://online.iona.edu) — dark mode is on by default
5. Click the Darkboard icon in your toolbar to toggle it on or off at any time

> Works on Chrome and any Chromium-based browser (Edge, Brave, Arc, etc.) that supports Chrome Web Store extensions.

## Features

| Feature | Detail |
|---|---|
| Zero FOUC | CSS injected at `document_start`; dark attribute applied in ~1ms — no flash of white |
| iFrame support | `"all_frames": true` covers every embedded Blackboard panel |
| Persistent state | Toggle preference survives browser restarts via `chrome.storage.local` |
| Cross-tab sync | Background service worker broadcasts state to all open Blackboard tabs instantly |
| Scoped | Only activates on `online.iona.edu` and `*.blackboardcdn.com` — no other sites touched |

## How it Works

The extension injects `dark-mode.css` at `document_start` so the dark theme is applied before the page renders, eliminating any flash of white. A lightweight service worker (`background.js`) listens for toggle events and broadcasts the new state to every open Blackboard tab, keeping all windows in sync. All colour values live in CSS custom properties on `:root`, making the theme easy to inspect and override.

## Project Structure

```
iona-darkmode-v1/
├── manifest.json          # Extension config (MV3)
├── popup.html             # Toggle UI
├── icons/                 # Extension icons (16, 48, 128 px)
└── src/
    ├── content.js         # Injected into every Blackboard page at document_start
    ├── dark-mode.css      # Full dark theme (CSS custom properties)
    ├── background.js      # Service worker — cross-tab state sync
    └── popup.js           # Toggle logic & state management
```

## Loading Unpacked (Dev / Testing)

If you want to run the source directly without installing from the store:

1. Go to `chrome://extensions`
2. Enable **Developer Mode** (top-right toggle)
3. Click **Load unpacked**
4. Select this project folder
5. Navigate to any `online.iona.edu` page

## Customising the Theme

Open [src/dark-mode.css](src/dark-mode.css) and edit the `:root` block:

```css
:root {
  --bg-primary:     #0f1117;   /* Page background */
  --accent-primary: #5c7cfa;   /* Buttons & focus rings */
  /* ... */
}
```

Every rule reads from these variables — no other changes needed.

---

*Portfolio project. Scoped exclusively to Iona University's Blackboard instance.*
