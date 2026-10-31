/**
 * Widget settings. A widget declares a schema of typed fields; the Inspector
 * (dashboard) and the OVERLAY module render a form from it, and the widget
 * receives the stored values merged over the defaults as `config`.
 *
 * Values live with the widget instance: `WidgetInstance.config` in a profile
 * layout, or `Overlay.config` for floating overlays. Unknown keys and values
 * that do not fit the schema are dropped when resolving, so old or hand-edited
 * data can never break a widget.
 */

interface Base<K extends string> {
  key: K;
  label: string;
  hint?: string;
  /** Group heading in the settings form. */
  group?: string;
  /** Shown only when another setting has the given value. */
  when?: { key: string; equals: string | number | boolean };
}

export interface ToggleSetting<K extends string = string> extends Base<K> {
  kind: "toggle";
  default: boolean;
}
export interface SelectSetting<K extends string = string, V extends string = string> extends Base<K> {
  kind: "select";
  options: readonly { value: V; label: string }[];
  default: V;
}
export interface RangeSetting<K extends string = string> extends Base<K> {
  kind: "range";
  min: number;
  max: number;
  step: number;
  unit?: string;
  default: number;
}
export interface TextSetting<K extends string = string> extends Base<K> {
  kind: "text";
  default: string;
  placeholder?: string;
  maxLength?: number;
}

/** An image from NETRUNNER's image library (services/appearance.rs); the value is its file name. */
export interface ImageSetting<K extends string = string> extends Base<K> {
  kind: "image";
  default: string;
}

export type WidgetSetting = ToggleSetting | SelectSetting | RangeSetting | TextSetting | ImageSetting;
export type WidgetSchema = readonly WidgetSetting[];

type ValueOf<S> = S extends { kind: "toggle" }
  ? boolean
  : S extends { kind: "range" }
    ? number
    : S extends { kind: "select"; options: readonly { value: infer V }[] }
      ? V
      : string;

/** Typed config object for a schema, e.g. `ConfigOf<typeof CLOCK_SETTINGS>`. */
export type ConfigOf<S extends WidgetSchema> = { [F in S[number] as F["key"]]: ValueOf<F> };

export type RawConfig = Record<string, unknown>;

/** Keeps literal types so `ConfigOf` can infer select values. */
export function defineSettings<const S extends WidgetSchema>(schema: S): S {
  return schema;
}

/** Settings every widget has: they control the frame, not the content. */
export const FRAME_SETTINGS = defineSettings([
  { key: "frame.title", kind: "text", label: "Title", default: "", placeholder: "Widget name", maxLength: 40, group: "Frame" },
  { key: "frame.header", kind: "toggle", label: "Show header", default: true, group: "Frame", hint: "The header always shows in EDIT LAYOUT." },
  { key: "frame.scale", kind: "range", label: "Content size", min: 70, max: 200, step: 5, unit: "%", default: 100, group: "Frame" },
  { key: "frame.transparent", kind: "toggle", label: "Transparent background", default: false, group: "Frame" },
  { key: "frame.accent", kind: "select", label: "Accent colour", group: "Frame", options: [
      { value: "theme", label: "Theme primary" },
      { value: "secondary", label: "Theme secondary" },
      { value: "success", label: "Green (success)" },
      { value: "warning", label: "Amber (warning)" },
      { value: "critical", label: "Red (critical)" },
    ], default: "theme" },
]);
export type FrameConfig = ConfigOf<typeof FRAME_SETTINGS>;

function coerceValue(field: WidgetSetting, value: unknown): unknown {
  switch (field.kind) {
    case "toggle":
      return typeof value === "boolean" ? value : field.default;
    case "select":
      return field.options.some((o) => o.value === value) ? value : field.default;
    case "range": {
      if (typeof value !== "number" || !Number.isFinite(value)) return field.default;
      const stepped = Math.round((value - field.min) / field.step) * field.step + field.min;
      return Math.min(field.max, Math.max(field.min, Number(stepped.toFixed(4))));
    }
    case "text":
      return typeof value === "string" ? value.slice(0, field.maxLength ?? 200) : field.default;
    case "image":
      return typeof value === "string" && /^wp-[\w.-]+$/.test(value) ? value : field.default;
  }
}

/** Stored values merged over defaults; anything invalid falls back to its default. */
export function resolveConfig<S extends WidgetSchema>(schema: S, raw: RawConfig | undefined): ConfigOf<S> {
  const out: RawConfig = {};
  for (const field of schema) out[field.key] = coerceValue(field, raw?.[field.key]);
  return out as ConfigOf<S>;
}

