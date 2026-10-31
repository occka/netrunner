/** BROWSER and media payloads (Rust serde camelCase). */

export interface BrowserTab {
  id: string;
  /** Window hosting the page: "main", "overlay-<id>" or a popup. */
  host: string;
  url: string;
  title: string;
  loading: boolean;
  canBack: boolean;
  canForward: boolean;
  blocked: number;
  private: boolean;
  muted: boolean;
  audible: boolean;
  fullscreen: boolean;
  favicon: string | null;
}

export type BrowserNoticeKind = "https-upgrade" | "permission" | "external-app" | "blocked-scheme" | "download";

export interface BrowserNotice {
  tab: string;
  kind: BrowserNoticeKind;
  host: string;
  detail: string;
}

export interface BrowserPrefs {
  adblock: boolean;
  cosmetic: boolean;
  httpsOnly: boolean;
  gpc: boolean;
  tracking: "strict" | "balanced" | "basic";
  history: boolean;
  autofill: boolean;
  search: string;
  lists: string[];
  exceptions: string[];
  webrtcProtect: boolean;
  extensions: boolean;
}

export interface FilterListStatus {
  id: string;
  name: string;
  purpose: string;
  url: string;
  enabled: boolean;
  downloaded: boolean;
  updatedAt: number | null;
  sizeBytes: number;
}

export interface BrowserStatus {
  prefs: BrowserPrefs;
  blocker: { ready: boolean; rules: number; building: boolean; lastError: string | null };
  lists: FilterListStatus[];
  blockedTotal: number;
  extensionsDir: string;
  searchEngines: [string, string][];
}

export interface Bookmark {
  id: number;
  url: string;
  title: string;
  createdAt: string;
}

export interface HistoryEntry {
  id: number;
  url: string;
  title: string;
  visitedAt: string;
}

export interface SitePermission {
  host: string;
  kind: string;
  grantedAt: string;
}

export interface BrowserDownload {
  id: number;
  url: string;
  path: string | null;
  state: "running" | "done" | "failed";
}

export interface MediaSession {
  appId: string;
  title: string;
  artist: string;
  album: string;
  status: "playing" | "paused" | "stopped" | "changing" | "closed";
  positionSecs: number | null;
  durationSecs: number | null;
  canPlayPause: boolean;
  canNext: boolean;
  canPrevious: boolean;
  thumbnail: string | null;
  current: boolean;
}

export interface MediaStatus {
  available: boolean;
  sessions: MediaSession[];
}

/** What a NETRUNNER tab or web overlay is playing (media hook). */
export interface TabMedia {
  tab: string;
  host: string;
  url: string;
  title: string;
  artist: string;
  album: string;
  artworkUrl: string | null;
  playing: boolean;
  positionSecs: number | null;
  durationSecs: number | null;
  canPrevious: boolean;
  canNext: boolean;
  muted: boolean;
}
