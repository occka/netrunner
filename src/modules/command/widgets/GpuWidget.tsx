import { MonitorOff } from "lucide-react";
import { HISTORY_LENGTH, useSystemSnapshot } from "@/hooks/useSystemSnapshot";
import { Sparkline } from "@/components/Sparkline";
import { LevelTag, Meter } from "@/components/Meter";
import { useSetting } from "@/stores/settings";
import { formatBytes, formatPercent } from "@/utils/format";
import { BigNumber, MetricRow, Sampling } from "./common";
import type { WidgetProps } from "./registry";
import type { ConfigOf, GPU_SETTINGS } from "./settings";

/** GPU load and memory from Windows GPU performance counters (any vendor). */
export default function GpuWidget({ config: c }: WidgetProps<ConfigOf<typeof GPU_SETTINGS>>) {
  const { snapshot, history } = useSystemSnapshot();
  const interval = useSetting("monitor.interval_ms");
  if (!snapshot) return <Sampling />;
  const gpu = snapshot.gpu;

  if (!gpu) {
    return (
      <div className="na-widget">
        <MonitorOff size={22} />
        <div className="label">GPU counters unavailable</div>
        <p>Windows did not expose GPU performance counters (requires Windows 10 1709+ and a WDDM 2.x driver).</p>
      </div>
    );
  }
  if (gpu.usagePercent == null) return <Sampling />;

  const adapter = gpu.adapters[0];
  const total = adapter?.dedicatedTotalBytes ?? null;
  const memPct = total && gpu.dedicatedUsedBytes != null ? (gpu.dedicatedUsedBytes / total) * 100 : null;

  return (
    <div className="cpu">
      <div className="cpu__top">
        <BigNumber value={gpu.usagePercent.toFixed(0)} unit="%" sub={adapter?.name ?? "GPU"} />
        <LevelTag percent={gpu.usagePercent} />
      </div>
      {c.graph && (
        <Sparkline
          values={history.gpu}
          max={100}
          capacity={HISTORY_LENGTH}
          format={(v) => formatPercent(v)}
          intervalSecs={interval / 1000}
          label="GPU 3D usage"
        />
      )}
      {c.memory && (
        <MetricRow
          label="Dedicated memory"
          value={`${formatBytes(gpu.dedicatedUsedBytes)}${total ? ` / ${formatBytes(total)}` : ""}`}
        >
          {memPct != null && <Meter percent={memPct} label="GPU memory usage" />}
        </MetricRow>
      )}
      <div className="label muted">Temperature: not exposed by Windows counters</div>
    </div>
  );
}
