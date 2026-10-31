# Architecture

## Layers

```
React (src/)                      Rust (src-tauri/src/)
─────────────                     ─────────────────────
modules/*  ── stores/* ── services/api.ts ──IPC──▶ commands/*  (thin adapters, async = off UI thread)
layouts/*                                              │
components/*                                           ▼
objects/*  (universal object model)              services/*  (domain logic, unit-tested)
search/*   (local palette engine)                system/*   (sysinfo, PDH counters, startup, services, power, network)
overlay/*  (overlay window root)                 dev/*      (workspace fs, ConPTY terminals, toolchains, git CLI, GitHub API)
                                                 security/* (command policy, target validation)
                                                 desktop.rs / overlay.rs / automation.rs (tray, windows, event engine)
                                                       │
                                                       ▼
                                                 storage/* (SQLite + migrations)
```

## Phase 2–3 subsystems

- **Tray and lifecycle** (`desktop.rs`): single-instance plugin, tray menu, close-to-tray (handled in the backend, so Alt+F4 behaves the same), autostart through the HKCU Run key with a `--autostart` flag that can start minimised.
- **System providers** (`system/`): `sysinfo` for CPU/RAM/disks/processes. **PDH** counters (`GPU Engine`, `GPU Adapter Memory`, `PhysicalDisk`) give vendor-neutral GPU load, VRAM and disk throughput, the same source Task Manager uses. Startup apps use Explorer's `StartupApproved` convention. Services come from the SCM (read-only), power plans from `powrprof`, connectivity from `GetNetworkConnectivityHint`, and adapters from `GetAdaptersAddresses`. Every FFI path has a smoke test that runs against the real OS.
- **Games** (`services/games.rs`): reads launcher data on disk (Steam app manifests, Epic manifests, GOG registry, Prism Launcher `instance.cfg`). Launch targets are resolved in the backend by game id.
- **Automation** (`automation.rs`): rules in SQLite. Events come from setup (start), `profile_activate`, the UI (manual) and a watcher thread that diffs process names every 3 s, only while process rules exist. Actions reuse the launcher, profiles and overlay code. Commands that need confirmation are sent to the UI as `automation://confirm` and never run unattended. A rate limit (10 s per rule) and a recursion depth limit prevent loops.
- **Overlays** (`overlay.rs`): each overlay is its own frameless, transparent, always-on-top webview (`overlay-<id>`) that loads the same bundle with `?overlay=<id>` and renders one widget. Geometry is saved from the window's move/resize events. A global shortcut toggles them.
- **Developer** (`dev/`): every file operation is canonicalised and must stay inside a project root the user opened (`developer.roots` setting). `.git` is read-only, deletes go to the Recycle Bin, and writes are atomic. Terminals are real ConPTY sessions (portable-pty) streamed over a Tauri `Channel` with incremental UTF-8 decoding; the xterm instances live outside React so they survive navigation. Git uses the installed `git` CLI (`GIT_TERMINAL_PROMPT=0`), so authentication is Git Credential Manager's job. Monaco is bundled locally with Vite-built workers and lazy-loaded with the DEVELOPER chunk.
- **GitHub** (`dev/github.rs`): REST calls from Rust (`reqwest` + rustls). The personal access token is validated, stored in Windows Credential Manager (`keyring`) and never returned to the UI.

- **React renders and holds UI state.** It never reads files, runs processes or touches the system directly. The Tauri capability file (`src-tauri/capabilities/default.json`) grants only window controls, events, the native file picker and logging, for the main window and `overlay-*` windows.
- **Rust owns all system access.** Commands are thin; rules live in `services/` and `security/` so they can be tested against an in-memory database.
- **`services/api.ts`** is the only frontend file that calls `invoke`. Errors arrive as `{ code, message }` (`ApiError`), so the UI can branch on `confirmation_required`.

## Startup cost

On boot the frontend loads only settings, profiles and Quick Access entries. Each module is a lazy chunk (`app/modules.ts`), and each widget is a lazy chunk (`widgets/registry.ts`). The system monitor (`sysinfo`) is created on the first metrics request, and polling runs only while a metrics widget is mounted and the window is visible (`hooks/useSystemSnapshot.ts`). All widgets share one request per tick.

## Universal object model

`objects/types.ts` defines `ObjectRef` (a pointer such as `{type:"qa-entry", id}`) and `NrObject` (title, icon, tags, details, actions). `objects/resolve.ts` turns a ref into an `NrObject` from live store data. The Inspector (OVERVIEW / ACTIONS / DETAILS / AI), the context menu and the command palette all use this model, so a new object type plugs into every surface at once.

## Dashboard

A profile's `layout_json` is `{ version: 1, widgets: [{ id, type, x, y, w, h }] }` on a 12-column grid (`react-grid-layout`). EDIT LAYOUT copies the layout into a draft (`stores/dashboard.ts`), and only **Save** writes it back through `profile_save_layout`. The draft records its profile id, so a profile switch mid-edit discards the draft rather than saving it to the wrong profile. The backend validates the layout's shape but treats widget types as opaque; the frontend registry defines them.

## Launching

`qa_launch(id, confirmed)` reads the entry from SQLite, so the frontend cannot pass an arbitrary path to execute.

- Apps, files, folders, websites and game URIs go through `ShellExecuteW`. It handles file associations, `.lnk` files and UAC prompts the same way Explorer does.
- Commands run as `cmd.exe /K` or `powershell.exe -NoExit -Command` in a **new visible console** (`CREATE_NEW_CONSOLE`).
- Every launch is recorded in `activity_log`.

## Storage

The SQLite file lives at `%APPDATA%\com.netrunner.app\netrunner.db` (WAL mode). Tables: `settings` (JSON values), `profiles`, `quick_access`, `activity_log` (trimmed to 2000 rows).

Migrations are SQL files in `src-tauri/migrations/`, embedded at compile time and tracked with `PRAGMA user_version`. Before an existing database is migrated, a consistent snapshot is written with `VACUUM INTO` to `backups/`. A database newer than the build is refused, never modified.

## Theming

`styles/theme.ts` writes each colour token as `--c-<token>` plus an `--c-<token>-rgb` triplet, and CSS derives translucent variants from the triplet. Components never hardcode colours. The theme is stored in the `theme` setting and sanitised on load.

## Phase 4 subsystems

- **NEURAL** (`neural/`): `context.rs` turns explicit attachments into one context block with per-item size/error reporting (`neural_preview` shows it before sending). `gemini.rs` streams `streamGenerateContent` over SSE to the UI through a Tauri `Channel`. It supports cancellation by request id and tries fallback models on 503/404. Context is appended only to the last user turn. The system prompt states that the model cannot access the machine and must return whole files in one code block, so they can be shown as diffs.
- **AI proposals** (`modules/developer/store.ts`): a `proposal` tab compares the current text (unsaved editor content if open) with the AI version in Monaco's diff editor. `applyProposal` confirms, then writes through the scoped workspace API.
- **FILES** (`files.rs`): a user-driven file manager. Unlike DEVELOPER it is not scoped to projects, but modifications are refused in system folders and on drive roots, deletes use the Recycle Bin, copies never overwrite (`name - Copy`), cross-volume moves copy then recycle, and search is a bounded on-demand scan (500 results, 6 s, depth 12) with no background index.