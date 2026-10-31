import { useEffect, useState } from "react";
import type { WidgetProps } from "./registry";

export default function ClockWidget(_: WidgetProps) {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    // Align ticks to the second boundary.
    let id: number;
    const tick = () => {
      setNow(new Date());
      id = window.setTimeout(tick, 1000 - (Date.now() % 1000));
    };
    id = window.setTimeout(tick, 1000 - (Date.now() % 1000));
    return () => window.clearTimeout(id);
  }, []);

  const year = now.getFullYear();
  const month = now.getMonth();
  const first = new Date(year, month, 1);
  // Monday-first calendar grid.
  const lead = (first.getDay() + 6) % 7;
  const days = new Date(year, month + 1, 0).getDate();
  const cells = [...Array(lead).fill(null), ...Array.from({ length: days }, (_, i) => i + 1)];

  return (
    <div className="clock">
      <div className="clock__time mono">
        {now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
        <span className="clock__sec">{String(now.getSeconds()).padStart(2, "0")}</span>
      </div>
      <div className="clock__date label">
        {now.toLocaleDateString([], { weekday: "long", day: "numeric", month: "long", year: "numeric" })}
      </div>
      <div className="cal">
        {["M", "T", "W", "T", "F", "S", "S"].map((d, i) => (
          <span key={`h${i}`} className="cal__head">
            {d}
          </span>
        ))}
        {cells.map((d, i) => (
          <span key={i} className="cal__day" aria-current={d === now.getDate() ? "date" : undefined}>
            {d ?? ""}
          </span>
        ))}
      </div>
    </div>
  );
}
