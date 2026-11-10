# DarkBoard

Dark mode for Blackboard Ultra. Install it once and every page is dark from the first frame.

<img width="1280" height="800" alt="DarkBoard on Iona's Blackboard" src="https://github.com/user-attachments/assets/53db7d69-ec29-4e1e-8554-7d96f5aa702f" />

**[Install from the Chrome Web Store](https://chromewebstore.google.com/detail/blackboard-dark-mode-dark/ogkjalalkednannikfgjhcnmgcepkeip)** · 100+ users

## Why

Blackboard Ultra has no dark mode and no way to add one. Staring at a white page for hours is rough on your eyes, especially at night, which is when most of us are on it. So I fixed it for myself and put it up for everyone else.

## What was hard

Theming a page you don't control is a few separate problems, and "write some dark CSS" is the easy one.

- **The white flash.** Extensions that theme after the page paints flash white first. DarkBoard injects its CSS at `document_start` and stamps `[data-bb-dark]` on `<html>` before the first paint.
- **React undoing my work.** Blackboard re-renders as you navigate and strips what I add. A `MutationObserver` puts the theme back whenever that happens.
- **Tabs disagreeing.** Toggle dark mode in one tab and the rest should follow. A background service worker pushes the change to every open Blackboard tab, so nothing polls storage. MV3 workers get shut down after about 30 seconds idle, so it rebuilds its state when it wakes. The preference itself lives in `chrome.storage.local`.
- **Iframes.** A lot of Blackboard lives in iframes that ignore the parent page's styles. `all_frames: true` runs the content script in every one.

There's also a grade colorizer that turns grades green, yellow or red. CSS can't do arithmetic, so the content script computes the percentage and sets a `data-grade-status` attribute for the stylesheet to key off. It's the smallest feature and my favorite.

## Other schools (beta)

Iona (`online.iona.edu`) works out of the box. For any other school, open your Blackboard, click the DarkBoard icon and choose **Enable on this school**. Chrome asks for access to that one site and nothing else.

I built and tested the theme on Iona's Blackboard, so other schools get a neutral indigo accent. If something is hard to read, [open an issue](https://github.com/lviss-1/Darkboard/issues/new?template=school-report.md) or use the **Report a problem** link in the popup.

Next up: pulling each school's accent color from its own logo.

## Install from source

```
git clone https://github.com/lviss-1/Darkboard
```

Then go to `chrome://extensions`, turn on Developer Mode, click **Load unpacked** and pick the cloned folder.

## Stack

Manifest V3, vanilla JavaScript, CSS custom properties, a background service worker, `chrome.storage.local`. No frameworks, no build step.
