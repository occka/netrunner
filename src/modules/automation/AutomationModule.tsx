import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp, CheckCircle2, CircleSlash, FlaskConical, Pencil, Play, Plus, Trash2, Workflow, X } from "lucide-react";
import { ModuleHeader } from "@/components/ModuleHeader";
import { Dialog } from "@/components/Dialog";
import { api } from "@/services/api";
import { usePolled } from "@/hooks/usePolled";
import { useQuickAccess } from "@/stores/quickAccess";
import { useProfiles } from "@/stores/profiles";
import { confirmAction } from "@/stores/confirm";
import { notify, reportError } from "@/stores/notifications";
import { refreshActivity } from "@/stores/activity";
import { formatRelative, parseDbTime } from "@/utils/format";
import { ValueInput, type Choices } from "./ValueInput";
import type { ActionKind, AutomationInput, AutomationRule, ConditionKind, DryRun, RuleAction, RuleCondition, TriggerKind } from "@/types/phase2";

export const TRIGGERS: Record<TriggerKind, string> = {
  netrunner_start: "NETRUNNER starts",
  manual: "Manual (Run button only)",
  app_started: "Application starts",
  app_stopped: "Application closes",
  profile_changed: "Profile changes",
  time: "At a time of day",
  interval: "Every N minutes",
  file_created: "New file in a folder",
  download_finished: "BROWSER download finished",
  network_up: "Network adapter connects",
  network_down: "Network adapter disconnects",
  game_started: "Game starts",
  game_stopped: "Game closes",
  power_source: "Power source changes",
  power_plan: "Power plan changes",
};
export const CONDITIONS: Record<ConditionKind, string> = {
  profile: "Profile is active",
  time_between: "Time is between",
  weekday: "Day of the week is",
  process_running: "Application is running",
  process_not_running: "Application is not running",
  power_source: "Running on",
  vpn: "VPN-type adapter is",
};
export const ACTIONS: Record<ActionKind, string> = {
  launch_program: "Launch program",
  launch_entry: "Launch Quick Access entry",
  switch_profile: "Switch profile",
  notify: "Show notification",
  show_overlay: "Show overlay",
  hide_overlay: "Hide overlay",
  show_overlay_set: "Show overlay set",
  hide_overlay_set: "Hide overlay set",
  set_volume: "Set volume",
  power_plan: "Switch power plan",
  open_url: "Open page in BROWSER",
  wait: "Wait",
};

/** Lists the editors choose from, loaded once for the module. */
function useChoices(): Choices {
  const entries = useQuickAccess((s) => s.entries);
  const profiles = useProfiles((s) => s.profiles);
  const overlays = usePolled(() => api.overlays.list());
  const games = usePolled(() => api.games.scan());
  const power = usePolled(() => api.system.power());
  const network = usePolled(() => api.network.status());
  return useMemo(
    () => ({
      entries: entries.map((e) => ({ id: String(e.id), label: `${e.name} (${e.kind})` })),
      profiles: profiles.map((p) => ({ id: String(p.id), label: p.name })),
      overlays: (overlays.data ?? []).map((o) => ({
        id: String(o.id),
        label: `#${o.id} ${(o.config["frame.title"] as string) || o.title || o.widgetType}`,
      })),
      games: [
        ...entries.filter((e) => e.kind === "game").map((e) => ({ id: `qa:${e.id}`, label: `${e.name} (your game)` })),
        ...(games.data?.games ?? []).map((g) => ({ id: g.id, label: g.name })),
      ],
      plans: (power.data?.plans ?? []).map((p) => ({ id: p.guid, label: p.name })),
      adapters: (network.data?.adapters ?? []).map((a) => ({ id: a.name, label: `${a.name}${a.vpnLike ? " (VPN-type)" : ""}` })),
    }),
    [entries, profiles, overlays.data, games.data, power.data, network.data],
  );
}

const label = (list: { id: string; label: string }[], id: string, missing = "?") => list.find((x) => x.id === id)?.label ?? missing;
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const daysText = (mask: string) => {
  const m = Number(mask);
  if (m === 127) return "every day";
  if (m === 31) return "weekdays";
  if (m === 96) return "weekends";
  return DAYS.filter((_, i) => m & (1 << i)).join(", ");
};

