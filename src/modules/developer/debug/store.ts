/**
 * The debugger session as the UI sees it. The backend owns the transport and
 * startup; here adapter events become state, and a stop loads the stack.
 */
import { Channel } from "@tauri-apps/api/core";
import { create } from "zustand";
import { api } from "@/services/api";
import { notify, reportError } from "@/stores/notifications";
import { useSettings } from "@/stores/settings";
import type { DapEvent } from "@/types/dev";
import { pathKey } from "../lsp/convert";
import { openAt } from "../lsp/client";
import { useDev } from "../store";
import type { DebugConfig } from "./configs";

export interface Breakpoint {
  line: number;
  condition?: string;
  /** False when the adapter could not bind the line. */
  verified?: boolean;
}

export interface Frame {
  id: number;
  name: string;
  line: number;
  column: number;
  source?: { name?: string; path?: string };
}

export interface Variable {
  name: string;
  value: string;
  type?: string;
  variablesReference: number;
}

export interface Scope {
  name: string;
  variablesReference: number;
  expensive?: boolean;
}

export interface ConsoleLine {
  kind: "out" | "err" | "info" | "input" | "result";
  text: string;
}

interface DebugStore {
  status: "idle" | "starting" | "running" | "stopped";
  config: DebugConfig | null;
  threadId: number | null;
  frames: Frame[];
  frameId: number | null;
  scopes: Scope[];
  /** Bumped at every stop: variable references are only valid until the program runs on. */
  stopTick: number;
  stopReason: string | null;
  /** Where execution stopped (the selected frame). */
  location: { path: string; line: number } | null;
  console: ConsoleLine[];
  watches: { expr: string; value: string | null; error: boolean }[];
  breakpoints: Record<string, { path: string; items: Breakpoint[] }>;
  loadBreakpoints: () => void;
  toggleBreakpoint: (path: string, line: number, condition?: string) => void;
  setBreakpointLines: (path: string, lines: number[]) => void;
  start: (root: string, config: DebugConfig) => Promise<void>;
  stop: () => Promise<void>;
  restart: (root: string) => Promise<void>;
  resume: (command: "continue" | "next" | "stepIn" | "stepOut") => Promise<void>;
  pause: () => Promise<void>;
  selectFrame: (frame: Frame) => Promise<void>;
  addWatch: (expr: string) => void;
  removeWatch: (expr: string) => void;
  evaluate: (expr: string) => Promise<void>;
}

const MAX_CONSOLE = 2000;

const saveBreakpoints = (all: DebugStore["breakpoints"]) => {
  const out: Record<string, { line: number; condition?: string }[]> = {};
  for (const f of Object.values(all)) if (f.items.length) out[f.path] = f.items.map((b) => ({ line: b.line, condition: b.condition }));
  useSettings.getState().setDebounced("developer.breakpoints", out);
};

const INITIAL = { status: "idle" as const, threadId: null, frames: [], frameId: null, scopes: [], stopReason: null, location: null };

