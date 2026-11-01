/**
 * Git inside the code editor: change bars in the gutter (against the index,
 * like VS Code) with Revert / Stage change, inline blame of the cursor line
 * (or every line), and merge-conflict blocks with Accept current / incoming / both.
 */
import { RotateCcw, Plus } from "lucide-react";
import { api } from "@/services/api";
import { useContextMenu } from "@/components/ContextMenu";
import { notify, reportError } from "@/stores/notifications";
import type { BlameLine } from "@/types/dev";
import { monaco } from "./monaco";
import { isDirty, relativeToRoot, useDev } from "./store";
import { pathKey } from "./lsp/convert";
import { applyHunkToBase, diffLines, findConflicts, resolveConflict, splitLines, type ConflictChoice, type Hunk } from "./gitDiff";

interface Base {
  lines: string[];
  eol: string;
}

const baselines = new Map<string, Promise<Base | null>>();
const blames = new Map<string, Promise<BlameLine[]>>();

function rel(path: string): { root: string; rel: string } | null {
  const root = useDev.getState().root;
  if (!root || !pathKey(path).startsWith(pathKey(root) + "\\")) return null;
  return { root, rel: relativeToRoot(root, path) };
}

function baselineFor(path: string): Promise<Base | null> {
  const key = pathKey(path);
  let p = baselines.get(key);
  if (!p) {
    const r = rel(path);
    p = r
      ? api.git.baseline(r.root, r.rel).then(
          (b) => (b.tracked && b.text != null ? { lines: splitLines(b.text), eol: b.text.includes("\r\n") ? "\r\n" : "\n" } : null),
          () => null, // not a repository
        )
      : Promise.resolve(null);
    baselines.set(key, p);
  }
  return p;
}

function blameFor(path: string): Promise<BlameLine[]> {
  const key = pathKey(path);
  let p = blames.get(key);
  if (!p) {
    const r = rel(path);
    p = r ? api.git.blame(r.root, r.rel).catch(() => []) : Promise.resolve([]);
    blames.set(key, p);
  }
  return p;
}

function ago(unix: number): string {
  const s = Date.now() / 1000 - unix;
  const units: [number, string][] = [
    [31536000, "year"],
    [2592000, "month"],
    [604800, "week"],
    [86400, "day"],
    [3600, "hour"],
    [60, "minute"],
  ];
  for (const [secs, name] of units) {
    const n = Math.floor(s / secs);
    if (n >= 1) return `${n} ${name}${n > 1 ? "s" : ""} ago`;
  }
  return "just now";
}

const blameText = (b: BlameLine) => (b.committed ? `${b.author}, ${ago(b.time)} · ${b.summary}` : "You · not committed yet");

let blameAll = false;
const controllers = new Set<() => void>();

/** Refresh every editor's git state (after commits, stage, checkout, save). */
export function refreshGit() {
  baselines.clear();
  blames.clear();
  controllers.forEach((reload) => reload());
}

const CLASSES: Record<Hunk["kind"], string> = { add: "git-gutter-add", modify: "git-gutter-mod", delete: "git-gutter-del" };

