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
  },  {
    id: "matrix",
    name: "Matrix",
    colors: {
      primary: "#00ff66",
      secondary: "#7dffb0",
      background: "#020a04",
      surface: "#06120a",
      elevated: "#0a1a0f",
      border: "#12301c",
      text: "#b8f5c8",
      muted: "#4f8a5f",
      success: "#39ff88",
      warning: "#d4ff4a",
      critical: "#ff4d5e",
    },
  },
  {
    id: "neon-city",
    name: "Neon City",
    colors: {
      primary: "#ff2bd6",
      secondary: "#00e5ff",
      background: "#0a0612",
      surface: "#120a1c",
      elevated: "#1a1026",
      border: "#2e1d42",
      text: "#e8dcf5",
      muted: "#8a78a3",
      success: "#3dffa8",
      warning: "#ffb347",
      critical: "#ff3b6b",
    },
  },
  {
    id: "synthwave",
    name: "Synthwave",
    colors: {
      primary: "#ff7edb",
      secondary: "#fede5d",
      background: "#120b1f",
      surface: "#1b1030",
      elevated: "#241540",
      border: "#3a2460",
      text: "#f0e4ff",
      muted: "#9a86b8",
      success: "#72f1b8",
      warning: "#fe9e4c",
      critical: "#fe4450",
    },
  },
  {
    id: "glitch",
    name: "Glitch",
    colors: {
      primary: "#ff0055",
      secondary: "#00fff0",
      background: "#08080a",
      surface: "#101014",
      elevated: "#17171d",
      border: "#2a2a33",
      text: "#e6e6ee",
      muted: "#7c7c8c",
      success: "#3dff9a",
      warning: "#ffd23f",
      critical: "#ff2e4d",
    },
  },
  {
    id: "hex",
    name: "Hex (honeycomb)",
    colors: {
      primary: "#ffb000",
      secondary: "#ff6a00",
      background: "#0d0a05",
      surface: "#151008",
      elevated: "#1d170c",
      border: "#352914",
      text: "#f2e2c2",
      muted: "#9a8460",
      success: "#8fd16a",
      warning: "#ffcc33",
      critical: "#ff5040",
    },
  },
  {
    id: "holo",
    name: "Holo",
    colors: {
      primary: "#7df9ff",
      secondary: "#c58bff",
      background: "#070b12",
      surface: "#0d1420",
      elevated: "#131c2c",
      border: "#23324a",
      text: "#dceeff",
      muted: "#7890ad",
      success: "#6dffc5",
      warning: "#ffd27a",
      critical: "#ff6b8a",
    },
  },
  {
    id: "crt-green",
    name: "CRT Green",
    colors: {
      primary: "#33ff33",
      secondary: "#99ff66",
      background: "#020702",
      surface: "#061006",
      elevated: "#0a170a",
      border: "#163016",
      text: "#7dff7d",
      muted: "#3f8f3f",
      success: "#33ff33",
      warning: "#ccff33",
      critical: "#ff5533",
    },
  },
  {
    id: "crt-amber",
    name: "CRT Amber",
    colors: {
      primary: "#ffb000",
      secondary: "#ffd060",
      background: "#0a0600",
      surface: "#130c02",
      elevated: "#1b1205",
      border: "#33230a",
      text: "#ffc24d",
      muted: "#9a7430",
      success: "#c8e060",
      warning: "#ffd060",
      critical: "#ff5a30",
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
