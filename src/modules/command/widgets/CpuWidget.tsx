import { HISTORY_LENGTH, useSystemSnapshot } from "@/hooks/useSystemSnapshot";
import { Sparkline } from "@/components/Sparkline";
import { LevelTag } from "@/components/Meter";
import { useSetting } from "@/stores/settings";
import { formatPercent } from "@/utils/format";
import { BigNumber, Sampling } from "./common";
import type { WidgetProps } from "./registry";

export default function CpuWidget(_: WidgetProps) {
  const { snapshot, history } = useSystemSnapshot();
  const interval = useSetting("monitor.interval_ms");
  if (!snapshot || snapshot.cpu.usagePercent == null) return <Sampling />;
  const { cpu } = snapshot;

  return (
    <div className="cpu">
      <div className="cpu__top">
        <BigNumber
          value={cpu.usagePercent!.toFixed(0)}
          unit="%"
          sub={cpu.frequencyMhz ? `${(cpu.frequencyMhz / 1000).toFixed(2)} GHz reported` : "frequency unavailable"}
        />
        <LevelTag percent={cpu.usagePercent} />
      </div>
      <Sparkline
        values={history.cpu}
        max={100}
        capacity={HISTORY_LENGTH}
        format={(v) => formatPercent(v)}
        intervalSecs={interval / 1000}
        label="CPU usage"
      />
      <div className="cores" aria-label="Per-core usage">
        {cpu.perCorePercent.map((pct, i) => (
          <div key={i} className="cores__bar" title={`Core ${i}: ${pct.toFixed(0)}%`}>
            <div className="cores__fill" style={{ height: `${Math.max(2, Math.min(100, pct))}%` }} />
          </div>
        ))}
      </div>
      <div className="label cores__caption">{cpu.perCorePercent.length} logical processors</div>
    </div>
  );
}
