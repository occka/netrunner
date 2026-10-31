/**
 * Typed wrappers around the Rust commands. This is the only module that
 * calls `invoke` directly.
 */
import { invoke, type Channel } from "@tauri-apps/api/core";
import type {
  Commit,
  DirEntry,
  FileContent,
  GitHubIssue,
  GitHubRepo,
  GitHubStatus,
  GitHubUser,
  RepoStatus,
  ShellOption,
  TermEvent,
  Toolchain,
} from "@/types/dev";
import type { Attachment, ChatState, ContextItem, FileEntry, FilePreview, ModelInfo, NeuralStatus, Places, StreamEvent } from "@/types/neural";
import type {
  ActivityEntry,
  AppInfo,
  CommandAssessment,
  DashboardLayout,
  ProcessList,
  Profile,
  ProfilesState,
  QuickAccessEntry,
  QuickAccessInput,
  SystemInfo,
  SystemSnapshot,
} from "@/types/entities";
import type {
  AutomationInput,
  AutomationRule,
  Integration,
  LibraryScan,
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
    activate: (id: number) => call<Profile>("profile_activate", { id }),
  },

  quickAccess: {
    list: () => call<QuickAccessEntry[]>("qa_list"),
    create: (input: QuickAccessInput) => call<QuickAccessEntry>("qa_create", { input }),
    update: (id: number, input: QuickAccessInput) => call<QuickAccessEntry>("qa_update", { id, input }),
    setFavorite: (id: number, favorite: boolean) => call<QuickAccessEntry>("qa_set_favorite", { id, favorite }),
    reorder: (ids: number[]) => call<void>("qa_reorder", { ids }),
    remove: (id: number) => call<void>("qa_delete", { id }),
    launch: (id: number, confirmed = false) => call<QuickAccessEntry>("qa_launch", { id, confirmed }),
    reveal: (id: number) => call<void>("qa_reveal", { id }),
    assessCommand: (command: string) => call<CommandAssessment>("qa_assess_command", { command }),
  },

  activity: {
    list: (limit = 100) => call<ActivityEntry[]>("activity_list", { limit }),
    clear: () => call<void>("activity_clear"),
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
  },

  github: {
    status: () => call<GitHubStatus>("github_status"),
    connect: (token: string) => call<GitHubUser>("github_connect", { token }),
    disconnect: () => call<void>("github_disconnect"),
    repos: () => call<GitHubRepo[]>("github_repos"),
    issues: (owner: string, repo: string, pulls: boolean, state = "open") =>
      call<GitHubIssue[]>("github_issues", { owner, repo, pulls, state }),
  },

  neural: {
    status: () => call<NeuralStatus>("neural_status"),
    connect: (key: string) => call<ModelInfo[]>("neural_connect", { key }),
    disconnect: () => call<void>("neural_disconnect"),
    models: () => call<ModelInfo[]>("neural_models"),
    preview: (attachments: Attachment[]) => call<ContextItem[]>("neural_preview", { attachments }),
    chat: (history: { role: "user" | "model"; text: string }[], attachments: Attachment[], requestId: number, onEvent: Channel<StreamEvent>) =>
      call<string>("neural_chat", { history, attachments, requestId, onEvent }),
    cancel: (requestId: number) => call<void>("neural_cancel", { requestId }),
    chatOpen: (id?: number) => call<ChatState>("neural_chat_open", { id: id ?? null }),
    chatNew: () => call<ChatState>("neural_chat_new"),
    chatDelete: (id: number) => call<void>("neural_chat_delete", { id }),
    chatRename: (id: number, title: string) => call<void>("neural_chat_rename", { id, title }),
    chatAppend: (chatId: number, message: { role: "user" | "model"; text: string; model: string | null; sent: string[] }) =>
      call<number>("neural_chat_append", { chatId, message }),
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
  },

  overlays: {
    list: () => call<Overlay[]>("overlay_list"),
    get: (id: number) => call<Overlay>("overlay_get", { id }),
    create: (widgetType: string) => call<Overlay>("overlay_create", { widgetType }),
    patch: (id: number, patch: Partial<Pick<Overlay, "opacity" | "locked" | "showOnStartup">>) =>
      call<Overlay>("overlay_patch", { id, patch }),
    setGeometry: (id: number, x: number, y: number, width: number, height: number) =>
      call<void>("overlay_set_geometry", { id, x, y, width, height }),
    setVisible: (id: number, visible: boolean) => call<void>("overlay_set_visible", { id, visible }),
    remove: (id: number) => call<void>("overlay_delete", { id }),
    toggleAll: () => call<void>("overlay_toggle_all"),
  },
};
