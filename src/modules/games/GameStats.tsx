import { useEffect, useState } from "react";
import { BarChart3, Trash2 } from "lucide-react";
import { Dialog } from "@/components/Dialog";
import { api } from "@/services/api";
import { useSetting, useSettings } from "@/stores/settings";
import { confirmAction } from "@/stores/confirm";
import { reportError } from "@/stores/notifications";
import { formatPlaytime, type LibraryItem } from "./GamesModule";
import type { PlayDay, Playtime } from "@/types/phase2";

const RANGES = [7, 30, 90] as const;

/** Playtime history of one game: totals and a bar per day. */
export function GameStats({ item, total, onClose, onCleared }: { item: LibraryItem; total?: Playtime; onClose: () => void; onCleared: () => void }) {
  const untracked = useSetting("games.untracked");
  const tracked = !untracked.includes(item.key);
  const setTracked = (on: boolean) =>
    void useSettings.getState().set("games.untracked", on ? untracked.filter((id) => id !== item.key) : [...untracked, item.key]);
  const clear = async () => {
    const ok = await confirmAction({
      title: "Clear playtime",
      message: `Delete all recorded playtime of ${item.name}?`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    try {
      await api.games.clearPlaytime(item.key);
      onCleared();
      onClose();
    } catch (err) {
      reportError("Could not clear playtime", err);
    }
  };
  const [days, setDays] = useState<(typeof RANGES)[number]>(30);
  const [history, setHistory] = useState<PlayDay[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setHistory(null);
    api.games.history(item.key, days).then(setHistory, (e: Error) => setError(e.message));
  }, [item.key, days]);

  const max = Math.max(1, ...(history ?? []).map((d) => d.seconds));
  const sum = (history ?? []).reduce((s, d) => s + d.seconds, 0);
  const active = (history ?? []).filter((d) => d.seconds > 0).length;

  return (
    <Dialog title={item.name} onClose={onClose} icon={<BarChart3 size={15} />} wide>
      <div className="gstats">
        <div className="gstats__totals">
          <div>
            <span className="label">All time</span>
            <b className="mono">{formatPlaytime(total?.seconds ?? 0)}</b>
          </div>
          <div>
            <span className="label">Sessions</span>
            <b className="mono">{total?.sessions ?? 0}</b>
          </div>
          <div>
            <span className="label">Last {days} days</span>
            <b className="mono">{formatPlaytime(sum)}</b>
          </div>
          <div>
            <span className="label">Days played</span>
            <b className="mono">{active}</b>
          </div>
        </div>
        <div className="segmented">
          {RANGES.map((r) => (
            <button key={r} aria-pressed={days === r} onClick={() => setDays(r)}>
              {r} days
            </button>
          ))}
        </div>
        {error && <div className="unavailable">{error}</div>}
        {history && (
          <div className="gstats__chart" role="img" aria-label={`Playtime per day, last ${days} days`}>
            {history.map((d) => (
              <div key={d.date} className="gstats__col" title={`${new Date(`${d.date}T12:00`).toLocaleDateString()}: ${formatPlaytime(d.seconds)}`}>
                <div className="gstats__bar" style={{ height: `${(d.seconds / max) * 100}%` }} data-empty={d.seconds === 0} />
              </div>
            ))}
          </div>
        )}
        {history && (
          <div className="gstats__axis muted mono">
            <span>{new Date(`${history[0].date}T12:00`).toLocaleDateString()}</span>
            <span>peak {formatPlaytime(max === 1 ? 0 : max)}</span>
            <span>today</span>
          </div>
        )}
        {total === undefined && <p className="muted">No playtime recorded yet. NETRUNNER counts time while the game runs.</p>}
        <div className="gstats__options">
          <label className="check" title="Turn off for tools that run all the time (e.g. Wallpaper Engine)">
            <input type="checkbox" checked={tracked} onChange={(e) => setTracked(e.target.checked)} />
            Count playtime for this game
          </label>
          <button className="btn btn--sm btn--ghost" disabled={!total} onClick={() => void clear()}>
            <Trash2 size={12} /> Clear recorded time
          </button>
        </div>
      </div>
    </Dialog>
  );
}
