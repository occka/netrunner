import { levelFor } from "@/utils/format";

interface MeterProps {
  percent: number | null;
  segmented?: boolean;
  /** Thresholds for warn/critical colouring; pass null to disable status colour. */
  thresholds?: [number, number] | null;
  label: string;
}

export function Meter({ percent, segmented, thresholds = [75, 90], label }: MeterProps) {
  const value = percent == null ? 0 : Math.max(0, Math.min(100, percent));
  const level = thresholds ? levelFor(percent, thresholds[0], thresholds[1]) : "ok";
  return (
    <div
      className={`meter${segmented ? " meter--segmented" : ""}`}
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent == null ? undefined : Math.round(value)}
    >
      <div className="meter__fill" data-level={level} style={{ width: `${value}%` }} />
    </div>
  );
}

/** Text status that accompanies a coloured meter so colour is never the only signal. */
export function LevelTag({ percent, thresholds = [75, 90] }: { percent: number | null; thresholds?: [number, number] }) {
  if (percent == null) return null;
  const level = levelFor(percent, thresholds[0], thresholds[1]);
  if (level === "ok") return null;
  return <span className={`tag tag--${level}`}>{level === "crit" ? "Critical" : "High"}</span>;
}
