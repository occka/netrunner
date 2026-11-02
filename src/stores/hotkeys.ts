import { create } from "zustand";
import { api } from "@/services/api";
import type { HotkeyBinding } from "@/types/entities";

interface HotkeysStore {
  bindings: HotkeyBinding[];
  load: () => Promise<void>;
  /** Empty keys: back to the default (built-ins) or no key (entries). Throws on a conflict. */
  set: (id: string, keys: string) => Promise<void>;
  reset: () => Promise<void>;
}

export const useHotkeys = create<HotkeysStore>((set) => ({
  bindings: [],
  load: async () => set({ bindings: await api.hotkeys.list() }),
  set: async (id, keys) => set({ bindings: await api.hotkeys.set(id, keys) }),
  reset: async () => set({ bindings: await api.hotkeys.reset() }),
}));

export const keysOf = (bindings: HotkeyBinding[], id: string, fallback: string) => bindings.find((b) => b.id === id)?.keys ?? fallback;
