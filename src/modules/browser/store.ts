import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import { api } from "@/services/api";
import { reportError } from "@/stores/notifications";
import { useSettings, type BrowserSession, type BrowserTabGroup } from "@/stores/settings";
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

export interface ClosedTab {
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
  /** Recently closed tabs of this run, newest first. Private tabs are never kept. */
  closed: ClosedTab[];
  groups: BrowserTabGroup[];
  /** Tab id to group id. */
  members: Record<string, string>;
  notices: (BrowserNotice & { key: number })[];
  ready: boolean;
  init: () => Promise<void>;
  refresh: () => Promise<void>;
  activate: (id: string | null) => void;
  newTab: (isPrivate?: boolean) => void;
  open: (input: string) => Promise<void>;
  go: (input: string) => Promise<void>;
  close: (id: string) => Promise<void>;
  /** Opens the most recently closed tab again, or the given one. */
  reopen: (index?: number) => Promise<void>;
  /** A new group, with this tab in it. */
  addGroup: (name: string, tabId: string) => void;
  setGroup: (tabId: string, groupId: string | null) => void;
  renameGroup: (groupId: string, name: string) => void;
  toggleGroup: (groupId: string) => void;
  /** Ends the group; its tabs stay open. */
  removeGroup: (groupId: string) => void;
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
    zoom: 1,
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

const GROUP_COLORS = ["#4f9cf9", "#3ecf8e", "#f5a623", "#e5484d", "#b07cf0", "#27c5d6"];

/** A group with no tabs left does not stay. */
function pruneGroups<T extends Pick<BrowserStore, "groups" | "members">>(s: T): BrowserTabGroup[] {
  const used = new Set(Object.values(s.members));
  return s.groups.filter((g) => used.has(g.id));
}

export type StripItem = { kind: "group"; group: BrowserTabGroup; count: number } | { kind: "tab"; tab: StripTab; group: BrowserTabGroup | null };

/**
 * What the strip draws: a group's tabs together, at the place of its first tab,
 * after its label. A collapsed group shows only its active tab.
 */
export function stripItems(tabs: StripTab[], groups: BrowserTabGroup[], members: Record<string, string>, activeId: string | null): StripItem[] {
  const out: StripItem[] = [];
  const done = new Set<string>();
  const groupOf = (t: StripTab) => groups.find((g) => g.id === members[t.id]) ?? null;
  for (const tab of tabs) {
    const group = groupOf(tab);
    if (!group) {
      out.push({ kind: "tab", tab, group: null });
    } else if (!done.has(group.id)) {
      done.add(group.id);
      const inGroup = tabs.filter((t) => members[t.id] === group.id);
      out.push({ kind: "group", group, count: inGroup.length });
      for (const t of inGroup) if (!group.collapsed || t.id === activeId) out.push({ kind: "tab", tab: t, group });
    }
  }
  return out;
}

/** What is written to `browser.session`: http(s) pages of non-private tabs, in strip order. */
export function sessionOf(s: Pick<BrowserStore, "tabs" | "sleeping" | "order" | "activeId"> & Partial<Pick<BrowserStore, "groups" | "members">>): BrowserSession {
  const saved = stripTabs(s).filter((t) => !t.private && /^https?:\/\//.test(t.url));
  const members = s.members ?? {};
  const groups = (s.groups ?? []).filter((g) => saved.some((t) => members[t.id] === g.id));
  return {
    tabs: saved.map((t) => ({ url: t.url, title: t.title, ...(members[t.id] ? { group: members[t.id] } : {}) })),
    active: Math.max(0, saved.findIndex((t) => t.id === s.activeId)),
    ...(groups.length ? { groups } : {}),
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
        // The live tab has another id: it keeps its group.
        members: s.members[id] ? { ...Object.fromEntries(Object.entries(s.members).filter(([k]) => k !== id)), [tab.id]: s.members[id] } : s.members,
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
    closed: [],
    groups: [],
    members: {},
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
        const members = Object.fromEntries(session.tabs.flatMap((t, i) => (t.group ? [[sleeping[i].id, t.group]] : [])));
        set((s) => ({ sleeping, order: syncOrder(s.order, s.tabs, sleeping), activeId: active, groups: session.groups ?? [], members }));
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
      const gone = stripTabs(get()).find((t) => t.id === id);
      if (gone && !gone.private && /^https?:\/\//.test(gone.url)) {
        set((s) => ({ closed: [{ url: gone.url, title: gone.title }, ...s.closed].slice(0, 25) }));
      }
      set((s) => {
        const i = s.order.indexOf(id);
        const order = s.order.filter((x) => x !== id);
        const next = order[i] ?? order[i - 1];
        const members = Object.fromEntries(Object.entries(s.members).filter(([k]) => k !== id));
        return {
          members,
          groups: pruneGroups({ groups: s.groups, members }),
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
    reopen: async (index = 0) => {
      const entry = get().closed[index];
      if (!entry) return;
      set((s) => ({ closed: s.closed.filter((_, i) => i !== index), nextPrivate: false }));
      await get().open(entry.url);
    },
    addGroup: (name, tabId) =>
      set((s) => {
        const color = GROUP_COLORS[s.groups.length % GROUP_COLORS.length];
        const id = `group-${Date.now()}`;
        const members = { ...s.members, [tabId]: id };
        return { members, groups: pruneGroups({ groups: [...s.groups, { id, name: name.trim() || "Group", color, collapsed: false }], members }) };
      }),
    setGroup: (tabId, groupId) =>
      set((s) => {
        const members = Object.fromEntries(Object.entries(s.members).filter(([k]) => k !== tabId));
        if (groupId) members[tabId] = groupId;
        return { members, groups: pruneGroups({ groups: s.groups, members }) };
      }),
    renameGroup: (groupId, name) => set((s) => ({ groups: s.groups.map((g) => (g.id === groupId ? { ...g, name } : g)) })),
    toggleGroup: (groupId) => set((s) => ({ groups: s.groups.map((g) => (g.id === groupId ? { ...g, collapsed: !g.collapsed } : g)) })),
    removeGroup: (groupId) =>
      set((s) => ({
        groups: s.groups.filter((g) => g.id !== groupId),
        members: Object.fromEntries(Object.entries(s.members).filter(([, g]) => g !== groupId)),
      })),
    dismiss: (key) => set((s) => ({ notices: s.notices.filter((n) => n.key !== key) })),
  };
});
