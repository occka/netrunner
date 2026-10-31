import { useSystemSnapshot } from "@/hooks/useSystemSnapshot";
import { Meter } from "@/components/Meter";
import { formatBytes, formatDuration, formatPercent, formatRate } from "@/utils/format";
import { MetricRow, Sampling } from "./common";
import type { WidgetProps } from "./registry";
import type { ConfigOf, SYSTEM_OVERVIEW_SETTINGS } from "./settings";

export default function SystemOverviewWidget({ config: c }: WidgetProps<ConfigOf<typeof SYSTEM_OVERVIEW_SETTINGS>>) {
  const { snapshot } = useSystemSnapshot();
  if (!snapshot) return <Sampling />;

  const { cpu, memory, disks, network, temperatures } = snapshot;
  const memPct = memory.totalBytes ? (memory.usedBytes / memory.totalBytes) * 100 : null;
  // Prefer the Windows system volume; fall back to the first fixed disk.
  const sysDisk = disks.find((d) => d.mountPoint.toUpperCase().startsWith("C:")) ?? disks.find((d) => !d.removable);
  const diskPct = sysDisk && sysDisk.totalBytes ? ((sysDisk.totalBytes - sysDisk.availableBytes) / sysDisk.totalBytes) * 100 : null;
  const cpuTemp = temperatures.find((t) => /cpu|package|core|tz/i.test(t.label));

  return (
    <div className="overview">
      <MetricRow
        label="CPU usage"
        value={
          <>
            {formatPercent(cpu.usagePercent)}
            {cpu.frequencyMhz && <span className="muted"> · {(cpu.frequencyMhz / 1000).toFixed(2)} GHz</span>}
          </>
        }
      >
        <Meter percent={cpu.usagePercent} segmented label="CPU usage" />
      </MetricRow>
      <MetricRow label="Memory" value={`${formatBytes(memory.usedBytes)} / ${formatBytes(memory.totalBytes)}`}>
        <Meter percent={memPct} segmented label="Memory usage" />
      </MetricRow>
      {sysDisk ? (
        <MetricRow
          label={`Disk ${sysDisk.mountPoint}`}
          value={`${formatBytes(sysDisk.availableBytes)} free`}
        >
          <Meter percent={diskPct} segmented thresholds={[85, 95]} label={`Disk ${sysDisk.mountPoint} usage`} />
        </MetricRow>
      ) : (
        <MetricRow label="Disk" unavailable="No fixed volumes reported" />
      )}
      <MetricRow
        label="Network"
        value={
          <>
            ↓ {formatRate(network.rxBytesPerSec)} <span className="muted">↑ {formatRate(network.txBytesPerSec)}</span>
          </>
        }
      />
      <div className="overview__grid">
        {c.sensors && (
          <MetricRow
            label="CPU temp"
            value={cpuTemp ? `${cpuTemp.celsius.toFixed(0)} °C` : undefined}
            unavailable={cpuTemp ? undefined : "Windows does not expose a CPU sensor to standard-user apps"}
          />
        )}
        {snapshot.gpu?.usagePercent != null ? (
          <MetricRow
            label="GPU"
            value={`${formatPercent(snapshot.gpu.usagePercent)} · ${formatBytes(snapshot.gpu.dedicatedUsedBytes)}`}
          />
        ) : (
          <MetricRow
            label="GPU"
            value={snapshot.gpu ? "sampling…" : undefined}
            unavailable={snapshot.gpu ? undefined : "Windows GPU counters unavailable"}
          />
        )}
        {c.sensors && <MetricRow label="GPU temp" unavailable="Not exposed by Windows performance counters" />}
        {c.sensors && <MetricRow label="Fans" unavailable="Windows has no standard fan interface for applications" />}
        {!c.io ? null : snapshot.diskIo ? (
          <MetricRow
            label="Disk activity"
            value={`R ${formatRate(snapshot.diskIo.readBytesPerSec)} · W ${formatRate(snapshot.diskIo.writeBytesPerSec)}`}
          />
        ) : (
          <MetricRow label="Disk activity" value="sampling…" />
        )}
        <MetricRow label="Uptime" value={formatDuration(snapshot.uptimeSecs)} />
      </div>
    </div>
  );
}
