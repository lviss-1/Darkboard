# DarkBoard

Dark mode for Blackboard Ultra. One install, zero configuration, zero flash of white.

<img width="1280" height="800" alt="online iona edu_ultra_institution-page" src="https://github.com/user-attachments/assets/53db7d69-ec29-4e1e-8554-7d96f5aa702f" />


[![Chrome Web Store](https://img.shields.io/badge/Chrome_Web_Store-Published-4285F4?style=flat-square&logo=googlechrome&logoColor=white)](https://chromewebstore.google.com/detail/blackboard-dark-mode-dark/ogkjalalkednannikfgjhcnmgcepkeip)
![Manifest V3](https://img.shields.io/badge/Manifest-V3-orange?style=flat-square)
![Version](https://img.shields.io/badge/version-1.2.1-blue?style=flat-square)

## The problem

Blackboard Ultra ships no dark mode and gives students no way to add one. Anthology builds for universities, not students, so it's never been prioritized. Staring at a blinding white LMS for hours causes real eye strain — especially at night, which is when most students are actually using it.

## What it does

Install DarkBoard once and every page on your school's Blackboard automatically switches to a dark theme. No settings to configure, no theme to pick — it just works, immediately, on first load.

## Technical highlights

The interesting part of this project isn't "I added dark CSS" — it's three specific problems that only show up once you try to theme a page you don't control:

**Zero flash of white.** Most dark-mode extensions apply their theme after the page paints, so you see a white flash before it switches. DarkBoard injects CSS at `document_start` and stamps a `[data-bb-dark]` attribute onto `<html>` before first paint, so the dark theme is present from the first frame.

**Surviving a React SPA that fights back.** Blackboard Ultra is a React app — it re-renders and strips injected attributes/styles as the user navigates. A `MutationObserver` watches for that and re-applies the theme attribute whenever Blackboard's own JS tries to undo it.

**Cross-tab sync without polling.** If you toggle dark mode in one tab, every other open Blackboard tab needs to reflect that immediately. Rather than polling `chrome.storage`, an MV3 background service worker broadcasts the toggle via `chrome.tabs.query` + `sendMessage` to every open tab, and rehydrates its own state on the ~30-second MV3 worker-termination cycle. Preference itself persists via `chrome.storage.local`.

**Iframes in separate document contexts.** Blackboard renders significant content inside iframes, which don't inherit the parent page's injected styles. Solved with `all_frames: true` in the manifest so the content script runs in every frame, not just the top one.

There's also a grade colorizer (parses grade strings from the DOM, computes percentages client-side since CSS can't do arithmetic, and stamps a `data-grade-status` attribute the stylesheet keys off) — it's a smaller feature but a fun one if you're looking at the code.

## Stack

![JavaScript](https://img.shields.io/badge/JavaScript-F7DF1E?style=flat-square&logo=javascript&logoColor=black)
![CSS3](https://img.shields.io/badge/CSS-Custom_Properties-1572B6?style=flat-square&logo=css3&logoColor=white)
![Chrome Extension API](https://img.shields.io/badge/Chrome_Extension_API-MV3-4285F4?style=flat-square&logo=googlechrome&logoColor=white)

Manifest V3, vanilla JS content script + background service worker, `chrome.storage.local` for persistence.

## Known scope / roadmap

- **Other schools (beta).** Iona (`online.iona.edu`) is built in. Any other school is opt-in: open your school's Blackboard, click the DarkBoard icon, and choose **Enable on this school**. Chrome asks for access to that one site only, and nothing else is requested. The theme is built and tested on Iona's Blackboard, so other schools get a neutral indigo accent and a **Report a problem** link. If something is hard to read, [open an issue](https://github.com/lviss-1/Darkboard/issues/new?template=school-report.md).
- **Next:** derive each school's accent from its own logo, cached per site so the first frame is still correct.

- `googlef3331e5ec48014da.html` at the repo root is a Google Search Console verification token, not a stray file. Deleting it breaks domain verification.

## Install

**From the Chrome Web Store:** [Dark Mode for Blackboard](https://chromewebstore.google.com/detail/blackboard-dark-mode-dark/ogkjalalkednannikfgjhcnmgcepkeip)

**From source:**
```
1. Clone this repo
2. Go to chrome://extensions
3. Enable Developer Mode (top right)
4. Click "Load unpacked" and select the cloned folder
```

*Built by an Iona University student for Iona University students, and now open to other schools in beta.*
