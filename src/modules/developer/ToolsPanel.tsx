import { useState } from "react";
import { Check, Minus, RefreshCw } from "lucide-react";
import { api } from "@/services/api";
import { usePolled } from "@/hooks/usePolled";
import { reportError } from "@/stores/notifications";
import { promptText } from "@/stores/prompt";

const PATHS_KEY = "developer.toolchain_paths";

/** Detected SDKs and interpreters, with optional user-defined executable paths. */
export function ToolsPanel() {
  const { data, loading, reload } = usePolled(() => api.dev.toolchains());
  const [overrides, setOverrides] = useState<Record<string, string> | null>(null);

  const setPath = async (id: string, name: string, current: string | null) => {
    const value = await promptText({
      title: `${name} executable`,
      label: "Full path (leave empty to use PATH)",
      initial: current ?? "",
      placeholder: "C:\\Python312\\python.exe",
      confirmLabel: "Save",
      allowEmpty: true,
    });
    if (value === null) return;
    try {
      const all = overrides ?? ((await api.settings.getAll())[PATHS_KEY] as Record<string, string> | undefined) ?? {};
      const next = { ...all, [id]: value.trim() };
      await api.settings.set(PATHS_KEY, next);
      setOverrides(next);
      void reload();
    } catch (err) {
      reportError("Could not save toolchain path", err);
    }
  };

  return (
    <div className="tools">
      <div className="tree__head">
        <span className="label">Toolchains</span>
        <button className="icon-btn icon-btn--sm" title="Detect again" onClick={() => void reload()}>
          <RefreshCw size={12} className={loading ? "spin" : undefined} />
        </button>
      </div>
      {(data ?? []).map((t) => (
        <div key={t.id} className="tool" data-found={t.found}>
          <div className="tool__head">
            {t.found ? <Check size={12} className="tool__ok" /> : <Minus size={12} className="muted" />}
            <span className="tool__name">{t.name}</span>
            <span className="muted tool__lang">{t.language}</span>
          </div>
          <div className="tool__version mono truncate" title={t.version ?? undefined}>
            {t.version ?? "not found"}
          </div>
          {t.path && (
            <div className="tool__path mono muted truncate" title={t.path}>
              {t.customPath ? "custom: " : ""}
              {t.path}
            </div>
          )}
          {t.id !== "msvc" && (
            <button className="btn btn--ghost btn--sm tool__set" onClick={() => void setPath(t.id, t.name, t.customPath ? t.path : null)}>
              Set path…
            </button>
          )}
        </div>
      ))}
      <p className="muted tools__note">
        NETRUNNER uses your installed toolchains and does not ship compilers. Language servers (LSP) and a debugger (DAP)
        are planned; Monaco provides syntax highlighting for all listed languages today.
      </p>
    </div>
  );
}
