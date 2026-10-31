import { Suspense } from "react";
import { RefreshCw, ShieldQuestion } from "lucide-react";
import { ModuleHeader } from "@/components/ModuleHeader";
import { api } from "@/services/api";
import { usePolled } from "@/hooks/usePolled";
import { useSystemSnapshot } from "@/hooks/useSystemSnapshot";
import { WIDGETS, widgetConfig } from "@/modules/command/widgets/registry";
import { CONNECTIVITY_LABEL } from "@/modules/command/widgets/NetworkWidget";
import { Sampling } from "@/modules/command/widgets/common";
import { formatRate } from "@/utils/format";

function formatSpeed(bps: number | null) {
  if (!bps) return "—";
  return bps >= 1e9 ? `${(bps / 1e9).toFixed(1)} Gbps` : `${Math.round(bps / 1e6)} Mbps`;
}

export default function NetworkModule() {
  const { data, error, reload } = usePolled(() => api.network.status(), 10000);
  const { snapshot } = useSystemSnapshot();
  const Throughput = WIDGETS.network.component!;
  const rates = new Map(snapshot?.network.interfaces.map((i) => [i.name, i]) ?? []);
  const vpn = data?.adapters.filter((a) => a.vpnLike) ?? [];

  return (
    <div className="module">
      <ModuleHeader id="network">
        <button className="icon-btn" title="Refresh" onClick={() => void reload()}>
          <RefreshCw size={14} />
        </button>
      </ModuleHeader>
      <div className="module__scroll">
        {error && <div className="unavailable">{error}</div>}
        <div className="net-top">
          <section className="panel">
            <header className="panel__header">
              <h2 className="panel__title">Connectivity</h2>
            </header>
            <div className="panel__body net-conn">
              {data && (
                <>
                  <div className={`net-conn__state net-conn__state--${CONNECTIVITY_LABEL[data.connectivity][1] || "muted"}`}>
                    {CONNECTIVITY_LABEL[data.connectivity][0]}
                  </div>
                  <div className="muted">Reported by Windows (network connectivity hint). NETRUNNER sends no probe traffic.</div>
                  {data.metered != null && <div>Connection cost: {data.metered ? "metered" : "unmetered"}</div>}
                </>
              )}
            </div>
          </section>
          <section className="panel">
            <header className="panel__header">
              <h2 className="panel__title">VPN</h2>
            </header>
            <div className="panel__body">
              {vpn.length === 0 ? (
                <div className="muted">No VPN-type adapters installed.</div>
              ) : (
                vpn.map((a) => (
                  <div key={a.name} className="vpn-row">
                    <span className={`tag ${a.up ? "tag--ok" : ""}`}>{a.up ? "Up" : "Down"}</span>
                    <span>{a.name}</span>
                    <span className="muted truncate">{a.description}</span>
                  </div>
                ))
              )}
              <div className="unavailable vpn-note">
                <ShieldQuestion size={14} />
                An adapter being up means a tunnel interface exists. It does not prove traffic is routed through it.
              </div>
            </div>
          </section>
          <section className="panel">
            <header className="panel__header">
              <h2 className="panel__title">Throughput</h2>
            </header>
            <div className="panel__body">
              <Suspense fallback={<Sampling />}>
                <Throughput instanceId="network-module" editing={false} config={widgetConfig(WIDGETS.network, undefined)} host="dashboard" />
              </Suspense>
            </div>
          </section>
        </div>
        <h2 className="label section-title">Adapters</h2>
        <table className="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Type</th>
              <th>Status</th>
              <th>Link</th>
              <th>Gateway</th>
              <th className="num">Down</th>
              <th className="num">Up</th>
              <th>MAC</th>
            </tr>
          </thead>
          <tbody>
            {(data?.adapters ?? []).map((a) => {
              const r = rates.get(a.name);
              return (
                <tr key={a.name}>
                  <td title={a.description}>
                    {a.name}
                    <div className="muted cell-sub truncate">{a.description}</div>
                  </td>
                  <td>
                    {a.kind}
                    {a.vpnLike && <span className="tag tag--info">VPN-type</span>}
                  </td>
                  <td>
                    <span className={`tag ${a.up ? "tag--ok" : ""}`}>{a.up ? "Up" : "Down"}</span>
                  </td>
                  <td className="mono">{formatSpeed(a.linkSpeedBps)}</td>
                  <td>{a.hasGateway ? "yes" : "—"}</td>
                  <td className="num mono">{formatRate(r?.rxBytesPerSec)}</td>
                  <td className="num mono">{formatRate(r?.txBytesPerSec)}</td>
                  <td className="mono muted">{a.mac ?? "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
