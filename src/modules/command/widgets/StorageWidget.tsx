import { useSystemSnapshot } from "@/hooks/useSystemSnapshot";
import { Meter } from "@/components/Meter";
import { formatBytes } from "@/utils/format";
import { Sampling } from "./common";
import type { WidgetProps } from "./registry";
import type { ConfigOf, STORAGE_SETTINGS } from "./settings";

export default function StorageWidget({ config: c }: WidgetProps<ConfigOf<typeof STORAGE_SETTINGS>>) {
  const { snapshot } = useSystemSnapshot();
  if (!snapshot) return <Sampling />;
  const usedShare = (d: (typeof snapshot.disks)[number]) => (d.totalBytes ? (d.totalBytes - d.availableBytes) / d.totalBytes : 0);
  const disks = snapshot.disks
    .filter((d) => c.removable || !d.removable)
    .sort((a, b) =>
      c.sort === "used"
        ? usedShare(b) - usedShare(a)
        : c.sort === "free"
          ? a.availableBytes - b.availableBytes
          : a.mountPoint.localeCompare(b.mountPoint),
    );
  if (disks.length === 0) return <div className="unavailable">No volumes reported by Windows.</div>;

  return (
    <div className="disks">
      {disks.map((d) => {
        const used = d.totalBytes - d.availableBytes;
        const pct = d.totalBytes ? (used / d.totalBytes) * 100 : null;
        return (
          <div key={d.mountPoint} className="disk">
            <div className="disk__head">
              <span className="disk__mount mono">{d.mountPoint}</span>
              <span className="disk__name truncate">{d.name || "Local disk"}</span>
              {c.details && <span className="tag">{d.kind === "Unknown" ? d.fileSystem : `${d.kind} · ${d.fileSystem}`}</span>}
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
