/** Payload types for DEVELOPER and GITHUB commands. */

export interface DirEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number | null;
  heavy: boolean;
}

export interface FileContent {
  path: string;
  content: string;
  readOnly: boolean;
  binary: boolean;
  size: number;
}

export interface Toolchain {
  id: string;
  name: string;
  language: string;
  found: boolean;
  version: string | null;
  path: string | null;
  customPath: boolean;
}

export interface ShellOption {
  id: "powershell" | "pwsh" | "cmd" | "gitbash";
  label: string;
}

export type TermEvent = { type: "data"; data: string } | { type: "exit"; code: number | null };

export interface GitFile {
  path: string;
  index: string;
  worktree: string;
  origPath: string | null;
}

export interface RepoStatus {
  isRepo: boolean;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  files: GitFile[];
}

export interface Commit {
  hash: string;
  author: string;
  date: string;
  subject: string;
}

export interface GitHubUser {
  login: string;
  name: string | null;
  htmlUrl: string;
  publicRepos: number;
}

export interface GitHubStatus {
  connected: boolean;
  user: GitHubUser | null;
  error: string | null;
}

/** An entry of a repository folder (GitHub contents API). */
export interface GitHubEntry {
  name: string;
  path: string;
  kind: "file" | "dir" | "symlink" | "submodule";
  size: number;
}

/** A repository file for viewing; text only (binary or very large files have no content). */
export interface GitHubFile {
  path: string;
  size: number;
  content: string | null;
  binary: boolean;
  tooLarge: boolean;
  htmlUrl: string | null;
}

export interface GitHubRepo {
  fullName: string;
  name: string;
  description: string | null;
  private: boolean;
  fork: boolean;
  language: string | null;
  stargazersCount: number;
  openIssuesCount: number;
  cloneUrl: string;
  htmlUrl: string;
  defaultBranch: string | null;
  pushedAt: string | null;
}

export interface GitHubIssue {
  number: number;
  title: string;
  state: string;
  user: { login: string };
  htmlUrl: string;
  createdAt: string;
  updatedAt: string;
  draft: boolean | null;
}

// ---------- Language servers (LSP) ----------

export type LspEvent =
  | { type: "status"; server: string; spec: string; state: "starting" | "ready" | "crashed" | "stopped"; message: string | null }
  | { type: "diagnostics"; server: string; uri: string; path: string | null; version: number | null; diagnostics: LspDiagnostic[] }
  | { type: "log"; server: string; level: number; message: string }
  | { type: "progress"; server: string; token: unknown; value: { kind?: string; title?: string; message?: string; percentage?: number } | null }
  | { type: "applyEdit"; server: string; label: string | null; edit: LspWorkspaceEdit };

export type LspOpened =
  | { state: "ready"; server: string; spec: string; name: string; uri: string; languageId: string; capabilities: Record<string, unknown> }
  | { state: "missing"; spec: string; name: string; server: string; install: string | null }
  | { state: "disabled"; spec: string; name: string }
  | { state: "failed"; spec: string; name: string; message: string }
  | { state: "unsupported" };

export interface LspServerStatus {
  id: string;
  name: string;
  server: string;
  extensions: string[];
  found: boolean;
  path: string | null;
  version: string | null;
  customPath: boolean;
  disabled: boolean;
  install: string | null;
  docs: string;
}

export interface LspPosition {
  line: number;
  character: number;
}
export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}
export interface LspDiagnostic {
  range: LspRange;
  severity?: number;
  code?: string | number | { value: string | number };
  source?: string;
  message: string;
  tags?: number[];
}
export interface LspTextEdit {
  range: LspRange;
  newText: string;
}
export interface LspWorkspaceEdit {
  changes?: Record<string, LspTextEdit[]>;
  documentChanges?: (
    | { textDocument: { uri: string; version?: number | null }; edits: LspTextEdit[] }
    | { kind: "create" | "rename" | "delete"; uri?: string; oldUri?: string; newUri?: string }
  )[];
}

// ---------- Project search ----------

export interface SearchQuery {
  pattern: string;
  regex: boolean;
  caseSensitive: boolean;
  wholeWord: boolean;
  include: string;
  exclude: string;
}

export interface SearchMatch {
  line: number;
  column: number;
  length: number;
  preview: string;
  previewColumn: number;
}

export interface SearchResult {
  files: { path: string; matches: SearchMatch[] }[];
  total: number;
  truncated: boolean;
  searched: number;
}

// ---------- Git in the editor ----------

export interface GitBaseline {
  text: string | null;
  tracked: boolean;
}

export interface BlameLine {
  line: number;
  hash: string;
  author: string;
  time: number;
  summary: string;
  committed: boolean;
}

export interface GitStash {
  index: number;
  name: string;
  message: string;
}

export interface GraphRow {
  graph: string;
  hash: string | null;
  refs: string;
  subject: string;
  author: string;
  date: string;
}

export interface ChangedFile {
  status: string;
  path: string;
}
