import { Lock, RefreshCw } from "lucide-react";
import { api } from "@/services/api";
import { usePolled } from "@/hooks/usePolled";
import { reportError } from "@/stores/notifications";
import { refreshActivity } from "@/stores/activity";
import type { StartupEntry } from "@/types/phase2";

export function StartupTab() {
  const { data, error, reload, setData } = usePolled(() => api.system.startupList());

  const toggle = async (e: StartupEntry) => {
    try {
      await api.system.startupSet(e.id, !e.enabled);
      setData((list) => list?.map((x) => (x.id === e.id ? { ...x, enabled: !e.enabled } : x)) ?? null);
      refreshActivity();
    } catch (err) {
      reportError("Could not change startup entry", err);
    }
  };

  if (error) return <div className="unavailable">{error}</div>;

  return (
    <div className="tab-pane">
      <div className="toolbar">
        <span className="muted">
          Same mechanism as Task Manager: disabling keeps the entry, Windows just skips it at sign-in. Machine-wide entries
          need administrator rights and are read-only here.
        </span>
        <button className="icon-btn" title="Refresh" onClick={() => void reload()}>
          <RefreshCw size={14} />
        </button>
      </div>
      <table className="table">
        <thead>
          <tr>
            <th style={{ width: 70 }}>Enabled</th>
            <th>Name</th>
            <th>Command</th>
            <th>Source</th>
          </tr>
        </thead>
        <tbody>
          {(data ?? []).map((e) => (
            <tr key={e.id}>
              <td>
                {e.canToggle ? (
                  <label className="check">
                    <input type="checkbox" checked={e.enabled} onChange={() => void toggle(e)} aria-label={`Enable ${e.name}`} />
                  </label>
                ) : (
                  <span className="muted" title="Requires administrator rights">
                    <Lock size={12} /> {e.enabled ? "on" : "off"}
                  </span>
                )}
              </td>
              <td>{e.name}</td>
              <td className="mono muted truncate" title={e.command} data-selectable>
                {e.command}
              </td>
              <td className="muted">{e.source}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {data?.length === 0 && <div className="empty">No startup entries found.</div>}
    </div>
  );
}
