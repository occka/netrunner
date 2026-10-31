import { useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { FolderSearch, Pencil, Play, Plus, Trash2, Workflow } from "lucide-react";
import { ModuleHeader } from "@/components/ModuleHeader";
import { Dialog } from "@/components/Dialog";
import { api } from "@/services/api";
import { usePolled } from "@/hooks/usePolled";
import { useQuickAccess } from "@/stores/quickAccess";
import { useProfiles } from "@/stores/profiles";
import { confirmAction } from "@/stores/confirm";
import { notify, reportError } from "@/stores/notifications";
import { refreshActivity } from "@/stores/activity";
import { WIDGETS } from "@/modules/command/widgets/registry";
import { formatRelative, parseDbTime } from "@/utils/format";
import type { ActionKind, AutomationInput, AutomationRule, Overlay, TriggerKind } from "@/types/phase2";

const TRIGGERS: Record<TriggerKind, string> = {
  netrunner_start: "NETRUNNER starts",
  app_started: "Application starts",
  app_stopped: "Application closes",
  profile_changed: "Profile changes",
  manual: "Manual (Run button only)",
};
const ACTIONS: Record<ActionKind, string> = {
  launch_program: "Launch program",
  launch_entry: "Launch Quick Access entry",
  switch_profile: "Switch profile",
  notify: "Show notification",
  show_overlay: "Show overlay",
  hide_overlay: "Hide overlay",
};

export default function AutomationModule() {
  const rules = usePolled(() => api.automation.list(), 10000);
  const overlays = usePolled(() => api.overlays.list());
  const [editing, setEditing] = useState<AutomationRule | "new" | null>(null);
  const entries = useQuickAccess((s) => s.entries);
  const profiles = useProfiles((s) => s.profiles);

  const describeTrigger = (r: AutomationRule) => {
    if (r.triggerKind === "app_started" || r.triggerKind === "app_stopped") return `${TRIGGERS[r.triggerKind]}: ${r.triggerValue}`;
    if (r.triggerKind === "profile_changed")
      return r.triggerValue ? `Profile → ${profiles.find((p) => String(p.id) === r.triggerValue)?.name ?? "?"}` : "Any profile change";
    return TRIGGERS[r.triggerKind];
  };
  const describeAction = (r: AutomationRule) => {
    const id = Number(r.actionValue);
    switch (r.actionKind) {
      case "launch_program":
        return `Launch ${r.actionValue.split(/[\\/]/).pop()}${r.actionArgs ? ` ${r.actionArgs}` : ""}`;
      case "launch_entry":
        return `Launch "${entries.find((e) => e.id === id)?.name ?? "missing entry"}"`;
      case "switch_profile":
        return `Switch to "${profiles.find((p) => p.id === id)?.name ?? "missing profile"}"`;
      case "notify":
        return `Notify: ${r.actionValue}`;
      default: {
        const o = overlays.data?.find((x) => x.id === id);
        return `${r.actionKind === "show_overlay" ? "Show" : "Hide"} overlay ${o ? WIDGETS[o.widgetType]?.title ?? o.widgetType : "?"}`;
      }
    }
  };

  const toggle = async (r: AutomationRule) => {
    try {
      await api.automation.update(r.id, { ...r, enabled: !r.enabled });
      void rules.reload();
    } catch (err) {
      reportError("Could not update rule", err);
    }
  };

  const remove = async (r: AutomationRule) => {
    if (!(await confirmAction({ title: "Delete rule", message: `Delete automation "${r.name}"?`, confirmLabel: "Delete", danger: true }))) return;
    try {
      await api.automation.remove(r.id);
      void rules.reload();
    } catch (err) {
      reportError("Could not delete rule", err);
    }
  };

  const run = async (r: AutomationRule) => {
    try {
      const outcome = await api.automation.run(r.id);
      notify.success(`"${r.name}"`, outcome);
    } catch (err) {
      reportError(`"${r.name}" failed`, err);
    } finally {
      void rules.reload();
      refreshActivity();
    }
  };

  return (
    <div className="module">
      <ModuleHeader id="automation">
        <button className="btn btn--primary" onClick={() => setEditing("new")}>
          <Plus size={14} /> New rule
        </button>
      </ModuleHeader>
      <div className="module__scroll">
        <div className="howto">
          <div className="label">How rules work</div>
          <ol>
            <li>
              <b>When</b>: the event that fires the rule, e.g. <i>NETRUNNER starts</i> or <i>Application starts: game.exe</i>.
              <i>Manual</i> rules only run from the ▶ button.
            </li>
            <li>
              <b>Do</b>: one action, e.g. <i>Launch program</i> → <span className="mono">E:\ThrottleStop_9.7\ThrottleStop.exe</span>.
            </li>
            <li>
              ▶ runs a rule immediately to test it; the result appears as a notification and in the activity log.
            </li>
          </ol>
          <div className="muted">
            Programs that need administrator rights show the normal Windows UAC prompt. Commands that need confirmation are
            never run unattended: NETRUNNER asks you first. Application start/stop is checked every 3 s, only while such a
            rule is enabled.
          </div>
        </div>
        {rules.data?.length === 0 && (
          <div className="empty">
            <Workflow size={26} />
            No automation rules yet.
          </div>
        )}
        <div className="rules">
          {rules.data?.map((r) => (
            <div key={r.id} className="panel rule" data-enabled={r.enabled}>
              <label className="check" title={r.enabled ? "Enabled" : "Disabled"}>
                <input type="checkbox" checked={r.enabled} onChange={() => void toggle(r)} aria-label={`Enable ${r.name}`} />
              </label>
              <div className="rule__main">
                <div className="rule__name">{r.name}</div>
                <div className="rule__flow">
                  <span className="tag tag--info">When</span> {describeTrigger(r)}
                  {r.conditionProfileId != null && (
                    <>
                      {" "}
                      <span className="tag">If profile</span> {profiles.find((p) => p.id === r.conditionProfileId)?.name ?? "?"}
                    </>
                  )}{" "}
                  <span className="tag tag--accent">Do</span> {describeAction(r)}
                </div>
              </div>
              <div className="rule__stats muted">
                {r.runCount} runs · last {formatRelative(parseDbTime(r.lastRunAt))}
              </div>
              <div className="rule__actions">
                <button className="icon-btn icon-btn--sm" title="Run now" onClick={() => void run(r)}>
                  <Play size={13} />
                </button>
                <button className="icon-btn icon-btn--sm" title="Edit" onClick={() => setEditing(r)}>
                  <Pencil size={13} />
                </button>
                <button className="icon-btn icon-btn--sm" title="Delete" onClick={() => void remove(r)}>
                  <Trash2 size={13} />
                </button>
              </div>
            </div>
          ))}
        </div>
        <p className="muted qa-hint">A visual node-based editor and more triggers (file created, download completed) are planned for Phase 5.</p>
      </div>
      {editing && (
        <RuleEditor
          rule={editing === "new" ? null : editing}
          overlays={overlays.data ?? []}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void rules.reload();
          }}
        />
      )}
    </div>
  );
}

