/**
 * Alarms, timers and what is ringing, shared by every Timer / Alarm widget
 * and the ringing window in this window. The backend owns the schedule; this
 * store reloads on its `alarms://changed` / `alarms://ringing` events.
 */
import { useEffect, useState } from "react";
import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import { api } from "@/services/api";
import type { AlarmsState, Sound } from "@/types/alarms";

interface AlarmStore {
  state: AlarmsState | null;
  /** Backend clock minus the page clock, so countdowns match the scheduler. */
  offset: number;
  sounds: Sound[];
  error: string | null;
  load: () => Promise<void>;
  loadSounds: () => Promise<void>;
}

export const useAlarms = create<AlarmStore>((set) => ({
  state: null,
  offset: 0,
  sounds: [],
  error: null,
  load: async () => {
    try {
      const state = await api.alarms.state();
      set({ state, offset: state.now - Date.now(), error: null });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    }
  },
  loadSounds: async () => {
    set({ sounds: await api.alarms.sounds() });
  },
}));

let listening = false;
export function listenForAlarms() {
  if (listening) return;
  listening = true;
  const reload = () => void useAlarms.getState().load();
  void listen("alarms://changed", reload);
  void listen("alarms://ringing", reload);
}

/** Backend "now", refreshed every `ms` while mounted. */
export function useNow(ms = 250): number {
  const offset = useAlarms((s) => s.offset);
  const [now, setNow] = useState(() => Date.now() + offset);
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now() + offset), ms);
    setNow(Date.now() + offset);
    return () => window.clearInterval(id);
  }, [ms, offset]);
  return now;
}

export const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function daysLabel(days: number): string {
  if (days === 0) return "Once";
  if (days === 127) return "Every day";
  if (days === 0b0011111) return "Weekdays";
  if (days === 0b1100000) return "Weekends";
  return DAY_NAMES.filter((_, i) => days & (1 << i)).join(", ");
}

/** 3725000 → "1:02:05", 65000 → "1:05". */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = h ? String(m).padStart(2, "0") : String(m);
  return `${h ? `${h}:` : ""}${mm}:${String(s).padStart(2, "0")}`;
}

/** "in 7 h 12 min" / "in 45 min" / "in 30 s". */
export function relative(ms: number): string {
  const min = Math.round(ms / 60000);
  if (ms < 60000) return `in ${Math.max(1, Math.round(ms / 1000))} s`;
  if (min < 60) return `in ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 48) return `in ${h} h${min % 60 ? ` ${min % 60} min` : ""}`;
  return `in ${Math.round(h / 24)} days`;
}

/** "5" (minutes), "4:30" (min:s), "1:30:00" (h:min:s) → ms. */
export function parseDuration(text: string): number | null {
  const parts = text.trim().split(":").map((p) => p.trim());
  if (!parts.length || parts.some((p) => !/^\d{1,3}$/.test(p)) || parts.length > 3) return null;
  const n = parts.map(Number);
  const s = n.length === 3 ? n[0] * 3600 + n[1] * 60 + n[2] : n.length === 2 ? n[0] * 60 + n[1] : n[0] * 60;
  return s > 0 ? s * 1000 : null;
}
