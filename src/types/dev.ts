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
