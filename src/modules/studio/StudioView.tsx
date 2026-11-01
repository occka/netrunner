import { useCallback, useEffect, useMemo, useState } from "react";
import { ExternalLink, Minus, Plus, RefreshCw, RotateCcw } from "lucide-react";
import { api } from "@/services/api";
import { useSettings } from "@/stores/settings";
import { reportError } from "@/stores/notifications";
import { THEME_TOKENS } from "@/styles/theme";
import type { CustomWidget, FeedResult } from "@/types/studio";

/** Renders any Widget Studio widget. `preview` is the unsaved editor state (no side effects). */
export function StudioView({ widget, preview = false }: { widget: CustomWidget; preview?: boolean }) {
  switch (widget.kind) {
    case "html":
      return <HtmlFrame html={str(widget.config.html)} css={str(widget.config.css)} />;
    case "text":
      return <TextView config={widget.config} />;
    case "counter":
      return <Counter widget={widget} preview={preview} />;
    case "links":
      return <Links config={widget.config} />;
    case "feed":
      return <Feed widget={widget} />;
  }
}

export const str = (v: unknown, d = "") => (typeof v === "string" ? v : d);
export const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);

const openLink = (url: string) => void api.studio.openLink(url).catch((err) => reportError("Could not open the link", err));

function hostOf(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/**
 * Own HTML/CSS in a frame with `sandbox=""`: no scripts, an opaque origin (no
 * NETRUNNER IPC, storage or cookies), no forms, popups or navigation of the
 * app. Its own CSP allows no network at all: images and fonts only as data:.
 * Theme colours are passed in as the same CSS variables the app uses.
 */
export function HtmlFrame({ html, css }: { html: string; css: string }) {
  const theme = useSettings((s) => s.values.theme);
  const doc = useMemo(() => {
    const root = getComputedStyle(document.documentElement);
    const vars = [
      ...THEME_TOKENS.flatMap((t) => [`--c-${t}`, `--c-${t}-rgb`]),
      "--font-body",
      "--font-display",
      "--font-mono",
      "--radius",
    ]
      .map((v) => `${v}:${root.getPropertyValue(v).trim()};`)
      .join("");
    // Same colour scheme as the app, or Chromium paints an opaque white frame behind a transparent page.
    return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'">
<style>:root{${vars}color-scheme:${root.colorScheme || "normal"}}html,body{margin:0;background:transparent;color:var(--c-text);font:13px/1.45 var(--font-body);overflow:auto}a{color:var(--c-secondary)}*{box-sizing:border-box}</style>
<style>${css.replace(/<\/style/gi, "<\\/style")}</style></head><body>${html}</body></html>`;
    // `theme` changes the variables read above.
  }, [html, css, theme]);
  return <iframe className="studio-frame" sandbox="" srcDoc={doc} title="Custom widget" referrerPolicy="no-referrer" />;
}

function TextView({ config }: { config: Record<string, unknown> }) {
  const font = str(config.font, "body");
  return (
    <div
      className="studio-text"
      data-color={str(config.color, "text")}
      style={{
        fontSize: num(config.size, 18),
        textAlign: (str(config.align, "left") as "left" | "center" | "right") ?? "left",
        fontFamily: `var(--font-${font === "display" || font === "mono" ? font : "body"})`,
      }}
    >
      {str(config.text)}
    </div>
  );
}

function Counter({ widget, preview }: { widget: CustomWidget; preview: boolean }) {
  const [value, setValue] = useState(num(widget.config.value, 0));
  useEffect(() => setValue(num(widget.config.value, 0)), [widget.config.value]);
  const step = num(widget.config.step, 1) || 1;
  const set = (v: number) => {
    setValue(v);
    if (!preview) void api.studio.counter(widget.id, v).catch((err) => reportError("Could not save the counter", err));
  };
  return (
    <div className="studio-counter">
      <div className="label">{str(widget.config.label, "Counter")}</div>
      <div className="studio-counter__value mono">{value}</div>
      <div className="studio-counter__buttons">
        <button className="btn btn--sm" onClick={() => set(value - step)} title={`−${step}`}>
          <Minus size={13} />
        </button>
        <button className="btn btn--sm btn--ghost" onClick={() => set(0)} title="Reset to 0">
          <RotateCcw size={12} />
        </button>
        <button className="btn btn--sm btn--primary" onClick={() => set(value + step)} title={`+${step}`}>
          <Plus size={13} />
        </button>
      </div>
    </div>
  );
}

export interface LinkItem {
  title: string;
  url: string;
}

export function linksOf(config: Record<string, unknown>): LinkItem[] {
  return Array.isArray(config.links)
    ? (config.links as unknown[]).map((l) => {
        const o = (l && typeof l === "object" ? l : {}) as Record<string, unknown>;
        return { title: str(o.title), url: str(o.url) };
      })
    : [];
}

function Links({ config }: { config: Record<string, unknown> }) {
  const links = linksOf(config).filter((l) => /^https?:\/\//i.test(l.url));
  if (!links.length) return <div className="empty">No links yet.</div>;
  return (
    <div className="studio-links">
      {links.map((l, i) => (
        <button key={i} className="studio-link" title={l.url} onClick={() => openLink(l.url)}>
          <span className="studio-link__badge">{(l.title || hostOf(l.url)).slice(0, 1).toUpperCase()}</span>
          <span className="studio-link__title">{l.title || hostOf(l.url)}</span>
          <span className="studio-link__host muted">{hostOf(l.url)}</span>
        </button>
      ))}
    </div>
  );
}

function ago(ms: number) {
  const m = Math.round((Date.now() - ms) / 60000);
  if (m < 1) return "now";
  if (m < 60) return `${m} min`;
  if (m < 48 * 60) return `${Math.round(m / 60)} h`;
  return new Date(ms).toLocaleDateString();
}

function Feed({ widget }: { widget: CustomWidget }) {
  const [data, setData] = useState<FeedResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const refresh = Math.max(5, num(widget.config.refresh, 30));

  const load = useCallback(
    async (force: boolean) => {
      setBusy(true);
      try {
        setData(await api.studio.feed(widget.id, force));
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [widget.id],
  );

  // Reload when the saved widget changes (address, allowlist) and on its refresh interval.
  useEffect(() => {
    void load(false);
    const t = window.setInterval(() => !document.hidden && void load(false), refresh * 60000);
    return () => window.clearInterval(t);
  }, [load, refresh, widget.updatedAt]);

  return (
    <div className="studio-feed">
      <div className="studio-feed__bar muted">
        <span>{data ? `Updated ${ago(data.fetchedAt) === "now" ? "just now" : `${ago(data.fetchedAt)} ago`}` : busy ? "Loading…" : ""}</span>
        <button className="icon-btn icon-btn--sm" title="Refresh (at most once a minute)" disabled={busy} onClick={() => void load(true)}>
          <RefreshCw size={12} />
        </button>
      </div>
      {error && <div className="unavailable">{error}</div>}
      {data && data.items.length === 0 && !error && <div className="empty">The feed has no items.</div>}
      <ul className="studio-feed__list">
        {data?.items.map((it, i) => (
          <li key={i}>
            <button className="studio-feed__item" disabled={!it.link} title={it.summary || it.title} onClick={() => it.link && openLink(it.link)}>
              <span className="studio-feed__title">{it.title}</span>
              <span className="muted">
                {it.link ? hostOf(it.link) : ""}
                {it.date ? ` · ${ago(it.date)}` : ""}
                {it.link && <ExternalLink size={10} />}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
