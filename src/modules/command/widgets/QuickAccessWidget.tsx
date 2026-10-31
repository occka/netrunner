import { Plus } from "lucide-react";
import { useQuickAccess } from "@/stores/quickAccess";
import { EntryTile } from "@/modules/quick-access/EntryTile";
import type { WidgetProps } from "./registry";

export default function QuickAccessWidget({ editing }: WidgetProps) {
  const entries = useQuickAccess((s) => s.entries);
  const openEditor = useQuickAccess((s) => s.openEditor);

  if (entries.length === 0) {
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
    <div className="tile-grid tile-grid--compact">
      {entries.map((e) => (
        <EntryTile key={e.id} entry={e} compact disabled={editing} />
      ))}
      <button className="tile tile--compact tile--add" onClick={() => openEditor(null)} disabled={editing} title="Add object">
        <span className="tile__icon">
          <Plus size={18} />
        </span>
        <span className="tile__name">Add</span>
      </button>
    </div>
  );
}
