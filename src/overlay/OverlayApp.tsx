import { Suspense, useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { Lock, X } from "lucide-react";
import { api } from "@/services/api";
import { useSettings } from "@/stores/settings";
import { useQuickAccess } from "@/stores/quickAccess";
import { applyTheme } from "@/styles/theme";
import { WIDGETS } from "@/modules/command/widgets/registry";
import { Sampling } from "@/modules/command/widgets/common";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { ConfirmHost } from "@/components/ConfirmHost";
import { Toasts } from "@/components/Toasts";
import type { Overlay } from "@/types/phase2";

/** Root of a floating overlay window: one widget in a minimal frame. */
export function OverlayApp({ id }: { id: number }) {
  const [overlay, setOverlay] = useState<Overlay | null>(null);
  const [error, setError] = useState<string | null>(null);
  const theme = useSettings((s) => s.values.theme);

  useEffect(() => {
    document.documentElement.classList.add("overlay-root");
    const load = () => api.overlays.get(id).then(setOverlay, (e: Error) => setError(e.message));
    Promise.all([useSettings.getState().load(), useQuickAccess.getState().load()]).catch(() => undefined);
    void load();
    const un = listen("overlays://changed", () => void load());
    return () => void un.then((f) => f());
  }, [id]);

  useEffect(() => applyTheme(theme), [theme]);

  // Persist position/size after the user stops moving or resizing.
  useEffect(() => {
    const win = getCurrentWindow();
    let timer: number | undefined;
    const save = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(async () => {
        const [pos, size] = await Promise.all([win.outerPosition(), win.innerSize()]);
        void api.overlays.setGeometry(id, pos.x, pos.y, size.width, size.height).catch(() => undefined);
      }, 500);
    };
    const subs = [win.onMoved(save), win.onResized(save)];
    return () => subs.forEach((p) => void p.then((f) => f()));
  }, [id]);

  if (error) return <div className="overlay overlay--error">{error}</div>;
  if (!overlay) return null;
  const def = WIDGETS[overlay.widgetType];
  const Body = def?.component;

  return (
    <div className="overlay" data-locked={overlay.locked} style={{ ["--overlay-alpha" as string]: overlay.opacity }}>
      <header className="overlay__bar" data-tauri-drag-region={overlay.locked ? undefined : true}>
        <span className="overlay__title" data-tauri-drag-region={overlay.locked ? undefined : true}>
          {def?.title ?? overlay.widgetType}
        </span>
        {overlay.locked && <Lock size={10} className="muted" />}
        <button className="icon-btn icon-btn--sm" title="Hide overlay" onClick={() => void api.overlays.setVisible(id, false)}>
          <X size={12} />
        </button>
      </header>
      <div className="overlay__body">
        {Body ? (
          <ErrorBoundary compact>
            <Suspense fallback={<Sampling />}>
              <Body instanceId={`overlay-${id}`} editing={false} />
            </Suspense>
          </ErrorBoundary>
        ) : (
          <div className="unavailable">Widget "{overlay.widgetType}" is not available as an overlay.</div>
        )}
      </div>
      {!overlay.locked && (
        <div
          className="overlay__grip"
          title="Drag to resize"
          onMouseDown={(e) => {
            e.preventDefault();
            void getCurrentWindow().startResizeDragging("SouthEast");
          }}
        />
      )}
      <ConfirmHost />
      <Toasts />
    </div>
  );
}
