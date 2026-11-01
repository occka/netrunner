import { useEffect, useState, type FormEvent } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { AlarmClock, BellRing, Flag, Pause, Pencil, Play, Plus, RotateCcw, Square, Trash2, Volume2, X } from "lucide-react";
import { api } from "@/services/api";
import { reportError } from "@/stores/notifications";
import { confirmAction } from "@/stores/confirm";
import { Sampling } from "./common";
import { DAY_NAMES, daysLabel, formatDuration, listenForAlarms, parseDuration, relative, useAlarms, useNow } from "./alarmStore";
import type { WidgetProps } from "./registry";
import type { ALARM_SETTINGS, ConfigOf } from "./settings";
import type { Alarm, AlarmInput, Timer } from "@/types/alarms";

type Config = ConfigOf<typeof ALARM_SETTINGS>;
type Tab = "alarms" | "timers" | "stopwatch";

const run = (title: string, op: Promise<unknown>) => op.catch((err) => reportError(title, err));

export default function AlarmWidget({ instanceId, config: c }: WidgetProps<Config>) {
  const state = useAlarms((s) => s.state);
  const error = useAlarms((s) => s.error);
  const [tab, setTab] = useState<Tab>("alarms");

  useEffect(() => {
    listenForAlarms();
    void useAlarms.getState().load();
    void useAlarms.getState().loadSounds().catch(() => undefined);
  }, []);

  if (error && !state) return <div className="unavailable">{error}</div>;
  if (!state) return <Sampling />;
  const view: Tab = c.view === "tabs" ? tab : c.view;
  const running = state.timers.filter((t) => t.endsAt).length;

  return (
    <div className="alarmw">
      <RingingBanner />
      {c.view === "tabs" && (
        <div className="segmented alarmw__tabs">
          <button aria-pressed={tab === "alarms"} onClick={() => setTab("alarms")}>
            Alarms
          </button>
          <button aria-pressed={tab === "timers"} onClick={() => setTab("timers")}>
            Timers{running ? ` · ${running}` : ""}
          </button>
          <button aria-pressed={tab === "stopwatch"} onClick={() => setTab("stopwatch")}>
            Stopwatch
          </button>
        </div>
      )}
      {view === "alarms" && <Alarms alarms={state.alarms} />}
      {view === "timers" && <Timers timers={state.timers} />}
      {view === "stopwatch" && <Stopwatch id={instanceId} />}
    </div>
  );
}

function RingingBanner() {
  const state = useAlarms((s) => s.state);
  if (!state?.ringing.length) return null;
  return (
    <div className="alarmw__ringing">
      {state.ringing.map((r) => (
        <div key={r.key} className="alarmw__ring">
          <BellRing size={14} className="alarmw__bell" />
          <span className="alarmw__ring-label">{r.label || (r.kind === "alarm" ? "Alarm" : "Timer done")}</span>
          <button className="btn btn--sm" onClick={() => void run("Could not snooze", api.alarms.snooze(r.key))}>
            {r.kind === "alarm" ? "Snooze" : "+1 min"}
          </button>
          <button className="btn btn--sm btn--primary" onClick={() => void run("Could not stop", api.alarms.stop(r.key))}>
            Stop
          </button>
        </div>
      ))}
    </div>
  );
}

// ---------- Alarms ----------

function Alarms({ alarms }: { alarms: Alarm[] }) {
  const [editing, setEditing] = useState<Alarm | "new" | null>(null);
  const now = useNow(15000);

  if (editing) return <AlarmEditor alarm={editing === "new" ? null : editing} onDone={() => setEditing(null)} />;

  return (
    <>
      {alarms.length === 0 ? (
        <div className="empty">
          <AlarmClock size={20} strokeWidth={1.4} />
          No alarms. They ring even when NETRUNNER is in the tray.
        </div>
      ) : (
        <ul className="alarmw__list">
          {alarms.map((a) => (
            <li key={a.id} className="alarmw__alarm" data-off={!a.enabled}>
              <span className="alarmw__time mono">{a.time}</span>
              <span className="alarmw__meta">
                <span className="alarmw__label">{a.label || "Alarm"}</span>
                <span className="muted">
                  {daysLabel(a.days)}
                  {a.snoozedUntil && a.enabled
                    ? ` · snoozed ${relative(a.snoozedUntil - now)}`
                    : a.nextAt && a.enabled
                      ? ` · ${relative(a.nextAt - now)}`
                      : ""}
                </span>
              </span>
              <span className="alarmw__actions">
                <button className="icon-btn icon-btn--sm" title="Edit" onClick={() => setEditing(a)}>
                  <Pencil size={12} />
                </button>
                <button
                  className="icon-btn icon-btn--sm"
                  title="Delete"
                  onClick={() =>
                    void confirmAction({ title: "Delete alarm", message: `Delete the ${a.time} alarm?`, confirmLabel: "Delete", danger: true }).then(
                      (ok) => ok && run("Could not delete the alarm", api.alarms.remove(a.id)),
                    )
                  }
                >
                  <Trash2 size={12} />
                </button>
              </span>
              <label className="switch" title={a.enabled ? "On" : "Off"}>
                <input
                  type="checkbox"
                  checked={a.enabled}
                  onChange={(e) => void run("Could not change the alarm", api.alarms.setEnabled(a.id, e.target.checked))}
                />
                <span />
              </label>
            </li>
          ))}
        </ul>
      )}
      <button className="btn btn--sm alarmw__add" onClick={() => setEditing("new")}>
        <Plus size={12} /> Alarm
      </button>
    </>
  );
}

