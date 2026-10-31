import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Bell, ChevronRight, Copy, Minus, Search, Settings, Square, X } from "lucide-react";
import { MODULE_BY_ID } from "@/app/modules";
import { useShell } from "@/stores/shell";
import { useActiveProfile } from "@/stores/profiles";
import { useDashboard } from "@/stores/dashboard";
import { useNotifications } from "@/stores/notifications";
import { NotificationCenter } from "@/layouts/NotificationCenter";
import { Logo } from "@/components/Logo";

export function TopBar() {
  const module = useShell((s) => s.module);
  const navigate = useShell((s) => s.navigate);
  const openPalette = useShell((s) => s.openPalette);
  const profile = useActiveProfile();
  const editing = useDashboard((s) => s.editing);
  const unread = useNotifications((s) => s.history.filter((n) => !n.read).length);
  const [notifOpen, setNotifOpen] = useState(false);
  const def = MODULE_BY_ID[module];

  return (
    <header className="topbar" data-tauri-drag-region>
      <button className="topbar__logo" onClick={() => navigate("command")} title="Return to COMMAND">
        <Logo size={20} />
        <span>NETRUNNER</span>
      </button>

      <nav className="topbar__crumbs" aria-label="Breadcrumb" data-tauri-drag-region>
        <span className="label">{profile ? profile.name : "—"}</span>
        <ChevronRight size={12} className="muted" />
        <span className="topbar__crumb-current">{def.label}</span>
        {editing && module === "command" && <span className="tag tag--accent">Edit layout</span>}
      </nav>

      <button className="topbar__search" onClick={() => openPalette()} title="Search and commands (Ctrl+K)">
        <Search size={14} />
        <span>Search apps, files, commands, settings…</span>
        <kbd>Ctrl K</kbd>
      </button>

      <div className="topbar__right" data-tauri-drag-region>
        <div className="topbar__notif">
          <button
            className="icon-btn"
            aria-label="Notifications"
            aria-expanded={notifOpen}
            onClick={() => setNotifOpen((v) => !v)}
          >
            <Bell size={15} />
            {unread > 0 && <span className="topbar__badge">{unread > 9 ? "9+" : unread}</span>}
          </button>
          {notifOpen && <NotificationCenter onClose={() => setNotifOpen(false)} />}
        </div>
        <button className="topbar__profile" onClick={() => navigate("profiles")} title="Active profile">
          <span className="dot" />
          {profile ? profile.name.toUpperCase() : "NO PROFILE"}
        </button>
        <button className="icon-btn" aria-label="Settings" onClick={() => navigate("settings")}>
          <Settings size={15} />
        </button>
        <WindowControls />
      </div>
    </header>
  );
}

function WindowControls() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    const win = getCurrentWindow();
    let unlisten: (() => void) | undefined;
    void win.isMaximized().then(setMaximized).catch(() => undefined);
    void win
      .onResized(() => {
        void win.isMaximized().then(setMaximized).catch(() => undefined);
      })
      .then((fn) => (unlisten = fn))
      .catch(() => undefined);
    return () => unlisten?.();
  }, []);

  const win = () => getCurrentWindow();
  return (
    <div className="winctl">
      <button aria-label="Minimize" onClick={() => void win().minimize()}>
        <Minus size={14} />
      </button>
      <button aria-label={maximized ? "Restore" : "Maximize"} onClick={() => void win().toggleMaximize()}>
        {maximized ? <Copy size={12} /> : <Square size={11} />}
      </button>
      <button className="winctl__close" aria-label="Close" onClick={() => void win().close()}>
        <X size={15} />
      </button>
    </div>
  );
}
