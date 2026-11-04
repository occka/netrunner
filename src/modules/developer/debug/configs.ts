/**
 * What a debug session starts with: from `.netrunner/launch.json` entries that
 * have a "debug" block, or chosen from the active file. Pure and tested.
 */
export interface DebugConfig {
  name: string;
  adapter: "debugpy" | "delve" | "codelldb" | "js-debug";
  request: "launch" | "attach";
  config: Record<string, unknown>;
}

const dirOf = (path: string) => path.replace(/[\\/][^\\/]*$/, "");
const ADAPTERS = ["debugpy", "delve", "codelldb", "js-debug"];

/** A debug configuration for the file, or null when its language needs a built program or has no adapter. */
export function autoDebugConfig(path: string, root: string): DebugConfig | null {
  const name = path.split(/[\\/]/).pop() ?? path;
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  if (ext === "py" || ext === "pyw") {
    return {
      name: `Python: ${name}`,
      adapter: "debugpy",
      request: "launch",
      config: { name, type: "python", request: "launch", program: path, cwd: root, console: "internalConsole", justMyCode: true },
    };
  }
  if (ext === "go") {
    return { name: `Go: ${name}`, adapter: "delve", request: "launch", config: { name, type: "go", request: "launch", mode: "debug", program: dirOf(path), cwd: root } };
  }
  if (ext === "js" || ext === "mjs" || ext === "cjs") {
    return { name: `Node: ${name}`, adapter: "js-debug", request: "launch", config: nodeConfig({ name, request: "launch", program: path, cwd: root }) };
  }
  return null;
}

/** Output goes to the debug console, not to a terminal the session cannot reach. */
const nodeConfig = (c: Record<string, unknown>) => ({ type: "pwa-node", console: "internalConsole", ...c });

/** A built program for Rust, C and C++ (the user names it). */
export function nativeDebugConfig(program: string, root: string): DebugConfig {
  return {
    name: `Native: ${program.split(/[\\/]/).pop()}`,
    adapter: "codelldb",
    request: "launch",
    config: { name: "native", type: "lldb", request: "launch", program, cwd: root, args: [] },
  };
}

export const needsBuiltProgram = (path: string) => /\.(rs|c|cc|cpp|cxx|h|hpp)$/i.test(path);

/** `"debug": { "adapter": "debugpy", "program": "main.py", ... }` blocks of launch.json configurations. */
export function debugConfigsFromLaunch(raw: { configurations?: { name?: string; debug?: Record<string, unknown> }[] }, root: string): DebugConfig[] {
  const out: DebugConfig[] = [];
  for (const c of raw.configurations ?? []) {
    const d = c.debug;
    if (!d || typeof c.name !== "string" || !ADAPTERS.includes(String(d.adapter))) continue;
    const { adapter, request, ...rest } = d;
    const req = request === "attach" ? "attach" : "launch";
    const config: Record<string, unknown> = { name: c.name, request: req, cwd: root, ...rest };
    if (adapter === "debugpy") {
      config.type = "python";
      config.console = "internalConsole";
    }
    out.push({ name: c.name, adapter: adapter as DebugConfig["adapter"], request: req, config: adapter === "js-debug" ? nodeConfig(config) : config });
  }
  return out;
}

/** Display text of a stack frame's location. */
export function frameLabel(f: { name: string; line: number; source?: { name?: string; path?: string } }) {
  const file = f.source?.name ?? f.source?.path?.split(/[\\/]/).pop();
  return file ? `${file}:${f.line}` : `line ${f.line}`;
}

/** Breakpoints after an edit: lines from the editor's tracked decorations, keeping order and conditions. */
export function shiftedBreakpoints<T extends { line: number }>(items: T[], newLines: number[]): T[] {
  return items.map((b, i) => ({ ...b, line: newLines[i] ?? b.line }));
}
