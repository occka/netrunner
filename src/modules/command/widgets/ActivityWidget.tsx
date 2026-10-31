import { useEffect } from "react";
import { useActivity } from "@/stores/activity";
import type { WidgetProps } from "./registry";
import type { ACTIVITY_SETTINGS, ConfigOf } from "./settings";

export default function ActivityWidget({ config: c }: WidgetProps<ConfigOf<typeof ACTIVITY_SETTINGS>>) {
  const entries = useActivity((s) => s.entries);
  const refresh = useActivity((s) => s.refresh);

  useEffect(() => {
    void refresh().catch(() => undefined);
  }, [refresh]);

  const shown = entries.filter((e) => c.level === "all" || e.level === "error" || (c.level === "warn" && e.level === "warn"));
  if (shown.length === 0)
    return <div className="empty">{entries.length ? "Nothing matches this filter." : "No activity recorded yet."}</div>;

  return (
    <ol className="activity">
      {shown.slice(0, c.limit).map((e) => {
        const time = new Date(e.ts);
        return (
          <li key={e.id} className="activity__item" data-level={e.level}>
            <span className="activity__time mono">
              {time.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
            </span>
            {c.source && <span className="activity__src">{e.source}</span>}
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
