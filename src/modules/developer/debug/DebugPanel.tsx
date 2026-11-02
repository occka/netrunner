import { useEffect, useRef, useState } from "react";
import { ArrowDownToLine, ArrowUpFromLine, ChevronDown, ChevronRight, Download, ExternalLink, Pause, Play, Redo2, RotateCw, Square, X } from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { api } from "@/services/api";
import { usePolled } from "@/hooks/usePolled";
import { confirmAction } from "@/stores/confirm";
import { promptText } from "@/stores/prompt";
import { reportError } from "@/stores/notifications";
import { currentKey, useDev } from "../store";
import { runInTerminal } from "../terminals";
import { openAt } from "../lsp/client";
import { LAUNCH_FILE } from "../runConfigs";
import { autoDebugConfig, debugConfigsFromLaunch, frameLabel, needsBuiltProgram, nativeDebugConfig, type DebugConfig } from "./configs";
import { useDebug, type Scope, type Variable } from "./store";

function stripComments(text: string) {
  return text.replace(/\/\*[\s\S]*?\*\/|("(?:\\.|[^"\\])*")|\/\/.*$/gm, (_m, str) => str ?? "");
}

function useLaunchConfigs(root: string) {
  const revision = useDev((s) => s.revision);
  const [configs, setConfigs] = useState<DebugConfig[]>([]);
  useEffect(() => {
    let alive = true;
    api.dev
      .readFile(`${root}\\${LAUNCH_FILE}`)
      .then((f) => debugConfigsFromLaunch(JSON.parse(stripComments(f.content)), root))
      .catch(() => [])
      .then((list) => alive && setConfigs(list));
    return () => {
      alive = false;
    };
  }, [root, revision]);
  return configs;
}

/** Starts the configuration for the active file (asks for the program of native code). */
export async function startForActiveFile(root: string) {
  const s = useDev.getState();
  const tab = s.tabs.find((t) => t.key === currentKey(s) && t.kind === "file");
  const debug = useDebug.getState();
  if (!tab) return reportError("Nothing to debug", "Open a file first, or add a debug block to .netrunner/launch.json.");
  const config = autoDebugConfig(tab.path, root);
  if (config) return debug.start(root, config);
  if (needsBuiltProgram(tab.path)) {
    const file = await openDialog({ multiple: false, title: "Program to debug (build it first)", defaultPath: root, filters: [{ name: "Programs", extensions: ["exe"] }] });
    if (typeof file === "string") return debug.start(root, nativeDebugConfig(file, root));
    return;
  }
  reportError("No debugger for this file", "Python, Go, Rust, C and C++ are supported. Add a debug block to .netrunner/launch.json for other setups.");
}

function VariableRow({ v, depth }: { v: Variable; depth: number }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <div className="dbg-var" style={{ paddingLeft: 8 + depth * 12 }} onClick={() => v.variablesReference > 0 && setOpen((o) => !o)} title={v.type ? `${v.type}: ${v.value}` : v.value}>
        {v.variablesReference > 0 ? open ? <ChevronDown size={11} /> : <ChevronRight size={11} /> : <span className="tree__spacer" />}
        <span className="dbg-var__name">{v.name}</span>
        <span className="dbg-var__value mono truncate">{v.value}</span>
      </div>
      {open && <VariableList reference={v.variablesReference} depth={depth + 1} />}
    </>
  );
}

function VariableList({ reference, depth }: { reference: number; depth: number }) {
  const [vars, setVars] = useState<Variable[] | null>(null);
  useEffect(() => {
    let alive = true;
    api.dap
      .request<{ variables: Variable[] }>("variables", { variablesReference: reference })
      .then((r) => alive && setVars(r.variables))
      .catch(() => alive && setVars([]));
    return () => {
      alive = false;
    };
  }, [reference]);
  if (!vars) return <div className="muted dbg-var" style={{ paddingLeft: 8 + depth * 12 }}>Loading…</div>;
  return (
    <>
      {vars.slice(0, 500).map((v) => (
        <VariableRow key={v.name} v={v} depth={depth} />
      ))}
    </>
  );
}

function ScopeBlock({ scope, tick }: { scope: Scope; tick: number }) {
  const [open, setOpen] = useState(!scope.expensive);
  return (
    <>
      <div className="dbg-scope" onClick={() => setOpen((o) => !o)}>
        {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />} {scope.name}
      </div>
      {open && <VariableList key={`${tick}:${scope.variablesReference}`} reference={scope.variablesReference} depth={1} />}
    </>
  );
}