export function attachGit(editor: monaco.editor.IStandaloneCodeEditor): monaco.IDisposable {
  const gutter = editor.createDecorationsCollection();
  const blameDeco = editor.createDecorationsCollection();
  const conflictDeco = editor.createDecorationsCollection();
  let base: Base | null = null;
  let hunks: Hunk[] = [];
  let path: string | null = null;
  let diffTimer = 0;
  let blameTimer = 0;

  const filePath = () => {
    const m = editor.getModel();
    return m && m.uri.scheme === "file" ? m.uri.fsPath : null;
  };

  const recompute = () => {
    const model = editor.getModel();
    if (!model) return;
    const lines = model.getLinesContent();
    hunks = base ? diffLines(base.lines, lines) : [];
    gutter.set(
      hunks.map((h) => {
        const first = h.kind === "delete" ? Math.min(Math.max(1, h.start + 1), model.getLineCount()) : h.start + 1;
        const last = h.kind === "delete" ? first : h.start + h.count;
        return { range: new monaco.Range(first, 1, last, 1), options: { isWholeLine: true, linesDecorationsClassName: CLASSES[h.kind] } };
      }),
    );
    const conflicts = findConflicts(lines);
    conflictDeco.set(
      conflicts.flatMap((c) => {
        const block = (a: number, b: number, cls: string) => (b >= a ? [{ range: new monaco.Range(a + 1, 1, b + 1, 1), options: { isWholeLine: true, className: cls } }] : []);
        return [
          ...block(c.start, c.start, "git-conflict-marker"),
          ...block(c.start + 1, (c.base ?? c.middle) - 1, "git-conflict-current"),
          ...block(c.base ?? c.middle, c.middle, "git-conflict-marker"),
          ...block(c.middle + 1, c.end - 1, "git-conflict-incoming"),
          ...block(c.end, c.end, "git-conflict-marker"),
        ];
      }),
    );
  };

  const showBlame = async () => {
    const p = filePath();
    const model = editor.getModel();
    const tab = useDev.getState().tabs.find((t) => t.kind === "file" && p && pathKey(t.path) === pathKey(p));
    // Line numbers only match the saved file.
    if (!p || !model || !tab || isDirty(tab) || !(await baselineFor(p))) return blameDeco.clear();
    const all = await blameFor(p);
    if (editor.getModel() !== model) return;
    const cursor = editor.getPosition()?.lineNumber ?? 0;
    const shown = blameAll ? all.slice(0, 5000) : all.filter((b) => b.line === cursor);
    blameDeco.set(
      shown
        .filter((b) => b.line <= model.getLineCount())
        .map((b) => {
          const col = model.getLineMaxColumn(b.line);
          return {
            range: new monaco.Range(b.line, col, b.line, col),
            options: { after: { content: `    ${blameText(b)}`, inlineClassName: "git-blame-inline" }, hoverMessage: { value: `\`${b.hash}\` ${b.author}\n\n${b.summary}` } },
          };
        }),
    );
  };

  const load = async () => {
    const p = filePath();
    if (p !== path) {
      // Another file: drop the old comparison until the new one arrives.
      path = p;
      base = null;
      recompute();
    }
    const b = p ? await baselineFor(p) : null;
    if (filePath() !== p) return; // the editor switched files meanwhile
    base = b;
    recompute();
    void showBlame();
  };

  const hunkAt = (line: number) =>
    hunks.find((h) => (h.kind === "delete" ? Math.max(1, h.start + 1) === line || h.start === line : line >= h.start + 1 && line <= h.start + h.count));

  const revert = (h: Hunk) => {
    const model = editor.getModel();
    if (!model || !base) return;
    const eol = model.getEOL();
    const old = base.lines.slice(h.baseStart, h.baseStart + h.baseCount);
    const n = model.getLineCount();
    let edit: monaco.editor.IIdentifiedSingleEditOperation;
    if (h.count > 0 && old.length > 0) {
      edit = { range: new monaco.Range(h.start + 1, 1, h.start + h.count, model.getLineMaxColumn(h.start + h.count)), text: old.join(eol) };
    } else if (h.count > 0) {
      // Added lines: remove them with their line breaks.
      const endLine = h.start + h.count;
      edit =
        endLine < n
          ? { range: new monaco.Range(h.start + 1, 1, endLine + 1, 1), text: "" }
          : { range: new monaco.Range(Math.max(1, h.start), h.start > 0 ? model.getLineMaxColumn(h.start) : 1, n, model.getLineMaxColumn(n)), text: "" };
    } else {
      // Deleted lines: put them back before the next line.
      edit =
        h.start < n
          ? { range: new monaco.Range(h.start + 1, 1, h.start + 1, 1), text: old.join(eol) + eol }
          : { range: new monaco.Range(n, model.getLineMaxColumn(n), n, model.getLineMaxColumn(n)), text: eol + old.join(eol) };
    }
    model.pushEditOperations([], [edit], () => null);
  };

  const stage = async (h: Hunk) => {
    const p = path;
    const model = editor.getModel();
    const r = p ? rel(p) : null;
    if (!p || !r || !model || !base) return;
    try {
      const text = applyHunkToBase(base.lines, model.getLinesContent(), h).join(base.eol);
      await api.git.stageText(r.root, r.rel, text);
      baselines.delete(pathKey(p));
      useDev.getState().bump();
      notify.success("Change staged", r.rel);
    } catch (err) {
      reportError("Could not stage the change", err);
    }
  };

  const subs: monaco.IDisposable[] = [
    editor.onDidChangeModel(() => void load()),
    editor.onDidChangeModelContent(() => {
      window.clearTimeout(diffTimer);
      diffTimer = window.setTimeout(recompute, 250);
      blameDeco.clear();
    }),
    editor.onDidChangeCursorPosition(() => {
      if (blameAll) return;
      window.clearTimeout(blameTimer);
      blameTimer = window.setTimeout(() => void showBlame(), 350);
    }),
    editor.onMouseDown((e) => {
      if (e.target.type !== monaco.editor.MouseTargetType.GUTTER_LINE_DECORATIONS || !e.target.position) return;
      const h = hunkAt(e.target.position.lineNumber);
      if (!h) return;
      const label = h.kind === "add" ? "added" : h.kind === "delete" ? "deleted" : "changed";
      const { posx, posy } = e.event;
      // After this mousedown: the menu closes on any mousedown that reaches the window.
      window.setTimeout(() =>
        useContextMenu.getState().open(posx, posy, [
          { id: "revert", label: `Revert ${label} lines`, icon: RotateCcw, run: () => revert(h) },
          { id: "stage", label: "Stage this change", icon: Plus, run: () => stage(h) },
        ]),
      );
    }),
    editor.addAction({
      id: "netrunner.git.blameAll",
      label: "Git: Toggle Blame for All Lines",
      contextMenuGroupId: "9_git",
      run: () => {
        blameAll = !blameAll;
        controllers.forEach((reload) => reload());
      },
    }),
  ];
  const reload = () => void load();
  controllers.add(reload);
  // Development builds expose the state for automated UI checks.
  if (import.meta.env.DEV) Object.assign(editor, { __git: { base: () => base, hunks: () => hunks, path: () => path } });
  void load();
  return {
    dispose: () => {
      controllers.delete(reload);
      subs.forEach((s) => s.dispose());
      gutter.clear();
      blameDeco.clear();
      conflictDeco.clear();
    },
  };
}

