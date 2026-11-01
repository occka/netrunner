import { create } from "zustand";
import { api } from "@/services/api";
import { confirmAction } from "@/stores/confirm";
import { notify, reportError } from "@/stores/notifications";
import { languageFor } from "./languages";

export type IdeMode = "code" | "debug" | "ai";
export type SidePanel = "explorer" | "search" | "git" | "problems" | "tools";

export interface EditorTab {
  key: string;
  /** proposal = an AI-suggested version of a file, shown as a diff until applied. */
  kind: "file" | "diff" | "proposal";
  path: string;
  name: string;
  language: string;
  content: string;
  saved: string;
  readOnly: boolean;
  binary: boolean;
  diff?: { original: string; modified: string; staged: boolean; label?: string };
}

interface DevStore {
  projects: string[];
  root: string | null;
  tabs: EditorTab[];
  /** Active tab of the left (or only) editor group. */
  active: string | null;
  /** Split editor: the right group's tab keys and its active tab. */
  split: boolean;
  right: string[];
  activeRight: string | null;
  /** The group that last had focus; new tabs open there. */
  focus: 0 | 1;
  mode: IdeMode;
  side: SidePanel;
  terminalOpen: boolean;
  /** Bumped after file-system or git changes so panels refresh. */
  revision: number;
  loadProjects: () => Promise<void>;
  openProject: (path: string) => Promise<void>;
  closeProject: (path: string) => Promise<void>;
  openFile: (path: string) => Promise<void>;
  openDiff: (relPath: string, staged: boolean) => Promise<void>;
  openProposal: (path: string, proposed: string) => Promise<void>;
  applyProposal: (key: string) => Promise<void>;
  setContent: (key: string, content: string) => void;
  save: (key: string) => Promise<void>;
  closeTab: (key: string) => Promise<void>;
  setActive: (key: string) => void;
  toggleSplit: () => void;
  moveToGroup: (key: string, group: 0 | 1) => void;
  setFocus: (group: 0 | 1) => void;
  /** Read-only diff of two files (Compare with…). */
  openCompare: (a: string, b: string) => Promise<void>;
  setMode: (mode: IdeMode) => void;
  setSide: (side: SidePanel) => void;
  toggleTerminal: (open?: boolean) => void;
  bump: () => void;
  /** Re-reads open tabs from disk after something else wrote the files. */
  reloadFromDisk: (paths: string[]) => Promise<void>;
}

/** Language-server work around saving (format on save, didSave). */
export const saveHooks: { before?: (tab: EditorTab) => Promise<unknown>; after?: (tab: EditorTab) => Promise<unknown> } = {};

/** Editors replace their model text when a tab is reloaded from disk. */
export const reloadHooks = new Set<(path: string, content: string) => void>();

const baseName = (p: string) => p.split(/[\\/]/).pop() ?? p;

type Groups = Pick<DevStore, "split" | "right" | "active" | "activeRight" | "focus">;

/** A new tab opens in the focused group. */
function placeNew(s: Groups, key: string): Partial<Groups> {
  const right = s.right.filter((k) => k !== key);
  return s.split && s.focus === 1 ? { right: [...right, key], activeRight: key } : { right, active: key, focus: 0 };
}

function activate(s: Groups, key: string): Partial<Groups> {
  return s.right.includes(key) ? { activeRight: key, focus: 1 } : { active: key, focus: 0 };
}

/** Key of the tab the user is working in (the focused group's active tab). */
export const currentKey = (s: Groups) => (s.split && s.focus === 1 ? s.activeRight : s.active);

const NO_TABS = { tabs: [], active: null, right: [], activeRight: null, focus: 0 as const };
export const isDirty = (t: EditorTab) => t.kind === "file" && t.content !== t.saved;

