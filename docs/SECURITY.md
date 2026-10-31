# Security model

## Principles

- Standard user rights. NETRUNNER never requests elevation itself. If a launched app needs admin, Windows shows its own UAC prompt. Operations that need administrator rights (machine-wide startup entries, starting/stopping services) are shown read-only.
- No hidden execution. Shell commands, Run file and terminals always run in visible consoles. Background helpers (git, version probes) only run fixed, known tools.
- Local data only. Nothing is uploaded. GitHub calls go only to `api.github.com` and only when you use the GITHUB module.

## Frontend capabilities

`src-tauri/capabilities/default.json` grants the main and overlay webviews `core:default`, window chrome (minimise/maximise/hide/show/close/drag), `dialog:allow-open` (native picker; returns a path, reads nothing) and `log:default`. No fs, shell or opener plugin is exposed to JavaScript. The CSP allows only local resources, IPC and local blob workers (for Monaco).

## Execution safeguards

| Operation | Safeguard |
|---|---|
| Quick Access launch | By entry id; the target is read from SQLite, never taken from the UI |
| Websites / external links | Absolute http(s) only |
| Game URIs | Protocol allowlist (steam, epic, gog, uplay/ubisoft, origin, battlenet, xbox) |
| Games from the library | Resolved by library id from launcher data; Prism instance ids are quoted |
| Shell command entries | `command_policy` flags destructive patterns. Flagged or marked commands return `confirmation_required` until confirmed |
| Automation | Never runs a command that needs confirmation; asks the UI instead. Rate-limited and depth-limited |
| Process termination | UI confirmation plus backend `confirmed` flag; protected system processes and NETRUNNER itself are refused |
| Startup entries | Only per-user entries can be toggled (Explorer's reversible StartupApproved flag; nothing is deleted) |
| Project files | Canonicalised paths must stay inside opened project roots; `..` rejected; `.git` read-only; deletes go to the Recycle Bin |
| Git discard / push | Confirmation required (backend enforces `confirmed`); push explains it publishes commits |
| Git clone | https URLs only; target folder must not exist |
| Terminals | Allowlisted shells only (PowerShell, pwsh, cmd, Git Bash); cwd must be inside a project |

The command policy is a safety net, not a sandbox: a confirmed command runs with your rights.

## Browser

| Layer | What it does |
|---|---|
| Isolation | Pages run in `web-*` webviews with their own WebView2 profile, separate from NETRUNNER's UI. No host objects, no web messages. Tauri's ACL refuses remote origins, and `lib.rs` rejects every command from a `web-*` webview regardless of origin |
| Content blocking | Every request (including workers where supported) is checked by adblock-rust against the built-in list plus enabled lists (EasyList, EasyPrivacy, uBlock filters/privacy/badware, Peter Lowe, RU AdList; optional cookie banners and URLhaus malware URLs). Blocked requests get a local 403 and never leave the machine. Cosmetic rules hide leftover ad frames. Per-site off switch |
| Tracking | WebView2 tracking prevention **Strict** by default; `Sec-GPC: 1` and `DNT: 1` on requests and `navigator.globalPrivacyControl` |
| Transport | HTTPS-only: top-level `http://` navigations are upgraded (local network addresses exempt); the user can allow HTTP per site for the session. Invalid certificates show WebView2's interstitial |
| Navigation | Only http(s), `about:`, `blob:`/`data:` pages. `file:` and custom schemes are refused; pages cannot launch external apps (`steam:`, `ms-settings:`…) |
| Popups | `window.open` without a size opens a normal tab; sized popups (sign-in flows) open a hardened popup window |
| Permissions | Camera, microphone, location, notifications, clipboard read, screen capture, MIDI, sensors, fonts, window management, multiple downloads and file-system access are denied unless the user allowed that site (stored in `browser_site_permissions`, revocable) |
| Data entry | Password saving and form autofill are off by default |
| Downloads | Default Downloads folder; SmartScreen reputation checks stay on (NETRUNNER's own webview disables SmartScreen, the browser profile does not) |
| WebRTC | `--force-webrtc-ip-handling-policy=default_public_interface_only` hides local IP addresses (applies after restart) |
| Private tabs | InPrivate WebView2 sessions; nothing is written to history |

Not covered: in-page video ads served from the site's own domain (e.g. YouTube) need uBlock scriptlets, which are not bundled. Loading unpacked extensions (e.g. uBlock Origin Lite) is an opt-in setting; extensions run with the permissions they declare. Fingerprinting resistance beyond WebView2's defaults is not attempted.

## Credentials

- **GitHub token:** validated against `/user`, then stored only in **Windows Credential Manager** (DPAPI) under `NETRUNNER / github-token`. It is never written to SQLite or logs and never returned to the UI. Disconnect deletes it.
- **Git remotes:** clone/pull/push use Git's own credential helper (Git Credential Manager). NETRUNNER never sees these credentials.
- **Gemini API key:** validated by listing models, stored only in Credential Manager (`NETRUNNER / gemini-api-key`), sent only in the `x-goog-api-key` header (never in URLs), never returned to the UI.

## AI (NEURAL)

- **No filesystem access for the model.** No tools or function calling are enabled. Each request carries an explicit attachment list built from user actions (Attach file, Attach selection, Attach project file list, FILES "Analyze with AI", Inspector "Ask NEURAL"). Pre-filled prompts are never sent automatically.
- The backend reads attached files itself, with limits of 256 KB per file and 1 MB per request. It refuses binary files and anything that looks like credentials (`.env*`, `.ssh`, `*.pem`/`*.key`/`*.pfx`, `.npmrc`, `.git-credentials`…).
- The composer shows exactly what will be sent and its size. Every send writes an activity-log entry listing the attachments that left the machine.
- AI code changes arrive as a **proposal diff** in DEVELOPER. Apply requires confirmation, writes the file only, and never commits or pushes.
- FILES modifications are refused in Windows/program folders and on drive roots; deletes go to the Recycle Bin.- Chat history is stored only in the local SQLite database (`neural_chats`/`neural_messages`). Earlier turns of the open chat are sent as conversation context when you send a new message; attachments are not re-sent. Deleting a chat deletes its messages.
