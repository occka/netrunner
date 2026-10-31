import { create } from "zustand";
import { api } from "@/services/api";
import { DEFAULT_THEME, sanitizeTheme, type ThemeColors } from "@/styles/theme";

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
}

export const SETTINGS_DEFAULTS: SettingsSchema = {
  theme: DEFAULT_THEME,
  "nav.pinned": false,
  "inspector.visible": true,
  "inspector.width": 300,
  "monitor.interval_ms": 1500,
  "ui.motion": "system",
  "app.close_to_tray": true,
  "app.start_minimized": true,
  "app.update_check": true,
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
