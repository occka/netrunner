import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { listen } from "@tauri-apps/api/event";
import { useShell } from "@/stores/shell";
import {
  ArrowLeft,
  ArrowRight,
  Bookmark as BookmarkIcon,
  Download,
  Globe,
  History,
  Loader2,
  Lock,
  PictureInPicture2,
  Plus,
  RotateCw,
  Search,
  Shield,
  ShieldOff,
  Star,
  Unlock,
  VenetianMask,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import { ModuleHeader } from "@/components/ModuleHeader";
import { api } from "@/services/api";
import { usePolled } from "@/hooks/usePolled";
import { useSetting, useSettings } from "@/stores/settings";
import { notify, reportError } from "@/stores/notifications";
import { BrowserSurface } from "./BrowserSurface";
import { BookmarksPanel, DownloadsPanel, HistoryPanel, PrivacyPanel } from "./BrowserPanels";
import { hostOf, mainTabs, stripTabs, useBrowser, type StripTab } from "./store";
import type { BrowserNotice, BrowserTab } from "@/types/browser";

type Panel = "bookmarks" | "history" | "downloads" | "privacy" | null;


const PERMISSION_LABEL: Record<string, string> = {
  camera: "your camera",
  microphone: "your microphone",
  geolocation: "your location",
  notifications: "to show notifications",
  "clipboard-read": "to read the clipboard",
  "display-capture": "to capture your screen",
  midi: "MIDI devices",
  sensors: "motion sensors",
  "local-fonts": "your installed fonts",
  "window-management": "to manage windows",
  "automatic-downloads": "to download several files",
  "file-system": "file system access",
};

export default function BrowserModule() {
  const { tabs, sleeping, order, activeId, ready, init, activate, newTab, close, nextPrivate } = useBrowser();
  const [panel, setPanel] = useState<Panel>(null);
  const shown = stripTabs({ tabs, sleeping, order });
  // A sleeping tab has no webview yet: the start page shows while it wakes.
  const tab = mainTabs(tabs).find((t) => t.id === activeId) ?? null;
  const adblock = useSetting("browser.adblock");
  const exceptions = useSetting("browser.adblock_exceptions");

  useEffect(() => {
    init().catch((err) => reportError("Browser unavailable", err));
  }, [init]);

  // Blocked-request counters change constantly; poll them instead of emitting per request.
  useEffect(() => {
    const id = window.setInterval(() => !document.hidden && void useBrowser.getState().refresh().catch(() => undefined), 1500);
    return () => window.clearInterval(id);
  }, []);

  // Page fullscreen (video) takes the whole window.
  useEffect(() => {
    const win = getCurrentWindow();
    void win.setFullscreen(!!tab?.fullscreen).catch(() => undefined);
  }, [tab?.fullscreen]);
  useEffect(() => () => void getCurrentWindow().setFullscreen(false).catch(() => undefined), []);

  // The same shortcuts while a page has focus: the backend forwards them.
  useEffect(() => {
    const un = listen<[string, string]>("browser://shortcut", (e) => {
      const [tabId, key] = e.payload;
      const s = useBrowser.getState();
      const order = s.order;
      const i = order.indexOf(tabId);
      // Keyboard focus is inside the native page; bring it back to NETRUNNER's address bar.
      const focusAddress = () =>
        void getCurrentWebview()
          .setFocus()
          .then(() => requestAnimationFrame(() => document.querySelector<HTMLInputElement>(".browser__address input")?.select()));
      if (key === "new" || key === "new-private") {
        s.newTab(key === "new-private");
        focusAddress();
      } else if (key === "address") focusAddress();
      else if (key === "close") void s.close(tabId);
      else if (key === "reload") void api.browser.action(tabId, "reload").catch(() => undefined);
      else if (key === "palette") useShell.getState().openPalette();
      else if ((key === "next" || key === "prev") && order.length > 1)
        s.activate(order[(i + (key === "next" ? 1 : -1) + order.length) % order.length]);
    });
    return () => void un.then((f) => f());
  }, []);

  // Shortcuts while focus is in NETRUNNER's chrome (pages keep their own keys).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === "t") {
        e.preventDefault();
        newTab(e.shiftKey);
      } else if (k === "w" && activeId) {
        e.preventDefault();
        void close(activeId);
      } else if (k === "l") {
        e.preventDefault();
        document.querySelector<HTMLInputElement>(".browser__address input")?.select();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [activeId, close, newTab]);

  const siteHost = tab ? hostOf(tab.url) : "";
  const siteExcepted = !!siteHost && exceptions.some((e) => siteHost === e || siteHost.endsWith(`.${e}`));

  return (
    <div className={`module browser${tab?.fullscreen ? " browser--fullscreen" : ""}`}>
      <ModuleHeader
        id="browser"
        subtitle={
          <>
            {adblock ? "Blocking ads and trackers" : "Content blocking off"} · HTTPS-only · isolated profile
          </>
        }
      />
      <div className="browser__tabs" role="tablist">
        {shown.map((t) => (
          <TabButton key={t.id} tab={t} active={t.id === activeId} onSelect={() => activate(t.id)} onClose={() => void close(t.id)} />
        ))}
        {activeId === null && (
          <div className="browser__tab" role="tab" aria-selected>
            {nextPrivate ? <VenetianMask size={13} /> : <Globe size={13} />}
            <span className="truncate">{nextPrivate ? "Private tab" : "New tab"}</span>
          </div>
        )}
        <button className="icon-btn icon-btn--sm" title="New tab (Ctrl+T)" onClick={() => newTab(false)}>
          <Plus size={14} />
        </button>
        <button className="icon-btn icon-btn--sm" title="New private tab (Ctrl+Shift+T): no history, cookies cleared when closed" onClick={() => newTab(true)}>
          <VenetianMask size={14} />
        </button>
      </div>

      <Toolbar tab={tab} startPage={ready && activeId === null} panel={panel} setPanel={setPanel} siteExcepted={siteExcepted} />
      {tab && <Notices tab={tab} />}

      <div className="browser__main">
        {tab ? (
          <BrowserSurface tabId={tab.id} className="browser__view" />
        ) : activeId ? (
          <div className="browser__view browser__waking label">Restoring tab…</div>
        ) : (
          <StartPage />
        )}
        {panel && (
          <aside className="browser__panel">
            <div className="browser__panel-head">
              <span className="label">{panel}</span>
              <button className="icon-btn icon-btn--sm" onClick={() => setPanel(null)} aria-label="Close panel">
                <X size={13} />
              </button>
            </div>
            <div className="browser__panel-body">
              {panel === "bookmarks" && <BookmarksPanel />}
              {panel === "history" && <HistoryPanel />}
              {panel === "downloads" && <DownloadsPanel />}
              {panel === "privacy" && <PrivacyPanel site={siteHost} />}
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}

function TabButton({ tab, active, onSelect, onClose }: { tab: StripTab; active: boolean; onSelect: () => void; onClose: () => void }) {
  return (
    <div
      className={`browser__tab${tab.sleeping ? " browser__tab--sleeping" : ""}`}
      role="tab"
      aria-selected={active}
      title={tab.url}
      onMouseDown={(e) => {
        if (e.button === 1) {
          e.preventDefault();
          onClose();
        } else if (e.button === 0) onSelect();
      }}
    >
      {tab.loading ? (
        <Loader2 size={13} className="spin" />
      ) : tab.favicon ? (
        <img src={tab.favicon} alt="" width={14} height={14} />
      ) : tab.private ? (
        <VenetianMask size={13} />
      ) : (
        <Globe size={13} />
      )}
      <span className="truncate">{tab.title || hostOf(tab.url) || "Loading…"}</span>
      {(tab.audible || tab.muted) && (
        <button
          className="icon-btn icon-btn--xs"
          title={tab.muted ? "Unmute tab" : "Mute tab"}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={() => void api.browser.action(tab.id, tab.muted ? "unmute" : "mute").catch(() => undefined)}
        >
          {tab.muted ? <VolumeX size={11} /> : <Volume2 size={11} />}
        </button>
      )}
      <button className="icon-btn icon-btn--xs" title="Close tab (Ctrl+W)" onMouseDown={(e) => e.stopPropagation()} onClick={onClose}>
        <X size={11} />
      </button>
    </div>
  );
}

function Toolbar({
  tab,
  startPage,
  panel,
  setPanel,
  siteExcepted,
}: {
  tab: BrowserTab | null;
  startPage: boolean;
  panel: Panel;
  setPanel: (p: Panel) => void;
  siteExcepted: boolean;
}) {
  const go = useBrowser((s) => s.go);
  const [text, setText] = useState("");
  const [editing, setEditing] = useState(false);
  const { data: bookmarks, reload: reloadBookmarks } = usePolled(() => api.browser.bookmarks());
  const bookmark = tab && bookmarks?.find((b) => b.url === tab.url);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editing) setText(tab?.url ?? "");
  }, [tab?.url, tab?.id, editing]);
  // Only a new tab takes focus; a tab that is still waking up does not.
  useEffect(() => {
    if (startPage) inputRef.current?.focus();
  }, [startPage]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    setEditing(false);
    inputRef.current?.blur();
    void go(text);
  };

  const act = (action: "back" | "forward" | "reload" | "stop") =>
    tab && void api.browser.action(tab.id, action).catch((err) => reportError("Browser action failed", err));

  const toggleBookmark = async () => {
    if (!tab) return;
    try {
      if (bookmark) await api.browser.removeBookmark(bookmark.id);
      else await api.browser.addBookmark(tab.url, tab.title);
      await reloadBookmarks();
    } catch (err) {
      reportError("Could not update bookmarks", err);
    }
  };

  const popOut = async () => {
    if (!tab) return;
    try {
      await api.browser.popOut(tab.id);
      notify.success("Moved to an overlay", "Playback continues in a floating window. Manage it in OVERLAY.");
    } catch (err) {
      reportError("Could not move the tab", err);
    }
  };

  const secure = tab?.url.startsWith("https://");
  const panelBtn = (p: Exclude<Panel, null>, icon: JSX.Element, title: string) => (
    <button className="icon-btn" aria-pressed={panel === p} title={title} onClick={() => setPanel(panel === p ? null : p)}>
      {icon}
    </button>
  );

  return (
    <div className="browser__bar">
      <button className="icon-btn" title="Back" disabled={!tab?.canBack} onClick={() => act("back")}>
        <ArrowLeft size={15} />
      </button>
      <button className="icon-btn" title="Forward" disabled={!tab?.canForward} onClick={() => act("forward")}>
        <ArrowRight size={15} />
      </button>
      <button className="icon-btn" title={tab?.loading ? "Stop" : "Reload"} disabled={!tab} onClick={() => act(tab?.loading ? "stop" : "reload")}>
        {tab?.loading ? <X size={15} /> : <RotateCw size={14} />}
      </button>
      <form className="browser__address" onSubmit={submit}>
        {tab ? (
          secure ? (
            <Lock size={12} className="browser__lock" aria-label="Encrypted connection (HTTPS)" />
          ) : (
            <Unlock size={12} className="browser__lock browser__lock--open" aria-label="Not encrypted" />
          )
        ) : (
          <Search size={12} className="muted" />
        )}
        {tab?.private && <span className="tag tag--info">Private</span>}
        <input
          ref={inputRef}
          value={text}
          spellCheck={false}
          placeholder="Search or enter address"
          onFocus={(e) => {
            setEditing(true);
            e.currentTarget.select();
          }}
          onBlur={() => setEditing(false)}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              setText(tab?.url ?? "");
              e.currentTarget.blur();
            }
          }}
        />
      </form>
      <button
        className="icon-btn browser__shield"
        title={siteExcepted ? "Blocking is off for this site" : `${tab?.blocked ?? 0} requests blocked on this page`}
        aria-pressed={panel === "privacy"}
        onClick={() => setPanel(panel === "privacy" ? null : "privacy")}
      >
        {siteExcepted ? <ShieldOff size={15} /> : <Shield size={15} />}
        {!!tab?.blocked && !siteExcepted && <span className="browser__count mono">{tab.blocked > 999 ? "999+" : tab.blocked}</span>}
      </button>
      <button className="icon-btn" title={bookmark ? "Remove bookmark" : "Bookmark this page"} disabled={!tab} onClick={() => void toggleBookmark()}>
        <Star size={15} fill={bookmark ? "currentColor" : "none"} />
      </button>
      <button className="icon-btn" title="Move to a floating overlay (keeps playing music or video)" disabled={!tab} onClick={() => void popOut()}>
        <PictureInPicture2 size={15} />
      </button>
      {panelBtn("bookmarks", <BookmarkIcon size={15} />, "Bookmarks")}
      {panelBtn("history", <History size={15} />, "History")}
      {panelBtn("downloads", <Download size={15} />, "Downloads")}
    </div>
  );
}

