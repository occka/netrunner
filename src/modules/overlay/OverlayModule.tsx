import { useEffect, useState, type FormEvent } from "react";
import { emit } from "@tauri-apps/api/event";
import { Eye, EyeOff, Globe, Layers, Lock, MousePointerClick, MousePointerBan, Plus, Settings2, Trash2, Unlock } from "lucide-react";
import { Dialog } from "@/components/Dialog";
import { WidgetSettingsForm } from "@/modules/command/WidgetSettingsForm";
import { ModuleHeader } from "@/components/ModuleHeader";
import { api } from "@/services/api";
import { usePolled } from "@/hooks/usePolled";
import { confirmAction } from "@/stores/confirm";
import { reportError } from "@/stores/notifications";
import { useProfiles } from "@/stores/profiles";
import { useSetting, useSettings } from "@/stores/settings";
import { refreshActivity } from "@/stores/activity";
import { WIDGETS, WIDGET_TYPES, widgetSchema } from "@/modules/command/widgets/registry";
import type { Overlay } from "@/types/phase2";

const OVERLAY_TYPES = WIDGET_TYPES.filter((t) => WIDGETS[t].component);

/** Starting points for music and video overlays; any http(s) address works. */
const WEB_PRESETS: { title: string; url: string; kind: "Music" | "Video" }[] = [
  { title: "YouTube", url: "https://www.youtube.com/", kind: "Video" },
  { title: "YouTube Music", url: "https://music.youtube.com/", kind: "Music" },
  { title: "SoundCloud", url: "https://soundcloud.com/discover", kind: "Music" },
  { title: "Spotify", url: "https://open.spotify.com/", kind: "Music" },
  { title: "Yandex Music", url: "https://music.yandex.ru/", kind: "Music" },
  { title: "Twitch", url: "https://www.twitch.tv/", kind: "Video" },
  { title: "VK Video", url: "https://vkvideo.ru/", kind: "Video" },
];

const overlayName = (o: Overlay) => (o.widgetType === "web" ? o.title || o.url : WIDGETS[o.widgetType]?.title ?? o.widgetType);

