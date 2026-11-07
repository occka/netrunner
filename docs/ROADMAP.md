# Roadmap

## Phase 1: Foundation and COMMAND (done)
Tauri/React/Rust/SQLite foundation, shell, design system, dashboard with edit mode, Quick Access, palette, profiles, settings, migrations with backups.

## Phase 2: System integration (done)
Tray, close-to-tray, autostart, single instance · GPU and disk I/O via PDH · processes with guarded termination · startup apps · services (read-only) · power plans · NETWORK module (connectivity, adapters, VPN-type adapters) · GAMES (Steam, Epic, GOG, Prism Launcher, custom) · INTEGRATIONS (14 apps, capability matrix) · AUTOMATION engine · OVERLAY windows with global hotkey.

Not done in Phase 2 (moved later):
- Audio devices and per-app volume (needs Core Audio COM).
- Starting/stopping services (needs elevation, which NETRUNNER avoids).
- CPU temperature and fan speed: Windows has no standard API for user apps. A bridge to HWiNFO shared memory is the realistic option.
- Per-profile Quick Access sets and overlay sets.

## Phase 3: Developer and GitHub (done)
Monaco editor, project explorer, ConPTY terminals, Run file, toolchain detection with path overrides, Git (status, stage, discard, commit, branches, pull, push, history, diff), GitHub (token auth, repos, PRs, issues, clone).

Language servers and the debugger arrived in 0.8, semantic colours and Node.js in 0.9. Not done:
- OAuth device-flow sign-in: needs a registered GitHub OAuth app; PAT is used today.

## Phase 4: Neural and Files (done, partial)
Gemini (key in Credential Manager, streaming, model choice, overload fallback), explicit-context assistant, AI edit proposals through the diff view, Inspector/FILES "Ask AI", FILES module (tabs, operations, search, preview).

Not done in Phase 4:
- Archive browsing, duplicate detection, opt-in index for instant search.
- Persistent chat history (in-memory only today, by design for privacy).
- AI-assisted semantic search in the command palette.
- AI coding assistant with tools in DEVELOPER (it intentionally has none there; context is explicit). NEURAL's own agent works only in its chat's folder.

## Phase 5: Overlay, Browser, Extensions (in progress)
Done:
- **Widget settings**: typed per-widget schema, frame settings for every widget (title, header, content size, transparency), Inspector SETTINGS tab with live preview, settings for overlays. Clock: 12/24 h, seconds style, size or fit-to-width, time zone, date format, week start, ISO week numbers.
- **BROWSER**: tabs (restored after restart, lazily), private tabs, bookmarks, history, downloads, ad/tracker/malware blocking, Strict tracking prevention, HTTPS-only, GPC, permission prompts, page fullscreen.
- **Web overlays** for music and video, pop-out of a playing tab and back, **Music Player** widget (NETRUNNER tabs first, music sites first, sticky on pause; other apps through Windows media sessions).
- **Appearance**: app and dashboard backgrounds (your images or animated patterns), glass panels, corner radius, fonts, interface scale, glow / scanlines / vignette, per-widget accent colour.

Remaining: see the release plan below.

## Release plan
Each release is small enough to test by hand in one sitting and ships through auto-update. Order is by value to daily use; later items may move.

### 0.6: Widget Studio and overlays
Done so far: GITHUB code browsing, Widget Studio, per-profile overlay sets, click-through and snapping, Notes / To-do, Timer / Alarm, eight colour presets and seven background patterns. Left: private source with public releases.

