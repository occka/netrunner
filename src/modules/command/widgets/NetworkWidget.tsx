import { HISTORY_LENGTH, useSystemSnapshot } from "@/hooks/useSystemSnapshot";
import { Sparkline } from "@/components/Sparkline";
import { useSetting } from "@/stores/settings";
import { formatBytes, formatRate } from "@/utils/format";
import { Sampling } from "./common";
import type { WidgetProps } from "./registry";
import type { ConfigOf, NETWORK_SETTINGS } from "./settings";
import { usePolled } from "@/hooks/usePolled";
import { api } from "@/services/api";

export const CONNECTIVITY_LABEL = {
  internet: ["Internet", "ok"],
  constrained: ["Limited", "warn"],
  local: ["Local only", "warn"],
  none: ["Offline", "crit"],
  unknown: ["Unknown", ""],
} as const;

/** Connectivity and VPN-type adapter state, refreshed every 10 s. */
function ConnectivityLine() {
  const { data } = usePolled(() => api.network.status(), 10000);
  if (!data) return null;
  const [label, tone] = CONNECTIVITY_LABEL[data.connectivity];
  const vpn = data.adapters.filter((a) => a.vpnLike && a.up);
  return (
    <div className="net__status">
      <span className={`tag ${tone ? `tag--${tone}` : ""}`}>{label}</span>
      {data.metered && <span className="tag tag--warn">Metered</span>}
      {vpn.length > 0 ? (
        <span className="tag tag--info" title={vpn.map((a) => a.description).join(", ")}>
          VPN-type adapter up
        </span>
      ) : (
        <span className="label">No VPN-type adapter up</span>
      )}
    </div>
  );
}

export default function NetworkWidget({ config: c }: WidgetProps<ConfigOf<typeof NETWORK_SETTINGS>>) {
  const { snapshot, history } = useSystemSnapshot();
  const interval = useSetting("monitor.interval_ms");
  if (!snapshot) return <Sampling />;
  const net = snapshot.network;
  // Adapters that moved traffic during the last interval.
  const activeAdapters = net.interfaces.filter((i) => (i.rxBytesPerSec ?? 0) + (i.txBytesPerSec ?? 0) > 0);

  return (
    <div className="net">
      <div className="net__rates">
        <div>
          <span className="label">Down</span>
          <div className="net__rate mono">{formatRate(net.rxBytesPerSec)}</div>
        </div>
        <div>
          <span className="label">Up</span>
          <div className="net__rate mono">{formatRate(net.txBytesPerSec)}</div>
        </div>
        <div>
          <span className="label">Traffic now</span>
          <div className="net__rate">
            {net.rxBytesPerSec == null ? (
              <span className="muted">sampling</span>
            ) : activeAdapters.length > 0 ? (
              <span className="tag tag--ok">{activeAdapters.length} active</span>
            ) : (
              <span className="tag">Idle</span>
            )}
          </div>
        </div>
      </div>
      {c.graph && (
        <Sparkline
          values={history.rx}
          capacity={HISTORY_LENGTH}
          format={(v) => `↓ ${formatRate(v)}`}
          intervalSecs={interval / 1000}
          label="Download rate"
        />
      )}
      <div className="net__list">
        {net.interfaces
          .filter((i) => !c.activeOnly || i.addresses.length > 0)
          .slice(0, c.adapters)
          .map((i) => (
          <div key={i.name} className="net__iface">
            <span className="truncate" title={i.name}>
              {i.name}
            </span>
            <span className="mono muted truncate" title={i.addresses.join(", ")}>
              {i.addresses.find((a) => a.includes(".")) ?? i.addresses[0] ?? "no address"}
            </span>
            <span className="mono muted">Σ {formatBytes(i.totalRxBytes)}</span>
          </div>
        ))}
      </div>
      {c.connectivity && <ConnectivityLine />}
    </div>
  );
}
