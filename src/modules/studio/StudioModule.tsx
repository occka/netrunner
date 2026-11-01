import { useEffect, useState } from "react";
import { Code2, Hash, Layers, LayoutDashboard, Link2, Plus, Rss, Save, Trash2, Type, X } from "lucide-react";
import { emit } from "@tauri-apps/api/event";
import { ModuleHeader } from "@/components/ModuleHeader";
import { api } from "@/services/api";
import { useProfiles } from "@/stores/profiles";
import { confirmAction } from "@/stores/confirm";
import { notify, reportError } from "@/stores/notifications";
import { newWidgetId, nextFreeY } from "@/stores/dashboard";
import { refreshActivity } from "@/stores/activity";
import { useStudio, useStudioWidgets } from "./studioStore";
import { linksOf, num, str, StudioView, type LinkItem } from "./StudioView";
import type { CustomWidget, StudioKind } from "@/types/studio";

const KINDS: { kind: StudioKind; label: string; icon: typeof Code2; hint: string }[] = [
  { kind: "html", label: "HTML / CSS", icon: Code2, hint: "Your own markup and styles in a sandbox (no scripts)" },
  { kind: "text", label: "Text", icon: Type, hint: "A note, a quote, a heading" },
  { kind: "counter", label: "Counter", icon: Hash, hint: "A number with − / + buttons" },
  { kind: "links", label: "Link grid", icon: Link2, hint: "Tiles that open in BROWSER" },
  { kind: "feed", label: "RSS / JSON feed", icon: Rss, hint: "News or an API, only from hosts you allow" },
];
const KIND_LABEL = Object.fromEntries(KINDS.map((k) => [k.kind, k.label])) as Record<StudioKind, string>;

export default function StudioModule() {
  const widgets = useStudioWidgets();
  const profiles = useProfiles((s) => s.profiles);
  const activeId = useProfiles((s) => s.activeId);
  const [scope, setScope] = useState<"profile" | "all">("profile");
  const [selected, setSelected] = useState<number | null>(null);
  const activeName = profiles.find((p) => p.id === activeId)?.name ?? "this profile";

  const shown = widgets?.filter((w) => scope === "all" || w.profileId === null || w.profileId === activeId) ?? [];
  const current = widgets?.find((w) => w.id === selected) ?? null;

  const create = async (kind: StudioKind) => {
    try {
      const n = (widgets?.filter((w) => w.kind === kind).length ?? 0) + 1;
      const w = await api.studio.create(kind, `${KIND_LABEL[kind]} ${n}`);
      await useStudio.getState().load();
      setSelected(w.id);
      refreshActivity();
    } catch (err) {
      reportError("Could not create the widget", err);
    }
  };

  return (
    <div className="module">
      <ModuleHeader id="studio" />
      <div className="studio">
        <aside className="studio__side">
          <div className="segmented">
            <button aria-pressed={scope === "profile"} onClick={() => setScope("profile")}>
              {activeName}
            </button>
            <button aria-pressed={scope === "all"} onClick={() => setScope("all")}>
              All
            </button>
          </div>
          <ul className="studio__list">
            {shown.map((w) => (
              <li key={w.id}>
                <button className="studio__item" aria-pressed={w.id === selected} onClick={() => setSelected(w.id)}>
                  <span>{w.name}</span>
                  <span className="muted">{KIND_LABEL[w.kind]}</span>
                </button>
              </li>
            ))}
            {widgets && shown.length === 0 && <li className="muted studio__none">No custom widgets in {activeName} yet.</li>}
          </ul>
          <h3 className="label">New from template</h3>
          {KINDS.map(({ kind, label, icon: Icon, hint }) => (
            <button key={kind} className="studio__new" title={hint} onClick={() => void create(kind)}>
              <Icon size={14} strokeWidth={1.6} />
              <span>{label}</span>
              <Plus size={12} className="muted" />
            </button>
          ))}
        </aside>
        {current ? (
          <Editor key={current.id} widget={current} onDeleted={() => setSelected(null)} />
        ) : (
          <div className="studio__empty empty">
            Pick a widget or start from a template. Custom widgets live in a profile and can sit on the dashboard or float as overlays.
          </div>
        )}
      </div>
    </div>
  );
}

