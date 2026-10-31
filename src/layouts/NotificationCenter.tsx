import { useEffect, useRef } from "react";
import { useNotifications } from "@/stores/notifications";
import { formatClock } from "@/utils/format";

export function NotificationCenter({ onClose }: { onClose: () => void }) {
  const history = useNotifications((s) => s.history);
  const markAllRead = useNotifications((s) => s.markAllRead);
  const clearHistory = useNotifications((s) => s.clearHistory);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    markAllRead();
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.parentElement?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [markAllRead, onClose]);

  return (
    <div className="notif-panel" ref={ref} role="dialog" aria-label="Notifications">
      <div className="notif-panel__head">
        <span className="label">Notifications · this session</span>
        <button className="btn btn--ghost btn--sm" onClick={clearHistory} disabled={history.length === 0}>
          Clear
        </button>
      </div>
      <div className="notif-panel__list">
        {history.length === 0 && <div className="empty">No notifications yet.</div>}
        {history.map((n) => (
          <div key={n.id} className="notif-item" data-level={n.level}>
            <span className="notif-item__time mono">{formatClock(n.at)}</span>
            <div>
              <div className="notif-item__title">{n.title}</div>
              {n.message && <div className="notif-item__msg">{n.message}</div>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
