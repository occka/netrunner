import { emit } from "@tauri-apps/api/event";
import { Eye, EyeOff, Layers, Lock, Plus, Trash2, Unlock } from "lucide-react";
import { ModuleHeader } from "@/components/ModuleHeader";
import { api } from "@/services/api";
import { usePolled } from "@/hooks/usePolled";
import { confirmAction } from "@/stores/confirm";
import { reportError } from "@/stores/notifications";
import { refreshActivity } from "@/stores/activity";
import { WIDGETS, WIDGET_TYPES } from "@/modules/command/widgets/registry";
import type { Overlay } from "@/types/phase2";

const OVERLAY_TYPES = WIDGET_TYPES.filter((t) => WIDGETS[t].component);

export default function OverlayModule() {
  const { data, reload, setData } = usePolled(() => api.overlays.list());

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

  const patch = async (o: Overlay, p: Partial<Pick<Overlay, "opacity" | "locked" | "showOnStartup">>) => {
    try {
      await changed(await api.overlays.patch(o.id, p));
    } catch (err) {
      reportError("Could not update overlay", err);
    }
  };

  const remove = async (o: Overlay) => {
    if (!(await confirmAction({ title: "Remove overlay", message: `Remove the ${WIDGETS[o.widgetType]?.title ?? o.widgetType} overlay?`, confirmLabel: "Remove", danger: true })))
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
        <h2 className="label section-title">Overlays</h2>
        {data?.length === 0 && <div className="empty">No overlays yet. Pick a widget above to create one.</div>}
        <table className="table">
          <tbody>
            {data?.map((o) => (
              <tr key={o.id}>
                <td>
                  {WIDGETS[o.widgetType]?.title ?? o.widgetType}
                  <div className="muted cell-sub mono">
                    #{o.id} · {o.width}×{o.height} at {o.x},{o.y}
                  </div>
                </td>
                <td>
                  <button className="btn btn--sm" onClick={() => void act(() => api.overlays.setVisible(o.id, !o.visible), "Could not toggle overlay")}>
                    {o.visible ? <EyeOff size={12} /> : <Eye size={12} />} {o.visible ? "Hide" : "Show"}
                  </button>
                </td>
                <td style={{ width: 220 }}>
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
                  <label className="check">
                    <input type="checkbox" checked={o.showOnStartup} onChange={(e) => void patch(o, { showOnStartup: e.target.checked })} />
                    Show on startup
                  </label>
                </td>
                <td className="actions">
                  <button className="icon-btn icon-btn--sm" title="Remove" onClick={() => void remove(o)}>
                    <Trash2 size={13} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted qa-hint">Widget Studio (custom BASIC / WEB / ADVANCED widgets) and web overlays such as SoundCloud are planned for Phase 5.</p>
      </div>
    </div>
  );
}
