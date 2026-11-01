import { Plus, WandSparkles } from "lucide-react";
import { Dialog } from "@/components/Dialog";
import { newWidgetId, nextFreeY, useDashboard } from "@/stores/dashboard";
import { useShell } from "@/stores/shell";
import { useProfiles } from "@/stores/profiles";
import { useStudioWidgets } from "@/modules/studio/studioStore";
import { PICKER_TYPES, WIDGETS, WIDGET_STATUS_LABEL } from "./widgets/registry";

export function WidgetPicker({ onClose }: { onClose: () => void }) {
  const draft = useDashboard((s) => s.draft);
  const addWidget = useDashboard((s) => s.addWidget);
  const select = useShell((s) => s.select);
  const navigate = useShell((s) => s.navigate);
  const activeId = useProfiles((s) => s.activeId);
  const studio = useStudioWidgets()?.filter((w) => w.profileId === null || w.profileId === activeId) ?? [];
  if (!draft) return null;

  const add = (type: string, config?: Record<string, unknown>) => {
    const def = WIDGETS[type];
    const id = newWidgetId(type, draft.widgets);
    addWidget({ id, type, x: 0, y: nextFreeY(draft.widgets), w: def.defaultSize.w, h: def.defaultSize.h, config });
    select({ type: "widget", id });
    onClose();
  };

  return (
    <Dialog title="Add widget" wide onClose={onClose}>
      <div className="picker">
        {PICKER_TYPES.map((type) => {
          const def = WIDGETS[type];
          const count = draft.widgets.filter((w) => w.type === type).length;
          const planned = def.status === "planned";
          return (
            <div key={type} className="picker__item" data-status={def.status}>
              <def.icon size={20} strokeWidth={1.5} className="picker__icon" />
              <div className="picker__text">
                <div className="picker__title">
                  {def.title}
                  {def.status !== "live" && (
                    <span className={`tag ${planned ? "" : "tag--warn"}`}>{WIDGET_STATUS_LABEL[def.status]}</span>
                  )}
                  {count > 0 && <span className="tag tag--info">On dashboard{count > 1 ? ` ×${count}` : ""}</span>}
                </div>
                <div className="picker__desc">{def.description}</div>
                <div className="picker__src">{def.dataSource}</div>
              </div>
              <button className="btn btn--sm" disabled={planned} onClick={() => add(type)} title={planned ? "Not implemented yet" : undefined}>
                <Plus size={12} /> Add
              </button>
            </div>
          );
        })}
      </div>
      <h3 className="label section-title">
        <WandSparkles size={12} /> Widget Studio
      </h3>
      <div className="picker">
        {studio.map((w) => (
          <div key={w.id} className="picker__item" data-status="live">
            <WandSparkles size={20} strokeWidth={1.5} className="picker__icon" />
            <div className="picker__text">
              <div className="picker__title">{w.name}</div>
              <div className="picker__desc">Custom widget · {w.kind}</div>
            </div>
            <button className="btn btn--sm" onClick={() => add("custom", { "studio.id": w.id, "frame.title": w.name })}>
              <Plus size={12} /> Add
            </button>
          </div>
        ))}
        <button
          className="btn btn--sm btn--ghost"
          onClick={() => {
            onClose();
            navigate("studio");
          }}
        >
          {studio.length ? "Open Widget Studio" : "Build your own widget in Widget Studio"}
        </button>
      </div>
    </Dialog>
  );
}
