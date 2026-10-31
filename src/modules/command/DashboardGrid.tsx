import { Suspense, useMemo } from "react";
import GridLayout, { WidthProvider, type Layout } from "react-grid-layout";
import { GripHorizontal, Info, X } from "lucide-react";
import { useDashboard } from "@/stores/dashboard";
import { useShell } from "@/stores/shell";
import { sameRef } from "@/objects/types";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { WIDGETS, WIDGET_STATUS_LABEL } from "./widgets/registry";
import { Sampling } from "./widgets/common";
import type { DashboardLayout, WidgetInstance } from "@/types/entities";

const Grid = WidthProvider(GridLayout);

export const GRID_COLS = 12;
export const ROW_HEIGHT = 28;
const MARGIN: [number, number] = [10, 10];

export function DashboardGrid({ layout, editing }: { layout: DashboardLayout; editing: boolean }) {
  const setPositions = useDashboard((s) => s.setPositions);

  const items: Layout[] = useMemo(
    () =>
      layout.widgets.map((w) => {
        const def = WIDGETS[w.type];
        return {
          i: w.id,
          x: w.x,
          y: w.y,
          w: w.w,
          h: w.h,
          minW: def?.minSize.w ?? 2,
          minH: def?.minSize.h ?? 3,
        };
      }),
    [layout],
  );

  return (
    <Grid
      className={`dash${editing ? " dash--editing" : ""}`}
      layout={items}
      cols={GRID_COLS}
      rowHeight={ROW_HEIGHT}
      margin={MARGIN}
      containerPadding={[0, 0]}
      isDraggable={editing}
      isResizable={editing}
      draggableHandle=".widget__drag"
      draggableCancel=".widget__nodrag"
      compactType="vertical"
      resizeHandles={["se"]}
      onLayoutChange={(next) => editing && setPositions(next.map(({ i, x, y, w, h }) => ({ id: i, x, y, w, h })))}
    >
      {layout.widgets.map((w) => (
        <div key={w.id}>
          <WidgetFrame instance={w} editing={editing} />
        </div>
      ))}
    </Grid>
  );
}

function WidgetFrame({ instance, editing }: { instance: WidgetInstance; editing: boolean }) {
  const def = WIDGETS[instance.type];
  const select = useShell((s) => s.select);
  const selected = useShell((s) => sameRef(s.selection, { type: "widget", id: instance.id }));
  const removeWidget = useDashboard((s) => s.removeWidget);
  const Body = def?.component;

  return (
    <section
      className="panel widget"
      aria-selected={selected}
      aria-label={def?.title ?? instance.type}
      onMouseDown={() => select({ type: "widget", id: instance.id })}
    >
      <header className={`panel__header${editing ? " widget__drag" : ""}`}>
        {editing && <GripHorizontal size={13} className="muted" />}
        <h2 className="panel__title truncate">{def?.title ?? `Unknown widget: ${instance.type}`}</h2>
        {def && def.status !== "live" && <span className="tag tag--warn">{WIDGET_STATUS_LABEL[def.status]}</span>}
        <div className="panel__actions widget__nodrag">
          {editing ? (
            <button
              className="icon-btn icon-btn--sm"
              aria-label={`Remove ${def?.title ?? "widget"}`}
              title="Remove from layout"
              onClick={() => removeWidget(instance.id)}
            >
              <X size={13} />
            </button>
          ) : (
            def && (
              <span className="widget__info" title={def.dataSource}>
                <Info size={12} />
              </span>
            )
          )}
        </div>
      </header>
      <div className={`panel__body widget__body${editing ? " widget__body--editing" : ""}`}>
        {Body ? (
          <ErrorBoundary compact>
            <Suspense fallback={<Sampling text="Loading…" />}>
              <Body instanceId={instance.id} editing={editing} />
            </Suspense>
          </ErrorBoundary>
        ) : (
          <div className="unavailable">
            {def ? `${def.title} is planned. ${def.dataSource}` : "This widget type is not available in this version."}
          </div>
        )}
      </div>
    </section>
  );
}