const DEFAULT_ALARM: AlarmInput = { label: "", time: "07:00", days: 0, sound: "pulse", volume: 80, snoozeMinutes: 5 };

function AlarmEditor({ alarm, onDone }: { alarm: Alarm | null; onDone: () => void }) {
  const [form, setForm] = useState<AlarmInput>(() => (alarm ? { ...alarm } : { ...DEFAULT_ALARM }));
  const set = <K extends keyof AlarmInput>(k: K, v: AlarmInput[K]) => setForm((f) => ({ ...f, [k]: v }));
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api.alarms.stopPreview();
      await api.alarms.save(alarm?.id ?? null, form);
      onDone();
    } catch (err) {
      reportError("Could not save the alarm", err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="alarmw__editor" onSubmit={(e) => void submit(e)}>
      <div className="alarmw__row">
        <input className="input alarmw__time-input mono" type="time" required value={form.time} onChange={(e) => set("time", e.target.value)} />
        <input className="input" placeholder="Label (optional)" maxLength={60} value={form.label} onChange={(e) => set("label", e.target.value)} />
      </div>
      <div className="alarmw__days">
        {DAY_NAMES.map((d, i) => (
          <button
            key={d}
            type="button"
            className="alarmw__day"
            aria-pressed={!!(form.days & (1 << i))}
            onClick={() => set("days", form.days ^ (1 << i))}
          >
            {d.slice(0, 2)}
          </button>
        ))}
      </div>
      <div className="alarmw__presets muted">
        Repeat:
        {(
          [
            ["Once", 0],
            ["Weekdays", 0b0011111],
            ["Every day", 127],
          ] as const
        ).map(([label, days]) => (
          <button key={label} type="button" className="btn btn--sm btn--ghost" aria-pressed={form.days === days} onClick={() => set("days", days)}>
            {label}
          </button>
        ))}
      </div>
      <SoundPicker sound={form.sound} volume={form.volume} onSound={(s) => set("sound", s)} onVolume={(v) => set("volume", v)} />
      <label className="alarmw__field">
        <span className="label">Snooze</span>
        <select className="select select--sm" value={form.snoozeMinutes} onChange={(e) => set("snoozeMinutes", Number(e.target.value))}>
          {[1, 3, 5, 10, 15, 20, 30].map((m) => (
            <option key={m} value={m}>
              {m} min
            </option>
          ))}
        </select>
      </label>
      <div className="alarmw__buttons">
        <button
          type="button"
          className="btn btn--sm btn--ghost"
          onClick={() => {
            void api.alarms.stopPreview();
            onDone();
          }}
        >
          Cancel
        </button>
        <button className="btn btn--sm btn--primary" disabled={busy}>
          Save
        </button>
      </div>
    </form>
  );
}

