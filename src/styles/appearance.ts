/**
 * Appearance beyond colours: backgrounds (image or pattern) for the whole app
 * and for the dashboard, translucent "glass" panels, corner radius, font,
 * interface scale and visual effects. Stored as `appearance.*` settings and
 * applied as CSS variables / root attributes, like the theme.
 */
import { getCurrentWebview } from "@tauri-apps/api/webview";

export type BackgroundKind = "none" | "image" | "pattern";
export type BackgroundPattern =
  | "grid"
  | "dots"
  | "scanlines"
  | "aurora"
  | "circuit"
  | "matrix"
  | "neon-city"
  | "synthwave"
  | "glitch"
  | "hex"
  | "holo"
  | "crt";
export type BackgroundFit = "cover" | "contain" | "tile" | "center";

export interface BackgroundSpec {
  kind: BackgroundKind;
  /** Wallpaper file name from the wallpapers folder (see services/appearance.rs). */
  image: string;
  pattern: BackgroundPattern;
  /** Darkening over the image, 0–90 %. */
  dim: number;
  /** Blur of the image, 0–30 px. */
  blur: number;
  fit: BackgroundFit;
}

export const DEFAULT_BACKGROUND: BackgroundSpec = { kind: "none", image: "", pattern: "grid", dim: 45, blur: 0, fit: "cover" };

export const PATTERNS: { id: BackgroundPattern; label: string }[] = [
  { id: "grid", label: "Grid" },
  { id: "dots", label: "Dots" },
  { id: "scanlines", label: "Scanlines" },
  { id: "circuit", label: "Circuit" },
  { id: "aurora", label: "Aurora (animated)" },
  { id: "matrix", label: "Matrix rain (animated)" },
  { id: "neon-city", label: "Neon city" },
  { id: "synthwave", label: "Synthwave grid (animated)" },
  { id: "glitch", label: "Glitch (animated)" },
  { id: "hex", label: "Hex cells" },
  { id: "holo", label: "Holo (animated)" },
  { id: "crt", label: "CRT screen (animated)" },
];

export type UiFont = "plex" | "chakra" | "mono" | "system";
export const FONTS: { id: UiFont; label: string; css: string }[] = [
  { id: "plex", label: "IBM Plex Sans", css: '"IBM Plex Sans", "Segoe UI", sans-serif' },
  { id: "chakra", label: "Chakra Petch", css: '"Chakra Petch", "Segoe UI", sans-serif' },
  { id: "mono", label: "JetBrains Mono", css: '"JetBrains Mono", Consolas, monospace' },
  { id: "system", label: "Windows (Segoe UI)", css: '"Segoe UI", system-ui, sans-serif' },
];

const clamp = (v: unknown, min: number, max: number, d: number) =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : d;
const oneOf = <T extends string>(v: unknown, list: readonly T[], d: T): T => (list.includes(v as T) ? (v as T) : d);

export function sanitizeBackground(raw: unknown): BackgroundSpec {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    kind: oneOf(r.kind, ["none", "image", "pattern"] as const, "none"),
    image: typeof r.image === "string" && /^wp-[\w.-]+$/.test(r.image) ? r.image : "",
    pattern: oneOf(r.pattern, PATTERNS.map((p) => p.id), "grid"),
    dim: clamp(r.dim, 0, 90, DEFAULT_BACKGROUND.dim),
    blur: clamp(r.blur, 0, 30, 0),
    fit: oneOf(r.fit, ["cover", "contain", "tile", "center"] as const, "cover"),
  };
}

export function backgroundActive(b: BackgroundSpec): boolean {
  return b.kind === "pattern" || (b.kind === "image" && !!b.image);
}

export interface AppearanceValues {
  panelOpacity: number;
  panelBlur: number;
  radius: number;
  font: UiFont;
  scale: number;
  scanlines: boolean;
  glow: boolean;
  vignette: boolean;
}

let currentScale = 1;
/** Interface zoom of the main window; native browser views are positioned in unzoomed pixels. */
export function uiScale(): number {
  return currentScale;
}

export function applyAppearance(v: AppearanceValues, isOverlay = false) {
  const root = document.documentElement;
  root.style.setProperty("--panel-alpha", String(v.panelOpacity / 100));
  // `none` when unused: an idle backdrop-filter still costs a compositing layer per panel.
  root.style.setProperty("--panel-backdrop", v.panelBlur > 0 ? `blur(${v.panelBlur}px)` : "none");
  root.style.setProperty("--radius", `${v.radius}px`);
  root.style.setProperty("--font-body", FONTS.find((f) => f.id === v.font)?.css ?? FONTS[0].css);
  root.toggleAttribute("data-fx-scanlines", v.scanlines);
  root.toggleAttribute("data-fx-glow", v.glow);
  root.toggleAttribute("data-fx-vignette", v.vignette);
  const scale = isOverlay ? 1 : v.scale / 100;
  if (!isOverlay && scale !== currentScale) {
    currentScale = scale;
    void getCurrentWebview()
      .setZoom(scale)
      .catch(() => undefined);
  }
}