export function describeTrigger(kind: TriggerKind, value: string, c: Choices): string {
  switch (kind) {
    case "app_started":
    case "app_stopped":
      return `${TRIGGERS[kind]}: ${value}`;
    case "profile_changed":
      return value ? `Profile → ${label(c.profiles, value)}` : "Any profile change";
    case "time":
      return `Every day at ${value}`;
    case "interval":
      return `Every ${value} min`;
    case "file_created":
      return `New file in ${value}`;
    case "download_finished":
      return value ? `Download finished: ${value.split(",").map((e) => `.${e}`).join(", ")}` : "Any download finished";
    case "network_up":
    case "network_down":
      return `${value === "vpn" ? "VPN-type adapter" : value || "Any adapter"} ${kind === "network_up" ? "connects" : "disconnects"}`;
    case "game_started":
    case "game_stopped":
      return `${value ? label(c.games, value) : "Any game"} ${kind === "game_started" ? "starts" : "closes"}`;
    case "power_source":
      return value === "ac" ? "Plugged in" : "On battery";
    case "power_plan":
      return value ? `Power plan → ${label(c.plans, value)}` : "Power plan changes";
    default:
      return TRIGGERS[kind];
  }
}

export function describeCondition(x: RuleCondition, c: Choices): string {
  switch (x.kind) {
    case "profile":
      return `profile is ${label(c.profiles, x.value)}`;
    case "time_between":
      return `time ${x.value.replace("-", "–")}`;
    case "weekday":
      return daysText(x.value);
    case "process_running":
      return `${x.value} is running`;
    case "process_not_running":
      return `${x.value} is not running`;
    case "power_source":
      return x.value === "ac" ? "plugged in" : "on battery";
    case "vpn":
      return `VPN-type adapter ${x.value}`;
  }
}

export function describeAction(a: RuleAction, c: Choices): string {
  switch (a.kind) {
    case "launch_program":
      return `Launch ${a.value.split(/[\\/]/).pop()}${a.args ? ` ${a.args}` : ""}`;
    case "launch_entry":
      return `Launch "${label(c.entries, a.value, "missing entry")}"`;
    case "switch_profile":
      return `Switch to "${label(c.profiles, a.value, "missing profile")}"`;
    case "notify":
      return `Notify: ${a.value}`;
    case "show_overlay":
    case "hide_overlay":
      return `${a.kind === "show_overlay" ? "Show" : "Hide"} overlay ${label(c.overlays, a.value)}`;
    case "show_overlay_set":
    case "hide_overlay_set":
      return `${a.kind === "show_overlay_set" ? "Show" : "Hide"} overlays of ${a.value === "all" ? "every profile" : label(c.profiles, a.value)}`;
    case "set_volume":
      return `Volume ${a.value}%`;
    case "power_plan":
      return `Power plan "${label(c.plans, a.value)}"`;
    case "open_url":
      return `Open ${a.value}`;
    case "wait":
      return `Wait ${a.value} s`;
  }
}

