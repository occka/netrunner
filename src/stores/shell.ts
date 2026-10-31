import { create } from "zustand";
import type { ModuleId } from "@/app/modules";
import type { ObjectRef } from "@/objects/types";

interface ShellStore {
  module: ModuleId;
  /** Optional in-module section to scroll to (e.g. a settings group). */
  section: string | null;
  /** Object the user most recently selected; drives the Inspector. */
  selection: ObjectRef | null;
  /** When set, the Inspector shows this object instead of the selection. */
  pinned: ObjectRef | null;
  /** One-shot request for the Inspector to show a tab (e.g. a widget's gear button). */
  inspectorTab: string | null;
  paletteOpen: boolean;
  paletteQuery: string;
  navigate: (module: ModuleId, section?: string) => void;
  select: (ref: ObjectRef | null) => void;
  pin: (ref: ObjectRef | null) => void;
  inspect: (ref: ObjectRef, tab: string) => void;
  openPalette: (query?: string) => void;
  closePalette: () => void;
}

export const useShell = create<ShellStore>((set) => ({
  module: "command",
  section: null,
  selection: null,
  pinned: null,
  inspectorTab: null,
  paletteOpen: false,
  paletteQuery: "",
  navigate: (module, section) => set({ module, section: section ?? null }),
  select: (selection) => set({ selection }),
  pin: (pinned) => set({ pinned }),
  inspect: (selection, inspectorTab) => set({ selection, inspectorTab }),
  openPalette: (query = "") => set({ paletteOpen: true, paletteQuery: query }),
  closePalette: () => set({ paletteOpen: false }),
}));
