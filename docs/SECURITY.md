# Security model

## Principles

- Standard user rights. NETRUNNER never requests elevation itself. If a launched app needs admin, Windows shows its own UAC prompt. Operations that need administrator rights (machine-wide startup entries, starting/stopping services) are shown read-only.
- No hidden execution. Shell commands, Run file and terminals always run in visible consoles. Background helpers (git, version probes) only run fixed, known tools.
- Local data only. Nothing is uploaded. GitHub calls go only to `api.github.com` and only when you use the GITHUB module. Looking for local clones reads only `.git/config` files, in a bounded scan, and stays on this computer.

## Frontend capabilities

`src-tauri/capabilities/default.json` grants the main, overlay and alarm-ringing webviews `core:default`, window chrome (minimise/maximise/hide/show/close/drag), `dialog:allow-open` (native picker; returns a path, reads nothing) and `log:default`. No fs, shell or opener plugin is exposed to JavaScript. The CSP allows only local resources, IPC and local blob workers (for Monaco).

## Execution safeguards

| Operation | Safeguard |
|---|---|
| Quick Access launch | By entry id; the target is read from SQLite, never taken from the UI |
| Websites / external links | Absolute http(s) only |
| Game URIs | Protocol allowlist (steam, epic, gog, uplay/ubisoft, origin, battlenet, xbox) |
| Games from the library | Resolved by library id from launcher data; Prism instance ids are quoted |
| Shell command entries | `command_policy` flags destructive patterns. Flagged or marked commands return `confirmation_required` until confirmed |
| Automation | Never runs a command that needs confirmation; asks the UI instead. Rate-limited and depth-limited. URLs open only as http(s) BROWSER tabs; folder triggers only list file names; the dry run never runs anything |
| Process termination | UI confirmation plus backend `confirmed` flag; protected system processes and NETRUNNER itself are refused |
| Startup entries | Only per-user entries can be toggled (Explorer's reversible StartupApproved flag; nothing is deleted) |
| Project files | Canonicalised paths must stay inside opened project roots; `..` rejected; `.git` read-only; deletes go to the Recycle Bin |
| Replace in files | Confirmation listing the files; only files inside open projects; refused while an affected tab has unsaved changes |
| Git discard / push | Confirmation required (backend enforces `confirmed`); push explains it publishes commits |
| Git amend / cherry-pick / stash drop | Confirmation required (backend enforces `confirmed`); amend warns when the commit is already on the remote. Revisions from the UI are checked so they can never be read as git options |
| GitHub from DEVELOPER | Publish (shows whether the repository is public), Create pull request (pushes the branch) and comments need a confirmation and the backend's `confirmed` flag. Reading uses the stored token only; an existing `origin` is never replaced |
| Hotkeys | An entry's global key launches through the same `launcher` path and policy as a click: a flagged command never runs without confirmation in the main window |
| Debugger | Only the known adapters start, on an open project, when the user asks; the program runs with the user's rights, like Run. TCP adapters listen on 127.0.0.1 only. The UI can send only allow-listed debug requests. **Install** types the official command into a visible terminal |
| HWiNFO sensors | Off by default. Read-only view of HWiNFO's shared memory, treated as untrusted input: a damaged block gives "unavailable", never a crash |
| Sound | Volume, mute and per-app volume use documented Core Audio. **Changing the default device uses `IPolicyConfig`, an undocumented Windows interface** (no public API exists); a failure is reported and the Windows sound settings are offered instead. Automations can use both |
| Git clone | https URLs only; target folder must not exist |
| Terminals | Allowlisted shells only (PowerShell, pwsh, cmd, Git Bash); cwd must be inside a project |
| Language servers | Only executables from the registry's known names (or a path the user picked) start, in the project folder, without a window. The UI may send only allow-listed LSP methods, for files inside open projects. Server edits to files that are not open are written only after confirmation; file create/rename/delete steps are skipped. **Install** types the official command into a visible terminal after confirmation; NETRUNNER never installs a server itself |

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
| Data entry | WebView2's password saving and form autofill are off by default |
| Saved logins | Off by default. Passwords are stored only in Windows Credential Manager; the database holds which accounts exist. The user types them in NETRUNNER's own panel, so nothing is captured from pages. A page cannot ask for a login: the backend fills one only when the user clicks Fill, in the top frame, on exactly the host it was saved for (not a subdomain), and over HTTPS unless the address is local. Once filled, the page's own scripts can read the field, as they can read anything typed into it |
| Autoplay | Per site, `autoplay_guard.js` refuses `play()` and pauses media until the user clicks or presses a key on the page. Hosts reach the script as JSON |
| Downloads | Default Downloads folder; SmartScreen reputation checks stay on (NETRUNNER's own webview disables SmartScreen, the browser profile does not) |
| WebRTC | `--force-webrtc-ip-handling-policy=default_public_interface_only` hides local IP addresses (applies after restart) |
| Private tabs | InPrivate WebView2 sessions; nothing is written to history |
| YouTube ads | `youtube_guard.js`, our own code in the binary, runs on `youtube.com` and `youtube-nocookie.com` only. It edits what those pages receive and show, reads nothing else, sends nothing and has no way back to NETRUNNER. Off in Privacy; off when blocking is off for YouTube |
| Cookies | The viewer lists names, domains and expiry of the current page's cookies. Values never leave WebView2, because they are often login tokens |
| JavaScript | Can be turned off per site (`browser.no_script`), applied before each navigation |
| Page appearance | Off unless the user turns it on. What reaches a page is a stylesheet built from validated hex colours (`page_style.rs` refuses anything else) and never a value the page supplied; it reads nothing and has no way back to NETRUNNER. A page can see the stylesheet and so learn the theme's accent colour, which is a small fingerprinting signal to weigh when turning it on. Transparency applies only to sites the user listed |

Not covered: uBlock scriptlets (`##+js`) are not bundled, because they would mean running downloaded code in pages, so sites other than YouTube that serve ads from their own domain can still show them. Loading unpacked extensions (e.g. uBlock Origin Lite) is an opt-in setting; extensions run with the permissions they declare. Fingerprinting resistance beyond WebView2's defaults is not attempted.

## Widget Studio

| Part | Safeguard |
|---|---|
| HTML/CSS widgets | Sandboxed frame without `allow-scripts` / `allow-same-origin`: no JavaScript, no NETRUNNER IPC, storage or cookies. Own CSP `default-src 'none'` (images and fonts only as `data:`); the app CSP blocks navigating the frame to remote pages |
| Feed widgets | Fetched by the backend from the stored address only; host must be on the widget's allowlist, redirects too; 2 MB / 15 s limits, at most every 5 minutes. Markup is stripped; only http(s) links are passed on |
| Links | Validated as http(s) and opened as BROWSER tabs (hardened profile), never handed to the shell |

## Credentials

- **GitHub token:** validated against `/user`, then stored only in **Windows Credential Manager** (DPAPI) under `NETRUNNER / github-token`. It is never written to SQLite or logs and never returned to the UI. Disconnect deletes it.
- **Git remotes:** clone/pull/push use Git's own credential helper (Git Credential Manager). NETRUNNER never sees these credentials.
- **Gemini API key:** validated by listing models, stored only in Credential Manager (`NETRUNNER / gemini-api-key`), sent only in the `x-goog-api-key` header (never in URLs), never returned to the UI.

## AI (NEURAL)

- **The model reaches only its own folder.** Each chat in the NEURAL tab has a folder, `<app data>\neural\chats\<id>`, and tools to list, read, write, append to and edit text files in it (`neural/folder.rs`). Paths come from the model and are treated as hostile: relative only, no `..`, no absolute or UNC paths, no alternate data streams or reserved Windows names, no links or junctions, text types only (`md, txt, json, csv, yaml, yml, toml, log, py`), and the credentials filter applies. Limits: 256 KB a file, 300 files, 16 MB a folder, 8 tool steps a message. Nothing in the folder is ever run.
- **It cannot delete or run anything.** There is no delete tool. Every change appears as a card with a diff and an Undo button, and is written to the activity log. Copies for undo are kept outside the folder, so the model cannot change them. Writes need no confirmation, because they cannot leave the folder and can be undone. Deleting a chat moves its folder to the Recycle Bin.
- **Python never runs on this PC.** Work mode offers Gemini's hosted code execution, which runs in Google's environment and has no way to the folder. It is not offered in Play.
- **Files and photos can carry instructions.** A photo or attachment may contain text aimed at the model. The folder limit is what contains that: at worst it changes files in that chat's folder, which can be undone.
- **DEVELOPER's panel has no tools.** There the model still sees only explicit attachments (Attach file, Attach selection, Attach project file list), and AI code changes arrive as a proposal diff. Pre-filled prompts (FILES "Analyze with AI", Inspector "Ask NEURAL") are never sent automatically.
- **What leaves the machine.** Each request sends the chat's recent history, attachments, photos and the text files at the top level of its folder, to Google. On the free tier Google may use this to improve its products and human reviewers may read it, and its terms say not to submit sensitive information. The connect screen says so. Attachments can be kept in context, in which case they are read again and sent with every message of that chat until the pin is removed.
- **Photos** are re-encoded on a canvas as JPEG before they are stored or sent, which removes metadata such as location. They stay in the chat's folder and are sent with their message and the following few messages.
- The backend reads attached files itself, with limits of 256 KB per file and 1 MB per request. It refuses binary files and anything that looks like credentials (`.env*`, `.ssh`, `*.pem`/`*.key`/`*.pfx`, `.npmrc`, `.git-credentials`…).
- The composer shows exactly what will be attached and its size. Every send writes an activity-log entry listing what left the machine.
- AI code changes arrive as a **proposal diff** in DEVELOPER. Apply requires confirmation, writes the file only, and never commits or pushes.
- FILES modifications are refused in Windows/program folders and on drive roots; deletes go to the Recycle Bin.- Chat history is stored only in the local SQLite database (`neural_chats`/`neural_messages`). Earlier turns of the open chat are sent as conversation context when you send a new message, up to about 60 000 tokens; attachments are not re-sent unless kept in context. Deleting a chat deletes its messages.