/**
 * Only values that differ from their defaults are stored, so changing a
 * default later reaches every widget that never touched that setting.
 */
export function compactConfig(schema: WidgetSchema, values: RawConfig): RawConfig {
  const out: RawConfig = {};
  for (const field of schema) {
    const v = coerceValue(field, values[field.key]);
    if (v !== field.default) out[field.key] = v;
  }
  return out;
}

export function isVisible(field: WidgetSetting, values: RawConfig): boolean {
  return !field.when || values[field.when.key] === field.when.equals;
}

// ---------- Per-widget schemas ----------
// Kept here (not in the lazy widget chunks) so the Inspector can render a
// form without loading the widget.

export const TIME_ZONES = [
  "UTC",
  "Europe/London",
  "Europe/Berlin",
  "Europe/Kyiv",
  "Europe/Moscow",
  "Europe/Istanbul",
  "Asia/Dubai",
  "Asia/Almaty",
  "Asia/Kolkata",
  "Asia/Bangkok",
  "Asia/Shanghai",
  "Asia/Seoul",
  "Asia/Tokyo",
  "Australia/Sydney",
  "Pacific/Auckland",
  "America/Sao_Paulo",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
] as const;

export const CLOCK_SETTINGS = defineSettings([
  {
    key: "hourCycle",
    kind: "select",
    label: "Time format",
    group: "Time",
    options: [
      { value: "system", label: "System default" },
      { value: "h24", label: "24-hour (18:30)" },
      { value: "h12", label: "12-hour (6:30 PM)" },
    ],
    default: "system",
  },
  { key: "seconds", kind: "select", label: "Seconds", group: "Time", options: [
      { value: "small", label: "Small, next to the time" },
      { value: "inline", label: "Same size (18:30:05)" },
      { value: "hidden", label: "Hidden" },
    ], default: "small" },
  { key: "leadingZero", kind: "toggle", label: "Leading zero in hours", group: "Time", default: true },
  { key: "fit", kind: "toggle", label: "Fit time to widget width", group: "Time", default: false, hint: "The time grows and shrinks with the widget." },
  { key: "timeSize", kind: "range", label: "Time size", group: "Time", min: 50, max: 400, step: 10, unit: "%", default: 100, when: { key: "fit", equals: false } },
  {
    key: "timeZone",
    kind: "select",
    label: "Time zone",
    group: "Time",
    options: [{ value: "local", label: "This computer" }, ...TIME_ZONES.map((z) => ({ value: z, label: z.replace(/_/g, " ") }))],
    default: "local",
  },
  { key: "showZone", kind: "toggle", label: "Show time zone name", group: "Time", default: false },
  { key: "date", kind: "select", label: "Date", group: "Date", options: [
      { value: "long", label: "Friday, 31 October 2026" },
      { value: "medium", label: "Fri, 31 Oct 2026" },
      { value: "numeric", label: "31.10.2026 (locale order)" },
      { value: "iso", label: "2026-10-31" },
      { value: "hidden", label: "Hidden" },
    ], default: "long" },
  { key: "calendar", kind: "toggle", label: "Month calendar", group: "Date", default: true },
  { key: "weekStart", kind: "select", label: "Week starts on", group: "Date", options: [
      { value: "monday", label: "Monday" },
      { value: "sunday", label: "Sunday" },
    ], default: "monday", when: { key: "calendar", equals: true } },
  { key: "weekNumbers", kind: "toggle", label: "ISO week numbers", group: "Date", default: false, when: { key: "calendar", equals: true } },
  { key: "align", kind: "select", label: "Alignment", group: "Layout", options: [
      { value: "start", label: "Left" },
      { value: "center", label: "Center" },
    ], default: "start" },
]);

export const CPU_SETTINGS = defineSettings([
  { key: "graph", kind: "toggle", label: "Usage history graph", default: true },
  { key: "cores", kind: "toggle", label: "Per-core bars", default: true },
  { key: "frequency", kind: "toggle", label: "Reported frequency", default: true },
]);

export const GPU_SETTINGS = defineSettings([
  { key: "graph", kind: "toggle", label: "Usage history graph", default: true },
  { key: "memory", kind: "toggle", label: "Dedicated memory", default: true },
]);

export const RAM_SETTINGS = defineSettings([
  { key: "graph", kind: "toggle", label: "Usage history graph", default: true },
  { key: "pagefile", kind: "toggle", label: "Page file", default: true },
]);

