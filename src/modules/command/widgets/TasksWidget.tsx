import { useEffect, useState } from "react";
import { api } from "@/services/api";
import { useSetting } from "@/stores/settings";
import { formatBytes } from "@/utils/format";
import { Sampling } from "./common";
import type { WidgetProps } from "./registry";
import type { ProcessList } from "@/types/entities";

/** Processes are heavier to enumerate, so this widget polls at 2× the base interval. */
export default function TasksWidget(_: WidgetProps) {
  const interval = useSetting("monitor.interval_ms");
  const [data, setData] = useState<ProcessList | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      if (document.hidden) return;
      api.system
        .topProcesses(12)
        .then((d) => !cancelled && (setData(d), setError(null)))
        .catch((e: Error) => !cancelled && setError(e.message));
    };
    load();
    const id = window.setInterval(load, interval * 2);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [interval]);

  if (error) return <div className="unavailable">{error}</div>;
  if (!data) return <Sampling text="Enumerating processes…" />;

  return (
    <table className="proc">
      <thead>
        <tr>
          <th className="label">Process</th>
          <th className="label num">PID</th>
          <th className="label num">CPU</th>
          <th className="label num">Memory</th>
        </tr>
      </thead>
      <tbody>
        {data.processes.map((p) => (
          <tr key={p.pid}>
            <td className="truncate" title={p.name}>
              {p.name}
            </td>
            <td className="num mono muted">{p.pid}</td>
            <td className="num mono">{data.cpuValid ? `${p.cpuPercent.toFixed(1)}%` : "…"}</td>
            <td className="num mono">{formatBytes(p.memoryBytes)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
