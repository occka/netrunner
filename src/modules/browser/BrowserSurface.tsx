import { useEffect, useRef } from "react";
import { api } from "@/services/api";
import { uiScale } from "@/styles/appearance";

/** Elements that must stay above web content: the native webview cannot be drawn under HTML. */
const OCCLUDERS = ".dialog-backdrop, .menu, .notif-panel";
/** The navigation rail expanded on hover floats over the workspace; the page makes room for it instead. */
const SIDE_OVERLAYS = '.shell__nav[data-pinned="false"] .nav[data-open="true"]';

/**
 * Placeholder for a native browser webview. Each animation frame it compares
 * its on-screen rectangle with the last one sent and moves the webview to
 * match; the webview is hidden while a dialog, menu or the palette is open,
 * when `visible` is false, and when this component unmounts.
 */
export function BrowserSurface({ tabId, visible = true, className }: { tabId: string | null; visible?: boolean; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!tabId) return;
    let last = "";
    let sentAt = 0;
    let frame = 0;
    const sync = () => {
      const rect = ref.current?.getBoundingClientRect();
      let left = rect?.left ?? 0;
      const side = document.querySelector(SIDE_OVERLAYS)?.getBoundingClientRect();
      if (rect && side && side.right > left && side.left <= left) left = side.right;
      const width = rect ? rect.right - left : 0;
      const top = rect?.top ?? 0;
      const height = rect?.height ?? 0;
      const show = visible && width > 1 && height > 1 && !document.querySelector(OCCLUDERS);
      const key = show ? `${Math.round(left)},${Math.round(top)},${Math.round(width)},${Math.round(height)}` : "hidden";
      // Re-send now and then: a command that arrives while the native view is
      // still being created is dropped, and the rectangle may never change again.
      const now = performance.now();
      if (key !== last || now - sentAt > 1000) {
        last = key;
        sentAt = now;
        // CSS pixels are zoomed by the interface scale; native views use window pixels.
        const z = uiScale();
        api.browser
          .setBounds(tabId, Math.round(left * z), Math.round(top * z), Math.round(width * z), Math.round(height * z), show)
          .catch(() => undefined);
      }
      frame = requestAnimationFrame(sync);
    };
    frame = requestAnimationFrame(sync);
    return () => {
      cancelAnimationFrame(frame);
      api.browser.setBounds(tabId, 0, 0, 0, 0, false).catch(() => undefined);
    };
  }, [tabId, visible]);

  return <div ref={ref} className={className ?? "browser-surface"} />;
}
