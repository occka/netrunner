/**
 * Editor behaviour around models: indentation from .editorconfig or the
 * user's preferences, whitespace fixes on save, auto save, and the per-project
 * session (open tabs, groups and cursor lines) restored after a restart.
 */
import { api } from "@/services/api";
import { useSettings, type DevSession } from "@/stores/settings";
import { monaco } from "./monaco";
import { parseEditorConfig, resolveEditorConfig, type EditorConfig, type ParsedFile } from "./editorconfig";
import { isDirty, useDev, type EditorTab } from "./store";
import { pathKey } from "./lsp/convert";

// ---------- .editorconfig ----------

const configCache = new Map<string, Promise<ParsedFile | null>>();

function readConfig(dir: string): Promise<ParsedFile | null> {
  const key = pathKey(dir);
  let p = configCache.get(key);
  if (!p) {
    p = api.dev
      .readFile(`${dir}\\.editorconfig`)
      .then((f) => parseEditorConfig(f.content))
      .catch(() => null);
    configCache.set(key, p);
  }
  return p;
}

/** EditorConfig settings for a file inside the open project. */
export async function editorConfigFor(path: string): Promise<EditorConfig> {
  const root = useDev.getState().root;
  if (!root || !pathKey(path).startsWith(pathKey(root))) return {};
  const parts = path.slice(root.replace(/[\\/]+$/, "").length + 1).split(/[\\/]/);
  const files: { parsed: ParsedFile; relative: string }[] = [];
  let dir = root.replace(/[\\/]+$/, "");
  for (let i = 0; i < parts.length; i++) {
    const parsed = await readConfig(dir);
    if (parsed) files.push({ parsed, relative: parts.slice(i).join("/") });
    dir = `${dir}\\${parts[i]}`;
  }
  return resolveEditorConfig(files);
}

const effective = new Map<string, EditorConfig>();

/** Applies indentation for a model's file: .editorconfig first, else Monaco's detection. */
export async function applyFileConfig(model: monaco.editor.ITextModel, path: string) {
  const cfg = await editorConfigFor(path);
  effective.set(pathKey(path), cfg);
  if (model.isDisposed()) return;
  const options: monaco.editor.ITextModelUpdateOptions = {};
  if (cfg.indentStyle) options.insertSpaces = cfg.indentStyle === "space";
  if (cfg.indentSize) options.indentSize = cfg.indentSize;
  if (cfg.tabWidth) options.tabSize = cfg.tabWidth;
  if (Object.keys(options).length) model.updateOptions(options);
}

/** Whitespace fixes before saving (editorconfig wins over the user's preferences). */
export function applySaveFixes(tab: EditorTab) {
  const model = monaco.editor.getModels().find((m) => m.uri.scheme === "file" && pathKey(m.uri.fsPath) === pathKey(tab.path));
  if (!model) return;
  const prefs = useSettings.getState().values["developer.editor"];
  const cfg = effective.get(pathKey(tab.path)) ?? {};
  const trim = cfg.trimTrailingWhitespace ?? prefs.trimTrailingWhitespace;
  const finalNewline = cfg.insertFinalNewline ?? prefs.insertFinalNewline;
  const edits: monaco.editor.IIdentifiedSingleEditOperation[] = [];
  if (trim) {
    for (let line = 1; line <= model.getLineCount(); line++) {
      const text = model.getLineContent(line);
      const trimmed = text.replace(/[ \t]+$/, "");
      if (trimmed.length !== text.length) edits.push({ range: new monaco.Range(line, trimmed.length + 1, line, text.length + 1), text: "" });
    }
  }
  const last = model.getLineCount();
  if (finalNewline && model.getLineContent(last) !== "" && model.getValueLength() > 0) {
    const col = model.getLineMaxColumn(last);
    edits.push({ range: new monaco.Range(last, col, last, col), text: model.getEOL() });
  }
  if (!edits.length) return;
  model.pushEditOperations([], edits, () => null);
  useDev.getState().setContent(tab.key, model.getValue());
}

// ---------- Auto save ----------

const autoSaveTimers = new Map<string, number>();