export default function AutomationModule() {
  const rules = usePolled(() => api.automation.list(), 10000);
  const choices = useChoices();
  const [editing, setEditing] = useState<AutomationRule | "new" | null>(null);

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
        {import.meta.env.DEV && (
          <div className="edit-banner">
            <span className="tag tag--warn">Dev build</span>
            Automations do not run in development builds, so rebuilding does not launch your programs. Dry runs still work.
          </div>
        )}
        <div className="howto">
          <div className="label">How rules work</div>
          <ol>
            <li>
              <b>When</b>: one event fires the rule: NETRUNNER starts, an application or game starts, a time of day, a new file, a
              finished download, a network adapter or the power source changing… <i>Manual</i> rules only run from ▶.
            </li>
            <li>
              <b>If</b> (optional): conditions that must all hold at that moment, e.g. a profile, a time range, weekdays.
            </li>
            <li>
              <b>Then</b>: actions run in order; <i>Wait</i> pauses between them. The chain stops at the first failure.
            </li>
          </ol>
          <div className="muted">
            <b>Dry run</b> in the editor checks the conditions now and shows what each action would do, without running anything. ▶
            runs a rule for real and skips its conditions. Programs that need administrator rights show the normal UAC prompt;
            commands that need confirmation are never run unattended.
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
                  <span className="tag tag--info">When</span> {describeTrigger(r.triggerKind, r.triggerValue, choices)}
                  {r.conditions.length > 0 && (
                    <>
                      {" "}
                      <span className="tag">If</span> {r.conditions.map((c) => describeCondition(c, choices)).join(" and ")}
                    </>
                  )}{" "}
                  <span className="tag tag--accent">Then</span> {r.actions.map((a) => describeAction(a, choices)).join(" → ")}
                </div>
              </div>
              <div className="rule__stats muted">
                {r.runCount} runs · last {formatRelative(parseDbTime(r.lastRunAt))}
              </div>
              <div className="rule__actions">
                <button className="icon-btn icon-btn--sm" title="Run now (skips conditions)" onClick={() => void run(r)}>
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
      </div>
      {editing && (
        <RuleEditor
          rule={editing === "new" ? null : editing}
          choices={choices}
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

/** Starting value when a kind is picked, so the editor shows something sensible. */
function defaultTriggerValue(kind: TriggerKind): string {
  return kind === "time" ? "08:00" : kind === "interval" ? "60" : kind === "power_source" ? "battery" : "";
}
function defaultCondition(kind: ConditionKind, c: Choices): RuleCondition {
  const value =
    kind === "time_between"
      ? "09:00-18:00"
      : kind === "weekday"
        ? "31"
        : kind === "power_source"
          ? "battery"
          : kind === "vpn"
            ? "up"
            : kind === "profile"
              ? (c.profiles[0]?.id ?? "")
              : "";
  return { kind, value };
}
function defaultAction(kind: ActionKind): RuleAction {
  const value = kind === "set_volume" ? "50" : kind === "wait" ? "5" : kind === "show_overlay_set" || kind === "hide_overlay_set" ? "all" : "";
  return { kind, value, args: "" };
}

function RuleEditor({ rule, choices, onClose, onSaved }: { rule: AutomationRule | null; choices: Choices; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState<AutomationInput>(
    rule ?? { name: "", enabled: true, triggerKind: "netrunner_start", triggerValue: "", conditions: [], actions: [defaultAction("launch_program")] },
  );
  const [error, setError] = useState<string | null>(null);
  const [dry, setDry] = useState<DryRun | null>(null);
  const [busy, setBusy] = useState(false);
  const patch = (p: Partial<AutomationInput>) => {
    setForm((f) => ({ ...f, ...p }));
    setDry(null);
  };
  const setCondition = (i: number, c: RuleCondition | null) =>
    patch({ conditions: c ? form.conditions.map((x, j) => (j === i ? c : x)) : form.conditions.filter((_, j) => j !== i) });
  const setAction = (i: number, a: RuleAction | null) =>
    patch({ actions: a ? form.actions.map((x, j) => (j === i ? a : x)) : form.actions.filter((_, j) => j !== i) });
  const moveAction = (i: number, d: -1 | 1) => {
    const list = [...form.actions];
    [list[i], list[i + d]] = [list[i + d], list[i]];
    patch({ actions: list });
  };

  const submit = async () => {
    setBusy(true);
    try {
      if (rule) await api.automation.update(rule.id, form);
      else await api.automation.create(form);
      refreshActivity();
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const dryRun = async () => {
    setBusy(true);
    setError(null);
    try {
      setDry(await api.automation.dryRun(form));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setDry(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      title={rule ? "Edit rule" : "New automation rule"}
      wide
      onClose={onClose}
      footer={
        <>
          <label className="check flow__enabled">
            <input type="checkbox" checked={form.enabled} onChange={(e) => patch({ enabled: e.target.checked })} />
            Enabled
          </label>
          <button className="btn" onClick={() => void dryRun()} disabled={busy} title="Check conditions now and show what the actions would do">
            <FlaskConical size={13} /> Dry run
          </button>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn--primary" onClick={() => void submit()} disabled={busy || !form.name.trim()}>
            Save rule
          </button>
        </>
      }
    >
      <div className="flow">
        <label className="field">
          <span className="label">Name</span>
          <input className="input" value={form.name} onChange={(e) => patch({ name: e.target.value })} maxLength={80} placeholder="Gaming mode" autoFocus />
        </label>

        <section className="flow__block flow__block--when">
          <div className="flow__head">
            <span className="tag tag--info">When</span>
          </div>
          <div className="flow__row">
            <select
              className="select"
              value={form.triggerKind}
              onChange={(e) => patch({ triggerKind: e.target.value as TriggerKind, triggerValue: defaultTriggerValue(e.target.value as TriggerKind) })}
            >
              {Object.entries(TRIGGERS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
            <ValueInput slot="trigger" kind={form.triggerKind} value={form.triggerValue} choices={choices} onChange={(v) => patch({ triggerValue: v })} />
          </div>
        </section>

        <div className="flow__arrow">↓</div>

        <section className="flow__block">
          <div className="flow__head">
            <span className="tag">If</span>
            <span className="muted">all of these hold (optional)</span>
          </div>
          {form.conditions.map((c, i) => (
            <div key={i} className="flow__row" data-met={dry ? String(dry.conditions[i]?.met) : undefined}>
              {dry && (dry.conditions[i]?.met ? <CheckCircle2 size={14} className="flow__ok" /> : <CircleSlash size={14} className="flow__no" />)}
              <select className="select" value={c.kind} onChange={(e) => setCondition(i, defaultCondition(e.target.value as ConditionKind, choices))}>
                {Object.entries(CONDITIONS).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
              <ValueInput slot="condition" kind={c.kind} value={c.value} choices={choices} onChange={(v) => setCondition(i, { ...c, value: v })} />
              <button className="icon-btn icon-btn--sm" title="Remove condition" onClick={() => setCondition(i, null)}>
                <X size={13} />
              </button>
            </div>
          ))}
          {form.conditions.length < 8 && (
            <button className="btn btn--sm btn--ghost" onClick={() => patch({ conditions: [...form.conditions, defaultCondition("profile", choices)] })}>
              <Plus size={12} /> Condition
            </button>
          )}
        </section>

        <div className="flow__arrow">↓</div>

        <section className="flow__block flow__block--then">
          <div className="flow__head">
            <span className="tag tag--accent">Then</span>
            <span className="muted">in this order</span>
          </div>
          {form.actions.map((a, i) => (
            <div key={i} className="flow__step">
              <span className="flow__num mono">{i + 1}</span>
              <div className="flow__row">
                <select className="select" value={a.kind} onChange={(e) => setAction(i, defaultAction(e.target.value as ActionKind))}>
                  {Object.entries(ACTIONS).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </select>
                <ValueInput
                  slot="action"
                  kind={a.kind}
                  value={a.value}
                  args={a.args}
                  choices={choices}
                  onChange={(v, args) => setAction(i, { ...a, value: v, args: args ?? a.args })}
                  onName={(n) => !form.name && patch({ name: n })}
                />
              </div>
              <div className="flow__step-tools">
                <button className="icon-btn icon-btn--sm" title="Move up" disabled={i === 0} onClick={() => moveAction(i, -1)}>
                  <ArrowUp size={12} />
                </button>
                <button className="icon-btn icon-btn--sm" title="Move down" disabled={i === form.actions.length - 1} onClick={() => moveAction(i, 1)}>
                  <ArrowDown size={12} />
                </button>
                <button className="icon-btn icon-btn--sm" title="Remove step" disabled={form.actions.length === 1} onClick={() => setAction(i, null)}>
                  <X size={13} />
                </button>
              </div>
              {dry?.actions[i] && <div className={`flow__dry mono ${dry.actions[i].startsWith("✗") ? "flow__dry--bad" : ""}`}>{dry.actions[i]}</div>}
            </div>
          ))}
          {form.actions.length < 12 && (
            <div className="flow__add">
              <button className="btn btn--sm btn--ghost" onClick={() => patch({ actions: [...form.actions, defaultAction("notify")] })}>
                <Plus size={12} /> Action
              </button>
              <button className="btn btn--sm btn--ghost" onClick={() => patch({ actions: [...form.actions, defaultAction("wait")] })}>
                <Plus size={12} /> Wait
              </button>
            </div>
          )}
        </section>

        {dry && (
          <div className={`flow__verdict ${dry.wouldRun ? "flow__verdict--ok" : ""}`}>
            {dry.wouldRun
              ? "If the trigger fired now, the rule would run the steps above."
              : "If the trigger fired now, the rule would be skipped: a condition does not hold."}{" "}
            Nothing was run.
          </div>
        )}
        {error && <div className="field__error">{error}</div>}
      </div>
    </Dialog>
  );
}
