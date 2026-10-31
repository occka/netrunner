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

## Adding an automation trigger or action

1. Add the kind to the `CHECK` constraint in a new migration and to `TRIGGERS` / `ACTIONS` in `services/automation.rs`.
2. Fire triggers with `automation::fire(app, kind, value)` from wherever the event originates; implement actions in `automation::execute`.
3. Add labels and an editor field in `modules/automation/AutomationModule.tsx`.

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

## Adding a database migration

1. Add `src-tauri/migrations/000N_description.sql`.
2. Append `(N, include_str!(...))` to `MIGRATIONS` in `storage/migrations.rs`.
3. Never edit a migration that has shipped. Existing databases are backed up automatically before migrating.

## Adding a setting

Add the key and its default to `SettingsSchema` / `SETTINGS_DEFAULTS` in `src/stores/settings.ts`. Keys must be lowercase `area.name`. If it should be searchable, add a section to `modules/settings/settingsIndex.ts`.

## Logs

The backend writes `%LOCALAPPDATA%\com.netrunner.app\logs\NETRUNNER.log`, and stdout in dev. User-visible events go to the `activity_log` table.

## Releases and auto-update

Installed copies update from `https://github.com/occka/netrunner/releases/latest/download/latest.json`. Updates are signed: the public key is in `tauri.conf.json`, and the **private key lives only at `%USERPROFILE%\.tauri\netrunner.key`** (never commit it; back it up, because without it you cannot ship updates to existing installs).

One-time setup:
1. Create the public repository `occka/netrunner` and push this project.
2. In the repo, go to Settings → Secrets and variables → Actions and add `TAURI_SIGNING_PRIVATE_KEY` with the *contents* of `netrunner.key`.

Each release:
1. Bump `version` in `src-tauri/tauri.conf.json`, `package.json` and `src-tauri/Cargo.toml`.
2. Commit, then `git tag v<version>` and `git push --follow-tags`.
3. `.github/workflows/release.yml` builds, signs and publishes the release with `latest.json`. Running apps offer the update on next start (Settings → Updates).

Local `npm run app:build` also signs updater artifacts, so set the key first:
`$env:TAURI_SIGNING_PRIVATE_KEY = Get-Content $env:USERPROFILE\.tauri\netrunner.key -Raw; $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ""`