import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { FolderSearch } from "lucide-react";
import type { ActionKind, ConditionKind, TriggerKind } from "@/types/phase2";

type Option = { id: string; label: string };
export interface Choices {
  entries: Option[];
  profiles: Option[];
  overlays: Option[];
  games: Option[];
  plans: Option[];
  adapters: Option[];
}

type Props = {
  value: string;
  args?: string;
  choices: Choices;
  onChange: (value: string, args?: string) => void;
  /** Suggests a rule name (e.g. from a picked program). */
  onName?: (name: string) => void;
} & ({ slot: "trigger"; kind: TriggerKind } | { slot: "condition"; kind: ConditionKind } | { slot: "action"; kind: ActionKind });

const DAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];

function Pick({ value, options, empty, onChange }: { value: string; options: Option[]; empty?: string; onChange: (v: string) => void }) {
  return (
    <select className="select" value={value} onChange={(e) => onChange(e.target.value)}>
      {empty !== undefined ? <option value="">{empty}</option> : !options.some((o) => o.id === value) && <option value="">Choose…</option>}
      {options.map((o) => (
        <option key={o.id} value={o.id}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

function Text({ value, placeholder, onChange, mono = true }: { value: string; placeholder: string; onChange: (v: string) => void; mono?: boolean }) {
  return (
    <input className={`input ${mono ? "input--mono" : ""}`} value={value} placeholder={placeholder} spellCheck={false} onChange={(e) => onChange(e.target.value)} />
  );
}

/** The value field for a trigger, condition or action kind. */
export function ValueInput(p: Props) {
  const { value, choices: c, onChange } = p;
  const key = `${p.slot}:${p.kind}`;
  switch (key) {
    case "trigger:netrunner_start":
    case "trigger:manual":
      return <span className="muted flow__none">no details</span>;
    case "trigger:app_started":
    case "trigger:app_stopped":
    case "condition:process_running":
    case "condition:process_not_running":
      return <Text value={value} placeholder="game.exe" onChange={onChange} />;
    case "trigger:profile_changed":
      return <Pick value={value} options={c.profiles} empty="Any profile" onChange={onChange} />;
    case "trigger:time":
      return <input className="input input--mono flow__time" type="time" value={value} onChange={(e) => onChange(e.target.value)} />;
    case "trigger:interval":
      return (
        <span className="flow__unit">
          <input className="input input--mono" type="number" min={1} max={1440} value={value} onChange={(e) => onChange(e.target.value)} /> min
        </span>
      );
    case "trigger:file_created":
      return (
        <span className="flow__path">
          <Text value={value} placeholder="C:\Users\you\Downloads" onChange={onChange} />
          <button
            type="button"
            className="btn btn--sm"
            onClick={async () => {
              const dir = await openDialog({ directory: true, multiple: false, title: "Folder to watch" });
              if (typeof dir === "string") onChange(dir);
            }}
          >
            <FolderSearch size={13} /> Folder
          </button>
        </span>
      );
    case "trigger:download_finished":
      return <Text value={value} placeholder="Any file, or: pdf, zip" onChange={onChange} />;
    case "trigger:network_up":
    case "trigger:network_down":
      return <Pick value={value} options={[{ id: "vpn", label: "Any VPN-type adapter" }, ...c.adapters]} empty="Any adapter" onChange={onChange} />;
    case "trigger:game_started":
    case "trigger:game_stopped":
      return <Pick value={value} options={c.games} empty="Any game" onChange={onChange} />;
    case "trigger:power_source":
    case "condition:power_source":
      return (
        <Pick
          value={value}
          options={[
            { id: "battery", label: "Battery" },
            { id: "ac", label: "AC power (plugged in)" },
          ]}
          onChange={onChange}
        />
      );
    case "trigger:power_plan":
      return <Pick value={value} options={c.plans} empty="Any plan" onChange={onChange} />;
    case "condition:profile":
    case "action:switch_profile":
      return <Pick value={value} options={c.profiles} onChange={onChange} />;
    case "condition:time_between": {
      const [a = "09:00", b = "18:00"] = value.split("-");
      return (
        <span className="flow__unit">
          <input className="input input--mono flow__time" type="time" value={a} onChange={(e) => onChange(`${e.target.value}-${b}`)} />–
          <input className="input input--mono flow__time" type="time" value={b} onChange={(e) => onChange(`${a}-${e.target.value}`)} />
        </span>
      );
    }
    case "condition:weekday": {
      const mask = Number(value) || 0;
      return (
        <span className="flow__days">
          {DAYS.map((d, i) => (
            <button key={d} type="button" className="alarmw__day" aria-pressed={!!(mask & (1 << i))} onClick={() => onChange(String(mask ^ (1 << i)))}>
              {d}
            </button>
          ))}
        </span>
      );
    }
    case "condition:vpn":
      return (
        <Pick
          value={value}
          options={[
            { id: "up", label: "up" },
            { id: "down", label: "down" },
          ]}
          onChange={onChange}
        />
      );
    case "action:launch_program":
      return (
        <span className="flow__program">
          <span className="flow__path">
            <Text value={value} placeholder="E:\Tools\ThrottleStop.exe" onChange={(v) => onChange(v, p.args)} />
            <button
              type="button"
              className="btn btn--sm"
              onClick={async () => {
                const file = await openDialog({ multiple: false, title: "Program to launch", filters: [{ name: "Programs", extensions: ["exe", "lnk", "bat", "cmd"] }] });
                if (typeof file === "string") {
                  onChange(file, p.args);
                  p.onName?.(`Launch ${file.split(/[\\/]/).pop()?.replace(/\.\w+$/, "")}`);
                }
              }}
            >
              <FolderSearch size={13} /> Browse
            </button>
          </span>
          <Text value={p.args ?? ""} placeholder="arguments (optional)" onChange={(v) => onChange(value, v)} />
        </span>
      );
    case "action:launch_entry":
      return <Pick value={value} options={c.entries} onChange={onChange} />;
    case "action:notify":
      return <Text value={value} placeholder="Message" onChange={onChange} mono={false} />;
    case "action:show_overlay":
    case "action:hide_overlay":
      return <Pick value={value} options={c.overlays} onChange={onChange} />;
    case "action:show_overlay_set":
    case "action:hide_overlay_set":
      return <Pick value={value} options={[{ id: "all", label: "All overlays" }, ...c.profiles.map((x) => ({ ...x, label: `${x.label} profile's overlays` }))]} onChange={onChange} />;
    case "action:set_volume":
      return (
        <span className="flow__unit flow__volume">
          <input type="range" min={0} max={100} step={5} value={Number(value) || 0} onChange={(e) => onChange(e.target.value)} />
          <span className="mono">{value}%</span>
        </span>
      );
    case "action:power_plan":
      return <Pick value={value} options={c.plans} onChange={onChange} />;
    case "action:open_url":
      return <Text value={value} placeholder="https://…" onChange={onChange} />;
    case "action:wait":
      return (
        <span className="flow__unit">
          <input className="input input--mono" type="number" min={1} max={600} value={value} onChange={(e) => onChange(e.target.value)} /> s
        </span>
      );
    default:
      return <Text value={value} placeholder="" onChange={onChange} />;
  }
}
