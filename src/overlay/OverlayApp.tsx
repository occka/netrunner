import { Suspense, useEffect, useMemo, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { emit, listen } from "@tauri-apps/api/event";
import { Lock, Minus, Plus, VolumeX, Volume2, X } from "lucide-react";
import { api } from "@/services/api";
import { useAppearance, useSettings } from "@/stores/settings";
import { useQuickAccess } from "@/stores/quickAccess";
import { applyTheme } from "@/styles/theme";
import { WIDGETS, widgetConfig } from "@/modules/command/widgets/registry";
import { accentStyle, frameStyle } from "@/modules/command/widgets/frame";
import { Sampling } from "@/modules/command/widgets/common";
import { BrowserSurface } from "@/modules/browser/BrowserSurface";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { ConfirmHost } from "@/components/ConfirmHost";
import { Toasts } from "@/components/Toasts";
import type { Overlay } from "@/types/phase2";
import type { BrowserTab } from "@/types/browser";

/** Root of a floating overlay window: one widget, or one web page, in a minimal frame. */
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
  useAppearance(true);

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

  const web = overlay?.widgetType === "web";
  const def = overlay && !web ? WIDGETS[overlay.widgetType] : undefined;
  const config = useMemo(() => widgetConfig(def, overlay?.config), [def, overlay?.config]);

  if (error) return <div className="overlay overlay--error">{error}</div>;
  if (!overlay) return null;
  const Body = def?.component;
  const title = web ? overlay.title || hostOf(overlay.url) : (config["frame.title"] as string).trim() || def?.title || overlay.widgetType;
  const header = web || (config["frame.header"] as boolean) || !overlay.locked;

  return (
    <div
      className={`overlay${web ? " overlay--web" : ""}${config["frame.transparent"] && !web ? " overlay--transparent" : ""}`}
      data-locked={overlay.locked}
      style={{ ["--overlay-alpha" as string]: overlay.opacity, ...accentStyle(config) }}
    >
      {header ? (
        <header className="overlay__bar" data-tauri-drag-region={overlay.locked ? undefined : true}>
          <span className="overlay__title" data-tauri-drag-region={overlay.locked ? undefined : true}>
            {title}
          </span>
          {web && <WebTabControls overlay={overlay} />}
          {overlay.locked && <Lock size={10} className="muted" />}
          <button className="icon-btn icon-btn--sm" title="Hide overlay" onClick={() => void api.overlays.setVisible(id, false)}>
            <X size={12} />
          </button>
        </header>
      ) : null}
      {web ? (
        <WebBody overlayId={id} />
      ) : (
        <div className="overlay__body" style={frameStyle(config)}>
          {Body ? (
            <ErrorBoundary compact>
              <Suspense fallback={<Sampling />}>
                <Body instanceId={`overlay-${id}`} editing={false} config={config} host="overlay" />
              </Suspense>
            </ErrorBoundary>
          ) : (
            <div className="unavailable">Widget "{overlay.widgetType}" is not available as an overlay.</div>
          )}
        </div>
      )}
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

function hostOf(url: string) {
  try {
    return new URL(url).hostname;
  } catch {
    return "Web";
  }
}

/** The overlay's browser tab, created on first use or moved here from BROWSER. */
function useOverlayTab(overlayId: number) {
  const [tab, setTab] = useState<BrowserTab | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    api.browser.overlayTab(overlayId).then(
      (t) => alive && setTab(t),
      (e: Error) => alive && setError(e.message),
    );
    const un = listen<BrowserTab>("browser://tab", (e) => {
      if (e.payload.host === `overlay-${overlayId}`) setTab(e.payload);
    });
    return () => {
      alive = false;
      void un.then((f) => f());
    };
  }, [overlayId]);
  return { tab, error };
}

function WebBody({ overlayId }: { overlayId: number }) {
  const { tab, error } = useOverlayTab(overlayId);
  if (error) return <div className="unavailable">{error}</div>;
  return <BrowserSurface tabId={tab?.id ?? null} className="overlay__web" />;
}

const ZOOM_STEPS = [0.5, 0.6, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5];

/** Mute and page zoom. Small windows get desktop layouts back by zooming out; the zoom is saved per overlay. */
function WebTabControls({ overlay }: { overlay: Overlay }) {
  const { tab } = useOverlayTab(overlay.id);
  const zoom = typeof overlay.config["web.zoom"] === "number" ? (overlay.config["web.zoom"] as number) : 1;

  useEffect(() => {
    if (tab) void api.browser.setZoom(tab.id, zoom).catch(() => undefined);
  }, [tab?.id, zoom]);

  if (!tab) return null;
  const step = (dir: 1 | -1) => {
    const i = ZOOM_STEPS.findIndex((z) => z >= zoom - 0.001);
    const next = ZOOM_STEPS[Math.min(ZOOM_STEPS.length - 1, Math.max(0, (i < 0 ? 6 : i) + dir))];
    void api.overlays
      .patch(overlay.id, { config: { ...overlay.config, "web.zoom": next } })
      .then(() => emit("overlays://changed"))
      .catch(() => undefined);
    void api.browser.setZoom(tab.id, next).catch(() => undefined);
  };
  return (
    <>
      <button className="icon-btn icon-btn--sm" title="Zoom out" onClick={() => step(-1)}>
        <Minus size={11} />
      </button>
      <span className="overlay__zoom mono" title="Page zoom">
        {Math.round(zoom * 100)}%
      </span>
      <button className="icon-btn icon-btn--sm" title="Zoom in" onClick={() => step(1)}>
        <Plus size={11} />
      </button>
      <button
      className="icon-btn icon-btn--sm"
      title={tab.muted ? "Unmute" : "Mute"}
      onClick={() => void api.browser.action(tab.id, tab.muted ? "unmute" : "mute").catch(() => undefined)}
    >
        {tab.muted ? <VolumeX size={12} /> : <Volume2 size={12} />}
      </button>
    </>
  );
}
