import { describe, expect, it } from "vitest";
import { joinWrapped, ProblemMatcher, resolveTaskPath, type TaskProblem } from "@/modules/developer/matchers";

const run = (text: string) => {
  const m = new ProblemMatcher();
  return text.split("\n").flatMap((l) => m.push(l)) as TaskProblem[];
};

describe("problem matchers", () => {
  it("rustc / cargo", () => {
    const p = run(`   Compiling demo v0.1.0
error[E0308]: mismatched types
 --> src\\main.rs:2:18
  |
warning: unused variable: \`x\`
  --> src/lib.rs:10:9
error: could not compile \`demo\` due to 1 previous error`);
    expect(p).toEqual([
      { file: "src\\main.rs", line: 2, column: 18, severity: 1, message: "mismatched types [E0308]", source: "rustc" },
      { file: "src/lib.rs", line: 10, column: 9, severity: 2, message: "unused variable: `x`", source: "rustc" },
    ]);
  });

  it("tsc in both formats and msbuild", () => {
    const p = run(`src/a.ts(2,7): error TS2322: Type 'string' is not assignable to type 'number'.
src/b.ts:3:1 - warning TS6133: 'x' is declared but never used.
C:\\p\\Program.cs(5,13): error CS0103: The name 'y' does not exist [C:\\p\\p.csproj]`);
    expect(p.map((x) => [x.file, x.line, x.column, x.severity, x.source])).toEqual([
      ["src/a.ts", 2, 7, 1, "tsc"],
      ["src/b.ts", 3, 1, 2, "tsc"],
      ["C:\\p\\Program.cs", 5, 13, 1, "build"],
    ]);
    expect(p[2].message).toBe("The name 'y' does not exist [CS0103]");
  });

  it("gcc, go and eslint", () => {
    const p = run(`main.c:3:5: error: expected ';' before 'return'
main.c:1:1: note: in a note
./cmd/main.go:5:2: undefined: x

D:\\proj\\src\\app.ts
  4:10  error    'a' is not defined  no-undef
  7:1   warning  Unexpected console statement  no-console

✖ 2 problems`);
    expect(p.map((x) => `${x.source}:${x.file}:${x.line}:${x.severity}`)).toEqual([
      "gcc:main.c:3:1",
      "go:./cmd/main.go:5:1",
      "eslint:D:\\proj\\src\\app.ts:4:1",
      "eslint:D:\\proj\\src\\app.ts:7:2",
    ]);
    expect(p[2].message).toBe("'a' is not defined [no-undef]");
  });

  it("python tracebacks point at the innermost frame", () => {
    const p = run(`Traceback (most recent call last):
  File "C:\\p\\main.py", line 8, in <module>
    run()
  File "C:\\p\\lib.py", line 3, in run
    raise ValueError("bad")
ValueError: bad`);
    expect(p).toEqual([{ file: "C:\\p\\lib.py", line: 3, column: 1, severity: 1, message: "ValueError: bad", source: "python" }]);
  });

  it("joins wrapped rows and resolves paths", () => {
    expect(joinWrapped([{ text: "src/a.ts(2,7): err", wrapped: false }, { text: "or TS1: x", wrapped: true }, { text: "next", wrapped: false }])).toEqual([
      "src/a.ts(2,7): error TS1: x",
      "next",
    ]);
    expect(resolveTaskPath("D:\\p", "./src/../lib/a.rs")).toBe("D:\\p\\lib\\a.rs");
    expect(resolveTaskPath("D:\\p", "C:/x/y.ts")).toBe("C:\\x\\y.ts");
  });
});
