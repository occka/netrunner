import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import { api } from "@/services/api";
import { reportError } from "@/stores/notifications";
import { useSettings, type BrowserSession } from "@/stores/settings";
import type { BrowserNotice, BrowserTab } from "@/types/browser";

/**
 * BROWSER tab state. Live tabs are native webviews in the backend (they
 * survive navigating to other modules); this store mirrors them from events.
 *
 * Tabs restored from the last session start as *sleeping* entries: shown in
 * the strip but without a webview until activated, so a restart does not load
 * (or start playing) every page at once. `order` is the strip order of both.
 * `activeId === null` shows the React start page instead of a webview.
 */
export interface SleepingTab {
  id: string;
  url: string;
  title: string;
}

/** A tab as the strip shows it. */
export type StripTab = BrowserTab & { sleeping?: boolean };

interface BrowserStore {
  tabs: BrowserTab[];
  sleeping: SleepingTab[];
  order: string[];
  activeId: string | null;
  /** Private mode for the next tab opened from the start page. */
  nextPrivate: boolean;
  notices: (BrowserNotice & { key: number })[];
  ready: boolean;
  init: () => Promise<void>;
  refresh: () => Promise<void>;
  activate: (id: string | null) => void;
  newTab: (isPrivate?: boolean) => void;
  open: (input: string) => Promise<void>;
  go: (input: string) => Promise<void>;
  close: (id: string) => Promise<void>;
  dismiss: (key: number) => void;
}

let noticeKey = 0;
let initialised = false;
const waking = new Set<string>();

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

/** Live tabs shown in the BROWSER module; overlays and popups host their own. */
export const mainTabs = (tabs: BrowserTab[]) => tabs.filter((t) => t.host === "main");

function sleeper(s: SleepingTab): StripTab {
  return {
    id: s.id,
    host: "main",
    url: s.url,
    title: s.title,
    loading: false,
    canBack: false,
    canForward: false,
    blocked: 0,
    private: false,
    muted: false,
    audible: false,
    fullscreen: false,
    favicon: null,
    sleeping: true,
  };
}

/** Live and sleeping tabs in strip order. */
export function stripTabs(s: Pick<BrowserStore, "tabs" | "sleeping" | "order">): StripTab[] {
  const live = new Map(mainTabs(s.tabs).map((t) => [t.id, t as StripTab]));
  const asleep = new Map(s.sleeping.map((t) => [t.id, sleeper(t)]));
  return s.order.map((id) => live.get(id) ?? asleep.get(id)).filter((t): t is StripTab => !!t);
}

/** Keeps known ids in place, drops vanished ones and appends new ones. */
function syncOrder(order: string[], tabs: BrowserTab[], sleeping: SleepingTab[]): string[] {
  const ids = new Set([...mainTabs(tabs).map((t) => t.id), ...sleeping.map((t) => t.id)]);
  const kept = order.filter((id) => ids.has(id));
  return [...kept, ...[...ids].filter((id) => !kept.includes(id))];
}

function upsert(list: BrowserTab[], tab: BrowserTab): BrowserTab[] {
  const i = list.findIndex((t) => t.id === tab.id);
  if (i < 0) return [...list, tab];
  const next = list.slice();
  next[i] = tab;
  return next;
}

/** What is written to `browser.session`: http(s) pages of non-private tabs, in strip order. */
export function sessionOf(s: Pick<BrowserStore, "tabs" | "sleeping" | "order" | "activeId">): BrowserSession {
  const saved = stripTabs(s).filter((t) => !t.private && /^https?:\/\//.test(t.url));
  return {
    tabs: saved.map((t) => ({ url: t.url, title: t.title })),
    active: Math.max(0, saved.findIndex((t) => t.id === s.activeId)),
  };
}

let saveTimer: number | undefined;
let lastSaved = "";
function scheduleSave(s: BrowserStore) {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    const settings = useSettings.getState();
    const session = settings.values["browser.restore_tabs"] ? sessionOf(s) : { tabs: [], active: 0 };
    const json = JSON.stringify(session);
    if (json === lastSaved) return;
    lastSaved = json;
    settings.set("browser.session", session).catch(() => undefined);
  }, 800);
}

