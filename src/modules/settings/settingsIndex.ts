/** Searchable settings sections (used by the command palette). */
export const SETTINGS_SECTIONS = [
  { id: "theme", title: "Theme colors", keywords: ["palette", "accent", "color", "colour", "appearance", "theme"] },
  {
    id: "appearance",
    title: "Appearance: backgrounds, glass, font, scale",
    keywords: ["wallpaper", "background", "image", "picture", "обои", "фон", "glass", "transparency", "blur", "font", "scale", "zoom", "glow", "scanlines", "customize"],
  },
  {
    id: "monitoring",
    title: "System monitoring interval",
    keywords: ["metrics", "polling", "refresh", "cpu", "temperature", "performance"],
  },
  { id: "interface", title: "Interface & motion", keywords: ["animation", "reduced motion", "navigation", "inspector", "sidebar"] },
  { id: "startup", title: "Startup & tray", keywords: ["autostart", "windows startup", "tray", "background"] },
] as const;

export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]["id"];
