import { create } from "zustand";
import { api } from "@/services/api";
import { refreshActivity } from "@/stores/activity";
import { reportError } from "@/stores/notifications";
import type { DashboardLayout, Profile } from "@/types/entities";

interface ProfilesStore {
  profiles: Profile[];
  activeId: number | null;
  loaded: boolean;
  load: () => Promise<void>;
  activate: (id: number) => Promise<void>;
  create: (name: string, copyFrom?: number) => Promise<Profile>;
  rename: (id: number, name: string) => Promise<void>;
  remove: (id: number) => Promise<void>;
  saveLayout: (id: number, layout: DashboardLayout) => Promise<void>;
  /** Applies at once and persists after the value settles (sliders send many changes). */
  setWidgetConfig: (id: number, widgetId: string, config: Record<string, unknown>) => void;
}

const pendingConfig = new Map<string, number>();

function replace(list: Profile[], profile: Profile) {
  return list.map((p) => (p.id === profile.id ? profile : p));
}

export const useProfiles = create<ProfilesStore>((set, get) => ({
  profiles: [],
  activeId: null,
  loaded: false,
  load: async () => {
    const state = await api.profiles.state();
    set({ profiles: state.profiles, activeId: state.activeId, loaded: true });
  },
  activate: async (id) => {
    const profile = await api.profiles.activate(id);
    set((s) => ({ activeId: profile.id, profiles: replace(s.profiles, profile) }));
    refreshActivity();
  },
  create: async (name, copyFrom) => {
    const profile = await api.profiles.create(name, copyFrom);
    set((s) => ({ profiles: [...s.profiles, profile] }));
    refreshActivity();
    return profile;
  },
  rename: async (id, name) => {
    const profile = await api.profiles.rename(id, name);
    set((s) => ({ profiles: replace(s.profiles, profile) }));
  },
  remove: async (id) => {
    await api.profiles.remove(id);
    set((s) => ({ profiles: s.profiles.filter((p) => p.id !== id) }));
    refreshActivity();
  },
  saveLayout: async (id, layout) => {
    const profile = await api.profiles.saveLayout(id, layout);
    set((s) => ({ profiles: replace(s.profiles, profile) }));
    refreshActivity();
  },
  setWidgetConfig: (id, widgetId, config) => {
    const profile = get().profiles.find((p) => p.id === id);
    if (!profile) return;
    const widgets = profile.layout.widgets.map((w) => (w.id === widgetId ? { ...w, config } : w));
    set((s) => ({ profiles: replace(s.profiles, { ...profile, layout: { ...profile.layout, widgets } }) }));
    const key = `${id}:${widgetId}`;
    window.clearTimeout(pendingConfig.get(key));
    pendingConfig.set(
      key,
      window.setTimeout(() => {
        pendingConfig.delete(key);
        api.profiles.setWidgetConfig(id, widgetId, config).catch((err) => reportError("Could not save widget settings", err));
      }, 400),
    );
  },
}));

export function useActiveProfile(): Profile | undefined {
  return useProfiles((s) => s.profiles.find((p) => p.id === s.activeId));
}

export const PROFILE_KIND_LABEL: Record<Profile["kind"], string> = {
  default: "Default",
  development: "Development",
  gaming: "Gaming",
  media: "Media",
  custom: "Custom",
};
