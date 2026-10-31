import { HISTORY_LENGTH, useSystemSnapshot } from "@/hooks/useSystemSnapshot";
import { Sparkline } from "@/components/Sparkline";
import { LevelTag, Meter } from "@/components/Meter";
import { useSetting } from "@/stores/settings";
import { formatBytes, formatPercent } from "@/utils/format";
import { BigNumber, MetricRow, Sampling } from "./common";
import type { WidgetProps } from "./registry";

export default function RamWidget(_: WidgetProps) {
  const { snapshot, history } = useSystemSnapshot();
  const interval = useSetting("monitor.interval_ms");
  if (!snapshot) return <Sampling />;
  const m = snapshot.memory;
  const pct = m.totalBytes ? (m.usedBytes / m.totalBytes) * 100 : null;
  const swapPct = m.swapTotalBytes ? (m.swapUsedBytes / m.swapTotalBytes) * 100 : null;

  return (
    <div className="ram">
      <div className="cpu__top">
        <BigNumber value={formatBytes(m.usedBytes).split(" ")[0]} unit={formatBytes(m.usedBytes).split(" ")[1]} sub={`of ${formatBytes(m.totalBytes)} · ${formatBytes(m.availableBytes)} available`} />
        <LevelTag percent={pct} thresholds={[80, 92]} />
      </div>
      <Sparkline
        values={history.memory}
        max={100}
        capacity={HISTORY_LENGTH}
        format={(v) => formatPercent(v, 1)}
        intervalSecs={interval / 1000}
        label="Memory usage"
      />
      {m.swapTotalBytes > 0 ? (
        <MetricRow label="Page file" value={`${formatBytes(m.swapUsedBytes)} / ${formatBytes(m.swapTotalBytes)}`}>
          <Meter percent={swapPct} thresholds={[80, 92]} label="Page file usage" />
        </MetricRow>
      ) : (
        <MetricRow label="Page file" unavailable="No page file reported" />
      )}
    </div>
  );
}