export default function OverlayModule() {
  const { data, reload, setData } = usePolled(() => api.overlays.list());
  const [configuring, setConfiguring] = useState<Overlay | null>(null);
  const [url, setUrl] = useState("");
  const [scope, setScope] = useState<"profile" | "all">("profile");
  const snap = useSetting("overlay.snap");
  const profiles = useProfiles((s) => s.profiles);
  const activeId = useProfiles((s) => s.activeId);
  const activeName = profiles.find((p) => p.id === activeId)?.name ?? "this profile";
  const profileName = (id: number | null) => (id === null ? "every profile" : (profiles.find((p) => p.id === id)?.name ?? `profile #${id}`));
  const inSet = (o: Overlay) => o.profileId === null || o.profileId === activeId;
  const shown = data?.filter((o) => scope === "all" || inSet(o));

  // A profile switch (also from automation or the palette) opens and closes overlays in the backend.
  useEffect(() => void reload(), [activeId, reload]);

  const changed = async (o?: Overlay) => {
    if (o) setData((list) => list?.map((x) => (x.id === o.id ? o : x)) ?? null);
    await emit("overlays://changed");
  };

  const act = async (fn: () => Promise<unknown>, title: string) => {
    try {
      await fn();
      await reload();
      await changed();
      refreshActivity();
    } catch (err) {
      reportError(title, err);
    }
  };

  const patch = async (o: Overlay, p: Partial<Pick<Overlay, "opacity" | "locked" | "showOnStartup" | "config" | "clickThrough">>) => {
    try {
      await changed(await api.overlays.patch(o.id, p));
    } catch (err) {
      reportError("Could not update overlay", err);
    }
  };

  const remove = async (o: Overlay) => {
    if (!(await confirmAction({ title: "Remove overlay", message: `Remove the ${overlayName(o)} overlay?`, confirmLabel: "Remove", danger: true })))
      return;
    await act(() => api.overlays.remove(o.id), "Could not remove overlay");
  };

  return (
    <div className="module">
      <ModuleHeader id="overlay">
        <button className="btn" onClick={() => void api.overlays.toggleAll()} title="Same as Ctrl+Alt+O">
          <Layers size={14} /> Hide / show all
        </button>
      </ModuleHeader>
      <div className="module__scroll">
        <p className="muted integrations-intro">
          Overlays are independent always-on-top windows. Drag them by their title bar and resize from the edges. They stay
          above windowed and borderless-fullscreen games; exclusive fullscreen draws over them, and NETRUNNER never injects
          into game processes. <kbd>Ctrl</kbd> <kbd>Alt</kbd> <kbd>O</kbd> hides or shows all overlays.
        </p>
        <p className="muted integrations-intro">
          A <b>click-through</b> overlay lets the mouse pass to the window below while it is locked, so it can sit over a game or
          video. Unlock it here or with <b>Unlock click-through overlays</b> in the tray menu.
        </p>
        <label className="check overlay-snap">
          <input type="checkbox" checked={snap} onChange={(e) => void useSettings.getState().set("overlay.snap", e.target.checked)} />
          Snap overlays to screen edges and to each other while moving or resizing
        </label>
        <p className="muted integrations-intro">
          Each profile has its own overlay set: a new overlay joins the active profile (<b>{activeName}</b>), and switching profile
          closes the previous set and opens the new one. Set an overlay to <b>All profiles</b> to keep it everywhere.
        </p>
        <h2 className="label section-title">New overlay</h2>
        <div className="overlay-types">
          {OVERLAY_TYPES.map((t) => {
            const def = WIDGETS[t];
            return (
              <button key={t} className="overlay-type" onClick={() => void act(() => api.overlays.create(t), "Could not create overlay")}>
                <def.icon size={16} strokeWidth={1.5} />
                {def.title}
                <Plus size={12} className="muted" />
              </button>
            );
          })}
        </div>
        <h2 className="label section-title">Music and video</h2>
        <p className="muted integrations-intro">
          A web overlay is a floating window with a page from the NETRUNNER browser: same ad blocking, tracking protection and sign-ins.
          Press the site's fullscreen button to fill the overlay with the video. The Music Player widget controls whatever plays. You can
          also move a playing BROWSER tab into an overlay with its picture-in-picture button.
        </p>
        <div className="overlay-types">
          {WEB_PRESETS.map((p) => (
            <button
              key={p.url}
              className="overlay-type"
              title={p.url}
              onClick={() => void act(() => api.overlays.createWeb(p.url, p.title), "Could not create overlay")}
            >
              <Globe size={16} strokeWidth={1.5} />
              {p.title}
              <span className="tag">{p.kind}</span>
            </button>
          ))}
        </div>
        <form
          className="input-row overlay-url"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            const target = /^https?:\/\//i.test(url.trim()) ? url.trim() : `https://${url.trim()}`;
            void act(() => api.overlays.createWeb(target, ""), "Could not create overlay").then(() => setUrl(""));
          }}
        >
          <input className="input" placeholder="Any page: https://…" value={url} onChange={(e) => setUrl(e.target.value)} />
          <button className="btn" disabled={!url.trim()}>
            <Plus size={13} /> Web overlay
          </button>
        </form>
        <div className="overlay-list-head">
          <h2 className="label section-title">Overlays</h2>
          <div className="segmented">
            <button aria-pressed={scope === "profile"} onClick={() => setScope("profile")}>
              {activeName}
            </button>
            <button aria-pressed={scope === "all"} onClick={() => setScope("all")}>
              All profiles
            </button>
          </div>
        </div>
        {data?.length === 0 && <div className="empty">No overlays yet. Pick a widget above to create one.</div>}
        {!!data?.length && shown?.length === 0 && (
          <div className="empty">{activeName} has no overlays yet. Create one above, or move one here from All profiles.</div>
        )}
        <table className="table">
          <tbody>
            {shown?.map((o) => (
              <tr key={o.id} className={inSet(o) ? undefined : "row--dim"}>
                <td>
                  {overlayName(o)}
                  <div className="muted cell-sub mono">
                    {o.widgetType === "web" && <>{o.url.slice(0, 60)} · </>}
                    #{o.id} · {o.width}×{o.height} at {o.x},{o.y}
                  </div>
                  {!inSet(o) && <div className="muted cell-sub">Opens when {profileName(o.profileId)} is active</div>}
                </td>
                <td>
                  <select
                    className="select select--sm"
                    title="Which profile's overlay set this belongs to"
                    value={o.profileId ?? ""}
                    onChange={(e) =>
                      void act(() => api.overlays.setProfile(o.id, e.target.value ? Number(e.target.value) : null), "Could not move overlay")
                    }
                  >
                    <option value="">All profiles</option>
                    {profiles.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <button className="btn btn--sm" onClick={() => void act(() => api.overlays.setVisible(o.id, !o.visible), "Could not toggle overlay")}>
                    {o.visible ? <EyeOff size={12} /> : <Eye size={12} />} {o.visible ? "Hide" : "Show"}
                  </button>
                </td>
                <td style={{ width: 190 }}>
                  <label className="opacity">
                    <span className="label">Opacity</span>
                    <input
                      type="range"
                      min={20}
                      max={100}
                      value={Math.round(o.opacity * 100)}
                      onChange={(e) => void patch(o, { opacity: Number(e.target.value) / 100 })}
                    />
                    <span className="mono">{Math.round(o.opacity * 100)}%</span>
                  </label>
                </td>
                <td>
                  <button className="btn btn--sm btn--ghost" onClick={() => void patch(o, { locked: !o.locked })}>
                    {o.locked ? <Lock size={12} /> : <Unlock size={12} />} {o.locked ? "Locked" : "Movable"}
                  </button>
                </td>
                <td>
                  <button
                    className="btn btn--sm btn--ghost"
                    aria-pressed={o.clickThrough}
                    title={
                      o.clickThrough
                        ? o.locked
                          ? "The mouse passes through this overlay. Click to make it clickable."
                          : "Will let the mouse pass through once locked"
                        : "Let the mouse pass through this overlay while it is locked"
                    }
                    onClick={() => void patch(o, { clickThrough: !o.clickThrough })}
                  >
                    {o.clickThrough ? <MousePointerBan size={12} /> : <MousePointerClick size={12} />}
                    {o.clickThrough ? (o.locked ? "Click-through" : "Click-through (when locked)") : "Clickable"}
                  </button>
                </td>
                <td>
                  <label className="check">
                    <input type="checkbox" checked={o.showOnStartup} onChange={(e) => void patch(o, { showOnStartup: e.target.checked })} />
                    Show on startup
                  </label>
                </td>
                <td className="actions">
                  {o.widgetType !== "web" && (
                    <button className="icon-btn icon-btn--sm" title="Widget settings" onClick={() => setConfiguring(o)}>
                      <Settings2 size={13} />
                    </button>
                  )}
                  <button className="icon-btn icon-btn--sm" title="Remove" onClick={() => void remove(o)}>
                    <Trash2 size={13} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted qa-hint">Widget Studio (custom widgets built from HTML) is planned.</p>
      </div>
      {configuring && (
        <Dialog title={`${overlayName(configuring)} · settings`} onClose={() => setConfiguring(null)} icon={<Settings2 size={15} />}>
          <p className="muted">Changes apply to the overlay immediately.</p>
          <WidgetSettingsForm
            schema={widgetSchema(WIDGETS[configuring.widgetType])}
            config={configuring.config}
            onChange={(config) => {
              setConfiguring({ ...configuring, config });
              void patch(configuring, { config });
            }}
          />
        </Dialog>
      )}
    </div>
  );
}
