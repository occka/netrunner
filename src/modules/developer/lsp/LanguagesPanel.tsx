import { Check, Download, ExternalLink, Minus, RefreshCw } from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { api } from "@/services/api";
import { usePolled } from "@/hooks/usePolled";
import { reportError } from "@/stores/notifications";
import { useSettings } from "@/stores/settings";
import type { LspServerStatus } from "@/types/dev";
import { installServer, retrySpec } from "./client";

/** Language servers: detection, Install (visible terminal), Locate… and Disable. */
export function LanguagesPanel({ root }: { root: string }) {
  const { data, loading, reload } = usePolled(() => api.lsp.servers(root));
  const formatOnSave = useSettings((s) => s.values["developer.format_on_save"]);
  const setSetting = useSettings((s) => s.set);

  const configure = async (s: LspServerStatus, path: string | null, disabled: boolean) => {
    try {
      await api.lsp.configure(s.id, path, disabled);
      await reload();
      retrySpec(s.id);
    } catch (err) {
      reportError(`Could not change ${s.name}`, err);
    }
  };

  const locate = async (s: LspServerStatus) => {
    const file = await openDialog({ multiple: false, title: `Locate ${s.server}`, filters: [{ name: "Programs", extensions: ["exe", "cmd", "bat"] }] });
    if (typeof file === "string") await configure(s, file, s.disabled);
  };

  return (
    <div className="tools">
      <div className="tree__head">
        <span className="label">Languages</span>
        <button className="icon-btn icon-btn--sm" title="Detect again" onClick={() => void reload()}>
          <RefreshCw size={12} className={loading ? "spin" : undefined} />
        </button>
      </div>
      <label className="tools__option">
        <input type="checkbox" checked={formatOnSave} onChange={(e) => void setSetting("developer.format_on_save", e.target.checked)} />
        Format on save (with the file's language server)
      </label>
      {!data && <p className="muted tools__note">Looking for language servers…</p>}
      {(data ?? []).map((s) => (
        <div key={s.id} className="tool" data-found={s.found && !s.disabled}>
          <div className="tool__head">
            {s.found ? <Check size={12} className="tool__ok" /> : <Minus size={12} className="muted" />}
            <span className="tool__name">{s.name}</span>
            <span className="muted tool__lang">{s.server}</span>
          </div>
          <div className="tool__version mono truncate" title={s.version ?? undefined}>
            {s.disabled ? "disabled" : s.found ? (s.version ?? "found") : "not installed"}
          </div>
          {s.path && (
            <div className="tool__path mono muted truncate" title={s.path}>
              {s.customPath ? "custom: " : ""}
              {s.path}
            </div>
          )}
          <div className="tool__actions">
            {!s.found && s.install && (
              <button className="btn btn--sm" title={s.install} onClick={() => void installServer(s.name, s.install!)}>
                <Download size={11} /> Install
              </button>
            )}
            {!s.found && !s.install && (
              <button className="btn btn--sm btn--ghost" onClick={() => void api.app.openUrl(s.docs)}>
                <ExternalLink size={11} /> Get it
              </button>
            )}
            <button className="btn btn--ghost btn--sm" onClick={() => void locate(s)}>
              Locate…
            </button>
            {s.customPath && (
              <button className="btn btn--ghost btn--sm" onClick={() => void configure(s, null, s.disabled)}>
                Auto-detect
              </button>
            )}
            <button className="btn btn--ghost btn--sm" onClick={() => void configure(s, s.customPath ? s.path : null, !s.disabled)}>
              {s.disabled ? "Enable" : "Disable"}
            </button>
          </div>
        </div>
      ))}
      <p className="muted tools__note">
        Language servers give errors as you type, completion, Go to Definition (F12), Rename (F2), Format (Shift+Alt+F) and quick fixes (Ctrl+.).
        NETRUNNER uses servers you install; Install only types the official command into a visible terminal.
      </p>
    </div>
  );
}
