# NETRUNNER

An industrial-cyberpunk control environment for Windows: dashboard, universal launcher, system control, game library, automation, floating overlays, an IDE with Git and GitHub, a file manager and a Gemini assistant that only sees what you attach. A regular desktop app built with **Tauri 2 + React + TypeScript + Rust + SQLite**. It runs alongside Windows and does not replace the shell.

## Status (Phases 1–4, Phase 5 in progress)

| Module | Status | What works |
|---|---|---|
| COMMAND | Implemented | 12-col drag/resize dashboard, EDIT LAYOUT with save/cancel, 14 live widgets (incl. Music Player and Image), per-widget settings (gear button → Inspector SETTINGS: e.g. clock 12/24 h, size, time zone, date format) |
| QUICK ACCESS | Implemented | apps, games, files, folders, websites, CMD/PowerShell commands, projects |
| SYSTEM | Implemented | hardware, processes (guarded termination), startup apps (toggle per-user entries), services (read-only), power plans |
| NETWORK | Implemented | Windows connectivity state, adapters, throughput, VPN-type adapter detection |
| GAMES | Implemented | Steam, Epic, GOG and Prism Launcher (Minecraft instances) detection, plus your own games |
| AUTOMATION | Implemented | triggers: start, app start/stop, profile change, manual; actions: launch program, launch entry, switch profile, notify, show/hide overlay |
| OVERLAY | Partial | any widget as an always-on-top window with its own settings; **web overlays** for music and video (YouTube, SoundCloud, Spotify, Yandex Music, Twitch, any URL) in the hardened browser profile; pop a playing BROWSER tab out without reloading. Widget Studio is planned |
| INTEGRATIONS | Partial | 14 known apps with separate launch / detect / status / control capabilities |
| DEVELOPER | Partial | Monaco editor, project explorer, ConPTY terminals, Run file, Git panel, diff view, toolchain detection, NEURAL panel with reviewable AI proposals. LSP and debugger are planned |
| NEURAL | Implemented | Gemini chat (streaming, model choice, fallback when a model is overloaded or silent), saved chats (new / switch / delete, local only), explicit attachments only, audit log; also available as a dashboard widget and floating overlay |
| FILES | Partial | tabs, history, places/drives, sort/filter, multi-select, copy/cut/paste, rename, Recycle Bin delete, on-demand search, text/image preview, Analyze with AI |
| GITHUB | Implemented | token in Credential Manager, repositories, PRs, issues, clone into DEVELOPER |
| PROFILES / SETTINGS / STORAGE | Implemented / Implemented / Partial | themes; appearance: wallpaper or animated pattern for the app and the dashboard, glass panels (opacity + blur), corner radius, font, interface scale, neon glow / scanlines / vignette, per-widget accent colour; tray and autostart, data locations |
| BROWSER | Implemented | WebView2 tabs inside NETRUNNER, tabs restored after a restart (lazily), private tabs, bookmarks, history, downloads; pop a tab out to an overlay and back; ad/tracker/malware blocking (adblock-rust with EasyList, EasyPrivacy, uBlock, RU AdList…), Strict tracking prevention, HTTPS-only, GPC, deny-by-default site permissions, no IPC for pages. See docs/SECURITY.md |

Shell: system tray, close-to-tray, start with Windows (optionally minimised), single instance, Ctrl+K command palette, Ctrl+I inspector.

## Quick start

Prerequisites (Windows 10 2004+/11): Node.js 20+, Rust (stable, MSVC), Visual Studio Build Tools with "Desktop development with C++" and the Windows SDK, WebView2, and Git for Windows (for Git/GitHub features).

```bash
npm install
npm run app:dev      # desktop app with hot reload
npm run app:build    # installers: src-tauri/target/release/bundle/{nsis,msi}/
```

Checks:

```bash
npm run typecheck && npm test
cd src-tauri && cargo test && cargo clippy --all-targets
```

`cargo test` also runs **smoke tests** against the real machine (services, adapters, PDH counters, game libraries, git). They need Git installed.

## Keyboard

`Ctrl+K` palette · `Ctrl+I` inspector · `Ctrl+Alt+O` show/hide overlays (global) · `Ctrl+S` save file · `` Ctrl+` `` terminal.

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): layers, data flow, object model, storage
- [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md): setup, adding modules, widgets and migrations
- [docs/SECURITY.md](docs/SECURITY.md): safeguards, credentials, permission model
- [docs/ROADMAP.md](docs/ROADMAP.md): phases and known limitations