function noticeText(n: BrowserNotice): string {
  switch (n.kind) {
    case "https-upgrade":
      return `${n.host} was opened over HTTPS instead of unencrypted HTTP.`;
    case "permission":
      return `${n.host || "This site"} wants ${PERMISSION_LABEL[n.detail] ?? n.detail}. Blocked.`;
    case "external-app":
      return `The page tried to open an external app (${n.host}:). Blocked.`;
    case "blocked-scheme":
      return `Blocked navigation to ${n.detail.slice(0, 80)}: only web pages open here.`;
    case "download":
      return `Downloading from ${n.host}. Windows SmartScreen checks the file.`;
  }
}

function Notices({ tab }: { tab: BrowserTab }) {
  const notices = useBrowser((s) => s.notices).filter((n) => n.tab === tab.id);
  const dismiss = useBrowser((s) => s.dismiss);
  if (notices.length === 0) return null;
  return (
    <div className="browser__notices">
      {notices.map((n) => (
        <div key={n.key} className={`browser__notice browser__notice--${n.kind}`}>
          <span>{noticeText(n)}</span>
          {n.kind === "https-upgrade" && (
            <button
              className="btn btn--sm btn--ghost"
              title="Only if the HTTPS version does not work. Traffic to this site will not be encrypted."
              onClick={() => {
                dismiss(n.key);
                void api.browser.allowHttp(tab.id, n.detail).catch((err) => reportError("Could not open over HTTP", err));
              }}
            >
              Load over HTTP this session
            </button>
          )}
          {n.kind === "permission" && n.host && (
            <button
              className="btn btn--sm"
              onClick={async () => {
                dismiss(n.key);
                try {
                  await api.browser.setPermission(n.host, n.detail, true);
                  await api.browser.action(tab.id, "reload");
                } catch (err) {
                  reportError("Could not allow the permission", err);
                }
              }}
            >
              Allow for {n.host}
            </button>
          )}
          <button className="icon-btn icon-btn--sm" aria-label="Dismiss" onClick={() => dismiss(n.key)}>
            <X size={12} />
          </button>
        </div>
      ))}
    </div>
  );
}

