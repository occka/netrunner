import { useState } from "react";
import { CheckCircle2, Copy, Pencil, Plus, Trash2 } from "lucide-react";
import { ModuleHeader } from "@/components/ModuleHeader";
import { Dialog } from "@/components/Dialog";
import { PROFILE_KIND_LABEL, useProfiles } from "@/stores/profiles";
import { useShell } from "@/stores/shell";
import { useDashboard } from "@/stores/dashboard";
import { confirmAction } from "@/stores/confirm";
import { notify, reportError } from "@/stores/notifications";
import { sameRef } from "@/objects/types";
import { WIDGETS } from "@/modules/command/widgets/registry";
import { parseDbTime } from "@/utils/format";
import type { Profile } from "@/types/entities";

type NameDialog = { mode: "create"; copyFrom?: Profile } | { mode: "rename"; profile: Profile } | null;

export default function ProfilesModule() {
  const { profiles, activeId } = useProfiles();
  const selection = useShell((s) => s.selection);
  const select = useShell((s) => s.select);
  const [dialog, setDialog] = useState<NameDialog>(null);

  const activate = async (p: Profile) => {
    if (useDashboard.getState().dirty) {
      const ok = await confirmAction({
        title: "Unsaved layout",
        message: "Switching profiles discards your unsaved dashboard layout changes.",
        confirmLabel: "Switch anyway",
        danger: true,
      });
      if (!ok) return;
      useDashboard.getState().end();
    }
    try {
      await useProfiles.getState().activate(p.id);
      notify.success(`Profile: ${p.name}`, "Running applications were not touched.");
    } catch (err) {
      reportError("Could not switch profile", err);
    }
  };

  const remove = async (p: Profile) => {
    const ok = await confirmAction({
      title: "Delete profile",
      message: `Delete the profile "${p.name}" and its dashboard layout?`,
      detail: "This cannot be undone. Quick Access entries are shared and are not affected.",
      confirmLabel: "Delete profile",
      danger: true,
    });
    if (!ok) return;
    try {
      await useProfiles.getState().remove(p.id);
      if (sameRef(selection, { type: "profile", id: p.id })) select(null);
    } catch (err) {
      reportError("Could not delete profile", err);
    }
  };

  return (
    <div className="module">
      <ModuleHeader id="profiles">
        <button className="btn btn--primary" onClick={() => setDialog({ mode: "create" })}>
          <Plus size={14} /> New profile
        </button>
      </ModuleHeader>
      <div className="module__scroll">
        <div className="profile-grid">
          {profiles.map((p) => {
            const active = p.id === activeId;
            return (
              <article
                key={p.id}
                className="panel profile-card"
                aria-selected={sameRef(selection, { type: "profile", id: p.id })}
                onClick={() => select({ type: "profile", id: p.id })}
              >
                <div className="profile-card__head">
                  <div>
                    <div className="profile-card__name">{p.name}</div>
                    <div className="label">{PROFILE_KIND_LABEL[p.kind]}{p.isBuiltin ? " · built-in" : ""}</div>
                  </div>
                  {active && (
                    <span className="tag tag--ok">
                      <CheckCircle2 size={11} /> Active
                    </span>
                  )}
                </div>
                <MiniLayout profile={p} />
                <div className="profile-card__meta muted">
                  {p.layout.widgets.length} widgets · updated {parseDbTime(p.updatedAt)?.toLocaleDateString() ?? "—"}
                </div>
                <div className="profile-card__actions" onClick={(e) => e.stopPropagation()}>
                  <button className="btn btn--sm" disabled={active} onClick={() => void activate(p)}>
                    {active ? "Active" : "Activate"}
                  </button>
                  <button className="icon-btn icon-btn--sm" title="Duplicate" onClick={() => setDialog({ mode: "create", copyFrom: p })}>
                    <Copy size={13} />
                  </button>
                  <button className="icon-btn icon-btn--sm" title="Rename" onClick={() => setDialog({ mode: "rename", profile: p })}>
                    <Pencil size={13} />
                  </button>
                  <button
                    className="icon-btn icon-btn--sm"
                    title={p.isBuiltin ? "Built-in profiles cannot be deleted" : active ? "Switch away before deleting" : "Delete"}
                    disabled={p.isBuiltin || active}
                    onClick={() => void remove(p)}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              </article>
            );
          })}
        </div>
        <p className="muted profiles-note">
          A profile defines the COMMAND dashboard layout and its own overlay set (see OVERLAY): switching closes the previous
          profile's overlays and opens this one's. Per-profile Quick Access sets, hotkeys and automation are planned. Switching
          profiles never closes applications.
        </p>
      </div>
      {dialog && <NameDialogView dialog={dialog} onClose={() => setDialog(null)} />}
    </div>
  );
}

/** Proportional thumbnail of the profile's dashboard layout. */
function MiniLayout({ profile }: { profile: Profile }) {
  const rows = Math.max(12, ...profile.layout.widgets.map((w) => w.y + w.h));
  return (
    <div className="mini-layout" aria-hidden="true">
      {profile.layout.widgets.map((w) => (
        <div
          key={w.id}
          className="mini-layout__cell"
          title={WIDGETS[w.type]?.title}
          style={{
            left: `${(w.x / 12) * 100}%`,
            top: `${(w.y / rows) * 100}%`,
            width: `${(w.w / 12) * 100}%`,
            height: `${(w.h / rows) * 100}%`,
          }}
        />
      ))}
    </div>
  );
}

function NameDialogView({ dialog, onClose }: { dialog: NonNullable<NameDialog>; onClose: () => void }) {
  const initial =
    dialog.mode === "rename" ? dialog.profile.name : dialog.copyFrom ? `${dialog.copyFrom.name} copy` : "";
  const [name, setName] = useState(initial);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      if (dialog.mode === "rename") await useProfiles.getState().rename(dialog.profile.id, name);
      else await useProfiles.getState().create(name, dialog.copyFrom?.id);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <Dialog
      title={dialog.mode === "rename" ? "Rename profile" : dialog.copyFrom ? "Duplicate profile" : "New profile"}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn--primary" type="submit" form="profile-form">
            {dialog.mode === "rename" ? "Rename" : "Create"}
          </button>
        </>
      }
    >
      <form id="profile-form" onSubmit={(e) => void submit(e)} className="field">
        <span className="label">Name</span>
        <input className="input" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} autoFocus required />
        {dialog.mode === "create" && (
          <span className="field__hint">
            {dialog.copyFrom ? `Starts with the layout of "${dialog.copyFrom.name}".` : "Starts with an empty dashboard (CUSTOM type)."}
          </span>
        )}
        {error && <span className="field__error">{error}</span>}
      </form>
    </Dialog>
  );
}