export const useDebug = create<DebugStore>((set, get) => {
  const log = (kind: ConsoleLine["kind"], text: string) => set((s) => ({ console: [...s.console, { kind, text }].slice(-MAX_CONSOLE) }));

  const sendBreakpoints = async (path: string) => {
    if (get().status === "idle" || get().status === "starting") return;
    const items = get().breakpoints[pathKey(path)]?.items ?? [];
    const name = path.split(/[\\/]/).pop();
    try {
      const reply = await api.dap.request<{ breakpoints?: { verified?: boolean }[] }>("setBreakpoints", {
        source: { path, name },
        breakpoints: items.map((b) => (b.condition ? { line: b.line, condition: b.condition } : { line: b.line })),
      });
      applyVerified(path, reply.breakpoints ?? []);
    } catch (err) {
      reportError("Could not update breakpoints", err);
    }
  };

  const applyVerified = (path: string, list: { verified?: boolean; line?: number }[]) =>
    set((s) => {
      const f = s.breakpoints[pathKey(path)];
      if (!f) return s;
      return { breakpoints: { ...s.breakpoints, [pathKey(path)]: { ...f, items: f.items.map((b, i) => ({ ...b, verified: list[i]?.verified ?? b.verified })) } } };
    });

  const refreshWatches = async () => {
    const { watches, frameId } = get();
    if (get().status !== "stopped") return;
    const next = await Promise.all(
      watches.map(async (w) => {
        try {
          const r = await api.dap.request<{ result: string }>("evaluate", { expression: w.expr, frameId, context: "watch" });
          return { expr: w.expr, value: r.result, error: false };
        } catch (err) {
          return { expr: w.expr, value: String((err as { message?: string })?.message ?? err), error: true };
        }
      }),
    );
    set({ watches: next });
  };

  const onStopped = async (threadId: number, reason: string | null) => {
    set({ status: "stopped", threadId, stopReason: reason, stopTick: get().stopTick + 1 });
    try {
      const st = await api.dap.request<{ stackFrames: Frame[] }>("stackTrace", { threadId, startFrame: 0, levels: 60 });
      set({ frames: st.stackFrames });
      // The first frame that has source code in a file.
      const top = st.stackFrames.find((f) => f.source?.path) ?? st.stackFrames[0];
      if (top) await get().selectFrame(top);
    } catch (err) {
      reportError("Could not read the call stack", err);
    }
  };

  const onEvent = (e: DapEvent) => {
    if (e.type === "failed") {
      log("err", e.message);
      notify.error("Debug session failed", e.message);
      return;
    }
    if (e.type === "closed") {
      set({ ...INITIAL });
      return;
    }
    const b = e.body ?? {};
    switch (e.event) {
      case "stopped":
        void onStopped(b.threadId ?? get().threadId ?? 1, b.description ?? b.reason ?? null);
        break;
      case "continued":
        set({ status: "running", frames: [], scopes: [], frameId: null, location: null, stopReason: null });
        break;
      case "output":
        if (b.category !== "telemetry" && typeof b.output === "string") log(b.category === "stderr" ? "err" : b.category === "console" ? "info" : "out", b.output);
        break;
      case "breakpointsSet":
        applyVerified(b.path, b.breakpoints ?? []);
        break;
      case "breakpoint":
        break;
      case "exited":
        log("info", `Program exited with code ${b.exitCode}\n`);
        break;
      case "terminated":
        void get().stop();
        break;
    }
  };

  return {
    ...INITIAL,
    config: null,
    stopTick: 0,
    console: [],
    watches: [],
    breakpoints: {},

    loadBreakpoints: () => {
      const saved = useSettings.getState().values["developer.breakpoints"];
      const all: DebugStore["breakpoints"] = {};
      for (const [path, items] of Object.entries(saved)) all[pathKey(path)] = { path, items };
      set({ breakpoints: all });
    },

    toggleBreakpoint: (path, line, condition) => {
      const key = pathKey(path);
      const f = get().breakpoints[key] ?? { path, items: [] };
      const has = f.items.find((b) => b.line === line);
      // A condition edits the breakpoint; a plain toggle removes it.
      const items =
        condition !== undefined
          ? [...f.items.filter((b) => b.line !== line), { line, condition: condition || undefined }]
          : has
            ? f.items.filter((b) => b.line !== line)
            : [...f.items, { line }];
      items.sort((a, b) => a.line - b.line);
      const all = { ...get().breakpoints, [key]: { path, items } };
      set({ breakpoints: all });
      saveBreakpoints(all);
      void sendBreakpoints(path);
    },

    setBreakpointLines: (path, lines) => {
      const key = pathKey(path);
      const f = get().breakpoints[key];
      if (!f || f.items.every((b, i) => b.line === lines[i])) return;
      const all = { ...get().breakpoints, [key]: { ...f, items: f.items.map((b, i) => ({ ...b, line: lines[i] ?? b.line })) } };
      set({ breakpoints: all });
      saveBreakpoints(all);
    },

    start: async (root, config) => {
      if (get().status !== "idle") await get().stop();
      set({ ...INITIAL, status: "starting", config, console: [{ kind: "info", text: `Starting ${config.name}\n` }] });
      useDev.getState().toggleTerminal(false);
      const channel = new Channel<DapEvent>();
      channel.onmessage = onEvent;
      const files = Object.values(get().breakpoints)
        .filter((f) => f.items.length)
        .map((f) => ({ path: f.path, breakpoints: f.items.map((b) => ({ line: b.line, condition: b.condition })) }));
      // Events can already arrive while dap_start waits, so "running" must not overwrite a stop.
      set({ status: "running" });
      try {
        await api.dap.start(root, config.adapter, config.request, config.config, files, channel);
      } catch (err) {
        set({ ...INITIAL });
        const message = String((err as { message?: string })?.message ?? err);
        log("err", `${message}\n`);
        reportError("Could not start debugging", err);
      }
    },

    stop: async () => {
      await api.dap.stop().catch(() => undefined);
      set({ ...INITIAL });
    },

    restart: async (root) => {
      const { config } = get();
      if (config) await get().start(root, config);
    },

    resume: async (command) => {
      const { threadId } = get();
      if (threadId == null || get().status !== "stopped") return;
      set({ status: "running", frames: [], scopes: [], frameId: null, location: null, stopReason: null });
      await api.dap.request(command, { threadId }).catch((err) => reportError(`Could not ${command}`, err));
    },

    pause: async () => {
      const t = await api.dap.request<{ threads: { id: number }[] }>("threads", {}).catch(() => null);
      const threadId = get().threadId ?? t?.threads[0]?.id;
      if (threadId != null) await api.dap.request("pause", { threadId }).catch((err) => reportError("Could not pause", err));
    },

    selectFrame: async (frame) => {
      const path = frame.source?.path;
      set({ frameId: frame.id, location: path ? { path, line: frame.line } : null });
      if (path) await openAt(path, { lineNumber: frame.line, column: Math.max(1, frame.column || 1) });
      const r = await api.dap.request<{ scopes: Scope[] }>("scopes", { frameId: frame.id }).catch(() => null);
      set({ scopes: r?.scopes ?? [] });
      await refreshWatches();
    },

    addWatch: (expr) => {
      if (!expr.trim() || get().watches.some((w) => w.expr === expr)) return;
      set((s) => ({ watches: [...s.watches, { expr, value: null, error: false }] }));
      void refreshWatches();
    },

    removeWatch: (expr) => set((s) => ({ watches: s.watches.filter((w) => w.expr !== expr) })),

    evaluate: async (expr) => {
      log("input", `${expr}\n`);
      try {
        const r = await api.dap.request<{ result: string }>("evaluate", { expression: expr, frameId: get().frameId ?? undefined, context: "repl" });
        log("result", `${r.result}\n`);
      } catch (err) {
        log("err", `${(err as { message?: string })?.message ?? err}\n`);
      }
    },
  };
});

// Development builds expose the store for automated UI checks.
if (import.meta.env.DEV) Object.assign(window, { __nrDebug: useDebug });
