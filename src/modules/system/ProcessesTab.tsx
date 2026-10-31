import { useMemo, useState } from "react";
import { RefreshCw, ShieldAlert, Skull } from "lucide-react";
import { api } from "@/services/api";
import { usePolled } from "@/hooks/usePolled";
import { useSetting } from "@/stores/settings";
import { confirmAction } from "@/stores/confirm";
import { notify, reportError } from "@/stores/notifications";
import { refreshActivity } from "@/stores/activity";
import { formatBytes } from "@/utils/format";
import type { ProcessInfo } from "@/types/phase2";

type Sort = "cpu" | "memory" | "name";

export function ProcessesTab() {
  const interval = useSetting("monitor.interval_ms");
  const { data, error, reload } = usePolled(() => api.system.topProcesses(2000), Math.max(2000, interval * 2));
  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState<Sort>("cpu");

  const rows = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const list = (data?.processes ?? []).filter(
      (p) => !q || p.name.toLowerCase().includes(q) || String(p.pid).includes(q),
    );
    return [...list].sort((a, b) =>
      sort === "name" ? a.name.localeCompare(b.name) : sort === "memory" ? b.memoryBytes - a.memoryBytes : b.cpuPercent - a.cpuPercent,
    );
  }, [data, filter, sort]);

  const terminate = async (p: ProcessInfo) => {
    const ok = await confirmAction({
      title: "Terminate process",
      message: `Force-terminate ${p.name} (PID ${p.pid})?`,
      detail: "Unsaved work in this program will be lost. Windows does not let it clean up.",
      confirmLabel: "Terminate",
      danger: true,
    });
    if (!ok) return;
    try {
      await api.system.terminate(p.pid);
      notify.success(`Terminated ${p.name}`);
      refreshActivity();
      void reload();
    } catch (err) {
      reportError(`Could not terminate ${p.name}`, err);
    }
  };

  if (error) return <div className="unavailable">{error}</div>;

  return (
    <div className="tab-pane">
      <div className="toolbar">
        <input className="input" placeholder="Filter by name or PID…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <div className="segmented">
          {(["cpu", "memory", "name"] as Sort[]).map((s) => (
            <button key={s} aria-pressed={sort === s} onClick={() => setSort(s)}>
              {s}
            </button>
          ))}
        </div>
        <span className="muted">{rows.length} processes</span>
        <button className="icon-btn" title="Refresh" onClick={() => void reload()}>
          <RefreshCw size={14} />
        </button>
      </div>
      <table className="table">
        <thead>
          <tr>
            <th>Name</th>
            <th className="num">PID</th>
            <th className="num">CPU</th>
            <th className="num">Memory</th>
            <th className="actions" />
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => (
            <tr key={p.pid}>
              <td className="truncate" title={p.exe ?? p.name}>
                {p.name}
              </td>
              <td className="num mono muted">{p.pid}</td>
              <td className="num mono">{data?.cpuValid ? `${p.cpuPercent.toFixed(1)}%` : "…"}</td>
              <td className="num mono">{formatBytes(p.memoryBytes)}</td>
              <td className="actions">
                {p.canTerminate ? (
                  <button className="icon-btn icon-btn--sm" title="Terminate…" onClick={() => void terminate(p)}>
                    <Skull size={13} />
                  </button>
                ) : (
                  <span className="muted" title="Protected system process">
                    <ShieldAlert size={13} />
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
