import { Plus } from "lucide-react";
import { useQuickAccess } from "@/stores/quickAccess";
import { EntryTile } from "@/modules/quick-access/EntryTile";
import type { WidgetProps } from "./registry";
import type { ConfigOf, QUICK_ACCESS_SETTINGS } from "./settings";

export default function QuickAccessWidget({ editing, config: c }: WidgetProps<ConfigOf<typeof QUICK_ACCESS_SETTINGS>>) {
  const all = useQuickAccess((s) => s.entries);
  const entries =
    c.filter === "favorites"
      ? all.filter((e) => e.favorite)
      : c.filter === "category"
        ? all.filter((e) => e.category === c.category.trim())
        : all;
  const openEditor = useQuickAccess((s) => s.openEditor);

  if (all.length === 0) {
    return (
      <div className="empty">
        <div>No launcher entries yet.</div>
        <button className="btn btn--primary" onClick={() => openEditor(null)} disabled={editing}>
          <Plus size={14} /> Add object
        </button>
      </div>
    );
  }

  return (
    <div className="tile-grid tile-grid--compact" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${c.tile}px, 1fr))` }}>
      {entries.length === 0 && <div className="empty">No entries match this widget's filter.</div>}
      {entries.map((e) => (
        <EntryTile key={e.id} entry={e} compact disabled={editing} />
      ))}
      {c.addButton && (
        <button className="tile tile--compact tile--add" onClick={() => openEditor(null)} disabled={editing} title="Add object">
          <span className="tile__icon">
            <Plus size={18} />
          </span>
          <span className="tile__name">Add</span>
        </button>
      )}
    </div>
  );
}