function Editor({ widget, onDeleted }: { widget: CustomWidget; onDeleted: () => void }) {
  const profiles = useProfiles((s) => s.profiles);
  const activeId = useProfiles((s) => s.activeId);
  const [name, setName] = useState(widget.name);
  const [config, setConfig] = useState<Record<string, unknown>>(widget.config);
  const [busy, setBusy] = useState(false);
  const dirty = name !== widget.name || JSON.stringify(config) !== JSON.stringify(widget.config);
  // A counter changed elsewhere (its buttons) updates the editor unless there are unsaved edits.
  useEffect(() => {
    if (!dirty) setConfig(widget.config);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [widget.config]);

  const set = (k: string, v: unknown) => setConfig((c) => ({ ...c, [k]: v }));
  const save = async () => {
    setBusy(true);
    try {
      await api.studio.update(widget.id, name, config);
      await useStudio.getState().load();
      return true;
    } catch (err) {
      reportError("Could not save the widget", err);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const toDashboard = async () => {
    if (dirty && !(await save())) return;
    const profile = useProfiles.getState().profiles.find((p) => p.id === useProfiles.getState().activeId);
    if (!profile) return;
    const widgets = profile.layout.widgets;
    const instance = {
      id: newWidgetId("custom", widgets),
      type: "custom",
      x: 0,
      y: nextFreeY(widgets),
      w: 3,
      h: widget.kind === "text" || widget.kind === "counter" ? 4 : 7,
      config: { "studio.id": widget.id, "frame.title": name },
    };
    try {
      await useProfiles.getState().saveLayout(profile.id, { ...profile.layout, widgets: [...widgets, instance] });
      notify.info(`${name} is on the ${profile.name} dashboard.`, "Widget Studio");
    } catch (err) {
      reportError("Could not add to the dashboard", err);
    }
  };

  const toOverlay = async () => {
    if (dirty && !(await save())) return;
    try {
      const o = await api.overlays.create("custom");
      await api.overlays.patch(o.id, { config: { "studio.id": widget.id, "frame.title": name } });
      await emit("overlays://changed");
      refreshActivity();
    } catch (err) {
      reportError("Could not open as an overlay", err);
    }
  };

  const remove = async () => {
    const ok = await confirmAction({
      title: "Delete custom widget",
      message: `Delete ${widget.name}? Dashboard and overlay copies will show that it was deleted.`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    try {
      await api.studio.remove(widget.id);
      await useStudio.getState().load();
      onDeleted();
    } catch (err) {
      reportError("Could not delete the widget", err);
    }
  };

  const draft: CustomWidget = { ...widget, name, config };

  return (
    <section className="studio__editor">
      <div className="studio__toolbar">
        <input className="input studio__name" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} />
        <select
          className="select select--sm"
          title="Which profile this widget belongs to"
          value={widget.profileId ?? ""}
          onChange={(e) =>
            void api.studio
              .setProfile(widget.id, e.target.value ? Number(e.target.value) : null)
              .then(() => useStudio.getState().load())
              .catch((err) => reportError("Could not move the widget", err))
          }
        >
          <option value="">All profiles</option>
          {profiles.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
              {p.id === activeId ? " (active)" : ""}
            </option>
          ))}
        </select>
        <button className="btn btn--sm btn--primary" disabled={!dirty || busy} onClick={() => void save()}>
          <Save size={12} /> Save
        </button>
        <button className="btn btn--sm" onClick={() => void toDashboard()} title="Add to the active profile's dashboard">
          <LayoutDashboard size={12} /> Dashboard
        </button>
        <button className="btn btn--sm" onClick={() => void toOverlay()} title="Open as a floating overlay">
          <Layers size={12} /> Overlay
        </button>
        <button className="icon-btn icon-btn--sm" title="Delete" onClick={() => void remove()}>
          <Trash2 size={13} />
        </button>
      </div>
      <div className="studio__body">
        <div className="studio__form">
          {widget.kind === "html" && <HtmlForm config={config} set={set} />}
          {widget.kind === "text" && <TextForm config={config} set={set} />}
          {widget.kind === "counter" && <CounterForm config={config} set={set} />}
          {widget.kind === "links" && <LinksForm config={config} set={set} />}
          {widget.kind === "feed" && <FeedForm config={config} set={set} />}
        </div>
        <div className="studio__preview">
          <div className="label">Preview{widget.kind === "feed" && dirty ? " (save to fetch with the new settings)" : ""}</div>
          <div className="studio__preview-box widget">
            <StudioView widget={widget.kind === "feed" ? widget : draft} preview />
          </div>
        </div>
      </div>
    </section>
  );
}

type FormProps = { config: Record<string, unknown>; set: (k: string, v: unknown) => void };

function HtmlForm({ config, set }: FormProps) {
  return (
    <>
      <p className="muted studio__note">
        Runs in a sandbox: no JavaScript, no network, no access to NETRUNNER. Images and fonts only as <code>data:</code> URLs. Theme colours
        are available as CSS variables, e.g. <code>var(--c-primary)</code>, <code>var(--c-text)</code>, <code>var(--font-display)</code>.
      </p>
      <label className="studio__field">
        <span className="label">HTML</span>
        <textarea className="textarea studio__code" spellCheck={false} value={str(config.html)} onChange={(e) => set("html", e.target.value)} />
      </label>
      <label className="studio__field">
        <span className="label">CSS</span>
        <textarea className="textarea studio__code" spellCheck={false} value={str(config.css)} onChange={(e) => set("css", e.target.value)} />
      </label>
    </>
  );
}

function TextForm({ config, set }: FormProps) {
  return (
    <>
      <label className="studio__field">
        <span className="label">Text</span>
        <textarea className="textarea" rows={6} maxLength={8000} value={str(config.text)} onChange={(e) => set("text", e.target.value)} />
      </label>
      <label className="studio__field studio__field--row">
        <span className="label">Size</span>
        <input type="range" min={10} max={72} value={num(config.size, 18)} onChange={(e) => set("size", Number(e.target.value))} />
        <span className="mono muted">{num(config.size, 18)} px</span>
      </label>
      <div className="studio__field studio__field--row">
        <span className="label">Align</span>
        <div className="segmented">
          {["left", "center", "right"].map((a) => (
            <button key={a} aria-pressed={str(config.align, "left") === a} onClick={() => set("align", a)}>
              {a}
            </button>
          ))}
        </div>
      </div>
      <label className="studio__field studio__field--row">
        <span className="label">Font</span>
        <select className="select select--sm" value={str(config.font, "body")} onChange={(e) => set("font", e.target.value)}>
          <option value="body">Interface</option>
          <option value="display">Display</option>
          <option value="mono">Monospace</option>
        </select>
        <span className="label">Colour</span>
        <select className="select select--sm" value={str(config.color, "text")} onChange={(e) => set("color", e.target.value)}>
          <option value="text">Text</option>
          <option value="primary">Primary accent</option>
          <option value="secondary">Secondary accent</option>
          <option value="muted">Muted</option>
        </select>
      </label>
    </>
  );
}

function CounterForm({ config, set }: FormProps) {
  return (
    <>
      <label className="studio__field">
        <span className="label">Label</span>
        <input className="input" maxLength={40} value={str(config.label)} onChange={(e) => set("label", e.target.value)} />
      </label>
      <label className="studio__field studio__field--row">
        <span className="label">Step</span>
        <input className="input mono" type="number" min={1} value={num(config.step, 1)} onChange={(e) => set("step", Math.max(1, Number(e.target.value) || 1))} />
        <span className="label">Value</span>
        <input className="input mono" type="number" value={num(config.value, 0)} onChange={(e) => set("value", Number(e.target.value) || 0)} />
      </label>
    </>
  );
}

function LinksForm({ config, set }: FormProps) {
  const links = linksOf(config);
  const update = (next: LinkItem[]) => set("links", next);
  return (
    <>
      <p className="muted studio__note">Links open as NETRUNNER BROWSER tabs. Only http(s) addresses are allowed.</p>
      {links.map((l, i) => (
        <div key={i} className="studio__field studio__field--row">
          <input className="input" placeholder="Title" maxLength={80} value={l.title} onChange={(e) => update(links.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)))} />
          <input className="input" placeholder="https://…" value={l.url} onChange={(e) => update(links.map((x, j) => (j === i ? { ...x, url: e.target.value } : x)))} />
          <button className="icon-btn icon-btn--sm" title="Remove" onClick={() => update(links.filter((_, j) => j !== i))}>
            <X size={12} />
          </button>
        </div>
      ))}
      <button className="btn btn--sm" disabled={links.length >= 48} onClick={() => update([...links, { title: "", url: "https://" }])}>
        <Plus size={12} /> Link
      </button>
    </>
  );
}

