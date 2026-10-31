import { useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";
import { api } from "@/services/api";
import { usePolled } from "@/hooks/usePolled";

const TONE: Record<string, string> = { running: "ok", stopped: "", paused: "warn" };

export function ServicesTab() {
  const { data, error, reload } = usePolled(() => api.system.services());
  const [filter, setFilter] = useState("");
  const [runningOnly, setRunningOnly] = useState(true);

  const rows = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return (data ?? []).filter(
      (s) =>
        (!runningOnly || s.state === "running") &&
        (!q || s.displayName.toLowerCase().includes(q) || s.name.toLowerCase().includes(q)),
    );
  }, [data, filter, runningOnly]);

  if (error) return <div className="unavailable">{error}</div>;

  return (
    <div className="tab-pane">
      <div className="toolbar">
        <input className="input" placeholder="Filter services…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <label className="check">
          <input type="checkbox" checked={runningOnly} onChange={(e) => setRunningOnly(e.target.checked)} />
          Running only
        </label>
        <span className="muted">
          {rows.length} of {data?.length ?? 0} · read-only (starting/stopping services needs administrator rights)
        </span>
        <button className="icon-btn" title="Refresh" onClick={() => void reload()}>
          <RefreshCw size={14} />
        </button>
      </div>
      <table className="table">
        <thead>
          <tr>
            <th>Display name</th>
            <th>Service</th>
            <th>State</th>
            <th className="num">PID</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((s) => (
            <tr key={s.name}>
              <td className="truncate">{s.displayName}</td>
              <td className="mono muted truncate">{s.name}</td>
              <td>
                <span className={`tag ${TONE[s.state] ? `tag--${TONE[s.state]}` : ""}`}>{s.state}</span>
              </td>
              <td className="num mono muted">{s.pid ?? ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
