import { useMemo, useState } from "react";
import { Plus, Rocket } from "lucide-react";
import { ModuleHeader } from "@/components/ModuleHeader";
import { useQuickAccess } from "@/stores/quickAccess";
import { EntryTile } from "./EntryTile";
import { ENTRY_KIND_META, ENTRY_KINDS } from "./entryMeta";
import type { EntryKind } from "@/types/entities";

type Filter = EntryKind | "all" | "favorites";

export default function QuickAccessModule() {
  const entries = useQuickAccess((s) => s.entries);
  const openEditor = useQuickAccess((s) => s.openEditor);
  const [filter, setFilter] = useState<Filter>("all");
  const [text, setText] = useState("");

  const visible = useMemo(() => {
    const q = text.trim().toLowerCase();
    return entries.filter(
      (e) =>
        (filter === "all" || (filter === "favorites" ? e.favorite : e.kind === filter)) &&
        (!q || e.name.toLowerCase().includes(q) || e.target.toLowerCase().includes(q) || e.category.toLowerCase().includes(q)),
    );
  }, [entries, filter, text]);

  const groups = useMemo(() => {
    const map = new Map<string, typeof visible>();
    for (const e of visible) {
      const key = e.category || "Uncategorised";
      map.set(key, [...(map.get(key) ?? []), e]);
    }
    return [...map.entries()].sort(([a], [b]) => (a === "Uncategorised" ? 1 : b === "Uncategorised" ? -1 : a.localeCompare(b)));
  }, [visible]);

  const counts = useMemo(() => {
    const c: Partial<Record<Filter, number>> = { all: entries.length, favorites: entries.filter((e) => e.favorite).length };
    for (const e of entries) c[e.kind] = (c[e.kind] ?? 0) + 1;
    return c;
  }, [entries]);

  return (
    <div className="module">
      <ModuleHeader id="quick-access">
        <input
          className="input qa-search"
          placeholder="Filter entries…"
          value={text}
          onChange={(e) => setText(e.target.value)}
          spellCheck={false}
        />
        <button className="btn btn--primary" onClick={() => openEditor(null)}>
          <Plus size={14} /> Add object
        </button>
      </ModuleHeader>

      <div className="filterbar" role="tablist">
        {(["all", "favorites", ...ENTRY_KINDS] as Filter[]).map((f) => (
          <button key={f} role="tab" aria-selected={filter === f} onClick={() => setFilter(f)}>
            {f === "all" ? "All" : f === "favorites" ? "Favorites" : ENTRY_KIND_META[f].label}
            <span className="filterbar__count">{counts[f] ?? 0}</span>
          </button>
        ))}
      </div>

      <div className="module__scroll">
        {entries.length === 0 ? (
          <div className="empty qa-empty">
            <Rocket size={28} />
            <div>
              Quick Access launches applications, games, files, folders, websites, shell commands and projects.
              <br />
              Add your first object to get started.
            </div>
            <button className="btn btn--primary" onClick={() => openEditor(null)}>
              <Plus size={14} /> Add object
            </button>
          </div>
        ) : visible.length === 0 ? (
          <div className="empty">No entries match this filter.</div>
        ) : (
          groups.map(([category, list]) => (
            <section key={category} className="qa-group">
              <h2 className="label qa-group__title">
                {category} <span className="muted">· {list.length}</span>
              </h2>
              <div className="tile-grid">
                {list.map((e) => (
                  <EntryTile key={e.id} entry={e} />
                ))}
              </div>
            </section>
          ))
        )}
        <p className="qa-hint muted">Click to inspect · double-click or Enter to launch · right-click for actions</p>
      </div>
    </div>
  );
}
