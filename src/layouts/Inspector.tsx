import { useCallback, useEffect, useState, type PointerEvent as ReactPointerEvent } from "react";
import { BrainCircuit, MousePointerClick, PanelRightClose, Pin, PinOff } from "lucide-react";
import { WidgetSettingsForm } from "@/modules/command/WidgetSettingsForm";
import { useShell } from "@/stores/shell";
import { useSetting, useSettings } from "@/stores/settings";
import { useQuickAccess } from "@/stores/quickAccess";
import { useProfiles } from "@/stores/profiles";
import { useDashboard } from "@/stores/dashboard";
import { reportError } from "@/stores/notifications";
import { resolveObject } from "@/objects/resolve";
import { sameRef, type NrObject, type ObjectRef } from "@/objects/types";

type Section = "overview" | "settings" | "actions" | "details" | "ai";
const SECTIONS: { id: Section; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "settings", label: "Settings" },
  { id: "actions", label: "Actions" },
  { id: "details", label: "Details" },
  { id: "ai", label: "AI" },
];

/** Re-resolves the object whenever any store it can depend on changes. */
function useNrObject(ref: ObjectRef | null): NrObject | null {
  useQuickAccess((s) => s.entries);
  useProfiles((s) => s.profiles);
  useProfiles((s) => s.activeId);
  useDashboard((s) => s.draft);
  useDashboard((s) => s.editing);
  return ref ? resolveObject(ref) : null;
}

export function Inspector() {
  const visible = useSetting("inspector.visible");
  const storedWidth = useSetting("inspector.width");
  const selection = useShell((s) => s.selection);
  const pinned = useShell((s) => s.pinned);
  const pin = useShell((s) => s.pin);
  const [width, setWidth] = useState(storedWidth);
  const [section, setSection] = useState<Section>("overview");
  const ref = pinned ?? selection;
  const object = useNrObject(ref);
  const requestedTab = useShell((s) => s.inspectorTab);

  useEffect(() => setWidth(storedWidth), [storedWidth]);

  // A widget's gear button asks for SETTINGS; make sure the panel is visible too.
  useEffect(() => {
    if (!requestedTab) return;
    setSection(requestedTab as Section);
    useShell.setState({ inspectorTab: null });
    if (!useSettings.getState().values["inspector.visible"]) {
      useSettings
        .getState()
        .set("inspector.visible", true)
        .catch((err) => reportError("Could not save inspector state", err));
    }
  }, [requestedTab]);

  const onResizeStart = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const startX = e.clientX;
      const startW = width;
      let latest = startW;
      const onMove = (ev: PointerEvent) => {
        latest = Math.min(520, Math.max(240, startW + (startX - ev.clientX)));
        setWidth(latest);
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        useSettings
          .getState()
          .set("inspector.width", Math.round(latest))
          .catch((err) => reportError("Could not save inspector width", err));
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [width],
  );

  if (!visible) return null;

  // A previous object's SETTINGS tab falls back to OVERVIEW for objects without settings.
  const shown: Section = section === "settings" && !object?.settings ? "overview" : section;
  const isPinned = !!pinned && !!object && sameRef(pinned, object.ref);

  return (
    <aside className="inspector" style={{ width }} aria-label="Inspector">
      <div className="inspector__resize" onPointerDown={onResizeStart} role="separator" aria-orientation="vertical" />
      <div className="inspector__head">
        <span className="label">Inspector</span>
        <div className="panel__actions">
          <button
            className="icon-btn icon-btn--sm"
            aria-pressed={isPinned}
            disabled={!object}
            title={isPinned ? "Unpin (follow selection)" : "Pin this object"}
            onClick={() => pin(isPinned ? null : (object?.ref ?? null))}
          >
            {isPinned ? <PinOff size={13} /> : <Pin size={13} />}
          </button>
          <button
            className="icon-btn icon-btn--sm"
            title="Hide inspector (Ctrl+I)"
            onClick={() =>
              useSettings
                .getState()
                .set("inspector.visible", false)
                .catch((err) => reportError("Could not save inspector state", err))
            }
          >
            <PanelRightClose size={13} />
          </button>
        </div>
      </div>

      {!object ? (
        <div className="empty inspector__empty">
          <MousePointerClick size={22} />
          <div>Select a widget, launcher entry, module or profile to inspect it.</div>
        </div>
      ) : (
        <>
          <div className="inspector__hero">
            <div className="inspector__icon">
              <object.icon size={20} strokeWidth={1.6} />
            </div>
            <div className="inspector__titles">
              <span className="label">{object.kindLabel}</span>
              <div className="inspector__title truncate" title={object.title}>
                {object.title}
              </div>
            </div>
          </div>
          <div className="inspector__tabs" role="tablist">
            {SECTIONS.filter((s) => s.id !== "settings" || object.settings).map((s) => (
              <button key={s.id} role="tab" aria-selected={shown === s.id} onClick={() => setSection(s.id)}>
                {s.label}
              </button>
            ))}
          </div>
          <div className="inspector__body">
            {shown === "overview" && <Overview object={object} />}
            {shown === "settings" &&
              (object.settings ? (
                <WidgetSettingsForm
                  schema={object.settings.schema}
                  config={object.settings.config}
                  onChange={object.settings.onChange}
                />
              ) : (
                <div className="empty">This object has no settings.</div>
              ))}
            {shown === "actions" && <Actions object={object} />}
            {shown === "details" && <Details object={object} />}
            {shown === "ai" && <AiSection object={object} />}
          </div>
        </>
      )}
    </aside>
  );
}

