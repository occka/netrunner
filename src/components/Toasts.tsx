import { AlertOctagon, AlertTriangle, CheckCircle2, Info, X } from "lucide-react";
import { useNotifications, type NoticeLevel } from "@/stores/notifications";

const ICONS: Record<NoticeLevel, typeof Info> = {
  info: Info,
  success: CheckCircle2,
  warn: AlertTriangle,
  error: AlertOctagon,
};

export function Toasts() {
  const toasts = useNotifications((s) => s.toasts);
  const dismiss = useNotifications((s) => s.dismiss);
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => {
        const Icon = ICONS[t.level];
        return (
          <div key={t.id} className="toast" data-level={t.level} role={t.level === "error" ? "alert" : "status"}>
            <Icon size={15} className={`toast__icon toast__icon--${t.level}`} />
            <div>
              <div className="toast__title">{t.title}</div>
              {t.message && <div className="toast__msg">{t.message}</div>}
            </div>
            <button className="icon-btn icon-btn--sm" onClick={() => dismiss(t.id)} aria-label="Dismiss">
              <X size={12} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
