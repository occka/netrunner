import { useEffect, useMemo, useState, type CSSProperties } from "react";
import type { WidgetProps } from "./registry";
import type { CLOCK_SETTINGS, ConfigOf } from "./settings";

type ClockConfig = ConfigOf<typeof CLOCK_SETTINGS>;

/** Wall-clock fields of `now` in a time zone (or locally), without Date maths across zones. */
function zonedParts(now: Date, timeZone: string | undefined) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return { year: get("year"), month: get("month") - 1, day: get("day"), hour: get("hour"), minute: get("minute"), second: get("second") };
}

/** ISO-8601 week number of a calendar date. */
function isoWeek(year: number, month: number, day: number): number {
  const d = new Date(Date.UTC(year, month, day));
  const dow = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dow);
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  return Math.ceil(((d.getTime() - yearStart) / 86400000 + 1) / 7);
}

const pad = (n: number) => String(n).padStart(2, "0");

export default function ClockWidget({ config }: WidgetProps<ClockConfig>) {
  const [now, setNow] = useState(() => new Date());
  const c = config;
  const timeZone = c.timeZone === "local" ? undefined : c.timeZone;

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

  // The locale decides 12/24 h when set to "system".
  const twelveHour = useMemo(() => {
    if (c.hourCycle !== "system") return c.hourCycle === "h12";
    const cycle = new Intl.DateTimeFormat([], { hour: "numeric" }).resolvedOptions().hourCycle;
    return cycle === "h11" || cycle === "h12";
  }, [c.hourCycle]);

  const p = zonedParts(now, timeZone);
  const h = twelveHour ? p.hour % 12 || 12 : p.hour;
  const hours = c.leadingZero ? pad(h) : String(h);
  const meridiem = twelveHour ? (p.hour < 12 ? "AM" : "PM") : null;

  const dateText = (() => {
    if (c.date === "hidden") return null;
    if (c.date === "iso") return `${p.year}-${pad(p.month + 1)}-${pad(p.day)}`;
    const opts: Intl.DateTimeFormatOptions =
      c.date === "long"
        ? { weekday: "long", day: "numeric", month: "long", year: "numeric" }
        : c.date === "medium"
          ? { weekday: "short", day: "numeric", month: "short", year: "numeric" }
          : { day: "2-digit", month: "2-digit", year: "numeric" };
    return now.toLocaleDateString([], { ...opts, timeZone });
  })();

  const zoneName = c.showZone
    ? (new Intl.DateTimeFormat([], { timeZone, timeZoneName: "short" }).formatToParts(now).find((x) => x.type === "timeZoneName")?.value ??
      "")
    : null;

  // Calendar for the month in the chosen zone.
  const first = new Date(p.year, p.month, 1).getDay();
  const lead = c.weekStart === "monday" ? (first + 6) % 7 : first;
  const days = new Date(p.year, p.month + 1, 0).getDate();
  const cells = [...Array(lead).fill(null), ...Array.from({ length: days }, (_, i) => i + 1)];
  while (cells.length % 7) cells.push(null);
  const heads = c.weekStart === "monday" ? ["M", "T", "W", "T", "F", "S", "S"] : ["S", "M", "T", "W", "T", "F", "S"];
  const rows = Array.from({ length: cells.length / 7 }, (_, r) => cells.slice(r * 7, r * 7 + 7));

  // "Fit" sizes the digits from the widget width (container query units) and the text length.
  const chars = hours.length + 3 + (c.seconds === "inline" ? 3 : c.seconds === "small" ? 1.3 : 0) + (meridiem ? 1.7 : 0);
  const timeStyle = c.fit
    ? ({ ["--clock-chars" as string]: chars } as CSSProperties)
    : { fontSize: `${(38 * c.timeSize) / 100}px` };

  return (
    <div className={`clock clock--${c.align}${c.fit ? " clock--fit" : ""}`}>
      <div className="clock__time mono" style={timeStyle}>
        {hours}:{pad(p.minute)}
        {c.seconds === "inline" && `:${pad(p.second)}`}
        {c.seconds === "small" && <span className="clock__sec">{pad(p.second)}</span>}
        {meridiem && <span className="clock__ampm">{meridiem}</span>}
      </div>
      {(dateText || zoneName) && (
        <div className="clock__date label">
          {dateText}
          {zoneName && <span className="clock__zone">{zoneName}</span>}
        </div>
      )}
      {c.calendar && (
        <div className={`cal${c.weekNumbers ? " cal--weeks" : ""}`}>
          {c.weekNumbers && <span className="cal__head cal__week">W</span>}
          {heads.map((d, i) => (
            <span key={`h${i}`} className="cal__head">
              {d}
            </span>
          ))}
          {rows.map((row, r) => {
            const firstDay = row.find((d) => d != null) as number;
            // ISO weeks start on Monday; for Sunday-first grids use the row's Monday.
            const weekDay = c.weekStart === "sunday" ? Math.min(days, firstDay + (row.indexOf(firstDay) === 0 ? 1 : 0)) : firstDay;
            return [
              c.weekNumbers && (
                <span key={`w${r}`} className="cal__week mono">
                  {isoWeek(p.year, p.month, weekDay)}
                </span>
              ),
              ...row.map((d, i) => (
                <span key={`${r}-${i}`} className="cal__day" aria-current={d === p.day ? "date" : undefined}>
                  {d ?? ""}
                </span>
              )),
            ];
          })}
        </div>
      )}
    </div>
  );
}
