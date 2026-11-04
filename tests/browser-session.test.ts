import { describe, expect, it } from "vitest";
import { sessionOf, stripItems, stripTabs, type StripTab } from "../src/modules/browser/store";
import type { BrowserTab } from "../src/types/browser";

const live = (id: string, url: string, extra: Partial<BrowserTab> = {}): BrowserTab => ({
  id,
  host: "main",
  zoom: 1,
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

describe("tab groups", () => {
  const tab = (id: string) => live(id, `https://${id}.example/`) as StripTab;
  const group = (id: string, collapsed = false) => ({ id, name: id, color: "#fff", collapsed });
  const tabs = [tab("a"), tab("b"), tab("c"), tab("d")];

  it("keeps a group's tabs together after its label", () => {
    const items = stripItems(tabs, [group("g")], { b: "g", d: "g" }, "a");
    expect(items.map((i) => (i.kind === "group" ? `[${i.group.id}:${i.count}]` : i.tab.id))).toEqual(["a", "[g:2]", "b", "d", "c"]);
  });

  it("a collapsed group shows only its active tab", () => {
    const shown = (active: string) => stripItems(tabs, [group("g", true)], { b: "g", d: "g" }, active).map((i) => (i.kind === "group" ? "[g]" : i.tab.id));
    expect(shown("a")).toEqual(["a", "[g]", "c"]);
    expect(shown("d")).toEqual(["a", "[g]", "d", "c"]);
  });

  it("ignores a membership whose group is gone", () => {
    expect(stripItems([tab("a")], [], { a: "gone" }, null)).toEqual([{ kind: "tab", tab: tab("a"), group: null }]);
  });

  it("saves groups only while they have a saved tab", () => {
    const s = { tabs: [tab("a"), { ...tab("p"), private: true }], sleeping: [], order: ["a", "p"], activeId: "a", groups: [group("g"), group("h")], members: { a: "g", p: "h" } };
    expect(sessionOf(s)).toEqual({ tabs: [{ url: "https://a.example/", title: "a", group: "g" }], active: 0, groups: [group("g")] });
  });
});
