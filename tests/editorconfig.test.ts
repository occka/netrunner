import { describe, expect, it } from "vitest";
import { globToRegExp, parseEditorConfig, resolveEditorConfig } from "@/modules/developer/editorconfig";

describe("editorconfig", () => {
  it("matches globs like the spec", () => {
    expect(globToRegExp("*").test("src/a.ts")).toBe(true);
    expect(globToRegExp("*.{ts,tsx}").test("src/App.tsx")).toBe(true);
    expect(globToRegExp("*.{ts,tsx}").test("src/a.rs")).toBe(false);
    expect(globToRegExp("src/*.rs").test("src/main.rs")).toBe(true);
    expect(globToRegExp("src/*.rs").test("src/dev/main.rs")).toBe(false);
    expect(globToRegExp("src/**.rs").test("src/dev/main.rs")).toBe(true);
    expect(globToRegExp("Makefile").test("sub/Makefile")).toBe(true);
    expect(globToRegExp("[Mm]akefile").test("makefile")).toBe(true);
    expect(globToRegExp("*.md").test("a.mdx")).toBe(false);
  });

  it("merges files from the root down, later sections winning", () => {
    const root = parseEditorConfig(`
root = true
# defaults
[*]
indent_style = space
indent_size = 2
trim_trailing_whitespace = true
insert_final_newline = true

[*.rs]
indent_size = 4

[Makefile]
indent_style = tab
`);
    expect(root.root).toBe(true);
    const sub = parseEditorConfig("[*.md]\ntrim_trailing_whitespace = false\n");
    expect(resolveEditorConfig([{ parsed: root, relative: "src/main.rs" }])).toEqual({
      indentStyle: "space",
      indentSize: 4,
      tabWidth: 4,
      trimTrailingWhitespace: true,
      insertFinalNewline: true,
    });
    expect(resolveEditorConfig([{ parsed: root, relative: "docs/a.md" }, { parsed: sub, relative: "a.md" }]).trimTrailingWhitespace).toBe(false);
    expect(resolveEditorConfig([{ parsed: root, relative: "Makefile" }]).indentStyle).toBe("tab");
    // A nested root=true file hides the ones above it.
    const inner = parseEditorConfig("root=true\n[*]\nindent_size=8\n");
    expect(resolveEditorConfig([{ parsed: root, relative: "x/a.ts" }, { parsed: inner, relative: "a.ts" }])).toEqual({ indentSize: 8, tabWidth: 8 });
  });
});
