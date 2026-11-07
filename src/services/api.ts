/**
 * Typed wrappers around the Rust commands. This is the only module that
 * calls `invoke` directly.
 */
import { invoke, type Channel } from "@tauri-apps/api/core";
import type { AudioDevices, AudioSession } from "@/types/audio";
import type {
  BlameLine,
  DapEvent,
  DebugAdapterStatus,
  GhChecks,
  GhComment,
  GhOrigin,
  GhPrDetail,
  GhPrFile,
  ChangedFile,
  Commit,
  GitBaseline,
  GitStash,
  GraphRow,
  DirEntry,
  FileContent,
  GitHubEntry,
  GitHubFile,
  GitHubIssue,
  GitHubRepo,
  GitHubStatus,
  GitHubUser,
  LspEvent,
  LspOpened,
  LspServerStatus,
  RepoStatus,
  SearchQuery,
  SearchResult,
  ShellOption,
  TermEvent,
  Toolchain,
} from "@/types/dev";
import type {
  Bookmark,
  BrowserCookie, BrowserDownload, BrowserLogin,
  BrowserStatus,
  BrowserTab,
  HistoryEntry,
  MediaStatus,
  SitePermission,
  TabMedia,
} from "@/types/browser";
import type { Attachment, ChatState, ContextItem, FileEntry, FilePreview, ModelInfo, NeuralAction, NeuralMode, NeuralStatus, Places, StreamEvent } from "@/types/neural";
import type { NoteItem, NotesBoard } from "@/types/notes";
import type { CustomWidget, FeedResult, StudioKind } from "@/types/studio";
import type { Alarm, AlarmInput, AlarmsState, Sound, Timer, TimerInput } from "@/types/alarms";
import type {
  ActivityEntry,
  AppInfo, DbBackup,
  CommandAssessment,
  DashboardLayout,
  ProcessList,
  Profile,
  ProfilesState,
  HotkeyBinding,
  QuickAccessEntry,
  QuickAccessInput,
  SystemInfo,
  SystemSnapshot,
} from "@/types/entities";
import type {
  AutomationInput,
  AutomationRule,
  DryRun,
  Integration,
  LibraryScan,
  PlayDay,
  Playtime,
  NetworkStatus,
  Overlay,
  PowerInfo,
  ServiceInfo,
  StartupEntry,
} from "@/types/phase2";

export type ApiErrorCode =
  | "database"
  | "serialization"
  | "io"
  | "not_found"
  | "invalid"
  | "confirmation_required"
  | "launch_failed"
  | "internal"
  | "unknown";

export class ApiError extends Error {
  constructor(
    public code: ApiErrorCode,
    message: string,
  ) {
    super(message);
  }
}

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (raw) {
    if (raw && typeof raw === "object" && "code" in raw && "message" in raw) {
      const err = raw as { code: ApiErrorCode; message: string };
      throw new ApiError(err.code, err.message);
    }
    throw new ApiError("unknown", String(raw));
  }
}