export const useDev = create<DevStore>((set, get) => ({
  projects: [],
  root: null,
  tabs: [],
  active: null,
  split: false,
  right: [],
  activeRight: null,
  focus: 0,
  mode: "code",
  side: "explorer",
  terminalOpen: false,
  revision: 0,

  loadProjects: async () => {
    const projects = await api.dev.projects();
    set((s) => ({ projects, root: s.root && projects.includes(s.root) ? s.root : (projects[0] ?? null) }));
  },

  openProject: async (path) => {
    const dirty = get().tabs.filter(isDirty);
    if (dirty.length && !(await confirmAction({ title: "Unsaved changes", message: `Discard unsaved changes in ${dirty.length} file(s)?`, confirmLabel: "Discard", danger: true })))
      return;
    try {
      const root = await api.dev.openProject(path);
      const projects = await api.dev.projects();
      set({ projects, root, ...NO_TABS, revision: get().revision + 1 });
    } catch (err) {
      reportError("Could not open project", err);
    }
  },

  closeProject: async (path) => {
    await api.dev.closeProject(path);
    const projects = await api.dev.projects();
    set((s) => (s.root === path ? { projects, root: projects[0] ?? null, ...NO_TABS } : { projects }));
  },

  openFile: async (path) => {
    const same = (a: string) => a.toLowerCase() === path.toLowerCase();
    const existing = get().tabs.find((t) => t.kind === "file" && same(t.path));
    if (existing) return set((s) => activate(s, existing.key));
    try {
      const f = await api.dev.readFile(path);
      const key = `file:${f.path}`;
      if (get().tabs.some((t) => t.key === key)) return set((s) => activate(s, key));
      const tab: EditorTab = {
        key,
        kind: "file",
        path: f.path,
        name: baseName(f.path),
        language: languageFor(f.path),
        content: f.content,
        saved: f.content,
        readOnly: f.readOnly,
        binary: f.binary,
      };
      set((s) => ({ tabs: [...s.tabs, tab], ...placeNew(s, key) }));
    } catch (err) {
      reportError(`Could not open ${baseName(path)}`, err);
    }
  },

  openDiff: async (relPath, staged) => {
    const root = get().root;
    if (!root) return;
    const key = `diff:${staged ? "staged" : "work"}:${relPath}`;
    try {
      const diff = await api.git.diff(root, relPath, staged);
      const tab: EditorTab = {
        key,
        kind: "diff",
        path: relPath,
        name: `${baseName(relPath)} ${staged ? "(staged)" : "(changes)"}`,
        language: languageFor(relPath),
        content: "",
        saved: "",
        readOnly: true,
        binary: false,
        diff: { ...diff, staged },
      };
      set((s) => ({ tabs: [...s.tabs.filter((t) => t.key !== key), tab], ...placeNew(s, key) }));
    } catch (err) {
      reportError("Could not load diff", err);
    }
  },

  openProposal: async (path, proposed) => {
    const key = `proposal:${path}`;
    try {
      // Compare against unsaved editor content if the file is open, else the file on disk.
      const open = get().tabs.find((t) => t.key === `file:${path}`);
      const original = open ? open.content : (await api.dev.readFile(path)).content;
      const tab: EditorTab = {
        key,
        kind: "proposal",
        path,
        name: `${baseName(path)} (AI proposal)`,
        language: languageFor(path),
        content: "",
        saved: "",
        readOnly: true,
        binary: false,
        diff: { original, modified: proposed, staged: false },
      };
      set((s) => ({ tabs: [...s.tabs.filter((t) => t.key !== key), tab], ...placeNew(s, key) }));
    } catch (err) {
      reportError("Could not open proposal", err);
    }
  },

  applyProposal: async (key) => {
    const tab = get().tabs.find((t) => t.key === key);
    if (!tab || tab.kind !== "proposal" || !tab.diff) return;
    const ok = await confirmAction({
      title: "Apply AI proposal",
      message: `Write the proposed version to ${tab.path}?`,
      detail: "The file on disk is replaced. Git can show or revert the change; nothing is committed or pushed.",
      confirmLabel: "Apply to file",
    });
    if (!ok) return;
    try {
      await api.dev.writeFile(tab.path, tab.diff.modified);
      const modified = tab.diff.modified;
      set((s) => ({
        tabs: s.tabs
          .filter((t) => t.key !== key)
          .map((t) => (t.key === `file:${tab.path}` ? { ...t, content: modified, saved: modified } : t)),
        right: s.right.filter((k) => k !== key),
        ...(s.tabs.some((t) => t.key === `file:${tab.path}`) ? activate(s, `file:${tab.path}`) : { active: s.active === key ? null : s.active }),
        revision: s.revision + 1,
      }));
      notify.success("Proposal applied", tab.path);
    } catch (err) {
      reportError("Could not apply proposal", err);
    }
  },

  setContent: (key, content) => set((s) => ({ tabs: s.tabs.map((t) => (t.key === key ? { ...t, content } : t)) })),

  save: async (key) => {
    const before = get().tabs.find((t) => t.key === key);
    if (!before || before.kind !== "file" || before.readOnly || !isDirty(before)) return;
    try {
      await saveHooks.before?.(before);
      // Formatting may have changed the text.
      const tab = get().tabs.find((t) => t.key === key) ?? before;
      await api.dev.writeFile(tab.path, tab.content);
      set((s) => ({ tabs: s.tabs.map((t) => (t.key === key ? { ...t, saved: tab.content } : t)), revision: s.revision + 1 }));
      void saveHooks.after?.(tab);
      notify.success(`Saved ${tab.name}`);
    } catch (err) {
      reportError(`Could not save ${before.name}`, err);
    }
  },

  closeTab: async (key) => {
    const tab = get().tabs.find((t) => t.key === key);
    if (tab && isDirty(tab)) {
      const ok = await confirmAction({ title: "Unsaved changes", message: `Close ${tab.name} without saving?`, confirmLabel: "Discard changes", danger: true });
      if (!ok) return;
    }
    set((s) => {
      const tabs = s.tabs.filter((t) => t.key !== key);
      // The neighbour in the same group becomes active.
      const inRight = s.right.includes(key);
      const group = s.tabs.filter((t) => s.right.includes(t.key) === inRight).map((t) => t.key);
      const index = group.indexOf(key);
      const rest = group.filter((k) => k !== key);
      const next = rest[Math.max(0, index - 1)] ?? null;
      if (inRight) return { tabs, right: s.right.filter((k) => k !== key), activeRight: s.activeRight === key ? next : s.activeRight };
      return { tabs, active: s.active === key ? next : s.active };
    });
  },

  setActive: (key) => set((s) => activate(s, key)),

  toggleSplit: () =>
    set((s) => {
      if (s.split) return { split: false, right: [], activeRight: null, focus: 0, active: s.active ?? s.activeRight };
      const left = s.tabs.filter((t) => !s.right.includes(t.key));
      // The active tab moves to the new group when others stay behind.
      if (s.active && left.length > 1) {
        const rest = left.filter((t) => t.key !== s.active);
        return { split: true, right: [s.active], activeRight: s.active, active: rest.at(-1)?.key ?? null, focus: 1 };
      }
      return { split: true, focus: 1 };
    }),

  moveToGroup: (key, group) =>
    set((s) => {
      if ((group === 1) === s.right.includes(key)) return activate(s, key);
      if (group === 1) {
        const left = s.tabs.filter((t) => !s.right.includes(t.key) && t.key !== key);
        return { split: true, right: [...s.right, key], activeRight: key, focus: 1, active: s.active === key ? (left.at(-1)?.key ?? null) : s.active };
      }
      const right = s.right.filter((k) => k !== key);
      return { right, active: key, focus: 0, activeRight: s.activeRight === key ? (right.at(-1) ?? null) : s.activeRight };
    }),

  setFocus: (focus) => set((s) => (s.focus === focus ? s : { focus })),

  openCompare: async (a, b) => {
    const key = `compare:${a}|${b}`;
    try {
      const [left, right] = await Promise.all([api.dev.readFile(a), api.dev.readFile(b)]);
      if (left.binary || right.binary) return notify.warn("Binary files cannot be compared as text");
      const tab: EditorTab = {
        key,
        kind: "diff",
        path: b,
        name: `${baseName(a)} ↔ ${baseName(b)}`,
        language: languageFor(b),
        content: "",
        saved: "",
        readOnly: true,
        binary: false,
        diff: { original: left.content, modified: right.content, staged: false, label: `${a} ↔ ${b}` },
      };
      set((s) => ({ tabs: [...s.tabs.filter((t) => t.key !== key), tab], ...placeNew(s, key) }));
    } catch (err) {
      reportError("Could not compare files", err);
    }
  },
  setMode: (mode) => set({ mode, terminalOpen: mode === "debug" ? true : get().terminalOpen }),
  setSide: (side) => set({ side }),
  toggleTerminal: (open) => set((s) => ({ terminalOpen: open ?? !s.terminalOpen })),
  bump: () => set((s) => ({ revision: s.revision + 1 })),

  reloadFromDisk: async (paths) => {
    const keys = new Set(paths.map((p) => p.toLowerCase()));
    for (const tab of get().tabs.filter((t) => t.kind === "file" && keys.has(t.path.toLowerCase()))) {
      const f = await api.dev.readFile(tab.path).catch(() => null);
      if (!f) continue;
      reloadHooks.forEach((h) => h(tab.path, f.content));
      set((s) => ({ tabs: s.tabs.map((t) => (t.key === tab.key ? { ...t, content: f.content, saved: f.content } : t)) }));
    }
  },
}));

/** Path of `abs` relative to the project root, with forward slashes (git style). */
export function relativeToRoot(root: string, abs: string): string {
  const r = root.replace(/[\\/]+$/, "");
  return abs.toLowerCase().startsWith(r.toLowerCase()) ? abs.slice(r.length + 1).replace(/\\/g, "/") : abs;
}