function Overview({ object }: { object: NrObject }) {
  return (
    <div className="inspector__section">
      {object.tags && object.tags.length > 0 && (
        <div className="inspector__tags">
          {object.tags.map((t) => (
            <span key={t.label} className={`tag${t.tone ? ` tag--${t.tone}` : ""}`}>
              {t.label}
            </span>
          ))}
        </div>
      )}
      {object.subtitle && (
        <p className="inspector__subtitle" data-selectable>
          {object.subtitle}
        </p>
      )}
      {object.summary && <p className="inspector__summary">{object.summary}</p>}
      <div className="label">Quick actions</div>
      <Actions object={object} limit={2} />
    </div>
  );
}

function Actions({ object, limit }: { object: NrObject; limit?: number }) {
  const actions = limit ? object.actions.filter((a) => !a.unavailable).slice(0, limit) : object.actions;
  return (
    <div className="inspector__actions">
      {actions.map((a) => (
        <button
          key={a.id}
          className={`inspector__action${a.danger ? " inspector__action--danger" : ""}`}
          disabled={!!a.unavailable}
          title={a.unavailable}
          onClick={() => void a.run()}
        >
          {a.icon && <a.icon size={14} />}
          <span>{a.label}</span>
          {a.unavailable && <span className="inspector__action-note">{a.unavailable}</span>}
        </button>
      ))}
    </div>
  );
}

/** Hands the object's details to NEURAL as an explicit attachment; never sends by itself. */
function AiSection({ object }: { object: NrObject }) {
  const ask = async () => {
    const { prefillNeural } = await import("@/modules/neural/store");
    const text = [`${object.kindLabel}: ${object.title}`, ...object.details.map((d) => `${d.label}: ${d.value}`)].join("\n");
    prefillNeural(`Explain this ${object.kindLabel.toLowerCase()} and suggest anything useful about it.`, [
      { kind: "selection", label: `${object.kindLabel} “${object.title}”`, text },
    ]);
    useShell.getState().navigate("neural");
  };
  return (
    <div className="inspector__section">
      <p className="inspector__summary">
        Send this object's details (shown under DETAILS) to NEURAL. You will see the message and attachment before
        anything is sent.
      </p>
      <button className="inspector__action" onClick={() => void ask()}>
        <BrainCircuit size={14} />
        <span>Ask NEURAL about this</span>
      </button>
    </div>
  );
}

function Details({ object }: { object: NrObject }) {
  return (
    <dl className="inspector__details">
      {object.details.map((d) => (
        <div key={d.label}>
          <dt className="label">{d.label}</dt>
          <dd className={d.mono ? "mono" : undefined} data-selectable>
            {d.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}