- ✅ **Widget Studio**: build a widget from HTML/CSS (sandboxed iframe, no IPC) or from a template (text, counter, link grid, RSS/JSON feed with a URL allowlist). Saved per profile, usable on the dashboard and as an overlay.
- ✅ **Per-profile overlay sets**: switching profile shows that profile's overlays (Gaming: FPS/GPU/music; Work: clock/notes).
- ✅ **Overlay click-through** (mouse passes through a locked overlay) and snap to screen edges.
- ✅ **Notes / to-do widget** stored locally.
- ✅ **Timer and alarm widget**: countdowns, stopwatch and alarms with a chosen sound (built-in sounds or your own audio file), repeat days, snooze; alarms ring even when NETRUNNER is in the tray.
- ✅ **More theme presets and background patterns** in the cyberpunk spirit: Matrix rain, neon city, synthwave grid, glitch, hex, holo, CRT green/amber; animated ones respect the motion setting.

- ✅ **GITHUB file browsing**: browse a repository's files and code inside NETRUNNER; open it in DEVELOPER (local clones are found automatically, or pick the folder).
- **Private source, public releases**: the source repository becomes private; installers and auto-updates are published from a separate public releases repository.

### 0.7: Automation editor, SYSTEM and GAMES
- ✅ **Visual rule editor**: trigger → conditions → several actions, with a dry-run preview.
- ✅ **New triggers**: time of day / schedule, file created in a folder, download finished, network or VPN-type adapter up/down, game started (from the GAMES library), battery / power plan change.
- ✅ **New actions**: set volume, switch power plan, open a URL in BROWSER, show/hide an overlay set, wait N seconds.
- ✅ **NETWORK moves into SYSTEM** as a tab (connectivity, adapters, throughput next to hardware, processes, startup, services, power); the separate module goes away and old links open the new tab.
- ✅ **GAMES library upgrade** (plus a per-game switch to stop counting tools such as Wallpaper Engine):
  - playtime per game (tracked while the game process runs) and totals for a chosen period (today, week, month, all time), with a per-game history chart;
  - optional banner view (toggle): each game shown with its Steam artwork (header/capsule images by app id, cached locally), falling back to a generated cover for non-Steam games; the current compact list stays available;
  - sort and filter by playtime, last played, launcher.

### 0.8: DEVELOPER IDE, GitHub link, system and sound
- ✅ **DEVELOPER as a full IDE**: language servers (20 languages, auto-detected, install in a visible terminal) with live errors, completion, hover, go to definition, references, rename, formatting and quick fixes; Problems panel; project search and replace; Ctrl+P / symbols; split editor and session restore; editor settings and `.editorconfig`; run configurations with compiler errors in Problems; debugger (DAP: Python, Go, Rust/C/C++); Git in the editor (gutter changes, blame, hunks, conflict resolution, stash, graph, cherry-pick, branch compare); Explain / Fix with NEURAL.
- ✅ **Code ↔ GitHub**: publish a project, create pull requests, PR list with CI status, checkout and review PR diffs, comments, branch from an issue, CI status of the current branch, open on GitHub / permalink.
- ✅ **Audio**: output/input devices, default device and per-app volume (Core Audio), as a SYSTEM tab and a widget, with automation actions.
- ✅ **Sensors**: optional HWiNFO shared-memory bridge for CPU/GPU temperatures and fan speeds (read-only, user enables it).
- ✅ **Per-profile Quick Access sets** and hotkeys per entry; hotkey editor in Settings.
- ✅ **Repair of damaged databases at startup** (0.8.2): an integrity check before migrations rebuilds a damaged database and keeps a copy of the original in `backups`.
- ✅ **Resizable panels** (0.8.2): DEVELOPER, FILES, GITHUB, NEURAL, Widget Studio and the pinned navigation; sizes are remembered.
- ✅ **Browser page appearance** (0.8.2): dark pages, theme accent and scrollbars, per-site transparency with a tint.
- ✅ **NEURAL agent** (0.9): photos, a Work / Play switch per chat, a folder per chat with tools to list, read, write, append and edit, Undo on every change, attachments kept in context, role-playing games with real dice, a context indicator.
- The CodeLLDB adapter is located, not downloaded by NETRUNNER. Node.js debugging and semantic highlighting arrived in 0.9.