function scheduleAutoSave(tabs: EditorTab[]) {
  if (useSettings.getState().values["developer.editor"].autoSave !== "afterDelay") return;
  for (const t of tabs) {
    if (!isDirty(t) || t.readOnly) continue;
    window.clearTimeout(autoSaveTimers.get(t.key));
    autoSaveTimers.set(
      t.key,
      window.setTimeout(() => {
        autoSaveTimers.delete(t.key);
        void useDev.getState().save(t.key);
      }, 1000),
    );
  }
}

/** Auto save "on focus change": the editor lost focus or the window went to the background. */
export function saveOnFocusChange() {
  if (useSettings.getState().values["developer.editor"].autoSave !== "onFocusChange") return;
  for (const t of useDev.getState().tabs) if (isDirty(t) && !t.readOnly) void useDev.getState().save(t.key);
}

// ---------- Session ----------

/** Cursor lines remembered for the session (and waiting to be restored). */
export const cursorMemory = new Map<string, { line: number; column: number }>();
const restoredCursors = new Map<string, { line: number; column: number }>();

export function takeRestoredCursor(path: string) {
  const c = restoredCursors.get(pathKey(path));
  restoredCursors.delete(pathKey(path));
  return c ?? null;
}

let sessionTimer = 0;
export function saveSessionSoon() {
  window.clearTimeout(sessionTimer);
  sessionTimer = window.setTimeout(saveSession, 1000);
}

function saveSession() {
  const s = useDev.getState();
  if (!s.root || restoring) return;
  const files = s.tabs
    .filter((t) => t.kind === "file")
    .map((t) => {
      const c = cursorMemory.get(pathKey(t.path));
      return { path: t.path, right: s.right.includes(t.key) || undefined, line: c?.line, column: c?.column };
    });
  const pathOf = (key: string | null) => s.tabs.find((t) => t.key === key && t.kind === "file")?.path;
  const session: DevSession = { files, active: pathOf(s.active), activeRight: pathOf(s.activeRight), split: s.split || undefined };
  const all = { ...useSettings.getState().values["developer.session"], [s.root]: session };
  // Keep the 20 most recent projects.
  const keys = Object.keys(all);
  for (const k of keys.slice(0, Math.max(0, keys.length - 20))) if (k !== s.root) delete all[k];
  void useSettings.getState().set("developer.session", all);
}

let restoring = false;
const restoredRoots = new Set<string>();

/** Reopens the project's tabs from the last run (once per project per app start). */
export async function restoreSession(root: string) {
  if (restoredRoots.has(root)) return;
  restoredRoots.add(root);
  const session = useSettings.getState().values["developer.session"][root];
  if (!session?.files.length || useDev.getState().tabs.length) return;
  restoring = true;
  try {
    const dev = useDev.getState();
    for (const f of session.files.slice(0, 30)) {
      if (useDev.getState().root !== root) return;
      if (f.right && !useDev.getState().split) dev.toggleSplit();
      dev.setFocus(f.right ? 1 : 0);
      if (f.line) restoredCursors.set(pathKey(f.path), { line: f.line, column: f.column ?? 1 });
      // Missing files are skipped quietly.
      const exists = await api.dev.readFile(f.path).then(
        () => true,
        () => false,
      );
      if (exists) await dev.openFile(f.path);
    }
    const s = useDev.getState();
    const keyOf = (path?: string) => s.tabs.find((t) => t.kind === "file" && path && pathKey(t.path) === pathKey(path))?.key;
    const active = keyOf(session.active);
    const activeRight = keyOf(session.activeRight);
    if (activeRight) dev.setActive(activeRight);
    if (active) dev.setActive(active);
    if (s.split && !s.right.length) dev.toggleSplit();
  } finally {
    restoring = false;
  }
}

let started = false;

export function startEditorPrefs() {
  if (started) return;
  started = true;
  useDev.subscribe((s, prev) => {
    if (s.tabs !== prev.tabs) scheduleAutoSave(s.tabs.filter((t) => prev.tabs.find((p) => p.key === t.key)?.content !== t.content));
    // Typing changes tab contents; only the set of tabs and groups belongs to the session.
    const keys = (tabs: EditorTab[]) => tabs.map((t) => t.key).join("|");
    if (keys(s.tabs) !== keys(prev.tabs) || s.right !== prev.right || s.active !== prev.active || s.activeRight !== prev.activeRight || s.split !== prev.split)
      saveSessionSoon();
    if (s.revision !== prev.revision) configCache.clear();
  });
  window.addEventListener("blur", saveOnFocusChange);
}
