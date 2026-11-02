/**
 * Tasks: the command is typed into a visible DEVELOPER terminal and its
 * output is read back from the terminal buffer for problem matching.
 */
import type { IDisposable } from "@xterm/xterm";
import { api } from "@/services/api";
import { useDev } from "./store";
import { runInTerminal, type TermSession } from "./terminals";
import { joinWrapped, ProblemMatcher, resolveTaskPath, type TaskProblem } from "./matchers";
import { detectConfigs, LAUNCH_FILE, parseLaunchJson, type RunConfig } from "./runConfigs";

export type { RunConfig } from "./runConfigs";

export async function loadConfigs(root: string): Promise<{ configs: RunConfig[]; error: string | null }> {
  const entries = await api.dev.listDir(root).catch(() => []);
  const names = entries.map((e) => e.name);
  const read: Record<string, string | undefined> = {};
  const text = (p: string) => api.dev.readFile(`${root}\\${p}`).then((f) => f.content, () => undefined);
  if (names.includes("package.json")) read["package.json"] = await text("package.json");
  if (!names.includes("Cargo.toml") && names.includes("src-tauri")) read["src-tauri/Cargo.toml"] = await text("src-tauri\\Cargo.toml");
  let user: RunConfig[] = [];
  let error: string | null = null;
  const launch = await text(LAUNCH_FILE);
  if (launch !== undefined) {
    try {
      user = parseLaunchJson(root, launch);
    } catch (err) {
      error = `${LAUNCH_FILE}: ${(err as Error).message}`;
    }
  }
  return { configs: [...user, ...detectConfigs(root, names, read)], error };
}

// ---------- Running ----------

type ProblemSink = (problems: { path: string; problem: TaskProblem }[] | null) => void;
let sink: ProblemSink = () => {};
/** The LSP client shows task problems next to language-server diagnostics. */
export function onTaskProblems(fn: ProblemSink) {
  sink = fn;
}

const attached = new WeakMap<TermSession, IDisposable>();

/** Reads the terminal buffer as it fills and feeds complete lines to the matchers. */
function attachMatcher(session: TermSession, cwd: string) {
  attached.get(session)?.dispose();
  const term = session.term;
  const buf = () => term.buffer.active;
  let next = buf().baseY + buf().cursorY;
  const matcher = new ProblemMatcher();
  const found: { path: string; problem: TaskProblem }[] = [];
  let timer = 0;
  const scan = () => {
    const b = buf();
    const last = b.baseY + b.cursorY; // the cursor row may still grow
    if (next > last) next = last;
    // The cursor row may continue the rows above it: stop before that logical line.
    let end = last;
    while (end > next && b.getLine(end)?.isWrapped) end--;
    const rows: { text: string; wrapped: boolean }[] = [];
    for (let i = next; i < end; i++) {
      const line = b.getLine(i);
      if (line) rows.push({ text: line.translateToString(true), wrapped: line.isWrapped });
    }
    next = end;
    let added = false;
    for (const text of joinWrapped(rows)) {
      for (const problem of matcher.push(text)) {
        found.push({ path: resolveTaskPath(cwd, problem.file), problem });
        added = true;
      }
    }
    if (added) sink([...found]);
  };
  const sub = term.onWriteParsed(() => {
    window.clearTimeout(timer);
    timer = window.setTimeout(scan, 250);
  });
  attached.set(session, sub);
}

export async function runTask(cfg: RunConfig) {
  useDev.getState().toggleTerminal(true);
  sink(null);
  const session = await runInTerminal("Task", cfg.command, cfg.cwd);
  if (session) attachMatcher(session, cfg.cwd);
}
