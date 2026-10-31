import { describe, expect, it } from "vitest";
import { chooseSource, mergeSources, siteOf, type MusicSource } from "../src/modules/command/widgets/musicSources";
import type { MediaSession, TabMedia } from "../src/types/browser";

const tab = (id: string, url: string, playing: boolean): TabMedia => ({
  tab: id,
  host: "main",
  url,
  title: id,
  artist: "",
  album: "",
  artworkUrl: null,
  playing,
  positionSecs: null,
  durationSecs: null,
  canPrevious: true,
  canNext: true,
  muted: false,
});
const session = (appId: string, playing: boolean): MediaSession => ({
  appId,
  title: appId,
  artist: "",
  album: "",
  status: playing ? "playing" : "paused",
  positionSecs: null,
  durationSecs: null,
  canPlayPause: true,
  canNext: true,
  canPrevious: true,
  thumbnail: null,
  current: false,
});

describe("music source selection", () => {
  it("recognises music sites", () => {
    expect(siteOf("https://soundcloud.com/discover")).toEqual({ label: "SoundCloud", music: true });
    expect(siteOf("https://music.youtube.com/watch?v=1").music).toBe(true);
    expect(siteOf("https://www.youtube.com/watch?v=1")).toEqual({ label: "YouTube", music: false });
  });

  it("prefers SoundCloud in NETRUNNER over YouTube in NETRUNNER and Chrome", () => {
    const list = mergeSources(
      [tab("yt", "https://www.youtube.com/watch?v=1", true), tab("sc", "https://soundcloud.com/x", false)],
      [session("Chrome", true)],
      "netrunner-first",
    );
    expect(chooseSource(list, null, false, "netrunner-first")).toBe("tab:sc");
  });

  it("stays on a paused source instead of jumping to Chrome", () => {
    const list = mergeSources([tab("sc", "https://soundcloud.com/x", false)], [session("Chrome", true)], "netrunner-first");
    expect(chooseSource(list, "tab:sc", false, "netrunner-first")).toBe("tab:sc");
  });

  it("switches up when a higher-class source starts playing", () => {
    const list = mergeSources(
      [tab("yt", "https://www.youtube.com/watch?v=1", false), tab("sc", "https://soundcloud.com/x", true)],
      [],
      "netrunner-first",
    );
    expect(chooseSource(list, "tab:yt", false, "netrunner-first")).toBe("tab:sc");
    // …but not when the user picked YouTube by hand.
    expect(chooseSource(list, "tab:yt", true, "netrunner-first")).toBe("tab:yt");
  });

  it("drops NETRUNNER's own WebView2 session when tabs are known", () => {
    const list: MusicSource[] = mergeSources([tab("sc", "https://soundcloud.com/x", true)], [session("msedgewebview2.exe", true)], "netrunner-first");
    expect(list.map((s) => s.key)).toEqual(["tab:sc"]);
  });

  it("netrunner-only ignores other apps", () => {
    const list = mergeSources([], [session("Spotify.exe", true)], "netrunner-only");
    expect(chooseSource(list, null, false, "netrunner-only")).toBeNull();
  });
});
