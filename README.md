# Darkboard — Dark Mode for Blackboard Ultra

A zero-FOUC Chrome/Edge/Firefox extension that brings a polished dark theme
to Blackboard Ultra. Built with Manifest V3, CSS variables, and no dependencies.

## Project Structure

```
bb-darkmode/
├── manifest.json          # Extension config (MV3)
├── popup.html             # Toggle UI
├── icons/                 # Extension icons (16, 48, 128px)
└── src/
    ├── content.js         # Injected into every BB page at document_start
    ├── dark-mode.css      # The entire dark theme (CSS variables)
    ├── background.js      # Service worker — cross-tab sync
    └── popup.js           # Toggle logic & state management
```

## Loading in Chrome / Edge (Dev Mode)

1. Go to `chrome://extensions` (or `edge://extensions`)
2. Enable **Developer Mode** (top-right toggle)
3. Click **Load unpacked**
4. Select the `bb-darkmode/` folder
5. Navigate to any `*.blackboard.com` page — dark mode is on by default!

## Loading in Firefox

1. Go to `about:debugging#/runtime/this-firefox`
2. Click **Load Temporary Add-on...**
3. Select `manifest.json` inside the `bb-darkmode/` folder

> Note: Firefox temporary add-ons are removed on browser restart.
> For persistent installation, the extension must be signed via AMO.

## How it Works

| Concern | Solution |
|---|---|
| Zero FOUC | CSS injected at `document_start`; `[data-bb-dark]` attribute applied in ~1ms |
| iFrames | `"all_frames": true` in manifest content_scripts |
| Persistence | `chrome.storage.local` survives restarts |
| Cross-tab sync | `background.js` broadcasts to all open BB tabs |
| Maintainability | All colours in CSS variables in `:root` |

## Customising the Theme

Open `src/dark-mode.css` and edit the `:root` block at the top:

```css
:root {
  --bg-primary:   #0f1117;   /* ← Change this to retheme the page background */
  --accent-primary: #5c7cfa; /* ← Change this to retheme buttons / focus rings */
  /* ... */
}
```

No other changes needed — every rule reads from these variables.