export const useBrowser = create<BrowserStore>((set, get) => {
  /** Gives a sleeping tab its webview, in the same strip position. */
  const wake = async (id: string) => {
    const entry = get().sleeping.find((t) => t.id === id);
    if (!entry || waking.has(id)) return;
    waking.add(id);
    try {
      const tab = await api.browser.open(entry.url, false);
      set((s) => ({
        tabs: upsert(s.tabs, tab),
        sleeping: s.sleeping.filter((t) => t.id !== id),
        // The tab event may already have appended the new id; keep it only in the sleeper's place.
        order: s.order.filter((x) => x !== tab.id).map((x) => (x === id ? tab.id : x)),
        activeId: s.activeId === id ? tab.id : s.activeId,
      }));
    } catch (err) {
      reportError("Could not reopen the tab", err);
    } finally {
      waking.delete(id);
    }
  };

  return {
    tabs: [],
    sleeping: [],
    order: [],
    activeId: null,
    nextPrivate: false,
    notices: [],
    ready: false,
    init: async () => {
      if (initialised) return get().refresh();
      initialised = true;
      await Promise.all([
        listen<BrowserTab>("browser://tab", (e) =>
          set((s) => {
            const tabs = upsert(s.tabs, e.payload);
            const order = syncOrder(s.order, tabs, s.sleeping);
            // A tab moved to an overlay leaves the strip.
            const activeId = s.activeId === e.payload.id && e.payload.host !== "main" ? (order[0] ?? null) : s.activeId;
            return { tabs, order, activeId };
          }),
        ),
        listen<BrowserTab>("browser://opened", (e) =>
          set((s) => {
            const tabs = upsert(s.tabs, e.payload);
            return { tabs, order: syncOrder(s.order, tabs, s.sleeping) };
          }),
        ),
        listen<string>("browser://closed", (e) =>
          set((s) => {
            const tabs = s.tabs.filter((t) => t.id !== e.payload);
            const order = syncOrder(s.order, tabs, s.sleeping);
            const activeId = s.activeId === e.payload ? (order.at(-1) ?? null) : s.activeId;
            return { tabs, order, activeId, notices: s.notices.filter((n) => n.tab !== e.payload) };
          }),
        ),
        listen<BrowserNotice>("browser://notice", (e) =>
          set((s) => {
            // One notice per tab/kind/host: repeated permission prompts do not pile up.
            const rest = s.notices.filter((n) => !(n.tab === e.payload.tab && n.kind === e.payload.kind && n.host === e.payload.host));
            return { notices: [...rest, { ...e.payload, key: ++noticeKey }].slice(-20) };
          }),
        ),
      ]);
      await get().refresh();

      // Reopen the last session when nothing is open yet (first visit after a start).
      const settings = useSettings.getState().values;
      const session = settings["browser.session"];
      if (settings["browser.restore_tabs"] && mainTabs(get().tabs).length === 0 && session.tabs.length > 0) {
        const sleeping = session.tabs.map((t, i) => ({ id: `sleeping-${i}`, url: t.url, title: t.title }));
        const active = sleeping[Math.min(session.active, sleeping.length - 1)].id;
        set((s) => ({ sleeping, order: syncOrder(s.order, s.tabs, sleeping), activeId: active }));
        void wake(active);
      }
      lastSaved = JSON.stringify(settings["browser.session"]);
      set((s) => ({ ready: true, activeId: s.activeId ?? s.order.at(-1) ?? null }));
      useBrowser.subscribe((s) => scheduleSave(s));
    },
    refresh: async () => {
      const tabs = await api.browser.tabs();
      set((s) => {
        const order = syncOrder(s.order, tabs, s.sleeping);
        return {
          tabs,
          order,
          // `null` is the start page the user asked for; only a vanished tab falls back.
          activeId: s.activeId === null || order.includes(s.activeId) ? s.activeId : (order.at(-1) ?? null),
        };
      });
    },
    activate: (activeId) => {
      set({ activeId });
      if (activeId && get().sleeping.some((t) => t.id === activeId)) void wake(activeId);
    },
    newTab: (isPrivate = false) => set({ activeId: null, nextPrivate: isPrivate }),
    open: async (input) => {
      try {
        const tab = await api.browser.open(input, get().nextPrivate);
        set((s) => {
          const tabs = upsert(s.tabs, tab);
          return { tabs, order: syncOrder(s.order, tabs, s.sleeping), activeId: tab.id, nextPrivate: false };
        });
      } catch (err) {
        reportError("Could not open the page", err);
      }
    },
    go: async (input) => {
      const id = get().activeId;
      if (!id || get().sleeping.some((t) => t.id === id)) return get().open(input);
      try {
        await api.browser.navigate(id, input);
      } catch (err) {
        reportError("Could not open the page", err);
      }
    },
    close: async (id) => {
      const isSleeping = get().sleeping.some((t) => t.id === id);
      set((s) => {
        const i = s.order.indexOf(id);
        const order = s.order.filter((x) => x !== id);
        const next = order[i] ?? order[i - 1];
        return {
          tabs: s.tabs.filter((t) => t.id !== id),
          sleeping: s.sleeping.filter((t) => t.id !== id),
          order,
          activeId: s.activeId === id ? (next ?? null) : s.activeId,
        };
      });
      const active = get().activeId;
      if (active && get().sleeping.some((t) => t.id === active)) void wake(active);
      if (isSleeping) return;
      try {
        await api.browser.close(id);
      } catch (err) {
        reportError("Could not close the tab", err);
      }
    },
    dismiss: (key) => set((s) => ({ notices: s.notices.filter((n) => n.key !== key) })),
  };
});
