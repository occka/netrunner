import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const SOURCE = readFileSync("src-tauri/src/browser/youtube_guard.js", "utf8");

class FakeResponse {
  constructor(
    public url: string,
    private body: string,
  ) {}
  async json() {
    return JSON.parse(this.body);
  }
  async text() {
    return this.body;
  }
}

/** Runs the guard the way a page would see it, without a browser. */
function page(hostname: string) {
  const window: Record<string | symbol, unknown> = {};
  const sandbox = {
    location: { hostname },
    window,
    Response: FakeResponse,
    document: { querySelector: () => null, querySelectorAll: () => [], adoptedStyleSheets: undefined },
    setInterval: () => 0,
    Symbol,
    Object,
    Proxy,
    Reflect,
    Array,
    Number,
    JSON: { parse: JSON.parse, stringify: JSON.stringify },
  };
  runInNewContext(SOURCE, sandbox);
  return sandbox;
}

const WITH_ADS = JSON.stringify({ videoDetails: { videoId: "x" }, adPlacements: [1], playerAds: [2], adSlots: [3], streamingData: { a: 1 } });

describe("YouTube guard", () => {
  it("removes ad data from parsed responses and keeps the rest", () => {
    const { JSON: json } = page("www.youtube.com");
    const parsed = json.parse(WITH_ADS);
    expect(parsed.adPlacements).toBeUndefined();
    expect(parsed.playerAds).toBeUndefined();
    expect(parsed.adSlots).toBeUndefined();
    expect(parsed.videoDetails.videoId).toBe("x");
    expect(parsed.streamingData).toEqual({ a: 1 });
    const nested = json.parse(JSON.stringify({ playerResponse: { adPlacements: [1], ok: true } }));
    expect(nested.playerResponse).toEqual({ ok: true });
    expect(json.parse("[1,2]")).toEqual([1, 2]);
    expect(json.parse('{"title":"no ads here"}')).toEqual({ title: "no ads here" });
  });

  it("removes ad data from the player API only", async () => {
    const { Response: R } = page("www.youtube.com");
    const api = new R("https://www.youtube.com/youtubei/v1/player?x=1", WITH_ADS);
    expect((await api.json()).adPlacements).toBeUndefined();
    const text = await new R("https://www.youtube.com/youtubei/v1/player", WITH_ADS).text();
    expect(text).not.toContain("adPlacements");
    expect(text).toContain("streamingData");
    expect(await new R("https://www.youtube.com/other", WITH_ADS).text()).toContain("adPlacements");
  });

  it("cleans the response the page writes into its global variable", () => {
    const { window } = page("www.youtube.com");
    window.ytInitialPlayerResponse = JSON.parse(WITH_ADS);
    expect((window.ytInitialPlayerResponse as Record<string, unknown>).adPlacements).toBeUndefined();
  });

  it("does nothing on other sites", () => {
    for (const host of ["example.com", "notyoutube.com", "youtube.com.evil.net"]) {
      const { JSON: json, window } = page(host);
      expect(json.parse(WITH_ADS).adPlacements).toEqual([1]);
      expect(Object.getOwnPropertySymbols(window)).toHaveLength(0);
    }
    expect(page("music.youtube.com").JSON.parse(WITH_ADS).adPlacements).toBeUndefined();
    expect(page("www.youtube-nocookie.com").JSON.parse(WITH_ADS).adPlacements).toBeUndefined();
  });
});