export const STORAGE_SETTINGS = defineSettings([
  { key: "removable", kind: "toggle", label: "Show removable drives", default: true },
  { key: "details", kind: "toggle", label: "File system and type tags", default: true },
  { key: "sort", kind: "select", label: "Order", options: [
      { value: "mount", label: "Drive letter" },
      { value: "used", label: "Most used first" },
      { value: "free", label: "Least free space first" },
    ], default: "mount" },
]);

export const NETWORK_SETTINGS = defineSettings([
  { key: "graph", kind: "toggle", label: "Download history graph", default: true },
  { key: "adapters", kind: "range", label: "Adapters listed", min: 0, max: 8, step: 1, default: 4 },
  { key: "activeOnly", kind: "toggle", label: "Only adapters with an address", default: false },
  { key: "connectivity", kind: "toggle", label: "Connectivity and VPN line", default: true },
]);

export const TASKS_SETTINGS = defineSettings([
  { key: "count", kind: "range", label: "Processes shown", min: 3, max: 30, step: 1, default: 12 },
  { key: "sort", kind: "select", label: "Sort by", options: [
      { value: "cpu", label: "CPU" },
      { value: "memory", label: "Memory" },
    ], default: "cpu" },
  { key: "pid", kind: "toggle", label: "PID column", default: true },
]);

export const ACTIVITY_SETTINGS = defineSettings([
  { key: "level", kind: "select", label: "Show", options: [
      { value: "all", label: "Everything" },
      { value: "warn", label: "Warnings and errors" },
      { value: "error", label: "Errors only" },
    ], default: "all" },
  { key: "limit", kind: "range", label: "Entries", min: 5, max: 200, step: 5, default: 60 },
  { key: "source", kind: "toggle", label: "Source column", default: true },
]);

export const QUICK_ACCESS_SETTINGS = defineSettings([
  { key: "filter", kind: "select", label: "Entries", options: [
      { value: "all", label: "All" },
      { value: "favorites", label: "Favorites only" },
      { value: "category", label: "One category" },
    ], default: "all" },
  { key: "category", kind: "text", label: "Category", default: "", placeholder: "Exact category name", when: { key: "filter", equals: "category" } },
  { key: "tile", kind: "range", label: "Tile width", min: 70, max: 180, step: 5, unit: "px", default: 92 },
  { key: "addButton", kind: "toggle", label: "Add button", default: true },
]);

export const SYSTEM_OVERVIEW_SETTINGS = defineSettings([
  { key: "sensors", kind: "toggle", label: "Sensors section", default: true },
  { key: "io", kind: "toggle", label: "Disk throughput", default: true },
]);

export const MUSIC_SETTINGS = defineSettings([
  { key: "sources", kind: "select", label: "Players", options: [
      { value: "netrunner-first", label: "NETRUNNER first, music sites first" },
      { value: "netrunner-only", label: "Only NETRUNNER tabs and overlays" },
      { value: "any", label: "Any app, follow what plays" },
    ], default: "netrunner-first", hint: "The player stays on its track when paused; it only moves to a higher-priority player that starts playing." },
  { key: "art", kind: "toggle", label: "Album art", default: true },
  { key: "progress", kind: "toggle", label: "Progress bar", default: true },
  { key: "source", kind: "toggle", label: "Source app name", default: true },
  { key: "layout", kind: "select", label: "Layout", options: [
      { value: "row", label: "Art beside text" },
      { value: "stack", label: "Art above text" },
    ], default: "row" },
]);

export const IMAGE_SETTINGS = defineSettings([
  { key: "image", kind: "image", label: "Picture", default: "" },
  { key: "fit", kind: "select", label: "Fit", options: [
      { value: "cover", label: "Fill the widget (crop)" },
      { value: "contain", label: "Show whole picture" },
    ], default: "cover" },
  { key: "position", kind: "select", label: "Focus", options: [
      { value: "center", label: "Centre" },
      { value: "top", label: "Top" },
      { value: "bottom", label: "Bottom" },
      { value: "left", label: "Left" },
      { value: "right", label: "Right" },
    ], default: "center", when: { key: "fit", equals: "cover" } },
  { key: "bleed", kind: "toggle", label: "Edge to edge (no padding)", default: true },
  { key: "opacity", kind: "range", label: "Opacity", min: 10, max: 100, step: 5, unit: "%", default: 100 },
  { key: "caption", kind: "text", label: "Caption", default: "", placeholder: "Optional text over the picture", maxLength: 80 },
]);
