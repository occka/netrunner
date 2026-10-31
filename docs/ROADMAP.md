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

## Phase 5: Overlay, Browser, Extensions
Widget Studio (BASIC / WEB / ADVANCED), web overlays, WebView2 BROWSER, plugin architecture, visual automation editor, more automation triggers.

## Known limitations
- Temperatures: usually unavailable to standard-user apps; GPU temperature is not exposed by PDH.
- CPU frequency is the OS-reported value (often the base clock).
- VPN: NETRUNNER reports a VPN-type adapter being up; it cannot prove traffic is routed through it.
- Overlays cannot draw over exclusive-fullscreen games (no injection by design).
- Automation process triggers have up to ~3 s latency (polling, only while such rules exist).
- Monaco is ~3.6 MB, loaded only when DEVELOPER opens.
- Free Gemini keys hit overloaded models (HTTP 503) at peak times; NEURAL falls back to other flash models automatically and shows which one answered.
