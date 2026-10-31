import { useMemo, useState } from "react";
import { FolderOpen, Gamepad2, Pencil, Play, Plus, RefreshCw } from "lucide-react";
import { ModuleHeader } from "@/components/ModuleHeader";
import { Tabs } from "@/components/Tabs";
import { api } from "@/services/api";
import { usePolled } from "@/hooks/usePolled";
import { useQuickAccess, emptyInput } from "@/stores/quickAccess";
import { notify, reportError } from "@/stores/notifications";
import { refreshActivity } from "@/stores/activity";
import { formatBytes } from "@/utils/format";
import type { Game } from "@/types/phase2";
import type { QuickAccessEntry } from "@/types/entities";

type Source = Game["source"] | "custom";
const SOURCE_LABEL: Record<Source, string> = {
  steam: "Steam",
  epic: "Epic Games",
  gog: "GOG Galaxy",
  prism: "Prism Launcher",
  custom: "Custom",
};
type Filter = "all" | Source;

/** One card in the library: a detected game or a user-added Quick Access game. */
interface LibraryItem {
  key: string;
  source: Source;
  name: string;
  location: string | null;
  sizeBytes: number | null;
  game?: Game;
  entry?: QuickAccessEntry;
}

export default function GamesModule() {
  const { data, error, loading, reload } = usePolled(() => api.games.scan());
  const entries = useQuickAccess((s) => s.entries);
  const qa = useQuickAccess();
  const [filter, setFilter] = useState<Filter>("all");
  const [text, setText] = useState("");

  const items = useMemo<LibraryItem[]>(() => {
    const detected = (data?.games ?? []).map((g) => ({
      key: g.id,
      source: g.source,
      name: g.name,
      location: g.installDir,
      sizeBytes: g.sizeBytes,
      game: g,
    }));
    const custom = entries
      .filter((e) => e.kind === "game")
      .map((e) => ({ key: `qa:${e.id}`, source: "custom" as const, name: e.name, location: e.target, sizeBytes: null, entry: e }));
    return [...custom, ...detected];
  }, [data, entries]);

  const visible = useMemo(() => {
    const q = text.trim().toLowerCase();
    return items.filter((i) => (filter === "all" || i.source === filter) && (!q || i.name.toLowerCase().includes(q)));
  }, [items, filter, text]);

  const launch = async (item: LibraryItem) => {
    if (item.entry) return qa.launch(item.entry);
    try {
      await api.games.launch(item.game!.id);
      notify.success(`Launching ${item.name}`, `via ${SOURCE_LABEL[item.source]}`);
      refreshActivity();
    } catch (err) {
      reportError(`Could not launch ${item.name}`, err);
    }
  };

  const reveal = (item: LibraryItem) => {
    if (item.entry) return void qa.reveal(item.entry);
    api.games.reveal(item.game!.id).catch((e) => reportError("Could not open folder", e));
  };

  const addToQuickAccess = (g: Game) => {
    const target = g.source === "steam" ? `steam://rungameid/${g.id.split(":")[1]}` : "";
    qa.openEditor(null, { ...emptyInput("game"), name: g.name, target, category: "Games" });
  };

  const counts = (s: Source) => items.filter((i) => i.source === s).length;
  const tabs: { id: Filter; label: string; count?: number }[] = [
    { id: "all", label: "All", count: items.length },
    ...(["custom", "steam", "epic", "gog", "prism"] as Source[])
      .filter((s) => counts(s) > 0)
      .map((s) => ({ id: s as Filter, label: SOURCE_LABEL[s], count: counts(s) })),
  ];

  return (
    <div className="module">
      <ModuleHeader id="games">
        <input className="input qa-search" placeholder="Filter games…" value={text} onChange={(e) => setText(e.target.value)} />
        <button className="btn" onClick={() => void reload()} disabled={loading}>
          <RefreshCw size={14} /> Rescan
        </button>
        <button className="btn btn--primary" onClick={() => qa.openEditor(null, { ...emptyInput("game"), category: "Games" })}>
          <Plus size={14} /> Add game
        </button>
      </ModuleHeader>
      <Tabs tabs={tabs} value={filter} onChange={setFilter} />
      <div className="module__scroll">
        {error && <div className="unavailable">{error}</div>}
        {data && (
          <div className="sources">
            {data.sources.map((s) => (
              <span key={s.source} className={`tag ${s.detected ? "tag--ok" : ""}`}>
                {SOURCE_LABEL[s.source]}: {s.detected ? `${s.count} found` : "not installed"}
              </span>
            ))}
          </div>
        )}
        {data && visible.length === 0 && (
          <div className="empty">
            <Gamepad2 size={26} />
            No games here. Use "Add game" for anything outside the supported launchers (any .exe, shortcut or launcher URI).
          </div>
        )}
        <div className="game-grid">
          {visible.map((item) => (
            <article key={item.key} className="panel game">
              <div className="game__head">
                <span className={`tag ${item.source === "custom" ? "tag--info" : "tag--accent"}`}>{SOURCE_LABEL[item.source]}</span>
                {item.sizeBytes && <span className="mono muted">{formatBytes(item.sizeBytes)}</span>}
              </div>
              <div className="game__name" title={item.name}>
                {item.name}
              </div>
              <div className="game__dir mono muted truncate" title={item.location ?? ""}>
                {item.location ?? "install location unknown"}
              </div>
              <div className="game__actions">
                <button className="btn btn--primary btn--sm" onClick={() => void launch(item)}>
                  <Play size={12} /> Launch
                </button>
                <button
                  className="icon-btn icon-btn--sm"
                  title="Open location"
                  disabled={!item.location || item.location.includes("://")}
                  onClick={() => reveal(item)}
                >
                  <FolderOpen size={13} />
                </button>
                {item.entry ? (
                  <button className="icon-btn icon-btn--sm" title="Edit" onClick={() => qa.openEditor(item.entry!.id)}>
                    <Pencil size={13} />
                  </button>
                ) : (
                  <button className="icon-btn icon-btn--sm" title="Add to Quick Access" onClick={() => addToQuickAccess(item.game!)}>
                    <Plus size={13} />
                  </button>
                )}
              </div>
            </article>
          ))}
        </div>
        <p className="muted qa-hint">
          Detected from launcher data on disk: Steam app manifests, Epic manifests, GOG registry and Prism Launcher instances
          (launched with Prism's own <span className="mono">--launch</span> option). Custom games are your Quick Access
          entries of type Game. NETRUNNER never modifies game files or processes.
        </p>
      </div>
    </div>
  );
}
