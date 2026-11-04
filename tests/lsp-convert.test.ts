import { describe, expect, it } from "vitest";
import {
  applyTextEdits,
  remapSemanticTokens,
  SEMANTIC_MODIFIERS,
  SEMANTIC_TYPES,
  completionKind,
  locations,
  markerSeverity,
  markupToMarkdown,
  offsetAt,
  pathKey,
  toLspPosition,
  toMonacoRange,
  uriToPath,
  workspaceEditFiles,
} from "@/modules/developer/lsp/convert";

describe("LSP conversions", () => {
  it("turns file URIs into Windows paths", () => {
    expect(uriToPath("file:///D:/Netrunner/src/main.rs")).toBe("D:\\Netrunner\\src\\main.rs");
    expect(uriToPath("file:///d%3A/x/%D0%BF%D1%80%D0%BE%D0%B5%D0%BA%D1%82/a%20b.ts")).toBe("D:\\x\\проект\\a b.ts");
    expect(uriToPath("file://server/share/a.txt")).toBe("\\\\server\\share\\a.txt");
    expect(uriToPath("untitled:Untitled-1")).toBeNull();
    expect(pathKey("D:/X/Y/")).toBe(pathKey("d:\\x\\y"));
  });

  it("shifts positions between 0-based and 1-based (both UTF-16)", () => {
    // "😀x": the emoji is two UTF-16 units in both Monaco and LSP.
    expect(toLspPosition(1, 3)).toEqual({ line: 0, character: 2 });
    expect(toMonacoRange({ start: { line: 0, character: 2 }, end: { line: 1, character: 0 } })).toEqual({
      startLineNumber: 1,
      startColumn: 3,
      endLineNumber: 2,
      endColumn: 1,
    });
  });

  it("maps severities and completion kinds", () => {
    expect([1, 2, 3, 4, undefined].map(markerSeverity)).toEqual([8, 4, 2, 1, 8]);
    expect(completionKind(3)).toBe(1); // Function
    expect(completionKind(15)).toBe(27); // Snippet
    expect(completionKind(99)).toBe(18);
  });

  it("renders hover contents as markdown", () => {
    expect(markupToMarkdown({ kind: "markdown", value: "**x**" })).toEqual(["**x**"]);
    expect(markupToMarkdown([{ language: "rust", value: "fn a()" }, "doc"])).toEqual(["```rust\nfn a()\n```", "doc"]);
    expect(markupToMarkdown({ kind: "plaintext", value: "a*b" })).toEqual(["a\\*b"]);
    expect(markupToMarkdown(null)).toEqual([]);
  });

  it("applies text edits back to front", () => {
    const text = "let a = 1;\r\nlet b = a + a;\n";
    expect(offsetAt(text, { line: 1, character: 4 })).toBe(16);
    // Past the end of a CRLF line clamps before the \r.
    expect(offsetAt(text, { line: 0, character: 99 })).toBe(10);
    const edits = [
      { range: { start: { line: 0, character: 4 }, end: { line: 0, character: 5 } }, newText: "count" },
      { range: { start: { line: 1, character: 8 }, end: { line: 1, character: 9 } }, newText: "count" },
      { range: { start: { line: 1, character: 12 }, end: { line: 1, character: 13 } }, newText: "count" },
    ];
    expect(applyTextEdits(text, edits)).toBe("let count = 1;\r\nlet b = count + count;\n");
    const inserts = [
      { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: "A" },
      { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: "B" },
    ];
    expect(applyTextEdits("x", inserts)).toBe("ABx");
  });

  it("groups workspace edits by file", () => {
    const e = { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, newText: "z" };
    const r = workspaceEditFiles({
      documentChanges: [
        { textDocument: { uri: "file:///d%3A/p/a.ts", version: 1 }, edits: [e] },
        { textDocument: { uri: "file:///D:/p/a.ts" }, edits: [e] },
        { kind: "rename", oldUri: "file:///D:/p/b.ts", newUri: "file:///D:/p/c.ts" },
      ],
    });
    expect(r.files).toHaveLength(1);
    expect(r.files[0].edits).toHaveLength(2);
    expect(r.resourceOps).toBe(1);
    expect(workspaceEditFiles({ changes: { "file:///D:/p/x.rs": [e] } }).files[0].path).toBe("D:\\p\\x.rs");
  });

  it("normalises locations and location links", () => {
    const range = { start: { line: 1, character: 0 }, end: { line: 1, character: 3 } };
    expect(locations({ uri: "file:///a", range })).toEqual([{ uri: "file:///a", range }]);
    expect(locations([{ targetUri: "file:///b", targetRange: range, targetSelectionRange: range }])).toEqual([{ uri: "file:///b", range }]);
    expect(locations(null)).toEqual([]);
  });
});

describe("semantic tokens", () => {
  it("renumbers a server's legend to the one Monaco knows", () => {
    const legend = { tokenTypes: ["function", "class", "somethingOdd"], tokenModifiers: ["readonly", "weird", "async"] };
    const out = [...remapSemanticTokens([0, 2, 4, 0, 0b001, 1, 0, 3, 1, 0b100, 0, 5, 1, 2, 0b010], legend)];
    expect(out.slice(0, 3)).toEqual([0, 2, 4]);
    expect(SEMANTIC_TYPES[out[3]]).toBe("function");
    expect(out[4]).toBe(1 << SEMANTIC_MODIFIERS.indexOf("readonly"));
    expect(SEMANTIC_TYPES[out[8]]).toBe("class");
    expect(out[9]).toBe(1 << SEMANTIC_MODIFIERS.indexOf("async"));
    expect(SEMANTIC_TYPES[out[13]]).toBe("unknown");
    expect(out[14]).toBe(0);
  });
});
