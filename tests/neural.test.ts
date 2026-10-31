import { describe, expect, it, vi } from "vitest";

// The store imports Tauri APIs; only the pure helper is under test here.
vi.mock("@tauri-apps/api/core", () => ({ Channel: class {}, invoke: vi.fn() }));
vi.mock("@/services/api", () => ({ api: {} }));
vi.mock("@/stores/activity", () => ({ refreshActivity: () => undefined }));

import { codeBlocks } from "../src/modules/neural/store";

describe("codeBlocks", () => {
  it("extracts fenced blocks with language", () => {
    const text = "Here:\n```python\nprint('a')\nprint('b')\n```\nand\n```\nraw\n```";
    expect(codeBlocks(text)).toEqual([
      { lang: "python", code: "print('a')\nprint('b')" },
      { lang: "", code: "raw" },
    ]);
  });

  it("ignores unterminated blocks (still streaming)", () => {
    expect(codeBlocks("```ts\nconst a = 1;")).toEqual([]);
  });
});
