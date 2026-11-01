import { describe, expect, it } from "vitest";
import { sessionOf, stripTabs } from "../src/modules/browser/store";
import type { BrowserTab } from "../src/types/browser";

const live = (id: string, url: string, extra: Partial<BrowserTab> = {}): BrowserTab => ({
  id,
  host: "main",
  url,
  title: id,
  loading: false,
  canBack: false,
  canForward: false,
  blocked: 0,
  private: false,
  muted: false,
  audible: false,
  fullscreen: false,
  favicon: null,
  ...extra,
});

describe("browser session", () => {
  const state = {
    tabs: [
      live("web-1", "https://www.youtube.com/watch?v=x"),
      live("web-2", "https://secret.example/", { private: true }),
      live("web-3", "https://soundcloud.com/", { host: "overlay-4" }),
      live("web-5", "about:blank"),
    ],
    sleeping: [{ id: "sleeping-0", url: "https://wikipedia.org/", title: "Wikipedia" }],
    order: ["sleeping-0", "web-1", "web-2", "web-5"],
    activeId: "web-1",
  };

  it("shows live and sleeping tabs in strip order, without overlay tabs", () => {
    expect(stripTabs(state).map((t) => [t.id, !!t.sleeping])).toEqual([
      ["sleeping-0", true],
      ["web-1", false],
      ["web-2", false],
      ["web-5", false],
    ]);
  });

  it("saves only non-private web pages and remembers the active one", () => {
    expect(sessionOf(state)).toEqual({
      tabs: [
        { url: "https://wikipedia.org/", title: "Wikipedia" },
        { url: "https://www.youtube.com/watch?v=x", title: "web-1" },
      ],
      active: 1,
    });
  });
});
