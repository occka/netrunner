import { useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { BarChart3, FolderOpen, Gamepad2, LayoutGrid, List, Pencil, Play, Plus, RefreshCw } from "lucide-react";
import { ModuleHeader } from "@/components/ModuleHeader";
import { Tabs } from "@/components/Tabs";
import { api } from "@/services/api";
import { usePolled } from "@/hooks/usePolled";
import { useQuickAccess, emptyInput } from "@/stores/quickAccess";
import { useSetting, useSettings } from "@/stores/settings";
import { notify, reportError } from "@/stores/notifications";
import { refreshActivity } from "@/stores/activity";
import { formatBytes } from "@/utils/format";
import { GameStats } from "./GameStats";
import type { Game, Playtime } from "@/types/phase2";
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
type Period = "today" | "week" | "month" | "all";

const PERIODS: { id: Period; label: string }[] = [
  { id: "today", label: "Today" },
  { id: "week", label: "Week" },
  { id: "month", label: "Month" },
  { id: "all", label: "All time" },
];

const PERIOD_PHRASE: Record<Period, string> = { today: "today", week: "this week", month: "this month", all: "in total" };

/** One card in the library: a detected game or a user-added Quick Access game. */
export interface LibraryItem {
  /** Library id (`steam:…`) or `qa:<entry id>`; also the playtime key. */
  key: string;
  source: Source;
  name: string;
  location: string | null;
  sizeBytes: number | null;
  game?: Game;
  entry?: QuickAccessEntry;
}

/** Start of the period in local time (Monday-based weeks), unix ms; null = all time. */
export function periodStart(p: Period, now = new Date()): number | null {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (p === "today") return d.getTime();
  if (p === "week") return d.getTime() - ((d.getDay() + 6) % 7) * 86400000;
  if (p === "month") return new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  return null;
}

/** 4500 → "1 h 15 min", 300 → "5 min", 20 → "< 1 min". */
export function formatPlaytime(seconds: number): string {
  if (seconds <= 0) return "—";
  const m = Math.floor(seconds / 60);
  if (m < 1) return "< 1 min";
  const h = Math.floor(m / 60);
  return h ? `${h} h${m % 60 ? ` ${m % 60} min` : ""}` : `${m} min`;
}

function lastPlayedLabel(ms: number | undefined) {
  if (!ms) return "never played";
  const days = Math.floor((Date.now() - ms) / 86400000);
  if (days < 1) return "played today";
  if (days < 2) return "played yesterday";
  if (days < 30) return `played ${days} days ago`;
  return `played ${new Date(ms).toLocaleDateString()}`;
}

/** Banner images, loaded once per game per session. */
const banners = new Map<string, Promise<string | null>>();
function useBanner(id: string | null) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!id) return setUrl(null);
    let alive = true;
    if (!banners.has(id)) banners.set(id, api.games.banner(id).catch(() => null));
    void banners.get(id)!.then((u) => alive && setUrl(u));
    return () => {
      alive = false;
    };
  }, [id]);
  return url;
}

/** Hue derived from the name, so a game keeps its generated cover. */
function hueOf(name: string) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

