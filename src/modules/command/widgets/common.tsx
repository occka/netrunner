import type { ReactNode } from "react";
import { Loader2 } from "lucide-react";

export function MetricRow({
  label,
  value,
  children,
  unavailable,
}: {
  label: string;
  value?: ReactNode;
  children?: ReactNode;
  /** When set, the row states the metric is unavailable and why. */
  unavailable?: string;
}) {
  return (
    <div className="metric">
      <div className="metric__head">
        <span className="label">{label}</span>
        {unavailable ? (
          <span className="metric__na" title={unavailable}>
            UNAVAILABLE
          </span>
        ) : (
          <span className="metric__value mono">{value}</span>
        )}
      </div>
      {!unavailable && children}
    </div>
  );
}

export function Sampling({ text = "Sampling…" }: { text?: string }) {
  return (
    <div className="sampling">
      <Loader2 size={14} className="spin" />
      <span className="label">{text}</span>
    </div>
  );
}

export function BigNumber({ value, unit, sub }: { value: string; unit?: string; sub?: ReactNode }) {
  return (
    <div className="bignum">
      <span className="bignum__value mono">{value}</span>
      {unit && <span className="bignum__unit">{unit}</span>}
      {sub && <span className="bignum__sub">{sub}</span>}
    </div>
  );
}
