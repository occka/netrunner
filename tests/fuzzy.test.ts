import { describe, expect, it } from "vitest";
import { fuzzyFilter, fuzzyScore } from "@/modules/developer/fuzzy";

const FILES = [
  "src/modules/developer/EditorArea.tsx",
  "src/modules/developer/store.ts",
  "src/stores/settings.ts",
  "src-tauri/src/dev/lsp/bridge.rs",
  "docs/ARCHITECTURE.md",
  "src/modules/developer/lsp/client.ts",
];

describe("fuzzy file matching", () => {
  it("requires the characters in order", () => {
    expect(fuzzyScore("brg", "src-tauri/src/dev/lsp/bridge.rs")).not.toBeNull();
    expect(fuzzyScore("gbr", "bridge.rs")).toBeNull();
    expect(fuzzyScore("", "x")?.score).toBe(0);
  });

  it("ranks file-name and word-start matches first", () => {
    expect(fuzzyFilter("store", FILES)[0].path).toBe("src/modules/developer/store.ts");
    expect(fuzzyFilter("ea", FILES)[0].path).toBe("src/modules/developer/EditorArea.tsx");
    expect(fuzzyFilter("lspcl", FILES)[0].path).toBe("src/modules/developer/lsp/client.ts");
    expect(fuzzyFilter("zzz", FILES)).toEqual([]);
  });

  it("reports matched positions for highlighting", () => {
    const hit = fuzzyScore("brs", "bridge.rs")!;
    expect(hit.positions.map((i) => "bridge.rs"[i]).join("")).toBe("brs");
  });
});
