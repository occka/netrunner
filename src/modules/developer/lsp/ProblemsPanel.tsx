import { useMemo, useState } from "react";
import { AlertTriangle, CircleX, Info } from "lucide-react";
import { relativeToRoot } from "../store";
import { mergeDiagnostics, openAt, useLsp } from "./client";

type Filter = "all" | "errors" | "warnings";

/** Every diagnostic the language servers reported, grouped by file. */
export function ProblemsPanel({ root }: { root: string }) {
  const lsp = useLsp((s) => s.diagnostics);
  const tasks = useLsp((s) => s.taskDiagnostics);
  const diagnostics = useMemo(() => mergeDiagnostics(lsp, tasks), [lsp, tasks]);
  const [filter, setFilter] = useState<Filter>("all");
  const files = useMemo(
    () =>
      Object.values(diagnostics)
        .map((f) => ({
          path: f.path,
          items: f.items
            .filter((d) => (filter === "errors" ? (d.severity ?? 1) === 1 : filter === "warnings" ? d.severity === 2 : true))
            .sort((a, b) => (a.severity ?? 1) - (b.severity ?? 1) || a.range.start.line - b.range.start.line),
        }))
        .filter((f) => f.items.length)
        .sort((a, b) => a.path.localeCompare(b.path)),
    [diagnostics, filter],
  );
  const total = files.reduce((n, f) => n + f.items.length, 0);

  const open = (path: string, line: number, character: number) => openAt(path, { lineNumber: line + 1, column: character + 1 });

  return (
    <div className="problems">
      <div className="tree__head">
        <span className="label">Problems</span>
        <span className="muted">{total}</span>
        <div className="segmented" style={{ marginLeft: "auto" }}>
          {(["all", "errors", "warnings"] as Filter[]).map((f) => (
            <button key={f} aria-pressed={filter === f} onClick={() => setFilter(f)}>
              {f}
            </button>
          ))}
        </div>
      </div>
      {!files.length ? (
        <p className="muted tools__note">
          No problems reported. Language servers report problems for open files; Run and Test configurations add compiler errors from their output.
        </p>
      ) : (
        files.map((f) => (
          <div key={f.path} className="problems__file">
            <div className="problems__path mono truncate" title={f.path}>
              {relativeToRoot(root, f.path)} <span className="muted">{f.items.length}</span>
            </div>
            {f.items.map((d, i) => {
              const Icon = (d.severity ?? 1) === 1 ? CircleX : d.severity === 2 ? AlertTriangle : Info;
              return (
                <button key={i} className="problems__item" onClick={() => void open(f.path, d.range.start.line, d.range.start.character)} title={d.message}>
                  <Icon size={12} className={(d.severity ?? 1) === 1 ? "text-crit" : d.severity === 2 ? "text-warn" : "muted"} />
                  <span className="problems__msg">{d.message}</span>
                  <span className="muted mono problems__pos">
                    {d.source ? `${d.source} ` : ""}
                    {d.range.start.line + 1}:{d.range.start.character + 1}
                  </span>
                </button>
              );
            })}
          </div>
        ))
      )}
    </div>
  );
}
