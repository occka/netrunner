/**
 * Which player the Music Player widget shows.
 *
 * Sources are NETRUNNER tabs/web overlays (read through the media hook) and
 * other apps' Windows media sessions. The widget holds on to the source it
 * shows: pausing never makes it jump elsewhere. It moves only when the held
 * source disappears, or when a source of a higher class starts playing.
 * Classes: NETRUNNER music site > other NETRUNNER tab > other app.
 */
import type { MediaSession, TabMedia } from "@/types/browser";

export interface MusicSource {
  key: string;
  kind: "tab" | "system";
  /** Site or app name shown in the source picker. */
  label: string;
  music: boolean;
  title: string;
  artist: string;
  album: string;
  playing: boolean;
  positionSecs: number | null;
  durationSecs: number | null;
  canPrevious: boolean;
  canNext: boolean;
  /** Tab id or Windows app id, for controls. */
  target: string;
  artworkUrl: string | null;
  thumbnail: string | null;
}

export type SourceMode = "netrunner-first" | "netrunner-only" | "any";

const SITES: [RegExp, string, boolean][] = [
  [/(^|\.)soundcloud\.com$/, "SoundCloud", true],
  [/^music\.youtube\.com$/, "YouTube Music", true],
  [/(^|\.)spotify\.com$/, "Spotify", true],
  [/^music\.yandex\.(ru|com|by|kz)$/, "Yandex Music", true],
  [/(^|\.)deezer\.com$/, "Deezer", true],
  [/(^|\.)tidal\.com$/, "TIDAL", true],
  [/(^|\.)bandcamp\.com$/, "Bandcamp", true],
  [/^music\.apple\.com$/, "Apple Music", true],
  [/^music\.amazon\./, "Amazon Music", true],
  [/(^|\.)mixcloud\.com$/, "Mixcloud", true],
  [/(^|\.)audiomack\.com$/, "Audiomack", true],
  [/(^|\.)zvuk\.com$/, "Zvuk", true],
  [/(^|\.)youtube\.com$/, "YouTube", false],
  [/(^|\.)twitch\.tv$/, "Twitch", false],
  [/(^|\.)(vk\.com|vkvideo\.ru)$/, "VK", false],
];

export function siteOf(url: string): { label: string; music: boolean } {
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    return { label: "Web", music: false };
  }
  const hit = SITES.find(([re]) => re.test(host));
  return hit ? { label: hit[1], music: hit[2] } : { label: host.replace(/^www\./, ""), music: false };
}

/** "Spotify.exe", "308046B0AF4A39CB", "Microsoft.ZuneMusic_8wekyb3d8bbwe!Microsoft.ZuneMusic" → readable name. */
export function appName(appId: string): string {
  const base = appId.split("!").pop() ?? appId;
  const name = base.replace(/\.exe$/i, "").split(".").pop() ?? base;
  if (/^msedgewebview2$/i.test(name)) return "NETRUNNER";
  const known: Record<string, string> = { chrome: "Chrome", msedge: "Edge", firefox: "Firefox", spotify: "Spotify", opera: "Opera" };
  if (known[name.toLowerCase()]) return known[name.toLowerCase()];
  if (/^[0-9A-F]{16}$/i.test(name)) return "Browser";
  return name.replace(/_[a-z0-9]{13}$/, "");
}

export function fromTab(t: TabMedia): MusicSource {
  const site = siteOf(t.url);
  return {
    key: `tab:${t.tab}`,
    kind: "tab",
    label: t.host.startsWith("overlay-") ? `${site.label} · overlay` : site.label,
    music: site.music,
    title: t.title,
    artist: t.artist,
    album: t.album,
    playing: t.playing,
    positionSecs: t.positionSecs,
    durationSecs: t.durationSecs,
    canPrevious: t.canPrevious,
    canNext: t.canNext,
    target: t.tab,
    artworkUrl: t.artworkUrl,
    thumbnail: null,
  };
}

export function fromSession(s: MediaSession): MusicSource {
  return {
    key: `sys:${s.appId}`,
    kind: "system",
    label: appName(s.appId),
    music: /spotify|zunemusic|yandex|deezer|tidal|itunes|applemusic|foobar|aimp|winamp|musicbee/i.test(s.appId),
    title: s.title,
    artist: s.artist,
    album: s.album,
    playing: s.status === "playing",
    positionSecs: s.positionSecs,
    durationSecs: s.durationSecs,
    canPrevious: s.canPrevious,
    canNext: s.canNext,
    target: s.appId,
    artworkUrl: null,
    thumbnail: s.thumbnail,
  };
}

/**
 * Merges both lists. NETRUNNER's own WebView2 session is dropped when its
 * tabs are known individually (it would be a duplicate of one of them).
 */
export function mergeSources(tabs: TabMedia[], sessions: MediaSession[], mode: SourceMode): MusicSource[] {
  const fromTabs = tabs.map(fromTab);
  const system = mode === "netrunner-only" ? [] : sessions.filter((s) => !(fromTabs.length && /msedgewebview2/i.test(s.appId))).map(fromSession);
  return [...fromTabs, ...system];
}

export function rank(s: MusicSource, mode: SourceMode): number {
  if (mode === "any") return 0;
  if (s.kind === "tab") return s.music ? 3 : 2;
  return s.music ? 1.5 : 1;
}

/**
 * The key of the source to show. `held` is what the widget showed last;
 * `manual` means the user picked it, which disables automatic switching
 * until it disappears.
 */
export function chooseSource(list: MusicSource[], held: string | null, manual: boolean, mode: SourceMode): string | null {
  if (list.length === 0) return null;
  const current = list.find((s) => s.key === held);
  if (current) {
    if (manual) return current.key;
    const r = rank(current, mode);
    const better = list
      .filter((s) => s.playing && s.key !== current.key && (rank(s, mode) > r || (mode === "any" && !current.playing)))
      .sort((a, b) => rank(b, mode) - rank(a, mode))[0];
    return (better ?? current).key;
  }
  const sorted = [...list].sort((a, b) => rank(b, mode) - rank(a, mode) || Number(b.playing) - Number(a.playing));
  return sorted[0].key;
}
