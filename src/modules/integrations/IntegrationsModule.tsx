import { Check, Minus, Play, Plus, RefreshCw } from "lucide-react";
import { ModuleHeader } from "@/components/ModuleHeader";
import { api } from "@/services/api";
import { usePolled } from "@/hooks/usePolled";
import { emptyInput, useQuickAccess } from "@/stores/quickAccess";
import { notify, reportError } from "@/stores/notifications";
import { refreshActivity } from "@/stores/activity";
import type { Capability, Integration } from "@/types/phase2";

function Cap({ cap }: { cap: Capability }) {
  return (
    <span className={`cap ${cap.available ? "cap--yes" : "cap--no"}`} title={cap.detail}>
      {cap.available ? <Check size={12} /> : <Minus size={12} />}
      <span className="truncate">{cap.detail}</span>
    </span>
  );
}

export default function IntegrationsModule() {
  const { data, error, loading, reload } = usePolled(() => api.integrations.list(), 15000);
  const openEditor = useQuickAccess((s) => s.openEditor);

  const launch = async (i: Integration) => {
    try {
      await api.integrations.launch(i.id);
      notify.success(`Launching ${i.name}`);
      refreshActivity();
      window.setTimeout(() => void reload(), 3000);
    } catch (err) {
      reportError(`Could not launch ${i.name}`, err);
    }
  };

  const installed = (data ?? []).filter((i) => i.installed);
  const missing = (data ?? []).filter((i) => !i.installed);

  return (
    <div className="module">
      <ModuleHeader id="integrations">
        <button className="btn" onClick={() => void reload()} disabled={loading}>
          <RefreshCw size={14} /> Refresh
        </button>
      </ModuleHeader>
      <div className="module__scroll">
        {error && <div className="unavailable">{error}</div>}
        <p className="muted integrations-intro">
          Each integration lists four separate capabilities. Launching an app does not mean NETRUNNER can read or control
          it. Only documented interfaces are used.
        </p>
        <table className="table">
          <thead>
            <tr>
              <th>Application</th>
              <th>State</th>
              <th>Launch</th>
              <th>Detect running</th>
              <th>Read status</th>
              <th>Control</th>
              <th className="actions" />
            </tr>
          </thead>
          <tbody>
            {[...installed, ...missing].map((i) => (
              <tr key={i.id} className={i.installed ? undefined : "row--dim"}>
                <td>
                  {i.name}
                  <div className="muted cell-sub">{i.category}</div>
                </td>
                <td>
                  {!i.installed ? (
                    <span className="tag">Not found</span>
                  ) : i.running ? (
                    <span className="tag tag--ok">Running</span>
                  ) : (
                    <span className="tag">Stopped</span>
                  )}
                </td>
                <td>
                  <Cap cap={i.launch} />
                </td>
                <td>
                  <Cap cap={i.detect} />
                </td>
                <td>
                  <Cap cap={i.status} />
                </td>
                <td>
                  <Cap cap={i.control} />
                </td>
                <td className="actions">
                  <button className="icon-btn icon-btn--sm" title="Launch" disabled={!i.installed} onClick={() => void launch(i)}>
                    <Play size={13} />
                  </button>
                  <button
                    className="icon-btn icon-btn--sm"
                    title="Add to Quick Access"
                    disabled={!i.path}
                    onClick={() =>
                      openEditor(null, { ...emptyInput("app"), name: i.name, target: i.path ?? "", args: i.args, category: i.category })
                    }
                  >
                    <Plus size={13} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted qa-hint">
          Plugin architecture for third-party integrations is planned for Phase 5. Any application can already be launched
          through Quick Access.
        </p>
      </div>
    </div>
  );
}
