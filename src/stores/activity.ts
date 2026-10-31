import { create } from "zustand";
import { api } from "@/services/api";
import type { ActivityEntry } from "@/types/entities";

interface ActivityStore {
  entries: ActivityEntry[];
  loading: boolean;
  refresh: () => Promise<void>;
}

/**
 * Activity log mirror. Stores that perform backend actions call `refresh`
 * afterwards, so the log updates on events instead of by polling.
 */
export const useActivity = create<ActivityStore>((set) => ({
  entries: [],
  loading: false,
  refresh: async () => {
    set({ loading: true });
    try {
      set({ entries: await api.activity.list(100) });
    } finally {
      set({ loading: false });
    }
  },
}));

export const refreshActivity = () => {
  void useActivity.getState().refresh().catch(() => undefined);
};
