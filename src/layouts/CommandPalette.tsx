import { useEffect, useMemo, useRef, useState } from "react";
import { CornerDownLeft, Search, Settings, UserCog, Zap } from "lucide-react";
import { useShell } from "@/stores/shell";
import { useQuickAccess } from "@/stores/quickAccess";
import { buildItems, itemIcon, runItem } from "@/search/sources";
import { CATEGORY_LABEL, parseQuery, search, type SearchItem } from "@/search/query";
import { entryIcon } from "@/modules/quick-access/entryMeta";

const HINTS = ["app:", "game:", "file:", "folder:", "web:", "cmd:", "project:", "widget:", "setting:", "profile:"];

export function CommandPalette() {
  const initial = useShell((s) => s.paletteQuery);
  const close = useShell((s) => s.closePalette);
  const entries = useQuickAccess((s) => s.entries);
  const [query, setQuery] = useState(initial);
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  // Rebuilt when launcher entries change; other sources are small and static enough.
  const items = useMemo(() => buildItems(), [entries]);
  const results = useMemo(() => search(items, query), [items, query]);
  const filter = parseQuery(query).filter;

  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const choose = (item: SearchItem | undefined) => {
    if (!item) return;
    close();
    runItem(item);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      setActive((i) => Math.min(results.length - 1, i + 1));
      e.preventDefault();
    } else if (e.key === "ArrowUp") {
      setActive((i) => Math.max(0, i - 1));
      e.preventDefault();
    } else if (e.key === "Enter") {
      choose(results[active]);
      e.preventDefault();
    } else if (e.key === "Escape") {
      close();
      e.preventDefault();
    }
  };

  return (
    <div className="dialog-backdrop palette-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="palette" role="dialog" aria-label="Search and commands">
        <div className="palette__input">
          <Search size={16} className="muted" />
          {filter && <span className="tag tag--accent">{CATEGORY_LABEL[filter]}</span>}
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search everything — try app:, file:, setting:…"
            spellCheck={false}
            aria-controls="palette-results"
          />
        </div>
        <div className="palette__hints">
          {HINTS.map((h) => (
            <button key={h} className="palette__hint" onClick={() => setQuery(h)}>
              {h}
            </button>
          ))}
        </div>
        <div className="palette__results" id="palette-results" ref={listRef} role="listbox">
          {results.length === 0 && <div className="empty">No local matches.</div>}
          {results.map((item, index) => {
            const Icon = iconFor(item, entries);
            return (
              <button
                key={item.id}
                data-index={index}
                role="option"
                aria-selected={index === active}
                className="palette__item"
                onMouseMove={() => setActive(index)}
                onClick={() => choose(item)}
              >
                <Icon size={15} className="palette__icon" />
                <span className="palette__title truncate">{item.title}</span>
                {item.subtitle && <span className="palette__sub truncate">{item.subtitle}</span>}
                <span className="palette__cat">{CATEGORY_LABEL[item.category]}</span>
              </button>
            );
          })}
        </div>
        <div className="palette__foot">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> navigate
          </span>
          <span>
            <kbd>
              <CornerDownLeft size={10} />
            </kbd>{" "}
            open / launch
          </span>
          <span>
            <kbd>Esc</kbd> close
          </span>
          <span className="palette__local">LOCAL SEARCH · NO AI</span>
        </div>
      </div>
    </div>
  );
}

function iconFor(item: SearchItem, entries: ReturnType<typeof useQuickAccess.getState>["entries"]) {
  if (item.id.startsWith("qa:")) {
    const entry = entries.find((e) => `qa:${e.id}` === item.id);
    if (entry) return entryIcon(entry);
  }
  if (item.category === "setting") return Settings;
  if (item.category === "profile") return UserCog;
  return itemIcon(item) ?? Zap;
}
