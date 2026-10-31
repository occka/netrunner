import { useEffect } from "react";
import { useActivity } from "@/stores/activity";
import type { WidgetProps } from "./registry";

export default function ActivityWidget(_: WidgetProps) {
  const entries = useActivity((s) => s.entries);
  const refresh = useActivity((s) => s.refresh);

  useEffect(() => {
    void refresh().catch(() => undefined);
  }, [refresh]);

  if (entries.length === 0) return <div className="empty">No activity recorded yet.</div>;

  return (
    <ol className="activity">
      {entries.slice(0, 60).map((e) => {
        const time = new Date(e.ts);
        return (
          <li key={e.id} className="activity__item" data-level={e.level}>
            <span className="activity__time mono">
              {time.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
            </span>
            <span className="activity__src">{e.source}</span>
            <span className="activity__msg" title={`${time.toLocaleString()} · ${e.message}`}>
              {e.level !== "info" && <span className={`tag tag--${e.level === "error" ? "crit" : "warn"}`}>{e.level}</span>}{" "}
              {e.message}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
