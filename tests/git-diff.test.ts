import { describe, expect, it } from "vitest";
import { applyHunkToBase, diffLines, findConflicts, resolveConflict, splitLines } from "@/modules/developer/gitDiff";

describe("gutter diff", () => {
  it("finds added, deleted and modified lines", () => {
    const base = splitLines("a\nb\nc\nd\ne\n");
    expect(diffLines(base, base)).toEqual([]);
    expect(diffLines(base, splitLines("a\nb\nX\nc\nd\ne\n"))).toEqual([{ kind: "add", baseStart: 2, baseCount: 0, start: 2, count: 1 }]);
    expect(diffLines(base, splitLines("a\nc\nd\ne\n"))).toEqual([{ kind: "delete", baseStart: 1, baseCount: 1, start: 1, count: 0 }]);
    expect(diffLines(base, splitLines("a\nB\nc\nD\ne\n"))).toEqual([
      { kind: "modify", baseStart: 1, baseCount: 1, start: 1, count: 1 },
      { kind: "modify", baseStart: 3, baseCount: 1, start: 3, count: 1 },
    ]);
    // CRLF and LF compare equal line by line.
    expect(diffLines(splitLines("a\r\nb\r\n"), splitLines("a\nb\n"))).toEqual([]);
  });

  it("stages one hunk into the baseline", () => {
    const base = splitLines("one\ntwo\nthree\n");
    const cur = splitLines("ONE\ntwo\nTHREE\n");
    const hunks = diffLines(base, cur);
    expect(hunks).toHaveLength(2);
    expect(applyHunkToBase(base, cur, hunks[0]).join("\n")).toBe("ONE\ntwo\nthree\n");
  });
});

describe("merge conflicts", () => {
  const text = splitLines(`keep
<<<<<<< HEAD
mine
||||||| base
old
=======
theirs
>>>>>>> feature
tail`);

  it("parses diff3 conflicts", () => {
    const [c] = findConflicts(text);
    expect(c).toEqual({ start: 1, base: 3, middle: 5, end: 7, currentLabel: "HEAD", incomingLabel: "feature" });
  });

  it("resolves to current, incoming or both", () => {
    const [c] = findConflicts(text);
    expect(resolveConflict(text, c, "current")).toEqual(["mine"]);
    expect(resolveConflict(text, c, "incoming")).toEqual(["theirs"]);
    expect(resolveConflict(text, c, "both")).toEqual(["mine", "theirs"]);
    expect(findConflicts(["<<<<<<< a", "x"])).toEqual([]);
  });
});
