const UNITS = ["B", "KB", "MB", "GB", "TB", "PB"];

/** Binary byte formatting (1 KB = 1024 B), as Windows Explorer displays sizes. */
export function formatBytes(bytes: number | null | undefined, digits = 1): string {
  if (bytes == null || !Number.isFinite(bytes)) return "—";
  let value = Math.abs(bytes);
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  const shown = unit === 0 ? value.toFixed(0) : value.toFixed(value >= 100 ? 0 : digits);
  return `${bytes < 0 ? "-" : ""}${shown} ${UNITS[unit]}`;
}

export function formatRate(bytesPerSec: number | null | undefined): string {
  if (bytesPerSec == null) return "—";
  return `${formatBytes(bytesPerSec)}/s`;
}

export function formatPercent(value: number | null | undefined, digits = 0): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${value.toFixed(digits)}%`;
}

export function formatDuration(totalSecs: number): string {
  const d = Math.floor(totalSecs / 86400);
  const h = Math.floor((totalSecs % 86400) / 3600);
  const m = Math.floor((totalSecs % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export function formatClock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/** SQLite `datetime('now')` values are UTC without a zone suffix. */
export function parseDbTime(value: string | null | undefined): Date | null {
  if (!value) return null;
  const iso = value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatRelative(date: Date | null, now = Date.now()): string {
  if (!date) return "never";
  const secs = Math.round((now - date.getTime()) / 1000);
  if (secs < 45) return "just now";
  if (secs < 3600) return `${Math.round(secs / 60)} min ago`;
  if (secs < 86400) return `${Math.round(secs / 3600)} h ago`;
  return date.toLocaleDateString();
}

export function levelFor(percent: number | null | undefined, warn = 75, crit = 90): "ok" | "warn" | "crit" {
  if (percent == null) return "ok";
  return percent >= crit ? "crit" : percent >= warn ? "warn" : "ok";
}
