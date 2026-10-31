import { useSystemSnapshot } from "@/hooks/useSystemSnapshot";
import { Meter } from "@/components/Meter";
import { formatBytes } from "@/utils/format";
import { Sampling } from "./common";
import type { WidgetProps } from "./registry";

export default function StorageWidget(_: WidgetProps) {
  const { snapshot } = useSystemSnapshot();
  if (!snapshot) return <Sampling />;
  if (snapshot.disks.length === 0) return <div className="unavailable">No volumes reported by Windows.</div>;

  return (
    <div className="disks">
      {snapshot.disks.map((d) => {
        const used = d.totalBytes - d.availableBytes;
        const pct = d.totalBytes ? (used / d.totalBytes) * 100 : null;
        return (
          <div key={d.mountPoint} className="disk">
            <div className="disk__head">
              <span className="disk__mount mono">{d.mountPoint}</span>
              <span className="disk__name truncate">{d.name || "Local disk"}</span>
              <span className="tag">{d.kind === "Unknown" ? d.fileSystem : `${d.kind} · ${d.fileSystem}`}</span>
              {d.removable && <span className="tag tag--info">Removable</span>}
            </div>
            <Meter percent={pct} thresholds={[85, 95]} label={`${d.mountPoint} used`} />
            <div className="disk__nums mono">
              <span>{formatBytes(d.availableBytes)} free</span>
              <span className="muted">
                {formatBytes(used)} / {formatBytes(d.totalBytes)}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
