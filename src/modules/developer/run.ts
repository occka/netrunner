/**
 * Builds the PowerShell command that runs a file with the user's own
 * toolchain. The command is typed into a visible terminal, never run hidden.
 * Returns null for file types without a sensible single-file run.
 */
const q = (s: string) => `'${s.replace(/'/g, "''")}'`;

export interface RunPlan {
  command: string;
  description: string;
}

export function runPlan(path: string, projectFiles: { hasCargo?: boolean; hasCsproj?: boolean; hasPackageJson?: boolean } = {}): RunPlan | null {
  const name = path.split(/[\\/]/).pop() ?? path;
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  const stem = name.slice(0, name.length - ext.length - 1);
  const dir = path.slice(0, path.length - name.length).replace(/[\\/]$/, "");
  const exe = `${dir}\\${stem}.exe`;
  switch (ext) {
    case "py":
      return { command: `python ${q(path)}`, description: "Python" };
    case "js":
    case "mjs":
    case "cjs":
      return { command: `node ${q(path)}`, description: "Node.js" };
    case "ts":
      return { command: `npx --yes tsx ${q(path)}`, description: "Node.js via tsx" };
    case "go":
      return { command: `go run ${q(path)}`, description: "Go" };
    case "java":
      return { command: `java ${q(path)}`, description: "Java single-file source launcher" };
    case "php":
      return { command: `php ${q(path)}`, description: "PHP" };
    case "rb":
      return { command: `ruby ${q(path)}`, description: "Ruby" };
    case "ps1":
      return { command: `& ${q(path)}`, description: "PowerShell script" };
    case "bat":
    case "cmd":
      return { command: `cmd /c ${q(path)}`, description: "Batch script" };
    case "c":
      return { command: `gcc ${q(path)} -o ${q(exe)}; if ($?) { & ${q(exe)} }`, description: "GCC compile + run" };
    case "cpp":
    case "cc":
    case "cxx":
      return { command: `g++ ${q(path)} -o ${q(exe)}; if ($?) { & ${q(exe)} }`, description: "G++ compile + run" };
    case "rs":
      return projectFiles.hasCargo
        ? { command: "cargo run", description: "Cargo project" }
        : { command: `rustc ${q(path)} -o ${q(exe)}; if ($?) { & ${q(exe)} }`, description: "rustc compile + run" };
    case "cs":
      return projectFiles.hasCsproj ? { command: "dotnet run", description: ".NET project" } : null;
    default:
      return null;
  }
}
