import { create } from "zustand";
import { api } from "@/services/api";
import { refreshActivity } from "@/stores/activity";
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
}

function replace(list: Profile[], profile: Profile) {
  return list.map((p) => (p.id === profile.id ? profile : p));
}

export const useProfiles = create<ProfilesStore>((set) => ({
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