export default function GamesModule() {
  const { data, error, loading, reload } = usePolled(() => api.games.scan());
  const entries = useQuickAccess((s) => s.entries);
  const qa = useQuickAccess();
  const view = useSetting("games.view");
  const sort = useSetting("games.sort");
  const period = useSetting("games.period");
  const untracked = useSetting("games.untracked");
  const set = useSettings((s) => s.set);
  const [filter, setFilter] = useState<Filter>("all");
  const [text, setText] = useState("");
  const [stats, setStats] = useState<LibraryItem | null>(null);
  const [running, setRunning] = useState<string[]>([]);
  const playtime = usePolled(() => api.games.playtime(periodStart(period)), 60000);
  const allTime = usePolled(() => api.games.playtime(null), 60000);

  useEffect(() => void playtime.reload(), [period]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    void api.games.running().then(setRunning, () => undefined);
    const un = listen<string[]>("games://running", (e) => {
      setRunning(e.payload);
      void playtime.reload();
      void allTime.reload();
    });
    return () => void un.then((f) => f());
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const played = useMemo(() => new Map((playtime.data ?? []).map((p) => [p.gameId, p])), [playtime.data]);
  const ever = useMemo(() => new Map((allTime.data ?? []).map((p) => [p.gameId, p])), [allTime.data]);

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
    const list = items.filter((i) => (filter === "all" || i.source === filter) && (!q || i.name.toLowerCase().includes(q)));
    const secs = (i: LibraryItem) => played.get(i.key)?.seconds ?? 0;
    const last = (i: LibraryItem) => ever.get(i.key)?.lastPlayed ?? 0;
    const byName = (a: LibraryItem, b: LibraryItem) => a.name.localeCompare(b.name);
    return [...list].sort((a, b) =>
      sort === "playtime"
        ? secs(b) - secs(a) || byName(a, b)
        : sort === "recent"
          ? last(b) - last(a) || byName(a, b)
          : sort === "launcher"
            ? SOURCE_LABEL[a.source].localeCompare(SOURCE_LABEL[b.source]) || byName(a, b)
            : byName(a, b),
    );
  }, [items, filter, text, sort, played, ever]);

  const counted = (playtime.data ?? []).filter((p) => !untracked.includes(p.gameId));
  const total = counted.reduce((s, p) => s + p.seconds, 0);
  const top = [...counted].sort((a, b) => b.seconds - a.seconds)[0];

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

  const card = (item: LibraryItem) => {
    const p = played.get(item.key);
    const isRunning = running.includes(item.key);
    const actions = (
      <div className="game__actions">
        <button className="btn btn--primary btn--sm" onClick={() => void launch(item)} disabled={isRunning}>
          <Play size={12} /> {isRunning ? "Running" : "Launch"}
        </button>
        <button className="icon-btn icon-btn--sm" title="Playtime history" onClick={() => setStats(item)}>
          <BarChart3 size={13} />
        </button>
        <button className="icon-btn icon-btn--sm" title="Open location" disabled={!item.location || item.location.includes("://")} onClick={() => reveal(item)}>
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
    );
    const meta = (
      <div className="game__play muted">
        {untracked.includes(item.key) ? (
          <span title="Playtime is not counted for this game (change it in its history)">not tracked</span>
        ) : (
          <span className={p?.seconds ? "game__time" : undefined}>{formatPlaytime(p?.seconds ?? 0)}</span>
        )}
        <span>· {lastPlayedLabel(ever.get(item.key)?.lastPlayed)}</span>
      </div>
    );
    if (view === "banners") return <BannerCard key={item.key} item={item} running={isRunning} meta={meta} actions={actions} />;
    return (
      <article key={item.key} className="panel game" data-running={isRunning}>
        <div className="game__head">
          <span className={`tag ${item.source === "custom" ? "tag--info" : "tag--accent"}`}>{SOURCE_LABEL[item.source]}</span>
          {isRunning && <span className="tag tag--ok">Running</span>}
          {item.sizeBytes && <span className="mono muted">{formatBytes(item.sizeBytes)}</span>}
        </div>
        <div className="game__name" title={item.name}>
          {item.name}
        </div>
        {meta}
        <div className="game__dir mono muted truncate" title={item.location ?? ""}>
          {item.location ?? "install location unknown"}
        </div>
        {actions}
      </article>
    );
  };

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
        <div className="games-bar">
          <div className="segmented" title="Playtime period">
            {PERIODS.map((p) => (
              <button key={p.id} aria-pressed={period === p.id} onClick={() => void set("games.period", p.id)}>
                {p.label}
              </button>
            ))}
          </div>
          <span className="games-bar__total">
            Played {PERIOD_PHRASE[period]}: <b className="mono">{formatPlaytime(total)}</b>
            {top && top.seconds > 0 && <span className="muted"> · most: {top.name}</span>}
          </span>
          <label className="games-bar__sort">
            <span className="label">Sort</span>
            <select className="select select--sm" value={sort} onChange={(e) => void set("games.sort", e.target.value as typeof sort)}>
              <option value="name">Name</option>
              <option value="playtime">Playtime</option>
              <option value="recent">Last played</option>
              <option value="launcher">Launcher</option>
            </select>
          </label>
          <div className="segmented" title="View">
            <button aria-pressed={view === "list"} onClick={() => void set("games.view", "list")} title="Compact list">
              <List size={13} />
            </button>
            <button aria-pressed={view === "banners"} onClick={() => void set("games.view", "banners")} title="Banners">
              <LayoutGrid size={13} />
            </button>
          </div>
        </div>
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
        <div className={view === "banners" ? "game-banners" : "game-grid"}>{visible.map(card)}</div>
        <p className="muted qa-hint">
          Detected from launcher data on disk: Steam app manifests, Epic manifests, GOG registry and Prism Launcher instances
          (launched with Prism's own <span className="mono">--launch</span> option). Custom games are your Quick Access entries of
          type Game. Playtime is counted while a process from the game's folder runs (your own games: their .exe), checked every
          15 seconds; it is stored only on this computer. NETRUNNER never modifies game files or processes.
        </p>
      </div>
      {stats && (
        <GameStats
          item={stats}
          total={ever.get(stats.key) as Playtime | undefined}
          onClose={() => setStats(null)}
          onCleared={() => {
            void playtime.reload();
            void allTime.reload();
          }}
        />
      )}
    </div>
  );
}

function BannerCard({ item, running, meta, actions }: { item: LibraryItem; running: boolean; meta: React.ReactNode; actions: React.ReactNode }) {
  const url = useBanner(item.source === "steam" ? item.key : null);
  const hue = hueOf(item.name);
  return (
    <article className="panel game-banner" data-running={running}>
      <div
        className="game-banner__art"
        style={
          url
            ? { backgroundImage: `url("${url}")` }
            : { background: `linear-gradient(135deg, hsl(${hue} 70% 22%), hsl(${(hue + 60) % 360} 70% 12%))` }
        }
      >
        {!url && <span className="game-banner__initials">{item.name.replace(/[^\p{L}\p{N} ]/gu, "").split(" ").filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase()}</span>}
        <span className="tag tag--accent game-banner__src">{SOURCE_LABEL[item.source]}</span>
        {running && <span className="tag tag--ok game-banner__run">Running</span>}
      </div>
      <div className="game-banner__body">
        <div className="game__name" title={item.name}>
          {item.name}
        </div>
        {meta}
        {actions}
      </div>
    </article>
  );
}
