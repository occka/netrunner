import { create } from "zustand";
import { api } from "@/services/api";
import { confirmAction } from "@/stores/confirm";
import { notify, reportError } from "@/stores/notifications";
import { languageFor } from "./languages";

export type IdeMode = "code" | "debug" | "ai";
export type SidePanel = "explorer" | "git" | "tools";

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
  diff?: { original: string; modified: string; staged: boolean };
}

interface DevStore {
  projects: string[];
  root: string | null;
  tabs: EditorTab[];
  active: string | null;
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
  setMode: (mode: IdeMode) => void;
  setSide: (side: SidePanel) => void;
  toggleTerminal: (open?: boolean) => void;
  bump: () => void;
}

const baseName = (p: string) => p.split(/[\\/]/).pop() ?? p;
export const isDirty = (t: EditorTab) => t.kind === "file" && t.content !== t.saved;

export const useDev = create<DevStore>((set, get) => ({
  projects: [],
  root: null,
  tabs: [],
  active: null,
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
      set({ projects, root, tabs: [], active: null, revision: get().revision + 1 });
    } catch (err) {
      reportError("Could not open project", err);
    }
  },

  closeProject: async (path) => {
    await api.dev.closeProject(path);
    const projects = await api.dev.projects();
    set((s) => (s.root === path ? { projects, root: projects[0] ?? null, tabs: [], active: null } : { projects }));
  },

  openFile: async (path) => {
    const key = `file:${path}`;
    if (get().tabs.some((t) => t.key === key)) return set({ active: key });
    try {
      const f = await api.dev.readFile(path);
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
      set((s) => ({ tabs: [...s.tabs, tab], active: key }));
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
      set((s) => ({ tabs: [...s.tabs.filter((t) => t.key !== key), tab], active: key }));
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
      set((s) => ({ tabs: [...s.tabs.filter((t) => t.key !== key), tab], active: key }));
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
        active: s.tabs.some((t) => t.key === `file:${tab.path}`) ? `file:${tab.path}` : null,
        revision: s.revision + 1,
      }));
      notify.success("Proposal applied", tab.path);
    } catch (err) {
      reportError("Could not apply proposal", err);
    }
  },

  setContent: (key, content) => set((s) => ({ tabs: s.tabs.map((t) => (t.key === key ? { ...t, content } : t)) })),

  save: async (key) => {
    const tab = get().tabs.find((t) => t.key === key);
    if (!tab || tab.kind !== "file" || tab.readOnly || !isDirty(tab)) return;
    try {
      await api.dev.writeFile(tab.path, tab.content);
      set((s) => ({ tabs: s.tabs.map((t) => (t.key === key ? { ...t, saved: tab.content } : t)), revision: s.revision + 1 }));
      notify.success(`Saved ${tab.name}`);
    } catch (err) {
      reportError(`Could not save ${tab.name}`, err);
    }
  },

  closeTab: async (key) => {
    const tab = get().tabs.find((t) => t.key === key);
    if (tab && isDirty(tab)) {
      const ok = await confirmAction({ title: "Unsaved changes", message: `Close ${tab.name} without saving?`, confirmLabel: "Discard changes", danger: true });
      if (!ok) return;
    }
    set((s) => {
      const index = s.tabs.findIndex((t) => t.key === key);
      const tabs = s.tabs.filter((t) => t.key !== key);
      const active = s.active === key ? (tabs[Math.max(0, index - 1)]?.key ?? null) : s.active;
      return { tabs, active };
    });
  },

  setActive: (active) => set({ active }),
  setMode: (mode) => set({ mode, terminalOpen: mode === "debug" ? true : get().terminalOpen }),
  setSide: (side) => set({ side }),
  toggleTerminal: (open) => set((s) => ({ terminalOpen: open ?? !s.terminalOpen })),
  bump: () => set((s) => ({ revision: s.revision + 1 })),
}));

/** Path of `abs` relative to the project root, with forward slashes (git style). */
export function relativeToRoot(root: string, abs: string): string {
  const r = root.replace(/[\\/]+$/, "");
  return abs.toLowerCase().startsWith(r.toLowerCase()) ? abs.slice(r.length + 1).replace(/\\/g, "/") : abs;
}
