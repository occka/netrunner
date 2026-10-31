import { create } from "zustand";
import { ApiError, api } from "@/services/api";
import { refreshActivity } from "@/stores/activity";
import { confirmAction } from "@/stores/confirm";
import { notify, reportError } from "@/stores/notifications";
import type { QuickAccessEntry, QuickAccessInput } from "@/types/entities";

interface QuickAccessStore {
  entries: QuickAccessEntry[];
  loaded: boolean;
  /** Entry being created/edited in the ADD OBJECT dialog (`null` id = new). */
  editor: { id: number | null; initial?: Partial<QuickAccessInput> } | null;
  load: () => Promise<void>;
  create: (input: QuickAccessInput) => Promise<QuickAccessEntry>;
  update: (id: number, input: QuickAccessInput) => Promise<QuickAccessEntry>;
  remove: (entry: QuickAccessEntry) => Promise<void>;
  toggleFavorite: (entry: QuickAccessEntry) => Promise<void>;
  launch: (entry: QuickAccessEntry) => Promise<void>;
  reveal: (entry: QuickAccessEntry) => Promise<void>;
  openEditor: (id: number | null, initial?: Partial<QuickAccessInput>) => void;
  closeEditor: () => void;
}

function upsert(list: QuickAccessEntry[], entry: QuickAccessEntry) {
  return list.some((e) => e.id === entry.id) ? list.map((e) => (e.id === entry.id ? entry : e)) : [...list, entry];
}

export const useQuickAccess = create<QuickAccessStore>((set) => ({
  entries: [],
  loaded: false,
  editor: null,
  load: async () => {
    set({ entries: await api.quickAccess.list(), loaded: true });
  },
  create: async (input) => {
    const entry = await api.quickAccess.create(input);
    set((s) => ({ entries: upsert(s.entries, entry) }));
    refreshActivity();
    return entry;
  },
  update: async (id, input) => {
    const entry = await api.quickAccess.update(id, input);
    set((s) => ({ entries: upsert(s.entries, entry) }));
    refreshActivity();
    return entry;
  },
  remove: async (entry) => {
    const ok = await confirmAction({
      title: "Remove entry",
      message: `Remove "${entry.name}" from Quick Access?`,
      detail: "Only the shortcut is removed. The target itself is not touched.",
      confirmLabel: "Remove",
      danger: true,
    });
    if (!ok) return;
    try {
      await api.quickAccess.remove(entry.id);
      set((s) => ({ entries: s.entries.filter((e) => e.id !== entry.id) }));
      refreshActivity();
    } catch (err) {
      reportError("Could not remove entry", err);
    }
  },
  toggleFavorite: async (entry) => {
    try {
      const updated = await api.quickAccess.setFavorite(entry.id, !entry.favorite);
      set((s) => ({ entries: upsert(s.entries, updated) }));
    } catch (err) {
      reportError("Could not update favorite", err);
    }
  },
  launch: async (entry) => {
    try {
      const updated = await api.quickAccess.launch(entry.id);
      set((s) => ({ entries: upsert(s.entries, updated) }));
      notify.success(`Launched ${entry.name}`);
    } catch (err) {
      if (err instanceof ApiError && err.code === "confirmation_required") {
        const ok = await confirmAction({
          title: "Run command",
          message: `Run "${entry.name}" in a new ${entry.shell === "powershell" ? "PowerShell" : "Command Prompt"} window?`,
          detail: `${err.message}\n\n${entry.target}`,
          confirmLabel: "Run command",
          danger: true,
        });
        if (!ok) return;
        try {
          const updated = await api.quickAccess.launch(entry.id, true);
          set((s) => ({ entries: upsert(s.entries, updated) }));
          notify.success(`Started ${entry.name}`);
        } catch (inner) {
          reportError(`Could not run ${entry.name}`, inner);
        }
      } else {
        reportError(`Could not launch ${entry.name}`, err);
      }
    } finally {
      refreshActivity();
    }
  },
  reveal: async (entry) => {
    try {
      await api.quickAccess.reveal(entry.id);
    } catch (err) {
      reportError("Could not open location", err);
    }
  },
  openEditor: (id, initial) => set({ editor: { id, initial } }),
  closeEditor: () => set({ editor: null }),
}));

export function findEntry(id: number) {
  return useQuickAccess.getState().entries.find((e) => e.id === id);
}

export const emptyInput = (kind: QuickAccessInput["kind"] = "app"): QuickAccessInput => ({
  kind,
  name: "",
  target: "",
  args: "",
  workingDir: "",
  shell: kind === "command" ? "powershell" : "",
  icon: "",
  category: "",
  favorite: false,
  requireConfirm: kind === "command",
});
