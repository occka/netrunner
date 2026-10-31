import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import { api } from "@/services/api";
import { reportError } from "@/stores/notifications";
import type { BrowserNotice, BrowserTab } from "@/types/browser";

/**
 * BROWSER tab state. Tabs live in the backend (native webviews survive
 * navigating to other modules); this store mirrors them from events.
 * `activeId === null` shows the React start page instead of a webview.
 */
interface BrowserStore {
  tabs: BrowserTab[];
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

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

/** Tabs shown in the BROWSER module; overlays and popups host their own. */
export const mainTabs = (tabs: BrowserTab[]) => tabs.filter((t) => t.host === "main");

function upsert(list: BrowserTab[], tab: BrowserTab): BrowserTab[] {
  const i = list.findIndex((t) => t.id === tab.id);
  if (i < 0) return [...list, tab];
  const next = list.slice();
  next[i] = tab;
  return next;
}

export const useBrowser = create<BrowserStore>((set, get) => ({
  tabs: [],
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
          // A tab moved to an overlay leaves the strip.
          const activeId = s.activeId === e.payload.id && e.payload.host !== "main" ? (mainTabs(tabs)[0]?.id ?? null) : s.activeId;
          return { tabs, activeId };
        }),
      ),
      listen<BrowserTab>("browser://opened", (e) => set((s) => ({ tabs: upsert(s.tabs, e.payload) }))),
      listen<string>("browser://closed", (e) =>
        set((s) => {
          const tabs = s.tabs.filter((t) => t.id !== e.payload);
          const activeId = s.activeId === e.payload ? (mainTabs(tabs).at(-1)?.id ?? null) : s.activeId;
          return { tabs, activeId, notices: s.notices.filter((n) => n.tab !== e.payload) };
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
    // First visit: show the most recent tab rather than the start page.
    set((s) => ({ ready: true, activeId: s.activeId ?? mainTabs(s.tabs).at(-1)?.id ?? null }));
  },
  refresh: async () => {
    const tabs = await api.browser.tabs();
    set((s) => ({
      tabs,
      // `null` is the start page the user asked for; only a vanished tab falls back.
      activeId:
        s.activeId === null || tabs.some((t) => t.id === s.activeId && t.host === "main")
          ? s.activeId
          : (mainTabs(tabs).at(-1)?.id ?? null),
    }));
  },
  activate: (activeId) => set({ activeId }),
  newTab: (isPrivate = false) => set({ activeId: null, nextPrivate: isPrivate }),
  open: async (input) => {
    try {
      const tab = await api.browser.open(input, get().nextPrivate);
      set((s) => ({ tabs: upsert(s.tabs, tab), activeId: tab.id, nextPrivate: false }));
    } catch (err) {
      reportError("Could not open the page", err);
    }
  },
  go: async (input) => {
    const id = get().activeId;
    if (!id) return get().open(input);
    try {
      await api.browser.navigate(id, input);
    } catch (err) {
      reportError("Could not open the page", err);
    }
  },
  close: async (id) => {
    set((s) => {
      const tabs = s.tabs.filter((t) => t.id !== id);
      const order = mainTabs(s.tabs);
      const i = order.findIndex((t) => t.id === id);
      const next = order[i + 1] ?? order[i - 1];
      return { tabs, activeId: s.activeId === id ? (next?.id ?? null) : s.activeId };
    });
    try {
      await api.browser.close(id);
    } catch (err) {
      reportError("Could not close the tab", err);
    }
  },
  dismiss: (key) => set((s) => ({ notices: s.notices.filter((n) => n.key !== key) })),
}));
