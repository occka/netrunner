import { describe, expect, it } from "vitest";
import { parseQuery, scoreItem, search, type SearchItem } from "../src/search/query";

const items: SearchItem[] = [
  { id: "1", category: "app", title: "Discord", subtitle: "C:\\Users\\x\\Discord\\Update.exe" },
  { id: "2", category: "app", title: "Python 3.12" },
  { id: "3", category: "file", title: "main.py", subtitle: "D:\\proj\\main.py" },
  { id: "4", category: "file", title: "config.json" },
  { id: "5", category: "widget", title: "Thermal Monitor", keywords: ["temperature", "sensors"] },
  { id: "6", category: "setting", title: "Theme colors", keywords: ["palette", "accent"] },
  { id: "7", category: "game", title: "Cyberpunk 2077" },
  { id: "8", category: "project", title: "website" },
];

describe("parseQuery", () => {
  it("extracts category prefixes", () => {
    expect(parseQuery("app:discord")).toEqual({ filter: "app", text: "discord" });
    expect(parseQuery("file: Config.JSON")).toEqual({ filter: "file", text: "config.json" });
    expect(parseQuery("website:git")).toEqual({ filter: "web", text: "git" });
  });

  it("treats unknown prefixes and drive letters as text", () => {
    expect(parseQuery("C:\\Users")).toEqual({ filter: null, text: "c:\\users" });
    expect(parseQuery("foo:bar")).toEqual({ filter: null, text: "foo:bar" });
  });
});

describe("search", () => {
  it("finds by title prefix", () => {
    expect(search(items, "disc")[0].id).toBe("1");
    expect(search(items, "python")[0].id).toBe("2");
  });

  it("finds by keyword", () => {
    expect(search(items, "temperature").map((i) => i.id)).toEqual(["5"]);
    expect(search(items, "theme")[0].id).toBe("6");
  });

  it("applies category filters", () => {
    expect(search(items, "game:cyber").map((i) => i.id)).toEqual(["7"]);
    expect(search(items, "project:website").map((i) => i.id)).toEqual(["8"]);
    expect(search(items, "file:config.json").map((i) => i.id)).toEqual(["4"]);
    expect(search(items, "app:main")).toEqual([]);
  });

  it("returns everything in a category for an empty query", () => {
    expect(search(items, "file:").length).toBe(2);
  });

  it("ranks exact and prefix matches above substring matches", () => {
    const exact = scoreItem({ id: "a", category: "file", title: "main.py" }, "main.py");
    const sub = scoreItem({ id: "b", category: "file", title: "domain.py" }, "main");
    expect(exact).toBeGreaterThan(sub);
  });
});
