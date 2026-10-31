import { Star } from "lucide-react";
import { useQuickAccess } from "@/stores/quickAccess";
import { useShell } from "@/stores/shell";
import { useContextMenu } from "@/components/ContextMenu";
import { entryObject } from "@/objects/resolve";
import { sameRef } from "@/objects/types";
import { ENTRY_KIND_META, entryIcon } from "./entryMeta";
import type { QuickAccessEntry } from "@/types/entities";

/**
 * One launcher entry. Single click selects (Inspector), double click or Enter
 * launches, right click opens the context menu.
 */
export function EntryTile({ entry, compact, disabled }: { entry: QuickAccessEntry; compact?: boolean; disabled?: boolean }) {
  const launch = useQuickAccess((s) => s.launch);
  const select = useShell((s) => s.select);
  const selected = useShell((s) => sameRef(s.selection, { type: "qa-entry", id: entry.id }));
  const openMenu = useContextMenu((s) => s.open);
  const Icon = entryIcon(entry);

  return (
    <button
      className={`tile${compact ? " tile--compact" : ""}`}
      aria-selected={selected}
      disabled={disabled}
      title={`${entry.name}\n${ENTRY_KIND_META[entry.kind].label} · ${entry.target}\nDouble-click to ${entry.kind === "command" ? "run" : "open"}`}
      onClick={() => select({ type: "qa-entry", id: entry.id })}
      onDoubleClick={() => void launch(entry)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          void launch(entry);
        }
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        select({ type: "qa-entry", id: entry.id });
        openMenu(e.clientX, e.clientY, entryObject(entry).actions);
      }}
    >
      <span className="tile__icon" data-kind={entry.kind}>
        <Icon size={compact ? 18 : 22} strokeWidth={1.5} />
      </span>
      <span className="tile__name truncate">{entry.name}</span>
      {!compact && <span className="tile__kind">{ENTRY_KIND_META[entry.kind].label}</span>}
      {entry.favorite && <Star size={10} className="tile__fav" fill="currentColor" />}
    </button>
  );
}