/** Variables, Watch, Call Stack, Breakpoints and the Debug Console. */
export function DebugPanel({ root }: { root: string }) {
  const d = useDebug();
  const launch = useLaunchConfigs(root);
  const adapters = usePolled(() => api.dap.adapters(root));
  const [watch, setWatch] = useState("");
  const [input, setInput] = useState("");
  const out = useRef<HTMLDivElement>(null);
  const active = d.status !== "idle";

  useEffect(() => {
    if (out.current) out.current.scrollTop = out.current.scrollHeight;
  }, [d.console.length]);

  const install = async (name: string, command: string) => {
    const ok = await confirmAction({ title: `Install ${name}`, message: `Run "${command}" in a DEVELOPER terminal?`, detail: "It runs visibly, with your permissions. NETRUNNER never installs anything by itself.", confirmLabel: "Run in terminal" });
    if (!ok) return;
    useDev.getState().toggleTerminal(true);
    await runInTerminal("Install", command, root);
  };

  const locateLldb = async () => {
    const file = await openDialog({ multiple: false, title: "Locate codelldb.exe", filters: [{ name: "codelldb", extensions: ["exe"] }] });
    if (typeof file !== "string") return;
    await api.settings.set("developer.codelldb_path", file).catch((e) => reportError("Could not save the path", e));
    void adapters.reload();
  };

  const breakpoints = Object.values(d.breakpoints).flatMap((f) => f.items.map((b) => ({ ...b, path: f.path })));

  return (
    <div className="dbg">
      <div className="dbg__bar">
        {!active ? (
          <>
            <button className="btn btn--primary btn--sm" title="Debug the active file (F5)" onClick={() => void startForActiveFile(root).catch((e) => reportError("Could not start", e))}>
              <Play size={12} /> Start
            </button>
            {launch.length > 0 && (
              <select className="input dbg__select" value="" onChange={(e) => e.target.value && void d.start(root, launch[Number(e.target.value)])} title={`From ${LAUNCH_FILE}`}>
                <option value="">launch.json…</option>
                {launch.map((c, i) => (
                  <option key={c.name} value={i}>
                    {c.name}
                  </option>
                ))}
              </select>
            )}
          </>
        ) : (
          <>
            {d.status === "stopped" ? (
              <button className="icon-btn icon-btn--sm" title="Continue (F5)" onClick={() => void d.resume("continue")}>
                <Play size={13} />
              </button>
            ) : (
              <button className="icon-btn icon-btn--sm" title="Pause" onClick={() => void d.pause()} disabled={d.status === "starting"}>
                <Pause size={13} />
              </button>
            )}
            <button className="icon-btn icon-btn--sm" title="Step over (F10)" disabled={d.status !== "stopped"} onClick={() => void d.resume("next")}>
              <Redo2 size={13} />
            </button>
            <button className="icon-btn icon-btn--sm" title="Step into (F11)" disabled={d.status !== "stopped"} onClick={() => void d.resume("stepIn")}>
              <ArrowDownToLine size={13} />
            </button>
            <button className="icon-btn icon-btn--sm" title="Step out (Shift+F11)" disabled={d.status !== "stopped"} onClick={() => void d.resume("stepOut")}>
              <ArrowUpFromLine size={13} />
            </button>
            <button className="icon-btn icon-btn--sm" title="Restart" onClick={() => void d.restart(root)}>
              <RotateCw size={13} />
            </button>
            <button className="icon-btn icon-btn--sm" title="Stop (Shift+F5)" onClick={() => void d.stop()}>
              <Square size={13} />
            </button>
            <span className="muted truncate dbg__state" title={d.config?.name}>
              {d.status === "stopped" ? `Paused${d.stopReason ? `: ${d.stopReason}` : ""}` : d.status === "starting" ? "Starting…" : "Running"}
            </span>
          </>
        )}
      </div>

      <div className="dbg__scroll">
        {active && (
          <>
            <div className="git__group-head label">Variables</div>
            {d.scopes.map((s) => (
              <ScopeBlock key={`${d.stopTick}:${d.frameId}:${s.name}`} scope={s} tick={d.stopTick} />
            ))}
            {!d.scopes.length && <div className="muted gh__note">{d.status === "stopped" ? "No variables here." : "Variables appear when the program pauses."}</div>}

            <div className="git__group-head label">Call stack</div>
            {d.frames.map((f) => (
              <button key={f.id} className="problems__item" aria-pressed={f.id === d.frameId} onClick={() => void d.selectFrame(f)}>
                <span className="truncate">{f.name}</span>
                <span className="muted mono problems__pos">{frameLabel(f)}</span>
              </button>
            ))}
          </>
        )}

        <div className="git__group-head label">Watch</div>
        {d.watches.map((w) => (
          <div key={w.expr} className="dbg-var dbg-watch" title={w.value ?? undefined}>
            <span className="dbg-var__name">{w.expr}</span>
            <span className={`dbg-var__value mono truncate${w.error ? " text-crit" : ""}`}>{w.value ?? "—"}</span>
            <button className="icon-btn icon-btn--sm" aria-label={`Remove watch ${w.expr}`} onClick={() => d.removeWatch(w.expr)}>
              <X size={10} />
            </button>
          </div>
        ))}
        <form
          className="gh__form"
          onSubmit={(e) => {
            e.preventDefault();
            d.addWatch(watch);
            setWatch("");
          }}
        >
          <input className="input dbg__input" placeholder="Add expression" value={watch} onChange={(e) => setWatch(e.target.value)} />
        </form>

        <div className="git__group-head label">Breakpoints · {breakpoints.length}</div>
        {breakpoints.map((b) => (
          <div key={`${b.path}:${b.line}`} className="dbg-var dbg-watch">
            <button className="gh__item-main" onClick={() => void openAt(b.path, { lineNumber: b.line, column: 1 })} title={b.path}>
              <span className={`debug-dot${b.verified === false ? " debug-dot--off" : ""}`} />
              <span className="truncate">{b.path.split(/[\\/]/).pop()}</span>
              <span className="muted mono">:{b.line}</span>
              {b.condition && <span className="muted mono truncate">if {b.condition}</span>}
            </button>
            <button
              className="icon-btn icon-btn--sm"
              title="Change the condition"
              onClick={async () => {
                const v = await promptText({ title: `Breakpoint on line ${b.line}`, label: "Stop only when this expression is true (empty: always)", initial: b.condition ?? "", confirmLabel: "Set", allowEmpty: true });
                if (v !== null) d.toggleBreakpoint(b.path, b.line, v.trim());
              }}
            >
              if
            </button>
            <button className="icon-btn icon-btn--sm" aria-label="Remove breakpoint" onClick={() => d.toggleBreakpoint(b.path, b.line)}>
              <X size={10} />
            </button>
          </div>
        ))}
        {!breakpoints.length && <div className="muted gh__note">Click left of a line number to add one, or press F9.</div>}

        {!active && (
          <>
            <div className="git__group-head label">Debuggers</div>
            {(adapters.data ?? []).map((a) => (
              <div key={a.id} className="tool" data-found={a.found}>
                <div className="tool__head">
                  <span className="tool__name">{a.name}</span>
                  <span className="muted tool__lang">{a.languages}</span>
                </div>
                <div className="tool__version mono truncate" title={a.note ?? a.path ?? undefined}>
                  {a.found ? (a.note ?? a.path) : (a.note ?? "not installed")}
                </div>
                {!a.found && (
                  <div className="tool__actions">
                    {a.install && (
                      <button className="btn btn--sm" title={a.install} onClick={() => void install(a.name, a.install!)}>
                        <Download size={11} /> Install
                      </button>
                    )}
                    {!a.install && (
                      <button className="btn btn--sm btn--ghost" onClick={() => void api.app.openUrl(a.docs)}>
                        <ExternalLink size={11} /> Get it
                      </button>
                    )}
                    {a.id === "codelldb" && (
                      <button className="btn btn--sm btn--ghost" onClick={() => void locateLldb()}>
                        Locate…
                      </button>
                    )}
                    <button className="btn btn--sm btn--ghost" onClick={() => void adapters.reload()}>
                      Retry
                    </button>
                  </div>
                )}
              </div>
            ))}
          </>
        )}
      </div>

      <div className="dbg__console">
        <div className="git__group-head label">Debug console</div>
        <div className="dbg__output mono" ref={out}>
          {d.console.map((l, i) => (
            <span key={i} className={`dbg-line dbg-line--${l.kind}`}>
              {l.text}
            </span>
          ))}
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (input.trim()) void d.evaluate(input);
            setInput("");
          }}
        >
          <input className="input dbg__input mono" placeholder={d.status === "stopped" ? "Evaluate in the selected frame" : "Available while paused"} disabled={d.status !== "stopped"} value={input} onChange={(e) => setInput(e.target.value)} />
        </form>
      </div>
    </div>
  );
}
