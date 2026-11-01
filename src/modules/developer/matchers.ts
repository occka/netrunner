/**
 * Problem matchers: turn compiler and tool output into Problems entries.
 * Fed complete terminal lines (wrapped lines already joined, no escapes).
 */

export interface TaskProblem {
  /** As printed (relative paths are resolved by the caller). */
  file: string;
  line: number;
  column: number;
  severity: 1 | 2 | 3;
  message: string;
  source: string;
}

const sev = (word: string): 1 | 2 | 3 => (/^err|^fatal/i.test(word) ? 1 : /^warn/i.test(word) ? 2 : 3);

export class ProblemMatcher {
  private pending: { severity: 1 | 2 | 3; message: string; source: string } | null = null;
  private eslintFile: string | null = null;
  private traceback: { file: string; line: number } | null = null;
  private inTraceback = false;

  /** Returns the problems completed by this line. */
  push(raw: string): TaskProblem[] {
    const line = raw.replace(/\s+$/, "");
    const out: TaskProblem[] = [];

    // rustc / cargo: "error[E0308]: mismatched types" then "  --> src/main.rs:2:18".
    const rustHead = /^(error|warning)(?:\[(\w+)\])?: (.+)$/.exec(line);
    if (rustHead && !/^(error|warning): (aborting|could not compile|build failed)/.test(line) && !/generated \d+ warnings?/.test(line)) {
      this.pending = { severity: sev(rustHead[1]), message: rustHead[2] ? `${rustHead[3]} [${rustHead[2]}]` : rustHead[3], source: "rustc" };
      return out;
    }
    const arrow = /^\s*--> (.+?):(\d+):(\d+)$/.exec(line);
    if (arrow && this.pending) {
      out.push({ file: arrow[1], line: +arrow[2], column: +arrow[3], ...this.pending });
      this.pending = null;
      return out;
    }

    // Python traceback: File "x.py", line 3, in f ... then "ValueError: msg".
    const pyFile = /^\s*File "(.+)", line (\d+)/.exec(line);
    if (pyFile) {
      this.inTraceback = true;
      this.traceback = { file: pyFile[1], line: +pyFile[2] };
      return out;
    }
    if (this.inTraceback) {
      const exc = /^([A-Za-z_][\w.]*(?:Error|Exception|Exit|Interrupt|Warning)?): ?(.*)$/.exec(line);
      if (exc && !line.startsWith(" ") && this.traceback) {
        out.push({ file: this.traceback.file, line: this.traceback.line, column: 1, severity: 1, message: line, source: "python" });
        this.inTraceback = false;
        this.traceback = null;
        return out;
      }
      if (line.startsWith(" ") || line.startsWith("Traceback") || !line) return out;
      this.inTraceback = false;
    }

    // tsc / msbuild / dotnet: "src/a.ts(2,7): error TS2322: msg".
    const paren = /^(.+?)\((\d+),(\d+)\): (error|warning|info) (\w+): (.+?)(?: \[.+\])?$/.exec(line);
    if (paren) {
      out.push({ file: paren[1].trim(), line: +paren[2], column: +paren[3], severity: sev(paren[4]), message: `${paren[6]} [${paren[5]}]`, source: /^TS\d/.test(paren[5]) ? "tsc" : "build" });
      return out;
    }
    // tsc --pretty: "src/a.ts:2:7 - error TS2322: msg".
    const tscPretty = /^(.+?):(\d+):(\d+) - (error|warning) (TS\d+): (.+)$/.exec(line);
    if (tscPretty) {
      out.push({ file: tscPretty[1], line: +tscPretty[2], column: +tscPretty[3], severity: sev(tscPretty[4]), message: `${tscPretty[6]} [${tscPretty[5]}]`, source: "tsc" });
      return out;
    }
    // gcc / clang: "main.c:3:5: error: msg" (notes skipped).
    const gcc = /^(.+?):(\d+):(\d+): (fatal error|error|warning): (.+)$/.exec(line);
    if (gcc) {
      out.push({ file: gcc[1], line: +gcc[2], column: +gcc[3], severity: sev(gcc[4]), message: gcc[5], source: "gcc" });
      return out;
    }
    // go build / vet: "./main.go:5:2: undefined: x".
    const go = /^(\.?[^\s:][^:]*\.go):(\d+):(\d+): (.+)$/.exec(line);
    if (go) {
      out.push({ file: go[1], line: +go[2], column: +go[3], severity: 1, message: go[4], source: "go" });
      return out;
    }

    // eslint stylish: a path line, then "  2:7  error  message  rule".
    const eslintRow = /^\s+(\d+):(\d+)\s+(error|warning)\s+(.+?)(?:\s{2,}(\S+))?$/.exec(line);
    if (eslintRow && this.eslintFile) {
      out.push({
        file: this.eslintFile,
        line: +eslintRow[1],
        column: +eslintRow[2],
        severity: sev(eslintRow[3]),
        message: eslintRow[5] ? `${eslintRow[4]} [${eslintRow[5]}]` : eslintRow[4],
        source: "eslint",
      });
      return out;
    }
    if (/^([A-Za-z]:[\\/]|\/|\.{0,2}[\\/]?[\w.-]+[\\/])\S*\.(m?[jt]sx?|vue|svelte)$/.test(line)) this.eslintFile = line;
    else if (!line) this.eslintFile = null;
    return out;
  }
}

/** Joins wrapped terminal rows into logical lines. */
export function joinWrapped(rows: { text: string; wrapped: boolean }[]): string[] {
  const out: string[] = [];
  for (const r of rows) {
    if (r.wrapped && out.length) out[out.length - 1] += r.text;
    else out.push(r.text);
  }
  return out;
}

/** Absolute Windows path for a path printed relative to `cwd`. */
export function resolveTaskPath(cwd: string, file: string): string {
  const f = file.replace(/\//g, "\\");
  if (/^[a-zA-Z]:\\/.test(f) || f.startsWith("\\\\")) return f;
  const parts = cwd.replace(/[\\/]+$/, "").split("\\");
  for (const p of f.split("\\")) {
    if (p === "..") parts.pop();
    else if (p && p !== ".") parts.push(p);
  }
  return parts.join("\\");
}
