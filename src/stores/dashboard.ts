import { create } from "zustand";
import type { DashboardLayout, WidgetInstance } from "@/types/entities";

/**
 * EDIT LAYOUT state. Edits apply to a draft copy; the profile's stored layout
 * only changes when the draft is saved.
 */
interface DashboardStore {
  editing: boolean;
  /** Profile the draft belongs to, so a save can never land on another profile. */
  profileId: number | null;
  draft: DashboardLayout | null;
  dirty: boolean;
  begin: (layout: DashboardLayout, profileId: number) => void;
  setPositions: (positions: Pick<WidgetInstance, "id" | "x" | "y" | "w" | "h">[]) => void;
  addWidget: (widget: WidgetInstance) => void;
  removeWidget: (id: string) => void;
  end: () => void;
}

export const useDashboard = create<DashboardStore>((set) => ({
  editing: false,
  profileId: null,
  draft: null,
  dirty: false,
  begin: (layout, profileId) => set({ editing: true, dirty: false, profileId, draft: structuredClone(layout) }),
  setPositions: (positions) =>
    set((s) => {
      if (!s.draft) return s;
      const byId = new Map(positions.map((p) => [p.id, p]));
      let changed = false;
      const widgets = s.draft.widgets.map((w) => {
        const p = byId.get(w.id);
        if (!p || (p.x === w.x && p.y === w.y && p.w === w.w && p.h === w.h)) return w;
        changed = true;
        return { ...w, x: p.x, y: p.y, w: p.w, h: p.h };
      });
      return changed ? { draft: { ...s.draft, widgets }, dirty: true } : s;
    }),
  addWidget: (widget) =>
    set((s) => (s.draft ? { draft: { ...s.draft, widgets: [...s.draft.widgets, widget] }, dirty: true } : s)),
  removeWidget: (id) =>
    set((s) =>
      s.draft ? { draft: { ...s.draft, widgets: s.draft.widgets.filter((w) => w.id !== id) }, dirty: true } : s,
    ),
  end: () => set({ editing: false, draft: null, dirty: false, profileId: null }),
}));

/** Finds the first free row below existing widgets for a new widget. */
export function nextFreeY(widgets: WidgetInstance[]): number {
  return widgets.reduce((max, w) => Math.max(max, w.y + w.h), 0);
}

export function newWidgetId(type: string, existing: WidgetInstance[]): string {
  let n = 1;
  const ids = new Set(existing.map((w) => w.id));
  while (ids.has(`${type}-${n}`)) n++;
  return `${type}-${n}`;
}
