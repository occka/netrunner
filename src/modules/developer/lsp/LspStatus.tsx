import { useMemo } from "react";
import { AlertTriangle, CircleX, Download, Loader2, RotateCw } from "lucide-react";
import { useDev } from "../store";
import { pathKey } from "./convert";
import { installServer, mergeDiagnostics, problemCounts, restartServer, retrySpec, useLsp } from "./client";

/** Language-server state of the active file, for the editor status bar. */
export function LspStatus({ path }: { path: string }) {
  const doc = useLsp((s) => s.docs[pathKey(path)]);
  const server = useLsp((s) => (doc?.server ? s.servers[doc.server] : undefined));
  const lspDiagnostics = useLsp((s) => s.diagnostics);
  const taskDiagnostics = useLsp((s) => s.taskDiagnostics);
  const diagnostics = useMemo(() => mergeDiagnostics(lspDiagnostics, taskDiagnostics), [lspDiagnostics, taskDiagnostics]);
  const setSide = useDev((s) => s.setSide);
  if (!doc || doc.state === "unsupported") return null;

  if (doc.state === "opening") {
    return (
      <span className="tag" title="Starting the language server">
        <Loader2 size={10} className="spin" /> language server
      </span>
    );
  }
  if (doc.state === "missing") {
    return (
      <span className="lsp-status">
        <span className="muted">no language server</span>
        {doc.install ? (
          <button className="btn btn--sm btn--ghost" title={doc.install} onClick={() => void installServer(doc.name ?? "", doc.install!)}>
            <Download size={11} /> Install
          </button>
        ) : (
          <button className="btn btn--sm btn--ghost" onClick={() => setSide("tools")}>
            Set up…
          </button>
        )}
        <button className="btn btn--sm btn--ghost" title="Look for the server again" onClick={() => doc.spec && retrySpec(doc.spec)}>
          <RotateCw size={11} />
        </button>
      </span>
    );
  }
  if (doc.state === "disabled") return <span className="muted">{doc.name}: language server off</span>;
  if (doc.state === "failed") {
    return (
      <span className="lsp-status">
        <span className="tag tag--crit" title={doc.message}>
          <CircleX size={10} /> {doc.name} failed
        </span>
        <button className="btn btn--sm btn--ghost" onClick={() => doc.spec && retrySpec(doc.spec)}>
          Retry
        </button>
      </span>
    );
  }

  const counts = problemCounts(diagnostics, path);
  const crashed = server?.state === "crashed";
  return (
    <span className="lsp-status">
      <span className={`tag${crashed ? " tag--crit" : " tag--ok"}`} title={crashed ? (server?.message ?? "") : `${doc.name} language server`}>
        {server?.progress ? <Loader2 size={10} className="spin" /> : null}
        {doc.name}
        {crashed ? " · stopped" : ""}
      </span>
      {server?.progress && <span className="muted truncate lsp-status__progress">{server.progress}</span>}
      {crashed && doc.server && (
        <button className="btn btn--sm btn--ghost" onClick={() => void restartServer(doc.server!)}>
          <RotateCw size={11} /> Restart
        </button>
      )}
      <button className="lsp-status__counts" title="Problems in this file (project total)" onClick={() => setSide("problems")}>
        <CircleX size={11} className={counts.file.errors ? "text-crit" : "muted"} /> {counts.file.errors}
        <AlertTriangle size={11} className={counts.file.warnings ? "text-warn" : "muted"} /> {counts.file.warnings}
        {(counts.total.errors !== counts.file.errors || counts.total.warnings !== counts.file.warnings) && (
          <span className="muted">
            ({counts.total.errors}/{counts.total.warnings})
          </span>
        )}
      </button>
    </span>
  );
}
