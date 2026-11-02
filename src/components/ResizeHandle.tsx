import { useEffect } from "react";
import { useSettings } from "@/stores/settings";
import { reportError } from "@/stores/notifications";

const cssVar = (pane: string) => `--pane-${pane}`;

/** Applies the saved pane sizes as CSS variables, which the layouts read. */
export function usePaneSizes() {
  const panes = useSettings((s) => s.values["ui.panes"]);
  useEffect(() => {
    const style = document.documentElement.style;
    for (const name of [...style].filter((n) => n.startsWith("--pane-"))) style.removeProperty(name);
    for (const [pane, size] of Object.entries(panes)) style.setProperty(cssVar(pane), `${size}px`);
  }, [panes]);
}

function save(pane: string, size: number | null) {
  const next = { ...useSettings.getState().values["ui.panes"] };
  if (size === null) delete next[pane];
  else next[pane] = Math.round(size);
  useSettings
    .getState()
    .set("ui.panes", next)
    .catch((err) => reportError("Could not save the panel size", err));
}

/**
 * A draggable divider between two panes. It sits in the layout as a zero-size
 * item next to the pane it sizes: `of="prev"` / `"next"` is that sibling,
 * `"parent"` the element it is inside. The size is a CSS variable, so the
 * layout's own stylesheet keeps the default. Double click resets.
 */
export function ResizeHandle({
  pane,
  of,
  axis = "x",
  min = 140,
  max = 1200,
  rest = 240,
}: {
  pane: string;
  of: "prev" | "next" | "parent";
  axis?: "x" | "y";
  min?: number;
  max?: number;
  /** Space the neighbouring pane keeps. */
  rest?: number;
}) {
  const parts = (el: HTMLElement) => {
    const target = of === "parent" ? el.parentElement : of === "prev" ? el.previousElementSibling : el.nextElementSibling;
    const other = of === "parent" ? null : of === "prev" ? el.nextElementSibling : el.previousElementSibling;
    const size = (n: Element | null | undefined) => (n ? (axis === "x" ? n.getBoundingClientRect().width : n.getBoundingClientRect().height) : 0);
    const start = size(target);
    return { start, limit: Math.min(max, other ? Math.max(min, start + size(other) - rest) : max) };
  };
  const clamp = (v: number, limit: number) => Math.max(min, Math.min(limit, v));
  const direction = of === "next" ? -1 : 1;

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const el = e.currentTarget;
    const { start, limit } = parts(el);
    const origin = axis === "x" ? e.clientX : e.clientY;
    let latest = start;
    el.setPointerCapture(e.pointerId);
    document.body.dataset.resizing = axis;
    const onMove = (ev: PointerEvent) => {
      latest = clamp(start + direction * ((axis === "x" ? ev.clientX : ev.clientY) - origin), limit);
      document.documentElement.style.setProperty(cssVar(pane), `${latest}px`);
    };
    const onUp = () => {
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
      delete document.body.dataset.resizing;
      if (latest !== start) save(pane, latest);
    };
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const back = axis === "x" ? "ArrowLeft" : "ArrowUp";
    const forward = axis === "x" ? "ArrowRight" : "ArrowDown";
    if (e.key !== back && e.key !== forward) return;
    e.preventDefault();
    const { start, limit } = parts(e.currentTarget);
    save(pane, clamp(start + direction * (e.key === forward ? 20 : -20), limit));
  };

  return (
    <div
      className={`pane-handle pane-handle--${axis}${of === "parent" ? " pane-handle--edge" : ""}`}
      role="separator"
      tabIndex={0}
      aria-orientation={axis === "x" ? "vertical" : "horizontal"}
      aria-label="Resize panel"
      title="Drag to resize · double click to reset"
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      onDoubleClick={() => save(pane, null)}
    />
  );
}