function FeedForm({ config, set }: FormProps) {
  const allow = Array.isArray(config.allow) ? (config.allow as string[]) : [];
  const [allowText, setAllowText] = useState(allow.join(", "));
  const host = (() => {
    try {
      return new URL(str(config.url)).hostname;
    } catch {
      return "";
    }
  })();
  const setAllow = (text: string) => {
    setAllowText(text);
    set(
      "allow",
      text
        .split(/[,\s]+/)
        .map((h) => h.trim().toLowerCase())
        .filter(Boolean),
    );
  };
  const json = str(config.format, "rss") === "json";
  return (
    <>
      <p className="muted studio__note">
        NETRUNNER fetches the feed itself, only from hosts on this widget's allowlist (subdomains included), at most every 5 minutes. Only
        text, links and dates reach the widget; markup and scripts are removed.
      </p>
      <label className="studio__field">
        <span className="label">Address</span>
        <input className="input mono" placeholder="https://example.com/feed.xml" value={str(config.url)} onChange={(e) => set("url", e.target.value.trim())} />
      </label>
      <label className="studio__field">
        <span className="label">Allowed hosts</span>
        <div className="studio__field--row">
          <input className="input mono" placeholder="example.com, api.example.org" value={allowText} onChange={(e) => setAllow(e.target.value)} />
          <button
            className="btn btn--sm"
            disabled={!host || allow.includes(host)}
            onClick={() => setAllow([...allow, host].join(", "))}
            title="Add the address's host to the allowlist"
          >
            Allow {host || "host"}
          </button>
        </div>
      </label>
      <div className="studio__field studio__field--row">
        <span className="label">Format</span>
        <select className="select select--sm" value={str(config.format, "rss")} onChange={(e) => set("format", e.target.value)}>
          <option value="rss">RSS / Atom / JSON Feed</option>
          <option value="json">JSON API</option>
        </select>
        <span className="label">Items</span>
        <input className="input mono" type="number" min={1} max={50} value={num(config.limit, 10)} onChange={(e) => set("limit", Number(e.target.value) || 10)} />
        <span className="label">Every (min)</span>
        <input className="input mono" type="number" min={5} value={num(config.refresh, 30)} onChange={(e) => set("refresh", Math.max(5, Number(e.target.value) || 30))} />
      </div>
      {json && (
        <div className="studio__grid">
          {(
            [
              ["itemsPath", "Items path", "data.items"],
              ["titleField", "Title field", "title"],
              ["linkField", "Link field", "url"],
              ["dateField", "Date field", "published_at"],
            ] as const
          ).map(([k, label, ph]) => (
            <label key={k} className="studio__field">
              <span className="label">{label}</span>
              <input className="input mono" placeholder={ph} value={str(config[k])} onChange={(e) => set(k, e.target.value)} />
            </label>
          ))}
        </div>
      )}
    </>
  );
}
