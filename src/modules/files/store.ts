import { create } from "zustand";

export interface FilesTab {
  id: number;
  path: string;
  back: string[];
  forward: string[];
}

interface FilesStore {
  tabs: FilesTab[];
  active: number;
  clipboard: { paths: string[]; move: boolean } | null;
  navigate: (path: string) => void;
  goBack: () => void;
  goForward: () => void;
  openTab: (path: string) => void;
  closeTab: (id: number) => void;
  setActive: (id: number) => void;
  setClipboard: (c: FilesStore["clipboard"]) => void;
}

let nextTab = 2;

/** Parent folder of a Windows path, or null at a drive root. */
export function parentOf(path: string): string | null {
  const trimmed = path.replace(/[\\/]+$/, "");
  const i = trimmed.lastIndexOf("\\");
  if (i < 0) return null;
  const parent = trimmed.slice(0, i);
  return /^[A-Za-z]:$/.test(parent) ? `${parent}\\` : parent || null;
}

const update = (tabs: FilesTab[], id: number, fn: (t: FilesTab) => FilesTab) => tabs.map((t) => (t.id === id ? fn(t) : t));

/** Tabs and clipboard persist while NETRUNNER runs (not across restarts). */
export const useFiles = create<FilesStore>((set) => ({
  tabs: [{ id: 1, path: "", back: [], forward: [] }],
  active: 1,
  clipboard: null,
  navigate: (path) =>
    set((s) => ({
      tabs: update(s.tabs, s.active, (t) => (t.path === path ? t : { ...t, path, back: t.path ? [...t.back, t.path] : t.back, forward: [] })),
    })),
  goBack: () =>
    set((s) => ({
      tabs: update(s.tabs, s.active, (t) =>
        t.back.length ? { ...t, path: t.back[t.back.length - 1], back: t.back.slice(0, -1), forward: [t.path, ...t.forward] } : t,
      ),
    })),
  goForward: () =>
    set((s) => ({
      tabs: update(s.tabs, s.active, (t) =>
        t.forward.length ? { ...t, path: t.forward[0], forward: t.forward.slice(1), back: [...t.back, t.path] } : t,
      ),
    })),
  openTab: (path) => {
    const id = nextTab++;
    set((s) => ({ tabs: [...s.tabs, { id, path, back: [], forward: [] }], active: id }));
  },
  closeTab: (id) =>
    set((s) => {
      if (s.tabs.length === 1) return s;
      const tabs = s.tabs.filter((t) => t.id !== id);
      return { tabs, active: s.active === id ? tabs[tabs.length - 1].id : s.active };
    }),
  setActive: (active) => set({ active }),
  setClipboard: (clipboard) => set({ clipboard }),
}));
