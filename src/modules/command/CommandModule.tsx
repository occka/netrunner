import { useEffect, useMemo, useState } from "react";
import { LayoutGrid, Plus, Save, Undo2, X } from "lucide-react";
import { ModuleHeader } from "@/components/ModuleHeader";
import { useActiveProfile, useProfiles } from "@/stores/profiles";
import { useDashboard } from "@/stores/dashboard";
import { useShell } from "@/stores/shell";
import { confirmAction } from "@/stores/confirm";
import { notify, reportError } from "@/stores/notifications";
import { DashboardGrid } from "./DashboardGrid";
import { WidgetPicker } from "./WidgetPicker";

export default function CommandModule() {
  const profile = useActiveProfile();
  const { editing, draft, dirty, profileId, begin, end } = useDashboard();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const layout = editing && draft ? draft : profile?.layout;

  // A profile switch mid-edit discards the draft instead of saving it elsewhere.
  useEffect(() => {
    if (editing && profile && profileId !== profile.id) {
      end();
      notify.warn("Layout edit cancelled", "The active profile changed before the layout was saved.");
    }
  }, [editing, profile, profileId, end]);

  const widgetCount = useMemo(() => layout?.widgets.length ?? 0, [layout]);

  if (!profile || !layout) {
    return (
      <div className="module">
        <ModuleHeader id="command" />
        <div className="empty">No active profile.</div>
      </div>
    );
  }

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      await useProfiles.getState().saveLayout(profile.id, draft);
      end();
      notify.success("Layout saved", `${profile.name} · ${draft.widgets.length} widgets`);
    } catch (err) {
      reportError("Could not save layout", err);
    } finally {
      setSaving(false);
    }
  };

  const cancel = async () => {
    if (dirty) {
      const ok = await confirmAction({
        title: "Discard changes",
        message: "Discard your unsaved layout changes?",
        confirmLabel: "Discard",
        danger: true,
      });
      if (!ok) return;
    }
    end();
    useShell.getState().select(null);
  };

  return (
    <div className="module module--dashboard">
      <ModuleHeader
        id="command"
        subtitle={
          <>
            <span className="mono">{profile.name.toUpperCase()}</span> · {widgetCount} widgets
            {editing && (dirty ? " · unsaved changes" : " · no changes yet")}
          </>
        }
      >
        {editing ? (
          <>
            <button className="btn" onClick={() => setPickerOpen(true)}>
              <Plus size={14} /> Add widget
            </button>
            <button className="btn btn--ghost" onClick={() => void cancel()}>
              {dirty ? <Undo2 size={14} /> : <X size={14} />} Cancel
            </button>
            <button className="btn btn--primary" onClick={() => void save()} disabled={!dirty || saving}>
              <Save size={14} /> {saving ? "Saving…" : "Save layout"}
            </button>
          </>
        ) : (
          <button className="btn" onClick={() => begin(profile.layout, profile.id)}>
            <LayoutGrid size={14} /> Edit layout
          </button>
        )}
      </ModuleHeader>

      {editing && (
        <div className="edit-banner">
          <span className="tag tag--accent">Edit layout</span>
          Drag widgets by their header, resize from the corner. Nothing is stored until you save.
        </div>
      )}

      <div className="dashboard-scroll">
        {layout.widgets.length === 0 ? (
          <div className="empty dashboard-empty">
            <LayoutGrid size={26} />
            <div>This profile has no widgets.</div>
            <button
              className="btn btn--primary"
              onClick={() => {
                if (!editing) begin(profile.layout, profile.id);
                setPickerOpen(true);
              }}
            >
              <Plus size={14} /> Add widgets
            </button>
          </div>
        ) : (
          <DashboardGrid layout={layout} editing={editing} />
        )}
      </div>

      {pickerOpen && <WidgetPicker onClose={() => setPickerOpen(false)} />}
    </div>
  );
}
