import { useEffect } from "react";
import { BellRing, Timer as TimerIcon } from "lucide-react";
import { api } from "@/services/api";
import { useAppearance, useSettings } from "@/stores/settings";
import { applyTheme } from "@/styles/theme";
import { reportError } from "@/stores/notifications";
import { Toasts } from "@/components/Toasts";
import { formatDuration, listenForAlarms, useAlarms } from "@/modules/command/widgets/alarmStore";

/**
 * The always-on-top window that opens when an alarm or timer rings, also when
 * the main window is hidden in the tray. Enter / Esc stop, S snoozes the first.
 */
export function RingApp() {
  const state = useAlarms((s) => s.state);
  const theme = useSettings((s) => s.values.theme);

  useEffect(() => {
    document.documentElement.classList.add("ring-root");
    void useSettings.getState().load().catch(() => undefined);
    listenForAlarms();
    void useAlarms.getState().load();
  }, []);
  useEffect(() => applyTheme(theme), [theme]);
  useAppearance(true);

  const ringing = state?.ringing ?? [];
  const stop = (key: string) => void api.alarms.stop(key).catch((err) => reportError("Could not stop", err));
  const snooze = (key: string) => void api.alarms.snooze(key).catch((err) => reportError("Could not snooze", err));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const first = ringing[0];
      if (!first) return;
      if (e.key === "Enter" || e.key === "Escape") stop(first.key);
      if (e.key.toLowerCase() === "s") snooze(first.key);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <div className="ring" data-tauri-drag-region>
      {ringing.length === 0 && <div className="ring__empty muted">Nothing is ringing.</div>}
      {ringing.map((r) => {
        const alarm = r.kind === "alarm" ? state?.alarms.find((a) => a.id === r.id) : undefined;
        const timer = r.kind === "timer" ? state?.timers.find((t) => t.id === r.id) : undefined;
        return (
          <section key={r.key} className="ring__item" data-tauri-drag-region>
            <div className="ring__icon">{r.kind === "alarm" ? <BellRing size={30} /> : <TimerIcon size={30} />}</div>
            <div className="ring__text" data-tauri-drag-region>
              <div className="ring__kind label">{r.kind === "alarm" ? "Alarm" : "Timer finished"}</div>
              <div className="ring__time mono">{alarm ? alarm.time : timer ? formatDuration(timer.durationMs) : ""}</div>
              <div className="ring__label">{r.label || (r.kind === "alarm" ? "Wake up" : "Time is up")}</div>
            </div>
            <div className="ring__buttons">
              <button className="btn" onClick={() => snooze(r.key)} title="S">
                {alarm ? `Snooze ${alarm.snoozeMinutes} min` : "+1 min"}
              </button>
              <button className="btn btn--primary" onClick={() => stop(r.key)} title="Enter / Esc" autoFocus>
                Stop
              </button>
            </div>
          </section>
        );
      })}
      <Toasts />
    </div>
  );
}