function RuleEditor({
  rule,
  overlays,
  onClose,
  onSaved,
}: {
  rule: AutomationRule | null;
  overlays: Overlay[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const entries = useQuickAccess((s) => s.entries);
  const profiles = useProfiles((s) => s.profiles);
  const [form, setForm] = useState<AutomationInput>(
    rule ?? {
      name: "",
      enabled: true,
      triggerKind: "netrunner_start",
      triggerValue: "",
      conditionProfileId: null,
      actionKind: "launch_program",
      actionValue: "",
      actionArgs: "",
    },
  );
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof AutomationInput>(k: K, v: AutomationInput[K]) => setForm((f) => ({ ...f, [k]: v }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      if (rule) await api.automation.update(rule.id, form);
      else await api.automation.create(form);
      refreshActivity();
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const idSelect = (options: { id: number; label: string }[], placeholder: string) => (
    <select className="select" value={form.actionValue} onChange={(e) => set("actionValue", e.target.value)} required>
      <option value="">{placeholder}</option>
      {options.map((o) => (
        <option key={o.id} value={String(o.id)}>
          {o.label}
        </option>
      ))}
    </select>
  );

  return (
    <Dialog
      title={rule ? "Edit rule" : "New automation rule"}
      wide
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn--primary" type="submit" form="rule-form">
            Save rule
          </button>
        </>
      }
    >
      <form id="rule-form" className="form-grid" onSubmit={(e) => void submit(e)}>
        <label className="field form-grid__full">
          <span className="label">Name</span>
          <input className="input" value={form.name} onChange={(e) => set("name", e.target.value)} required maxLength={80} />
        </label>
        <label className="field">
          <span className="label">When</span>
          <select
            className="select"
            value={form.triggerKind}
            onChange={(e) => setForm((f) => ({ ...f, triggerKind: e.target.value as TriggerKind, triggerValue: "" }))}
          >
            {Object.entries(TRIGGERS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="label">Trigger detail</span>
          {form.triggerKind === "app_started" || form.triggerKind === "app_stopped" ? (
            <input
              className="input input--mono"
              placeholder="Cyberpunk2077.exe"
              value={form.triggerValue}
              onChange={(e) => set("triggerValue", e.target.value)}
              required
            />
          ) : form.triggerKind === "profile_changed" ? (
            <select className="select" value={form.triggerValue} onChange={(e) => set("triggerValue", e.target.value)}>
              <option value="">Any profile</option>
              {profiles.map((p) => (
                <option key={p.id} value={String(p.id)}>
                  {p.name}
                </option>
              ))}
            </select>
          ) : (
            <input className="input" disabled value="—" />
          )}
        </label>
        <label className="field">
          <span className="label">Do</span>
          <select
            className="select"
            value={form.actionKind}
            onChange={(e) => setForm((f) => ({ ...f, actionKind: e.target.value as ActionKind, actionValue: "" }))}
          >
            {Object.entries(ACTIONS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </label>
        {form.actionKind === "launch_program" ? (
          <>
            <div className="field form-grid__full">
              <span className="label">Program</span>
              <div className="input-row">
                <input
                  className="input input--mono"
                  value={form.actionValue}
                  onChange={(e) => set("actionValue", e.target.value)}
                  placeholder="E:\ThrottleStop_9.7\ThrottleStop.exe"
                  spellCheck={false}
                  required
                />
                <button
                  type="button"
                  className="btn"
                  onClick={async () => {
                    const file = await openDialog({
                      multiple: false,
                      title: "Program to launch",
                      filters: [{ name: "Programs", extensions: ["exe", "lnk", "bat", "cmd"] }],
                    });
                    if (typeof file === "string") {
                      setForm((f) => ({ ...f, actionValue: file, name: f.name || `Launch ${file.split(/[\\/]/).pop()?.replace(/\.\w+$/, "")}` }));
                    }
                  }}
                >
                  <FolderSearch size={14} /> Browse
                </button>
              </div>
            </div>
            <label className="field">
              <span className="label">Arguments (optional)</span>
              <input className="input input--mono" value={form.actionArgs} onChange={(e) => set("actionArgs", e.target.value)} spellCheck={false} />
            </label>
          </>
        ) : (
        <label className="field">
          <span className="label">Action target</span>
          {form.actionKind === "notify" ? (
            <input className="input" value={form.actionValue} onChange={(e) => set("actionValue", e.target.value)} required />
          ) : form.actionKind === "launch_entry" ? (
            idSelect(entries.map((e) => ({ id: e.id, label: `${e.name} (${e.kind})` })), "Choose an entry…")
          ) : form.actionKind === "switch_profile" ? (
            idSelect(profiles.map((p) => ({ id: p.id, label: p.name })), "Choose a profile…")
          ) : (
            idSelect(overlays.map((o) => ({ id: o.id, label: `#${o.id} ${WIDGETS[o.widgetType]?.title ?? o.widgetType}` })), "Choose an overlay…")
          )}
        </label>
        )}
        <label className="field">
          <span className="label">Only while profile is active</span>
          <select
            className="select"
            value={form.conditionProfileId ?? ""}
            onChange={(e) => set("conditionProfileId", e.target.value ? Number(e.target.value) : null)}
          >
            <option value="">Any profile</option>
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <div className="field">
          <span className="label">State</span>
          <label className="check">
            <input type="checkbox" checked={form.enabled} onChange={(e) => set("enabled", e.target.checked)} />
            Enabled
          </label>
        </div>
        {form.actionKind === "launch_entry" &&
          entries.find((e) => String(e.id) === form.actionValue)?.kind === "command" && (
            <div className="danger-note form-grid__full">
              Commands that require confirmation will prompt you when the rule fires. They never run silently.
            </div>
          )}
        {error && <div className="field__error form-grid__full">{error}</div>}
      </form>
    </Dialog>
  );
}
