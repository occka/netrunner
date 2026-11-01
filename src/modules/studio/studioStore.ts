/** Custom widgets, shared by the Studio module and every Custom widget in this window. */
import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import { api } from "@/services/api";
import type { CustomWidget } from "@/types/studio";

interface StudioStore {
  widgets: CustomWidget[] | null;
  error: string | null;
  load: () => Promise<void>;
}

export const useStudio = create<StudioStore>((set) => ({
  widgets: null,
  error: null,
  load: async () => {
    try {
      set({ widgets: await api.studio.list(), error: null });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    }
  },
}));

let listening = false;
/** Loads custom widgets once per window and reloads them when any window changes one. */
export function useStudioWidgets(): CustomWidget[] | null {
  if (!listening) {
    listening = true;
    void useStudio.getState().load();
    void listen("studio://changed", () => void useStudio.getState().load());
  }
  return useStudio((s) => s.widgets);
}