/** Built-in sounds and imported files, with a preview button and "Add file…". */
function SoundPicker(props: { sound: string; volume: number; onSound: (s: string) => void; onVolume: (v: number) => void }) {
  const sounds = useAlarms((s) => s.sounds);

  const addFile = async () => {
    const path = await openDialog({
      title: "Choose an alarm sound",
      multiple: false,
      directory: false,
      filters: [{ name: "Audio", extensions: ["mp3", "wav", "ogg", "flac"] }],
    });
    if (typeof path !== "string") return;
    try {
      const s = await api.alarms.importSound(path);
      await useAlarms.getState().loadSounds();
      props.onSound(s.id);
    } catch (err) {
      reportError("Could not add the sound", err);
    }
  };

  const current = sounds.find((s) => s.id === props.sound);
  return (
    <>
      <label className="alarmw__field">
        <span className="label">Sound</span>
        <select
          className="select select--sm"
          value={props.sound}
          onChange={(e) => (e.target.value === "__add" ? void addFile() : props.onSound(e.target.value))}
        >
          <optgroup label="Built-in">
            {sounds
              .filter((s) => s.builtin)
              .map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
          </optgroup>
          {sounds.some((s) => !s.builtin) && (
            <optgroup label="Your files">
              {sounds
                .filter((s) => !s.builtin)
                .map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
            </optgroup>
          )}
          {!current && <option value={props.sound}>{props.sound}</option>}
          <option value="__add">Add a file…</option>
        </select>
        <button type="button" className="icon-btn icon-btn--sm" title="Play for 4 seconds" onClick={() => void run("Could not play", api.alarms.preview(props.sound, props.volume))}>
          <Play size={12} />
        </button>
        {current && !current.builtin && (
          <button
            type="button"
            className="icon-btn icon-btn--sm"
            title="Remove this file from NETRUNNER"
            onClick={() =>
              void api.alarms
                .deleteSound(current.id)
                .then(() => useAlarms.getState().loadSounds())
                .then(() => props.onSound("pulse"))
                .catch((err) => reportError("Could not remove the sound", err))
            }
          >
            <X size={12} />
          </button>
        )}
      </label>
      <label className="alarmw__field">
        <span className="label">
          <Volume2 size={11} />
        </span>
        <input type="range" min={0} max={100} step={5} value={props.volume} onChange={(e) => props.onVolume(Number(e.target.value))} />
        <span className="mono muted">{props.volume}%</span>
      </label>
    </>
  );
}

// ---------- Timers ----------

const PRESETS = [1, 3, 5, 10, 15, 25, 60];

function Timers({ timers }: { timers: Timer[] }) {
  const [text, setText] = useState("");
  const [label, setLabel] = useState("");
  const [sound, setSound] = useState("chime");
  const [volume, setVolume] = useState(80);
  const [more, setMore] = useState(false);
  const now = useNow(250);

  const create = (durationMs: number, name = label) => {
    void run("Could not start the timer", api.alarms.createTimer({ label: name, durationMs, sound, volume }, true));
    setText("");
    setLabel("");
  };
  const custom = parseDuration(text);

  return (
    <>
      <div className="alarmw__presets">
        {PRESETS.map((m) => (
          <button key={m} className="btn btn--sm btn--ghost" title={`Start a ${m} minute timer`} onClick={() => create(m * 60000, label || `${m} min`)}>
            {m < 60 ? `${m}m` : `${m / 60}h`}
          </button>
        ))}
      </div>
      <form
        className="alarmw__row"
        onSubmit={(e) => {
          e.preventDefault();
          if (custom) create(custom);
        }}
      >
        <input
          className="input mono alarmw__dur"
          placeholder="mm:ss"
          title="Minutes, mm:ss or h:mm:ss"
          value={text}
          onChange={(e) => setText(e.target.value)}
          aria-invalid={!!text && !custom}
        />
        <input className="input" placeholder="Label" maxLength={60} value={label} onChange={(e) => setLabel(e.target.value)} />
        <button className="icon-btn icon-btn--sm" title="Start" disabled={!custom}>
          <Play size={13} />
        </button>
        <button type="button" className="icon-btn icon-btn--sm" title="Sound" aria-pressed={more} onClick={() => setMore(!more)}>
          <Volume2 size={13} />
        </button>
      </form>
      {more && <SoundPicker sound={sound} volume={volume} onSound={setSound} onVolume={setVolume} />}
      {timers.length === 0 ? (
        <div className="empty">Pick a preset or type a time. Timers ring even when NETRUNNER is in the tray.</div>
      ) : (
        <ul className="alarmw__list">
          {timers.map((t) => {
            const left = t.endsAt ? t.endsAt - now : (t.remainingMs ?? t.durationMs);
            const state = t.endsAt ? "running" : t.remainingMs !== null ? "paused" : "idle";
            return (
              <li key={t.id} className="alarmw__timer" data-state={state}>
                <span className="alarmw__count mono">{formatDuration(left)}</span>
                <span className="alarmw__meta">
                  <span className="alarmw__label">{t.label || formatDuration(t.durationMs)}</span>
                  <span className="alarmw__bar">
                    <span style={{ width: `${Math.min(100, Math.max(0, (1 - left / t.durationMs) * 100))}%` }} />
                  </span>
                </span>
                <span className="alarmw__controls">
                  {state === "running" ? (
                    <button className="icon-btn icon-btn--sm" title="Pause" onClick={() => void run("Could not pause", api.alarms.timer(t.id, "pause"))}>
                      <Pause size={12} />
                    </button>
                  ) : (
                    <button className="icon-btn icon-btn--sm" title="Start" onClick={() => void run("Could not start", api.alarms.timer(t.id, "start"))}>
                      <Play size={12} />
                    </button>
                  )}
                  <button className="icon-btn icon-btn--sm" title="Reset" onClick={() => void run("Could not reset", api.alarms.timer(t.id, "reset"))}>
                    <RotateCcw size={12} />
                  </button>
                  <button className="icon-btn icon-btn--sm" title="Delete" onClick={() => void run("Could not delete", api.alarms.removeTimer(t.id))}>
                    <Trash2 size={12} />
                  </button>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

// ---------- Stopwatch ----------

interface Watch {
  /** Date.now() when started; null while stopped. */
  startedAt: number | null;
  /** Time accumulated before the current run. */
  elapsed: number;
  laps: number[];
}

const EMPTY_WATCH: Watch = { startedAt: null, elapsed: 0, laps: [] };

/** Kept in this window's storage per widget, so it survives switching modules and restarts. */
function useWatch(id: string): [Watch, (w: Watch) => void] {
  const key = `nr.stopwatch.${id}`;
  const [watch, setWatch] = useState<Watch>(() => {
    try {
      const raw = JSON.parse(localStorage.getItem(key) ?? "null") as Watch | null;
      return raw && typeof raw.elapsed === "number" && Array.isArray(raw.laps) ? raw : EMPTY_WATCH;
    } catch {
      return EMPTY_WATCH;
    }
  });
  const save = (w: Watch) => {
    setWatch(w);
    try {
      localStorage.setItem(key, JSON.stringify(w));
    } catch {
      /* storage full or blocked: keeps working for this session */
    }
  };
  return [watch, save];
}

function formatWatch(ms: number) {
  const cs = Math.floor(ms / 10) % 100;
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  return `${h ? `${h}:` : ""}${String(Math.floor(s / 60) % 60).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

function Stopwatch({ id }: { id: string }) {
  const [w, save] = useWatch(id);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (w.startedAt === null) return;
    const t = window.setInterval(() => setNow(Date.now()), 33);
    return () => window.clearInterval(t);
  }, [w.startedAt]);
  const total = w.elapsed + (w.startedAt !== null ? now - w.startedAt : 0);
  const lapBase = w.laps.reduce((a, b) => a + b, 0);

  return (
    <div className="alarmw__watch">
      <div className="alarmw__watch-time mono">{formatWatch(total)}</div>
      <div className="alarmw__buttons alarmw__buttons--center">
        {w.startedAt === null ? (
          <button className="btn btn--sm btn--primary" onClick={() => save({ ...w, startedAt: Date.now() })}>
            <Play size={12} /> {w.elapsed ? "Resume" : "Start"}
          </button>
        ) : (
          <button className="btn btn--sm" onClick={() => save({ ...w, startedAt: null, elapsed: total })}>
            <Square size={11} /> Stop
          </button>
        )}
        <button className="btn btn--sm btn--ghost" disabled={w.startedAt === null} onClick={() => save({ ...w, laps: [...w.laps, total - lapBase] })}>
          <Flag size={12} /> Lap
        </button>
        <button className="btn btn--sm btn--ghost" disabled={!total} onClick={() => save(EMPTY_WATCH)}>
          <RotateCcw size={12} /> Reset
        </button>
      </div>
      {w.laps.length > 0 && (
        <ol className="alarmw__laps mono">
          {w.laps
            .map((lap, i) => ({ lap, i }))
            .reverse()
            .map(({ lap, i }) => (
              <li key={i}>
                <span className="muted">#{i + 1}</span>
                <span>{formatWatch(lap)}</span>
                <span className="muted">{formatWatch(w.laps.slice(0, i + 1).reduce((a, b) => a + b, 0))}</span>
              </li>
            ))}
        </ol>
      )}
    </div>
  );
}