export const api = {
  appInfo: () => call<AppInfo>("app_info"),

  storage: {
    backups: () => call<DbBackup[]>("storage_backups"),
    backupNow: () => call<void>("storage_backup_now"),
    exportTo: (path: string) => call<void>("storage_export", { path }),
    /** Checks the backup, then restarts NETRUNNER to swap it in. */
    restore: (name: string) => call<void>("storage_restore", { name }),
    importFrom: (path: string) => call<void>("storage_import", { path }),
    remove: (name: string) => call<void>("storage_backup_delete", { name }),
    openFolder: () => call<void>("storage_open_backups"),
  },

  settings: {
    getAll: () => call<Record<string, unknown>>("settings_get_all"),
    set: (key: string, value: unknown) => call<void>("settings_set", { key, value }),
  },

  profiles: {
    state: () => call<ProfilesState>("profiles_state"),
    create: (name: string, copyFrom?: number) => call<Profile>("profile_create", { name, copyFrom }),
    rename: (id: number, name: string) => call<Profile>("profile_rename", { id, name }),
    remove: (id: number) => call<void>("profile_delete", { id }),
    saveLayout: (id: number, layout: DashboardLayout) => call<Profile>("profile_save_layout", { id, layout }),
    setWidgetConfig: (id: number, widgetId: string, config: Record<string, unknown>) =>
      call<Profile>("profile_set_widget_config", { id, widgetId, config }),
    activate: (id: number) => call<Profile>("profile_activate", { id }),
  },

  quickAccess: {
    list: () => call<QuickAccessEntry[]>("qa_list"),
    create: (input: QuickAccessInput) => call<QuickAccessEntry>("qa_create", { input }),
    update: (id: number, input: QuickAccessInput) => call<QuickAccessEntry>("qa_update", { id, input }),
    setFavorite: (id: number, favorite: boolean) => call<QuickAccessEntry>("qa_set_favorite", { id, favorite }),
    setProfile: (id: number, profileId: number | null) => call<QuickAccessEntry>("qa_set_profile", { id, profileId }),
    reorder: (ids: number[]) => call<void>("qa_reorder", { ids }),
    remove: (id: number) => call<void>("qa_delete", { id }),
    launch: (id: number, confirmed = false) => call<QuickAccessEntry>("qa_launch", { id, confirmed }),
    reveal: (id: number) => call<void>("qa_reveal", { id }),
    assessCommand: (command: string) => call<CommandAssessment>("qa_assess_command", { command }),
  },

  hotkeys: {
    list: () => call<HotkeyBinding[]>("hotkeys_list"),
    set: (id: string, keys: string) => call<HotkeyBinding[]>("hotkey_set", { id, keys }),
    reset: () => call<HotkeyBinding[]>("hotkeys_reset"),
  },

  activity: {
    list: (limit = 100) => call<ActivityEntry[]>("activity_list", { limit }),
    clear: () => call<void>("activity_clear"),
  },

  sensors: {
    status: () => call<{ available: boolean; message: string; temperatures: number; fans: number }>("sensors_status"),
  },

  audio: {
    devices: () => call<AudioDevices>("audio_devices"),
    sessions: (device?: string) => call<AudioSession[]>("audio_sessions", { device }),
    setVolume: (id: string, percent: number) => call<void>("audio_set_volume", { id, percent }),
    setMute: (id: string, mute: boolean) => call<void>("audio_set_mute", { id, mute }),
    setDefault: (id: string, name: string) => call<void>("audio_set_default", { id, name }),
    sessionSet: (id: string, volume?: number, mute?: boolean) => call<void>("audio_session_set", { id, volume, mute }),
    openSettings: () => call<void>("audio_open_settings"),
  },

  system: {
    info: () => call<SystemInfo>("system_info"),
    snapshot: () => call<SystemSnapshot>("system_snapshot"),
    topProcesses: (limit = 8) => call<ProcessList>("system_top_processes", { limit }),
    terminate: (pid: number) => call<void>("system_terminate_process", { pid, confirmed: true }),
    startupList: () => call<StartupEntry[]>("system_startup_list"),
    startupSet: (id: string, enabled: boolean) => call<void>("system_startup_set", { id, enabled }),
    services: () => call<ServiceInfo[]>("system_services"),
    power: () => call<PowerInfo>("system_power"),
    setPowerPlan: (guid: string) => call<void>("system_power_set_plan", { guid }),
  },

  network: {
    status: () => call<NetworkStatus>("network_status"),
  },

  app: {
    autostartGet: () => call<boolean>("app_autostart_get"),
    autostartSet: (enabled: boolean) => call<boolean>("app_autostart_set", { enabled }),
    quit: () => call<void>("app_quit"),
    openUrl: (url: string) => call<void>("app_open_url", { url }),
    checkUpdate: () => call<{ current: string; available: string | null; notes: string | null }>("app_check_update"),
    installUpdate: () => call<void>("app_install_update"),
  },

  games: {
    scan: () => call<LibraryScan>("games_scan"),
    launch: (id: string) => call<void>("games_launch", { id }),
    reveal: (id: string) => call<void>("games_reveal", { id }),
    /** Playtime per game since `from` (unix ms; null = all time). */
    playtime: (from: number | null) => call<Playtime[]>("games_playtime", { from }),
    history: (id: string, days: number) => call<PlayDay[]>("games_history", { id, days }),
    running: () => call<string[]>("games_running"),
    clearPlaytime: (id: string) => call<number>("games_clear_playtime", { id }),
    /** Steam header artwork as a data URL (Steam's local cache first). */
    banner: (id: string) => call<string>("games_banner", { id }),
  },

  integrations: {
    list: () => call<Integration[]>("integrations_list"),
    launch: (id: string) => call<void>("integration_launch", { id }),
  },

  automation: {
    list: () => call<AutomationRule[]>("automation_list"),
    create: (input: AutomationInput) => call<AutomationRule>("automation_create", { input }),
    update: (id: number, input: AutomationInput) => call<AutomationRule>("automation_update", { id, input }),
    remove: (id: number) => call<void>("automation_delete", { id }),
    run: (id: number) => call<string>("automation_run", { id }),
    dryRun: (input: AutomationInput) => call<DryRun>("automation_dry_run", { input }),
  },

  dev: {
    projects: () => call<string[]>("dev_projects"),
    openProject: (path: string) => call<string>("dev_open_project", { path }),
    closeProject: (path: string) => call<void>("dev_close_project", { path }),
    listDir: (path: string) => call<DirEntry[]>("dev_list_dir", { path }),
    readFile: (path: string) => call<FileContent>("dev_read_file", { path }),
    writeFile: (path: string, content: string) => call<void>("dev_write_file", { path, content }),
    create: (parent: string, name: string, dir: boolean) => call<string>("dev_create", { parent, name, dir }),
    rename: (path: string, newName: string) => call<string>("dev_rename", { path, newName }),
    remove: (path: string) => call<void>("dev_delete", { path }),
    reveal: (path: string) => call<void>("dev_reveal", { path }),
    toolchains: () => call<Toolchain[]>("dev_toolchains"),
    files: (root: string) => call<string[]>("dev_files", { root }),
    search: (root: string, query: SearchQuery) => call<SearchResult>("dev_search", { root, query }),
    replace: (query: SearchQuery, replacement: string, paths: string[]) => call<number>("dev_replace", { query, replacement, paths }),
  },

  lsp: {
    subscribe: (onEvent: Channel<LspEvent>) => call<void>("lsp_subscribe", { onEvent }),
    servers: (project: string | null) => call<LspServerStatus[]>("lsp_servers", { project }),
    open: (path: string, version: number, text: string) => call<LspOpened>("lsp_open", { path, version, text }),
    change: (uri: string, version: number, text: string) => call<void>("lsp_change", { uri, version, text }),
    save: (uri: string) => call<void>("lsp_save", { uri }),
    close: (uri: string) => call<void>("lsp_close", { uri }),
    request: <T = unknown>(server: string, method: string, params: unknown) => call<T>("lsp_request", { server, method, params }),
    restart: (server: string) => call<void>("lsp_restart", { server }),
    configure: (spec: string, path: string | null, disabled: boolean) => call<void>("lsp_configure", { spec, path, disabled }),
  },

  dap: {
    adapters: (root: string) => call<DebugAdapterStatus[]>("dap_adapters", { root }),
    start: (root: string, adapter: string, request: string, config: unknown, breakpoints: { path: string; breakpoints: { line: number; condition?: string }[] }[], onEvent: Channel<DapEvent>) =>
      call<void>("dap_start", { root, adapter, request, config, breakpoints, onEvent }),
    request: <T = unknown>(command: string, args: unknown) => call<T>("dap_request", { command, arguments: args }),
    stop: () => call<void>("dap_stop"),
  },

  term: {
    shells: () => call<ShellOption[]>("term_shells"),
    spawn: (shell: string, cwd: string | null, cols: number, rows: number, onEvent: Channel<TermEvent>) =>
      call<number>("term_spawn", { shell, cwd, cols, rows, onEvent }),
    write: (id: number, data: string) => call<void>("term_write", { id, data }),
    resize: (id: number, cols: number, rows: number) => call<void>("term_resize", { id, cols, rows }),
    kill: (id: number) => call<void>("term_kill", { id }),
  },

  git: {
    status: (root: string) => call<RepoStatus>("git_status", { root }),
    diff: (root: string, path: string, staged: boolean) =>
      call<{ original: string; modified: string }>("git_diff", { root, path, staged }),
    stage: (root: string, paths: string[]) => call<void>("git_stage", { root, paths }),
    unstage: (root: string, paths: string[]) => call<void>("git_unstage", { root, paths }),
    discard: (root: string, path: string, untracked: boolean) =>
      call<void>("git_discard", { root, path, untracked, confirmed: true }),
    commit: (root: string, message: string) => call<string>("git_commit", { root, message }),
    log: (root: string, limit = 50) => call<Commit[]>("git_log", { root, limit }),
    branches: (root: string) => call<string[]>("git_branches", { root }),
    checkout: (root: string, branch: string) => call<void>("git_checkout", { root, branch }),
    createBranch: (root: string, name: string) => call<void>("git_create_branch", { root, name }),
    pull: (root: string) => call<string>("git_pull", { root }),
    push: (root: string) => call<string>("git_push", { root, confirmed: true }),
    init: (root: string) => call<void>("git_init", { root }),
    clone: (url: string, parent: string, name: string) => call<string>("git_clone", { url, parent, name }),
    baseline: (root: string, path: string) => call<GitBaseline>("git_baseline", { root, path }),
    stageText: (root: string, path: string, content: string) => call<void>("git_stage_text", { root, path, content }),
    blame: (root: string, path: string, from?: number, to?: number) => call<BlameLine[]>("git_blame", { root, path, from, to }),
    stashList: (root: string) => call<GitStash[]>("git_stash_list", { root }),
    stashSave: (root: string, message: string, untracked: boolean) => call<void>("git_stash_save", { root, message, untracked }),
    stashAction: (root: string, action: "apply" | "pop" | "drop", index: number) =>
      call<string>("git_stash_action", { root, action, index, confirmed: true }),
    amend: (root: string, message: string) => call<string>("git_amend", { root, message, confirmed: true }),
    headPushed: (root: string) => call<boolean>("git_head_pushed", { root }),
    graph: (root: string, limit = 200) => call<GraphRow[]>("git_graph", { root, limit }),
    compare: (root: string, base: string, head: string) => call<ChangedFile[]>("git_compare", { root, base, head }),
    fileAt: (root: string, revision: string, path: string) => call<string>("git_file_at", { root, revision, path }),
    cherryPick: (root: string, hash: string) => call<string>("git_cherry_pick", { root, hash, confirmed: true }),
  },

  gh: {
    origin: (root: string) => call<GhOrigin | null>("gh_origin", { root }),
    publish: (root: string, name: string, description: string, isPrivate: boolean) =>
      call<{ full_name: string; clone_url: string; html_url: string }>("gh_publish", { root, name, description, private: isPrivate, confirmed: true }),
    commitsSince: (root: string, base: string) => call<string[]>("gh_commits_since", { root, base }),
    createPr: (root: string, title: string, body: string, base: string, draft: boolean) =>
      call<{ number: number; html_url: string }>("gh_create_pr", { root, title, body, base, draft, confirmed: true }),
    pr: (owner: string, repo: string, number: number) => call<GhPrDetail>("gh_pr", { owner, repo, number }),
    prFiles: (owner: string, repo: string, number: number) => call<GhPrFile[]>("gh_pr_files", { owner, repo, number }),
    comments: (owner: string, repo: string, number: number) => call<GhComment[]>("gh_comments", { owner, repo, number }),
    addComment: (owner: string, repo: string, number: number, body: string) =>
      call<GhComment>("gh_add_comment", { owner, repo, number, body, confirmed: true }),
    checkoutPr: (root: string, number: number) => call<string>("gh_checkout_pr", { root, number }),
    checks: (owner: string, repo: string, gitRef: string) => call<GhChecks>("gh_checks", { owner, repo, gitRef }),
    issueBranch: (root: string, number: number, title: string) => call<string>("gh_issue_branch", { root, number, title }),
    fileUrl: (root: string, path: string, from: number | null, to: number | null, permalink: boolean) =>
      call<string>("gh_file_url", { root, path, from, to, permalink }),
  },

  github: {
    status: () => call<GitHubStatus>("github_status"),
    connect: (token: string) => call<GitHubUser>("github_connect", { token }),
    disconnect: () => call<void>("github_disconnect"),
    repos: () => call<GitHubRepo[]>("github_repos"),
    issues: (owner: string, repo: string, pulls: boolean, state = "open") =>
      call<GitHubIssue[]>("github_issues", { owner, repo, pulls, state }),
    contents: (owner: string, repo: string, path: string, gitRef?: string) =>
      call<GitHubEntry[]>("github_contents", { owner, repo, path, gitRef }),
    file: (owner: string, repo: string, path: string, gitRef?: string) => call<GitHubFile>("github_file", { owner, repo, path, gitRef }),
    branches: (owner: string, repo: string) => call<string[]>("github_branches", { owner, repo }),
    /** "owner/repo" (lower case) → local folder: linked by hand, or found automatically. */
    localClones: () => call<Record<string, string>>("github_local_clones"),
    linkLocal: (fullName: string, path: string | null) => call<void>("github_link_local", { fullName, path }),
  },

  neural: {
    status: () => call<NeuralStatus>("neural_status"),
    connect: (key: string) => call<ModelInfo[]>("neural_connect", { key }),
    disconnect: () => call<void>("neural_disconnect"),
    models: () => call<ModelInfo[]>("neural_models"),
    preview: (attachments: Attachment[]) => call<ContextItem[]>("neural_preview", { attachments }),
    chat: (chatId: number, agent: boolean, history: { role: "user" | "model"; text: string; images: string[] }[], attachments: Attachment[], requestId: number, onEvent: Channel<StreamEvent>) =>
      call<string>("neural_chat", { chatId, agent, history, attachments, requestId, onEvent }),
    cancel: (requestId: number) => call<void>("neural_cancel", { requestId }),
    chatOpen: (id?: number) => call<ChatState>("neural_chat_open", { id: id ?? null }),
    chatNew: () => call<ChatState>("neural_chat_new"),
    chatDelete: (id: number) => call<void>("neural_chat_delete", { id }),
    chatRename: (id: number, title: string) => call<void>("neural_chat_rename", { id, title }),
    chatAppend: (chatId: number, message: { role: "user" | "model"; text: string; model: string | null; sent: string[]; images?: string[]; actions?: NeuralAction[] }) =>
      call<number>("neural_chat_append", { chatId, message }),
    chatSetMode: (id: number, mode: NeuralMode) => call<void>("neural_chat_set_mode", { id, mode }),
    chatSetKept: (id: number, kept: Attachment[]) => call<void>("neural_chat_set_kept", { id, kept }),
    files: (chatId: number) => call<{ path: string; size: number }[]>("neural_files", { chatId }),
    fileRead: (chatId: number, path: string) => call<string>("neural_file_read", { chatId, path }),
    undo: (chatId: number, change: number) => call<string>("neural_undo", { chatId, change }),
    openFolder: (chatId: number) => call<void>("neural_open_folder", { chatId }),
    imageSave: (chatId: number, data: string) => call<string>("neural_image_save", { chatId, data }),
    imageRead: (chatId: number, name: string) => call<string>("neural_image_read", { chatId, name }),
    imageFromPath: (path: string) => call<string>("neural_image_from_path", { path }),
  },

  files: {
    places: () => call<Places>("files_places"),
    list: (path: string) => call<FileEntry[]>("files_list", { path }),
    preview: (path: string) => call<FilePreview>("files_preview", { path }),
    createDir: (parent: string, name: string) => call<string>("files_create_dir", { parent, name }),
    rename: (path: string, newName: string) => call<string>("files_rename", { path, newName }),
    transfer: (paths: string[], dest: string, moveItems: boolean) => call<number>("files_transfer", { paths, dest, moveItems }),
    remove: (paths: string[]) => call<number>("files_delete", { paths }),
    open: (path: string) => call<void>("files_open", { path }),
    reveal: (path: string) => call<void>("files_reveal", { path }),
    search: (root: string, query: string) => call<{ entries: FileEntry[]; complete: boolean }>("files_search", { root, query }),
    extract: (path: string) => call<{ folder: string; files: number; skipped: number }>("files_extract", { path }),
    duplicates: (root: string, minSize: number) => call<{ groups: { size: number; paths: string[] }[]; scanned: number; complete: boolean }>("files_duplicates", { root, minSize }),
  },

  overlays: {
    list: () => call<Overlay[]>("overlay_list"),
    get: (id: number) => call<Overlay>("overlay_get", { id }),
    create: (widgetType: string) => call<Overlay>("overlay_create", { widgetType }),
    createWeb: (url: string, title: string) => call<Overlay>("overlay_create_web", { url, title }),
    patch: (id: number, patch: Partial<Pick<Overlay, "opacity" | "locked" | "showOnStartup" | "config" | "title" | "clickThrough">>) =>
      call<Overlay>("overlay_patch", { id, patch }),
    setGeometry: (id: number, x: number, y: number, width: number, height: number) =>
      call<void>("overlay_set_geometry", { id, x, y, width, height }),
    setVisible: (id: number, visible: boolean) => call<void>("overlay_set_visible", { id, visible }),
    setProfile: (id: number, profileId: number | null) => call<Overlay>("overlay_set_profile", { id, profileId }),
    remove: (id: number) => call<void>("overlay_delete", { id }),
    toggleAll: () => call<void>("overlay_toggle_all"),
  },

  studio: {
    list: () => call<CustomWidget[]>("studio_list"),
    create: (kind: StudioKind, name: string) => call<CustomWidget>("studio_create", { kind, name }),
    update: (id: number, name: string, config: Record<string, unknown>) => call<CustomWidget>("studio_update", { id, name, config }),
    setProfile: (id: number, profileId: number | null) => call<CustomWidget>("studio_set_profile", { id, profileId }),
    counter: (id: number, value: number) => call<CustomWidget>("studio_counter", { id, value }),
    remove: (id: number) => call<void>("studio_delete", { id }),
    feed: (id: number, force: boolean) => call<FeedResult>("studio_feed", { id, force }),
    /** Opens a link from a widget as a BROWSER tab in the main window. */
    openLink: (url: string) => call<void>("browser_open_request", { url }),
  },

  alarms: {
    state: () => call<AlarmsState>("alarms_state"),
    save: (id: number | null, input: AlarmInput) => call<Alarm>("alarm_save", { id, input }),
    setEnabled: (id: number, enabled: boolean) => call<Alarm>("alarm_set_enabled", { id, enabled }),
    remove: (id: number) => call<void>("alarm_delete", { id }),
    createTimer: (input: TimerInput, start: boolean) => call<Timer>("timer_create", { input, start }),
    timer: (id: number, action: "start" | "pause" | "reset") => call<Timer>("timer_control", { id, action }),
    removeTimer: (id: number) => call<void>("timer_delete", { id }),
    stop: (key: string) => call<void>("alarm_stop", { key }),
    snooze: (key: string) => call<void>("alarm_snooze", { key }),
    sounds: () => call<Sound[]>("sounds_list"),
    importSound: (path: string) => call<Sound>("sound_import", { path }),
    deleteSound: (id: string) => call<void>("sound_delete", { id }),
    preview: (sound: string, volume: number) => call<void>("sound_preview", { sound, volume }),
    stopPreview: () => call<void>("sound_preview_stop"),
  },

  notes: {
    board: (board: string) => call<NotesBoard>("notes_board", { board }),
    setText: (board: string, text: string) => call<void>("notes_set_text", { board, text }),
    add: (board: string, text: string, first: boolean) => call<NoteItem>("notes_add", { board, text, first }),
    update: (id: number, change: { text?: string; done?: boolean }) => call<void>("notes_update", { id, ...change }),
    remove: (id: number) => call<void>("notes_delete", { id }),
    reorder: (board: string, ids: number[]) => call<void>("notes_reorder", { board, ids }),
    clearDone: (board: string) => call<number>("notes_clear_done", { board }),
  },

  browser: {
    status: () => call<BrowserStatus>("browser_status"),
    updateLists: () => call<[string, string][]>("browser_update_lists"),
    tabs: () => call<BrowserTab[]>("browser_tabs"),
    open: (input: string, isPrivate = false) => call<BrowserTab>("browser_open", { input, private: isPrivate }),
    navigate: (id: string, input: string) => call<void>("browser_navigate", { id, input }),
    action: (id: string, action: "back" | "forward" | "reload" | "stop" | "mute" | "unmute") =>
      call<void>("browser_action", { id, action }),
    close: (id: string) => call<void>("browser_close", { id }),
    setBounds: (id: string, x: number, y: number, width: number, height: number, visible: boolean) =>
      call<void>("browser_set_bounds", { id, x, y, width, height, visible }),
    setZoom: (id: string, factor: number) => call<void>("browser_set_zoom", { id, factor }),
    allowHttp: (id: string, url: string) => call<void>("browser_allow_http", { id, url }),
    clearData: () => call<void>("browser_clear_data"),
    downloads: () => call<BrowserDownload[]>("browser_downloads"),
    cancelDownload: (url: string) => call<void>("browser_download_cancel", { url }),
    reader: (id: string) => call<void>("browser_reader", { id }),
    logins: () => call<BrowserLogin[]>("browser_logins"),
    loginSave: (host: string, username: string, password: string) => call<void>("browser_login_save", { host, username, password }),
    loginDelete: (host: string, username: string) => call<void>("browser_login_delete", { host, username }),
    loginFill: (id: string, username: string) => call<void>("browser_login_fill", { id, username }),
    cookies: (id: string) => call<BrowserCookie[]>("browser_cookies", { id }),
    deleteCookie: (id: string, c: Pick<BrowserCookie, "name" | "domain" | "path">) => call<void>("browser_cookie_delete", { id, name: c.name, domain: c.domain, path: c.path }),
    bookmarks: () => call<Bookmark[]>("browser_bookmarks"),
    addBookmark: (url: string, title: string) => call<Bookmark>("browser_bookmark_add", { url, title }),
    renameBookmark: (id: number, title: string) => call<void>("browser_bookmark_rename", { id, title }),
    removeBookmark: (id: number) => call<void>("browser_bookmark_remove", { id }),
    history: (query: string, limit = 200) => call<HistoryEntry[]>("browser_history", { query, limit }),
    clearHistory: () => call<void>("browser_history_clear"),
    permissions: () => call<SitePermission[]>("browser_permissions"),
    setPermission: (host: string, kind: string, granted: boolean) => call<void>("browser_permission_set", { host, kind, granted }),
    popOut: (id: string) => call<Overlay>("browser_pop_out", { id }),
    overlayTab: (overlayId: number) => call<BrowserTab>("browser_overlay_tab", { overlayId }),
    returnTab: (overlayId: number) => call<BrowserTab>("browser_return_tab", { overlayId }),
    media: () => call<TabMedia[]>("browser_media"),
    mediaControl: (id: string, action: "toggle" | "play" | "pause" | "nexttrack" | "previoustrack" | "stop") =>
      call<void>("browser_media_control", { id, action }),
    mediaArtwork: (url: string) => call<string | null>("browser_media_artwork", { url }),
  },

  appearance: {
    wallpapers: () => call<{ name: string; sizeBytes: number }[]>("appearance_wallpapers"),
    importWallpaper: (path: string) => call<{ name: string; sizeBytes: number }>("appearance_import_wallpaper", { path }),
    deleteWallpaper: (name: string) => call<void>("appearance_delete_wallpaper", { name }),
    wallpaperData: (name: string) => call<string>("appearance_wallpaper_data", { name }),
  },

  media: {
    status: () => call<MediaStatus>("media_status"),
    control: (appId: string, action: "toggle" | "next" | "previous" | "stop") => call<void>("media_control", { appId, action }),
  },
};