### 0.9: Browser, part 2
- ✅ **Ads on YouTube** removed by our own script instead of uBlock scriptlets (no downloaded code runs in pages).
- ✅ Per-site JavaScript switch and zoom memory, reader mode, tab search, recently closed tabs (Ctrl+Shift+T; private tab moved to Ctrl+Shift+N).
- ✅ Download progress and cancel; per-site cookie viewer.
- ✅ Tab groups, per-site autoplay blocking (from the next tab opened).
- ✅ Saved logins in Windows Credential Manager (opt-in, filled on click).
- ✅ **DEVELOPER**: Node.js debugging (js-debug, installed from the Tools panel), semantic highlighting from language servers.

### 0.10: Data safety, FILES, more launchers
- ✅ **Backups**: automatic (weekly by default) and manual, restore, export and import of all data (STORAGE).
- ✅ **FILES**: ZIP archives (list, extract), duplicate finder.
- ✅ **GAMES**: Riot Client, HoYoPlay, Ubisoft Connect.
- ✅ csharp-ls installs with .NET 8 and 9 SDKs too (0.21+ needs .NET 10).

### 1.0: Platform
- **Plugin architecture**: signed plugins with a declared permission set (commands, widgets, automation triggers), loaded in an isolated webview; no access beyond what they declare.
- **FILES**: 7z and RAR archives, opt-in search index.
- **GAMES**: EA app, Battle.net, Xbox app.

### Engineering (alongside releases)
- Upgrade `vitest` to 5.x (current 3.x has advisories in dev-only tooling, not shipped).
- ✅ Typecheck, tests, build and clippy run on every pull request (`checks.yml`).
- End-to-end smoke test of the built app (start, open each module, BROWSER tab, overlay).
- Authenticode code-signing certificate so Windows SmartScreen trusts the installer (needs a purchased certificate).
- Reduce the DEVELOPER chunk (Monaco) further; lazy-load language workers on demand.

## Known limitations
- Temperatures and fans: usually unavailable to standard-user apps without the optional HWiNFO source.
- Language servers and debug adapters are your own installs; without one, a language has highlighting only.
- Changing the default sound device uses an undocumented Windows interface (see SECURITY.md).
- CPU frequency is the OS-reported value (often the base clock).
- VPN: NETRUNNER reports a VPN-type adapter being up; it cannot prove traffic is routed through it.
- Overlays cannot draw over exclusive-fullscreen games (no injection by design).
- Browser tabs are native webviews: NETRUNNER's toasts cannot appear on top of a page, and app shortcuts (Ctrl+K) work only while focus is in NETRUNNER's own UI. Dialogs and the palette hide the page while open.
- Web overlay opacity applies to the frame only; page content is opaque.
- Saved logins fill the top frame only, so forms in an iframe and sites that ask for the password on a later step need a click there first.
- YouTube's ad removal can break when YouTube changes, and ads stitched into the video stream can only be played through quickly, not removed. Recently closed tabs last until NETRUNNER closes.
- Browser transparency shows the background only where a site leaves its own page background: elements the site paints stay opaque, and some sites stay fully opaque. Forced dark pages are recoloured by Chromium and can look wrong on some sites; the choice applies to the whole browser and takes effect after a restart.
- BROWSER's side panels are not resizable yet.
- The Music Player shows only apps that publish Windows media sessions.
- Automation process triggers have up to ~3 s latency (polling, only while such rules exist).
- Monaco is ~3.6 MB, loaded only when DEVELOPER opens.
- Free Gemini keys hit overloaded models (HTTP 503) at peak times; NEURAL falls back to other flash models automatically and shows which one answered. Free Flash models allow only 20 requests a day and 5 a minute, and an agent can use several requests for one message; Play therefore defaults to Flash Lite (500 a day, 15 a minute).
- The NEURAL agent can make mistakes in its files (for example, count an item twice) or forget to update them. Every change can be undone, but nothing checks that the model is right. A new chat does not see the files of an older one.
- HEIC photos are not expected to open in the webview (not tested); convert them first if NEURAL refuses one.