function StartPage() {
  const open = useBrowser((s) => s.open);
  const nextPrivate = useBrowser((s) => s.nextPrivate);
  const { data: bookmarks } = usePolled(() => api.browser.bookmarks());
  const { data: recent } = usePolled(() => api.browser.history("", 8));
  const { data: status } = usePolled(() => api.browser.status(), 4000);
  const search = useSetting("browser.search");
  const engines = useMemo(() => status?.searchEngines ?? [], [status]);

  return (
    <div className="browser__start">
      <div className="browser__start-inner">
        <div className="browser__start-title">
          {nextPrivate ? <VenetianMask size={22} /> : <Globe size={22} />}
          <span>{nextPrivate ? "Private tab" : "New tab"}</span>
        </div>
        {nextPrivate && (
          <p className="muted">Nothing from this tab is saved to history. Its cookies and site data are discarded when NETRUNNER closes it.</p>
        )}
        <div className="browser__start-search">
          <select
            className="input"
            value={search}
            title="Search engine"
            onChange={(e) => void useSettings.getState().set("browser.search", e.target.value).catch((err) => reportError("Could not save", err))}
          >
            {engines.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
          <span className="muted">Type in the address bar above and press Enter.</span>
        </div>
        {status && (
          <div className="browser__start-stats">
            <span className="tag tag--ok">
              <Shield size={11} /> {status.blocker.ready ? `${status.blocker.rules.toLocaleString()} filter rules` : "Loading filters…"}
            </span>
            <span className="tag">{status.blockedTotal.toLocaleString()} requests blocked this session</span>
            <span className="tag">Tracking prevention: {status.prefs.tracking}</span>
          </div>
        )}
        {bookmarks && bookmarks.length > 0 && (
          <>
            <h2 className="label section-title">Bookmarks</h2>
            <div className="browser__tiles">
              {bookmarks.slice(0, 24).map((b) => (
                <button key={b.id} className="browser__tile" title={b.url} onClick={() => void open(b.url)}>
                  <span className="truncate">{b.title || hostOf(b.url)}</span>
                  <span className="muted truncate mono">{hostOf(b.url)}</span>
                </button>
              ))}
            </div>
          </>
        )}
        {recent && recent.length > 0 && !nextPrivate && (
          <>
            <h2 className="label section-title">Recently visited</h2>
            <ul className="browser__recent">
              {recent.map((h) => (
                <li key={h.id}>
                  <button className="link-btn truncate" title={h.url} onClick={() => void open(h.url)}>
                    {h.title || h.url}
                  </button>
                  <span className="muted mono">{hostOf(h.url)}</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}
