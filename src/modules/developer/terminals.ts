/**
 * Terminal sessions live outside React so they survive navigating away from
 * DEVELOPER. Each session owns an xterm instance and a ConPTY in the backend.
 */
import { Channel } from "@tauri-apps/api/core";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { create } from "zustand";
import { api } from "@/services/api";
import { useSettings } from "@/stores/settings";
import { reportError } from "@/stores/notifications";
import type { TermEvent } from "@/types/dev";

export interface TermSession {
  id: number;
  title: string;
  shell: string;
  term: Terminal;
  fit: FitAddon;
  host: HTMLDivElement;
  exited: boolean;
}

interface TermStore {
  sessions: TermSession[];
  active: number | null;
  setActive: (id: number) => void;
}

export const useTerminals = create<TermStore>((set) => ({
  sessions: [],
  active: null,
  setActive: (active) => set({ active }),
}));

function xtermTheme() {
  const c = useSettings.getState().values.theme;
  return {
    background: c.surface,
    foreground: c.text,
    cursor: c.primary,
    cursorAccent: c.surface,
    selectionBackground: c.primary + "44",
    black: c.background,
    brightBlack: c.muted,
    yellow: c.primary,
    brightYellow: c.primary,
    cyan: c.secondary,
    brightCyan: c.secondary,
    green: c.success,
    brightGreen: c.success,
    red: c.critical,
    brightRed: c.critical,
  };
}

export async function openTerminal(shell: string, cwd: string | null, title?: string): Promise<TermSession | null> {
  const host = document.createElement("div");
  host.className = "term-host";
  const term = new Terminal({
    fontFamily: '"JetBrains Mono", "Cascadia Mono", Consolas, monospace',
    fontSize: 13,
    cursorBlink: true,
    scrollback: 5000,
    theme: xtermTheme(),
    allowProposedApi: false,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(host);

  const channel = new Channel<TermEvent>();
  let session: TermSession | null = null;
  channel.onmessage = (event) => {
    if (event.type === "data") term.write(event.data);
    else {
      term.write(`\r\n\x1b[90m[process exited${event.code != null ? ` with code ${event.code}` : ""}]\x1b[0m\r\n`);
      if (session) {
        session.exited = true;
        useTerminals.setState((s) => ({ sessions: [...s.sessions] }));
      }
    }
  };

  try {
    const id = await api.term.spawn(shell, cwd, term.cols, term.rows, channel);
    session = { id, title: title ?? shell, shell, term, fit, host, exited: false };
    term.onData((data) => {
      if (!session?.exited) void api.term.write(id, data).catch(() => undefined);
    });
    term.onResize(({ cols, rows }) => {
      if (!session?.exited) void api.term.resize(id, cols, rows).catch(() => undefined);
    });
    useTerminals.setState((s) => ({ sessions: [...s.sessions, session!], active: id }));
    return session;
  } catch (err) {
    term.dispose();
    reportError("Could not start terminal", err);
    return null;
  }
}

export async function closeTerminal(id: number) {
  const s = useTerminals.getState().sessions.find((x) => x.id === id);
  if (!s) return;
  if (!s.exited) await api.term.kill(id).catch(() => undefined);
  s.term.dispose();
  s.host.remove();
  useTerminals.setState((st) => {
    const sessions = st.sessions.filter((x) => x.id !== id);
    return { sessions, active: st.active === id ? (sessions.at(-1)?.id ?? null) : st.active };
  });
}

/** Types a command into a terminal (visible to the user, then executed). */
export function sendToTerminal(session: TermSession, command: string) {
  session.term.focus();
  void api.term.write(session.id, command + "\r");
}

// Keep terminal colours in sync with the NETRUNNER theme.
useSettings.subscribe((state, prev) => {
  if (state.values.theme === prev.values.theme) return;
  for (const s of useTerminals.getState().sessions) s.term.options.theme = xtermTheme();
});
