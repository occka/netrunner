# Development

## Environment

| Tool | Notes |
|---|---|
| Node.js 20+ / npm | frontend tooling |
| Rust stable (`x86_64-pc-windows-msvc`) | `winget install Rustlang.Rustup` |
| VS 2022 Build Tools | "Desktop development with C++" + Windows 11 SDK |
| WebView2 Runtime | preinstalled on Windows 11 |

```bash
npm install
npm run app:dev
```

The first Rust build takes a few minutes (SQLite is compiled from source via `rusqlite`'s `bundled` feature).

## Checks before committing

```bash
npm run typecheck && npm test
cd src-tauri && cargo test && cargo clippy --all-targets
```

Rust tests include `system::smoke` and `dev::smoke`, which call real Windows APIs and the git CLI on your machine. If `npm run app:dev` is running, give `cargo test` its own target dir (`$env:CARGO_TARGET_DIR="target\test"`) so it does not fight the dev build over file locks.

Development builds (`npm run app:dev`) never run automations, so rebuilding does not launch your real programs. Set `NETRUNNER_DEV_AUTOMATION=1` before starting the dev build to test the engine.

## Adding an automation trigger or action

1. Add the kind to `TRIGGERS` / `CONDITIONS` / `ACTIONS` in `services/automation.rs` and its value check to `trigger_value` / `condition` / `action` there (no migration needed). Matching (`trigger_matches`) and conditions (`condition_met`) are pure: add a test.
2. Fire triggers with `automation::fire(app, kind, value)` from wherever the event originates (or add it to `start_event_watcher`); implement actions in `automation::execute` and describe them in `dry_run`.
3. Add the label in `modules/automation/AutomationModule.tsx` (and `describe…`) and its value field in `ValueInput.tsx`.

## Adding a game source

Implement a `fn x_games() -> (bool, Vec<Game>)` in `services/games.rs` (detected?, games), add it to `scan()`, and, if the launcher needs parameters, extend `launch_params`. Add the label in `modules/games/GamesModule.tsx`.

## Adding a module

1. Create `src/modules/<name>/<Name>Module.tsx` with a default-export component. Start it with `<ModuleHeader id="<name>" />`.
2. In `src/app/modules.ts`, set `component: lazy(() => import(...))` and the honest `status` (`implemented` / `partial` / `planned`) on the module's entry.
3. If it needs backend work, add a service in `src-tauri/src/services/`, a thin adapter in `src-tauri/src/commands/`, register it in `lib.rs`, and add a typed wrapper in `src/services/api.ts`.

## Adding a dashboard widget

1. Create `src/modules/command/widgets/<Name>Widget.tsx` that default-exports `(props: WidgetProps) => JSX`.
2. Add an entry to `widgets/registry.ts` with `status`, `dataSource` (an honest description of where the data comes from), `defaultSize`, `minSize` and a lazy `component`.
3. For system metrics, use `useSystemSnapshot()` rather than a separate poller. If a value isn't available, render it as unavailable and give the reason. Never estimate it.
4. Settings: declare a schema with `defineSettings([...])` in `widgets/settings.ts`, set it as `settings` in the registry entry, and type the component as `WidgetProps<ConfigOf<typeof MY_SETTINGS>>`. The Inspector and the OVERLAY dialog render the form; the widget only reads `config`.

## Adding a database migration

1. Add `src-tauri/migrations/000N_description.sql`.
2. Append `(N, include_str!(...))` to `MIGRATIONS` in `storage/migrations.rs`.
3. Never edit a migration that has shipped. Existing databases are backed up automatically before migrating.

## Adding a setting

Add the key and its default to `SettingsSchema` / `SETTINGS_DEFAULTS` in `src/stores/settings.ts`. Keys must be lowercase `area.name`. If it should be searchable, add a section to `modules/settings/settingsIndex.ts`.

## Claude Code desktop sessions

The Claude desktop app is an MSIX package. Processes started from its terminals inherit its container: **new** files under `%APPDATA%` and `%LOCALAPPDATA%` land in `AppData\Local\Packages\Claude_*\LocalCache\`, but files that already exist (such as the installed app's `netrunner.db`) are changed in place. Never launch or update the **installed** NETRUNNER from such a session: the updater would remove the real install and put the new version into the container copy, breaking the Start menu entry and autostart.

Development builds (`debug_assertions`) therefore never use the installed app's data folders: they keep their database, wallpapers, sounds and browser profile in a `dev` subfolder of the app data folders, or in `NETRUNNER_DATA_DIR` (`roaming` and `local` inside it) when that is set. Copy a database there to test with real data; a dev build that migrates it cannot break the installed app.

## Logs

The backend writes `%LOCALAPPDATA%\com.netrunner.app\logs\NETRUNNER.log`, and stdout in dev. User-visible events go to the `activity_log` table.

## Releases and auto-update

The source repository `occka/netrunner` can be private. Installers and updates are published to the **public** repository `occka/netrunner-releases`, which holds only a README and releases. Installed copies update from `https://github.com/occka/netrunner-releases/releases/latest/download/latest.json` (the source repository's `latest.json` is a fallback for copies from 0.5.x). Updates are signed: the public key is in `tauri.conf.json`, and the **private key lives only at `%USERPROFILE%\.tauri\netrunner.key`** (never commit it; back it up, because without it you cannot ship updates to existing installs).

One-time setup:
1. In `occka/netrunner` → Settings → Secrets and variables → Actions, add `TAURI_SIGNING_PRIVATE_KEY` with the *contents* of `netrunner.key`.
2. Create the public repository `occka/netrunner-releases` with a README (it needs one commit so releases can be tagged).
3. Create a fine-grained personal access token limited to `occka/netrunner-releases` with **Contents: read and write**, and add it to `occka/netrunner` as the secret `RELEASES_TOKEN`.
4. After a release that installed copies have picked up, make `occka/netrunner` private (Settings → General → Danger zone). The workflow then stops mirroring `latest.json` into it. Private repositories use GitHub Actions minutes (Windows runners count double), so one release costs roughly 30–40 of the 2000 free minutes a month.

Each release:
1. Bump `version` in `src-tauri/tauri.conf.json`, `package.json` and `src-tauri/Cargo.toml`.
2. Commit, then `git tag v<version>` and `git push --follow-tags`.
3. `.github/workflows/release.yml` builds, signs and publishes the release with `latest.json` to `occka/netrunner-releases` (and mirrors `latest.json` into the source repository while it is public). Running apps offer the update on next start (Settings → Updates).

Local `npm run app:build` also signs updater artifacts, so set the key first:
`$env:TAURI_SIGNING_PRIVATE_KEY = Get-Content $env:USERPROFILE\.tauri\netrunner.key -Raw; $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ""`