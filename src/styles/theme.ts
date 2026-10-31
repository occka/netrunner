/**
 * Centralised colour system. Every component reads colours from CSS custom
 * properties generated here; no component hardcodes a colour value.
 */

export const THEME_TOKENS = [
  "primary",
  "secondary",
  "background",
  "surface",
  "elevated",
  "border",
  "text",
  "muted",
  "success",
  "warning",
  "critical",
] as const;

export type ThemeToken = (typeof THEME_TOKENS)[number];
export type ThemeColors = Record<ThemeToken, string>;

export interface ThemePreset {
  id: string;
  name: string;
  colors: ThemeColors;
}

export const TOKEN_LABELS: Record<ThemeToken, string> = {
  primary: "Primary accent",
  secondary: "Secondary accent",
  background: "Background",
  surface: "Surface",
  elevated: "Elevated surface",
  border: "Borders",
  text: "Text",
  muted: "Muted text",
  success: "Success",
  warning: "Warning",
  critical: "Critical",
};

export const THEME_PRESETS: ThemePreset[] = [
  {
    id: "industrial",
    name: "Industrial (default)",
    colors: {
      primary: "#f2e94e",
      secondary: "#3fe0d0",
      background: "#0b0d10",
      surface: "#111419",
      elevated: "#171b21",
      border: "#262c35",
      text: "#d6dbe2",
      muted: "#7b8592",
      success: "#5fd38d",
      warning: "#ffb347",
      critical: "#ff4d5e",
    },
  },
  {
    id: "redline",
    name: "Redline",
    colors: {
      primary: "#ff3b4e",
      secondary: "#f2e94e",
      background: "#0c0a0b",
      surface: "#141011",
      elevated: "#1b1517",
      border: "#2f2427",
      text: "#e4d9da",
      muted: "#8d7b7e",
      success: "#5fd38d",
      warning: "#ffb347",
      critical: "#ff5470",
    },
  },
  {
    id: "coldwire",
    name: "Coldwire",
    colors: {
      primary: "#3fe0d0",
      secondary: "#7aa2ff",
      background: "#080c10",
      surface: "#0e141a",
      elevated: "#141c24",
      border: "#1f2b36",
      text: "#d3e1ea",
      muted: "#6f8796",
      success: "#56d68f",
      warning: "#ffc04d",
      critical: "#ff5468",
    },
  },
];

export const DEFAULT_THEME: ThemeColors = THEME_PRESETS[0].colors;

const HEX = /^#[0-9a-f]{6}$/i;

/** Merges a stored (possibly partial or corrupt) theme over the default. */
export function sanitizeTheme(input: unknown): ThemeColors {
  const out = { ...DEFAULT_THEME };
  if (input && typeof input === "object") {
    for (const token of THEME_TOKENS) {
      const value = (input as Record<string, unknown>)[token];
      if (typeof value === "string" && HEX.test(value)) out[token] = value.toLowerCase();
    }
  }
  return out;
}

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * Writes the theme to :root. Each token is exposed as `--c-<token>` and as an
 * `--c-<token>-rgb` triplet so styles can derive translucent variants with
 * `rgb(var(--c-primary-rgb) / 0.2)`.
 */
export function applyTheme(colors: ThemeColors, root: HTMLElement = document.documentElement) {
  for (const token of THEME_TOKENS) {
    root.style.setProperty(`--c-${token}`, colors[token]);
    root.style.setProperty(`--c-${token}-rgb`, hexToRgb(colors[token]).join(" "));
  }
}
