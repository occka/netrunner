/**
 * Run configurations: auto-detected from project files or read from
 * `.netrunner/launch.json`. Pure functions (tested without a DOM).
 */
import { resolveTaskPath } from "./matchers";

export interface RunConfig {
  id: string;
  name: string;
  command: string;
  cwd: string;
  group: "run" | "test" | "build";
  source: "launch.json" | "auto";
}

export const LAUNCH_FILE = ".netrunner\\launch.json";
export const LAUNCH_TEMPLATE = `{
  // Run configurations for NETRUNNER DEVELOPER. "group": run | test | build; "cwd" is relative to the project.
  "configurations": [
    { "name": "Start", "command": "npm start", "group": "run" }
  ]
}
`;

const groupOf = (name: string): RunConfig["group"] => (/^test|:test|^check|^lint/i.test(name) ? "test" : /build|compile|bundle/i.test(name) ? "build" : "run");

function stripJsonComments(text: string) {
  return text.replace(/\/\*[\s\S]*?\*\/|("(?:\\.|[^"\\])*")|\/\/.*$/gm, (_m, str) => str ?? "");
}

/** Configurations from the project's files (pure: names of root entries and file contents). */
export function detectConfigs(root: string, names: string[], read: Record<string, string | undefined>): RunConfig[] {
  const has = (n: string) => names.some((x) => x.toLowerCase() === n.toLowerCase());
  const out: RunConfig[] = [];
  const add = (name: string, command: string, group: RunConfig["group"], cwd = root) =>
    out.push({ id: `${cwd}|${command}`, name, command, cwd, group, source: "auto" });

  if (read["package.json"]) {
    try {
      const scripts = (JSON.parse(read["package.json"]) as { scripts?: Record<string, string> }).scripts ?? {};
      const pm = has("pnpm-lock.yaml") ? "pnpm" : has("yarn.lock") ? "yarn" : has("bun.lockb") || has("bun.lock") ? "bun" : "npm";
      for (const name of Object.keys(scripts)) add(`${pm} run ${name}`, `${pm} run ${name}`, groupOf(name));
    } catch {
      // A broken package.json gives no scripts.
    }
  }
  const cargo = (cwd: string, label: string) => {
    add(`cargo run${label}`, "cargo run", "run", cwd);
    add(`cargo test${label}`, "cargo test", "test", cwd);
    add(`cargo build${label}`, "cargo build", "build", cwd);
    add(`cargo clippy${label}`, "cargo clippy --all-targets", "test", cwd);
  };
  if (has("Cargo.toml")) cargo(root, "");
  else if (read["src-tauri/Cargo.toml"]) cargo(`${root}\\src-tauri`, " (src-tauri)");
  if (has("go.mod")) {
    add("go run .", "go run .", "run");
    add("go test ./...", "go test ./...", "test");
    add("go build ./...", "go build ./...", "build");
  }
  if (names.some((n) => /\.(csproj|fsproj|sln)$/i.test(n))) {
    add("dotnet run", "dotnet run", "run");
    add("dotnet test", "dotnet test", "test");
    add("dotnet build", "dotnet build", "build");
  }
  if (has("pom.xml")) {
    add("mvn test", "mvn test", "test");
    add("mvn package", "mvn package", "build");
  }
  if (has("build.gradle") || has("build.gradle.kts")) {
    const g = has("gradlew.bat") ? ".\\gradlew.bat" : "gradle";
    add(`${g} run`, `${g} run`, "run");
    add(`${g} test`, `${g} test`, "test");
    add(`${g} build`, `${g} build`, "build");
  }
  if (has("Makefile")) {
    add("make", "make", "build");
    add("make test", "make test", "test");
  }
  if (has("pyproject.toml") || has("pytest.ini") || has("setup.py") || has("tests")) add("pytest", "python -m pytest", "test");
  if (has("main.py")) add("python main.py", "python main.py", "run");
  return out;
}

/** User configurations from `.netrunner/launch.json` (comments allowed). */
export function parseLaunchJson(root: string, text: string): RunConfig[] {
  const raw = JSON.parse(stripJsonComments(text)) as { configurations?: { name?: string; command?: string; cwd?: string; group?: string }[] };
  return (raw.configurations ?? [])
    .filter((c) => typeof c.name === "string" && typeof c.command === "string" && c.command.trim())
    .map((c) => {
      const cwd = c.cwd ? resolveTaskPath(root, c.cwd) : root;
      const group = c.group === "test" || c.group === "build" ? c.group : "run";
      return { id: `launch|${c.name}`, name: c.name!, command: c.command!, cwd, group, source: "launch.json" as const };
    });
}