// ---------- Conflict lenses (registered once) ----------

const RESOLVE = "netrunner.git.resolveConflict";
let lensesRegistered = false;

export function registerConflictLenses() {
  if (lensesRegistered) return;
  lensesRegistered = true;
  monaco.editor.registerCommand(RESOLVE, (_accessor, uri: string, start: number, choice: ConflictChoice) => {
    const model = monaco.editor.getModel(monaco.Uri.parse(uri));
    if (!model) return;
    const lines = model.getLinesContent();
    const c = findConflicts(lines).find((x) => x.start === start);
    if (!c) return;
    const text = resolveConflict(lines, c, choice).join(model.getEOL());
    const endCol = model.getLineMaxColumn(c.end + 1);
    // An empty resolution also removes the block's line break.
    const range =
      text || c.end + 2 > model.getLineCount() ? new monaco.Range(c.start + 1, 1, c.end + 1, endCol) : new monaco.Range(c.start + 1, 1, c.end + 2, 1);
    model.pushEditOperations([], [{ range, text }], () => null);
  });
  monaco.languages.registerCodeLensProvider("*", {
    provideCodeLenses(model) {
      const conflicts = findConflicts(model.getLinesContent());
      const uri = model.uri.toString();
      return {
        lenses: conflicts.flatMap((c) => {
          const range = new monaco.Range(c.start + 1, 1, c.start + 1, 1);
          const cmd = (title: string, choice: ConflictChoice) => ({ range, command: { id: RESOLVE, title, arguments: [uri, c.start, choice] } });
          return [
            cmd(`Accept current${c.currentLabel ? ` (${c.currentLabel})` : ""}`, "current"),
            cmd(`Accept incoming${c.incomingLabel ? ` (${c.incomingLabel})` : ""}`, "incoming"),
            cmd("Accept both", "both"),
          ];
        }),
        dispose() {},
      };
    },
  });
  // Commits, staging, checkout and saves change what the gutter compares with.
  useDev.subscribe((s, prev) => {
    if (s.revision !== prev.revision) refreshGit();
  });
  // Git commands run in a terminal or another program change it too.
  window.addEventListener("focus", refreshGit);
}
