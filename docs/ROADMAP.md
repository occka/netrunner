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

## Phase 3: Developer and GitHub (done, partial)
Monaco editor, project explorer, ConPTY terminals, Run file, toolchain detection with path overrides, Git (status, stage, discard, commit, branches, pull, push, history, diff), GitHub (token auth, repos, PRs, issues, clone).

Not done in Phase 3:
- **Language servers (LSP):** completion beyond Monaco's built-ins, diagnostics, go-to-definition.
- **Debugger (DAP):** breakpoints and variables. DEBUG mode states this.
- ~~AI coding assistant~~: delivered in Phase 4 (NEURAL panel + proposal diffs).
- OAuth device-flow sign-in: needs a registered GitHub OAuth app; PAT is used today.

## Phase 4: Neural and Files (done, partial)
Gemini (key in Credential Manager, streaming, model choice, overload fallback), explicit-context assistant, AI edit proposals through the diff view, Inspector/FILES "Ask AI", FILES module (tabs, operations, search, preview).

Not done in Phase 4:
- Archive browsing, duplicate detection, opt-in index for instant search.
- Persistent chat history (in-memory only today, by design for privacy).
- AI-assisted semantic search in the command palette.
- AI coding assistant with tools (it intentionally has none; context is explicit).

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
Done so far: Widget Studio, per-profile overlay sets, click-through and snapping, Notes / To-do, Timer / Alarm, the eight new colour presets. Left: the new background patterns, GITHUB file browsing, private source with public releases.

- ✅ **Widget Studio**: build a widget from HTML/CSS (sandboxed iframe, no IPC) or from a template (text, counter, link grid, RSS/JSON feed with a URL allowlist). Saved per profile, usable on the dashboard and as an overlay.
- ✅ **Per-profile overlay sets**: switching profile shows that profile's overlays (Gaming: FPS/GPU/music; Work: clock/notes).
- ✅ **Overlay click-through** (mouse passes through a locked overlay) and snap to screen edges.
- ✅ **Notes / to-do widget** stored locally.
- ✅ **Timer and alarm widget**: countdowns, stopwatch and alarms with a chosen sound (built-in sounds or your own audio file), repeat days, snooze; alarms ring even when NETRUNNER is in the tray.
- **More theme presets and background patterns** in the cyberpunk spirit: Matrix rain, neon city, synthwave grid, glitch, hex, holo, CRT green/amber; animated ones respect the motion setting. *Colour presets done; background patterns (`styles/appearance.ts` `PATTERNS`, `appearance.css`, `components/Backdrop.tsx`) remain.*

- **GITHUB file browsing**: browse a repository's files and code inside NETRUNNER; open it in DEVELOPER (local clones are found automatically, or pick the folder).
- **Private source, public releases**: the source repository becomes private; installers and auto-updates are published from a separate public releases repository.

### 0.7: Automation editor, SYSTEM and GAMES
- **Visual rule editor**: trigger → conditions → several actions, with a dry-run preview.
- **New triggers**: time of day / schedule, file created in a folder, download finished, network or VPN-type adapter up/down, game started (from the GAMES library), battery / power plan change.
- **New actions**: set volume, switch power plan, open a URL in BROWSER, show/hide an overlay set, wait N seconds.
- **NETWORK moves into SYSTEM** as a tab (connectivity, adapters, throughput next to hardware, processes, startup, services, power); the separate module goes away and old links open the new tab.
- **GAMES library upgrade**:
  - playtime per game (tracked while the game process runs) and totals for a chosen period (today, week, month, all time), with a per-game history chart;
  - optional banner view (toggle): each game shown with its Steam artwork (header/capsule images by app id, cached locally), falling back to a generated cover for non-Steam games; the current compact list stays available;
  - sort and filter by playtime, last played, launcher.

### 0.8: System and sound
- **Audio**: output/input device switching and per-app volume (Core Audio), as a module and a widget.
- **Sensors**: optional HWiNFO shared-memory bridge for CPU/GPU temperatures and fan speeds (read-only, user enables it).
- **Per-profile Quick Access sets** and hotkeys per entry; hotkey editor in Settings.

### 0.9: Browser, part 2
- **uBlock scriptlet resources** so in-video ads on sites like YouTube are blocked too.
- Per-site JavaScript / autoplay / zoom memory, reader mode, tab groups, tab search, recently closed tabs (Ctrl+Shift+T).
- Download manager panel with progress and "open folder"; per-site cookie viewer.
- Password autofill through Windows Credential Manager (opt-in).

### 1.0: Platform
- **Plugin architecture**: signed plugins with a declared permission set (commands, widgets, automation triggers), loaded in an isolated webview; no access beyond what they declare.
- **DEVELOPER**: language servers (TypeScript, Rust, Python) for completion and diagnostics; debugger (DAP) later.
- **FILES**: zip/7z browsing, duplicate finder, opt-in search index.
- Export / import of settings, profiles and layouts; backup schedule in STORAGE.

### Engineering (alongside releases)
- Upgrade `vitest` to 5.x (current 3.x has advisories in dev-only tooling, not shipped).
- Run typecheck, tests and clippy on every pull request in CI, not only on release tags.
- End-to-end smoke test of the built app (start, open each module, BROWSER tab, overlay).
- Authenticode code-signing certificate so Windows SmartScreen trusts the installer (needs a purchased certificate).
- Reduce the DEVELOPER chunk (Monaco) further; lazy-load language workers on demand.

## Known limitations
- Temperatures: usually unavailable to standard-user apps; GPU temperature is not exposed by PDH.
- CPU frequency is the OS-reported value (often the base clock).
- VPN: NETRUNNER reports a VPN-type adapter being up; it cannot prove traffic is routed through it.
- Overlays cannot draw over exclusive-fullscreen games (no injection by design).
- Browser tabs are native webviews: NETRUNNER's toasts cannot appear on top of a page, and app shortcuts (Ctrl+K) work only while focus is in NETRUNNER's own UI. Dialogs and the palette hide the page while open.
- Web overlay opacity applies to the frame only; page content is opaque.
- The Music Player shows only apps that publish Windows media sessions.
- Automation process triggers have up to ~3 s latency (polling, only while such rules exist).
- Monaco is ~3.6 MB, loaded only when DEVELOPER opens.
- Free Gemini keys hit overloaded models (HTTP 503) at peak times; NEURAL falls back to other flash models automatically and shows which one answered.
