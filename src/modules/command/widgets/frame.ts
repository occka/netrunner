import type { CSSProperties } from "react";
import type { RawConfig } from "./settings";

/** CSS for the frame settings shared by dashboard widgets and overlays. */
export function frameStyle(config: RawConfig): CSSProperties | undefined {
  const style: Record<string, string | number> = {};
  const scale = (config["frame.scale"] as number) / 100;
  // `zoom` scales text, icons and fixed pixel sizes together (Chromium/WebView2).
  if (scale !== 1) style.zoom = scale;
  return Object.keys(style).length ? (style as CSSProperties) : undefined;
}

/** Re-points the widget's primary colour at another theme token. */
export function accentStyle(config: RawConfig): CSSProperties | undefined {
  const accent = config["frame.accent"] as string;
  if (!accent || accent === "theme") return undefined;
  return { ["--c-primary" as string]: `var(--c-${accent})`, ["--c-primary-rgb" as string]: `var(--c-${accent}-rgb)` } as CSSProperties;
}
