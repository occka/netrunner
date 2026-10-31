import { Plus } from "lucide-react";
import { Dialog } from "@/components/Dialog";
import { newWidgetId, nextFreeY, useDashboard } from "@/stores/dashboard";
import { useShell } from "@/stores/shell";
import { WIDGETS, WIDGET_STATUS_LABEL, WIDGET_TYPES } from "./widgets/registry";

export function WidgetPicker({ onClose }: { onClose: () => void }) {
  const draft = useDashboard((s) => s.draft);
  const addWidget = useDashboard((s) => s.addWidget);
  const select = useShell((s) => s.select);
  if (!draft) return null;

  const add = (type: string) => {
    const def = WIDGETS[type];
    const id = newWidgetId(type, draft.widgets);
    addWidget({ id, type, x: 0, y: nextFreeY(draft.widgets), w: def.defaultSize.w, h: def.defaultSize.h });
    select({ type: "widget", id });
    onClose();
  };

  return (
    <Dialog title="Add widget" wide onClose={onClose}>
      <div className="picker">
        {WIDGET_TYPES.map((type) => {
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
    </Dialog>
  );
}
