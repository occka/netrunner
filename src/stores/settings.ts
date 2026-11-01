import { useEffect } from "react";
import { create } from "zustand";
import { api } from "@/services/api";
import { DEFAULT_THEME, sanitizeTheme, type ThemeColors } from "@/styles/theme";
import { applyAppearance, DEFAULT_BACKGROUND, FONTS, sanitizeBackground, type BackgroundSpec, type UiFont } from "@/styles/appearance";

/** Open BROWSER tabs, saved so they come back after a restart (never private tabs). */
export interface BrowserSession {
  tabs: { url: string; title: string }[];
  active: number;
}

function sanitizeSession(raw: unknown): BrowserSession {
  const r = (raw && typeof raw === "object" ? raw : {}) as { tabs?: unknown; active?: unknown };
  const tabs = (Array.isArray(r.tabs) ? r.tabs : [])
    .filter((t): t is { url: string; title?: unknown } => !!t && typeof (t as { url?: unknown }).url === "string")
    .filter((t) => /^https?:\/\//.test(t.url) && t.url.length <= 4096)
    .slice(0, 40)
    .map((t) => ({ url: t.url, title: typeof t.title === "string" ? t.title.slice(0, 300) : "" }));
  const active = typeof r.active === "number" && Number.isInteger(r.active) ? Math.min(Math.max(0, r.active), Math.max(0, tabs.length - 1)) : 0;
  return { tabs, active };
}

/** Every persisted setting with its default. Keys follow `area.name`. */
export interface SettingsSchema {
  theme: ThemeColors;
  "nav.pinned": boolean;
  "inspector.visible": boolean;
  "inspector.width": number;
  "monitor.interval_ms": number;
  "ui.motion": "system" | "reduced" | "full";
  /** Read by the backend: closing the window hides it to the tray. */
  "app.close_to_tray": boolean;
  /** Read by the backend: when started by Windows, stay in the tray. */
  "app.start_minimized": boolean;
  /** Check GitHub releases for an update at startup. */
  "app.update_check": boolean;
  "games.view": "list" | "banners";
  "games.sort": "name" | "playtime" | "recent" | "launcher";
  "games.period": "today" | "week" | "month" | "all";
  /** Read by the backend (overlay_snap.rs): overlays stick to screen edges and to each other. */
  "overlay.snap": boolean;
  // BROWSER: read by the backend (browser/mod.rs `Prefs`). Changing one reloads them.
  "browser.adblock": boolean;
  "browser.cosmetic": boolean;
  "browser.https_only": boolean;
  "browser.gpc": boolean;
  "browser.tracking": "strict" | "balanced" | "basic";
  "browser.history": boolean;
  "browser.autofill": boolean;
  "browser.search": string;
  "browser.adblock_lists": string[];
  "browser.adblock_exceptions": string[];
  /** Applies to tabs opened after a NETRUNNER restart (WebView2 environment option). */
  "browser.webrtc_protect": boolean;
  /** Applies after restart. Loads unpacked extensions from the extensions folder. */
  "browser.extensions": boolean;
  "browser.home": string;
  /** Reopen the tabs of the last session when BROWSER is first opened. */
  "browser.restore_tabs": boolean;
  "browser.session": BrowserSession;
  // Appearance (styles/appearance.ts).
  "appearance.background": BackgroundSpec;
  "appearance.dashboard_background": BackgroundSpec;
  /** Panel and chrome opacity in %, so a background shows through. */
  "appearance.panel_opacity": number;
  "appearance.panel_blur": number;
  "appearance.radius": number;
  "appearance.font": UiFont;
  /** Interface zoom of the main window in %. */
  "appearance.scale": number;
  "appearance.scanlines": boolean;
  "appearance.glow": boolean;
  "appearance.vignette": boolean;
}

export const SETTINGS_DEFAULTS: SettingsSchema = {
  theme: DEFAULT_THEME,
  "nav.pinned": false,
  "inspector.visible": true,
  "inspector.width": 300,
  "monitor.interval_ms": 1500,
  // Windows' "Animation effects" is often switched off for performance, not
  // preference, so NETRUNNER animates unless asked otherwise.
  "ui.motion": "full",
  "app.close_to_tray": true,
  "app.start_minimized": true,
  "app.update_check": true,
  "overlay.snap": true,
  "games.view": "list",
  "games.sort": "name",
  "games.period": "week",
  "browser.adblock": true,
  "browser.cosmetic": true,
  "browser.https_only": true,
  "browser.gpc": true,
  "browser.tracking": "strict",
  "browser.history": true,
  "browser.autofill": false,
  "browser.search": "duckduckgo",
  "browser.adblock_lists": ["easylist", "easyprivacy", "ublock", "ublock-privacy", "ublock-badware", "peterlowe", "ruadlist"],
  "browser.adblock_exceptions": [],
  "browser.webrtc_protect": true,
  "browser.extensions": false,
  "browser.home": "",
  "browser.restore_tabs": true,
  "browser.session": { tabs: [], active: 0 },
  "appearance.background": DEFAULT_BACKGROUND,
  "appearance.dashboard_background": DEFAULT_BACKGROUND,
  "appearance.panel_opacity": 100,
  "appearance.panel_blur": 0,
  "appearance.radius": 2,
  "appearance.font": "plex",
  "appearance.scale": 100,
  "appearance.scanlines": false,
  "appearance.glow": false,
  "appearance.vignette": false,
};

export type SettingKey = keyof SettingsSchema;

interface SettingsStore {
  values: SettingsSchema;
  loaded: boolean;
  load: () => Promise<void>;
  set: <K extends SettingKey>(key: K, value: SettingsSchema[K]) => Promise<void>;
  /** Applies immediately and persists once the value stops changing (e.g. colour pickers). */
  setDebounced: <K extends SettingKey>(key: K, value: SettingsSchema[K]) => void;
}

const pending = new Map<SettingKey, number>();

function coerce(raw: Record<string, unknown>): SettingsSchema {
  const values = { ...SETTINGS_DEFAULTS };
  for (const key of Object.keys(SETTINGS_DEFAULTS) as SettingKey[]) {
    if (!(key in raw)) continue;
    const value = raw[key];
    if (key === "theme") {
      values.theme = sanitizeTheme(value);
    } else if (typeof value === typeof SETTINGS_DEFAULTS[key]) {
      (values as Record<string, unknown>)[key] = value;
    }
  }
  values["monitor.interval_ms"] = Math.min(10000, Math.max(500, values["monitor.interval_ms"]));
  values["browser.session"] = sanitizeSession(values["browser.session"]);
  values["appearance.background"] = sanitizeBackground(values["appearance.background"]);
  values["appearance.dashboard_background"] = sanitizeBackground(values["appearance.dashboard_background"]);
  values["appearance.panel_opacity"] = Math.min(100, Math.max(30, values["appearance.panel_opacity"]));
  values["appearance.panel_blur"] = Math.min(24, Math.max(0, values["appearance.panel_blur"]));
  values["appearance.radius"] = Math.min(16, Math.max(0, values["appearance.radius"]));
  values["appearance.scale"] = Math.min(150, Math.max(70, values["appearance.scale"]));
  if (!FONTS.some((f) => f.id === values["appearance.font"])) values["appearance.font"] = "plex";
  values["inspector.width"] = Math.min(520, Math.max(240, values["inspector.width"]));
  return values;
}

export const useSettings = create<SettingsStore>((set, get) => ({
  values: SETTINGS_DEFAULTS,
  loaded: false,
  load: async () => {
    const raw = await api.settings.getAll();
    set({ values: coerce(raw), loaded: true });
  },
  // Optimistic: the UI updates immediately; a failed write is rolled back.
  set: async (key, value) => {
    const previous = get().values[key];
    set((s) => ({ values: { ...s.values, [key]: value } }));
    try {
      await api.settings.set(key, value);
    } catch (err) {
      set((s) => ({ values: { ...s.values, [key]: previous } }));
      throw err;
    }
  },
  setDebounced: (key, value) => {
    set((s) => ({ values: { ...s.values, [key]: value } }));
    window.clearTimeout(pending.get(key));
    pending.set(
      key,
      window.setTimeout(() => {
        pending.delete(key);
        api.settings.set(key, get().values[key]).catch((err) => console.error(`failed to persist ${key}`, err));
      }, 400),
    );
  },
}));

export function useSetting<K extends SettingKey>(key: K): SettingsSchema[K] {
  return useSettings((s) => s.values[key]);
}

/** Applies the `appearance.*` settings (main window and overlays). */
export function useAppearance(isOverlay = false) {
  const v = useSettings((s) => s.values);
  useEffect(
    () =>
      applyAppearance(
        {
          panelOpacity: v["appearance.panel_opacity"],
          panelBlur: v["appearance.panel_blur"],
          radius: v["appearance.radius"],
          font: v["appearance.font"],
          scale: v["appearance.scale"],
          scanlines: v["appearance.scanlines"],
          glow: v["appearance.glow"],
          vignette: v["appearance.vignette"],
        },
        isOverlay,
      ),
    [v, isOverlay],
  );
}
