import { useId, useRef, useState } from "react";

interface SparklineProps {
  values: number[];
  /** Fixed maximum (e.g. 100 for percentages); defaults to the data maximum. */
  max?: number;
  capacity: number;
  height?: number;
  format: (v: number) => string;
  /** Seconds between samples, used for the hover readout. */
  intervalSecs: number;
  label: string;
}

/**
 * Single-series area sparkline with a hover crosshair readout. Values fill
 * from the right so the newest sample is always at the right edge.
 */
export function Sparkline({ values, max, capacity, height = 46, format, intervalSecs, label }: SparklineProps) {
  const gradientId = useId();
  const ref = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const width = 200;
  const top = Math.max(max ?? 0, ...values, 1e-9);
  const step = width / Math.max(1, capacity - 1);
  const offset = capacity - values.length;
  const x = (i: number) => (offset + i) * step;
  const y = (v: number) => height - 2 - (Math.min(v, top) / top) * (height - 4);

  const line = values.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
  const area = values.length > 1 ? `${line}L${x(values.length - 1)},${height}L${x(0)},${height}Z` : "";

  const onMove = (e: React.PointerEvent) => {
    const rect = ref.current?.getBoundingClientRect();
    if (!rect || values.length === 0) return;
    const rel = ((e.clientX - rect.left) / rect.width) * width;
    const index = Math.round(rel / step) - offset;
    setHover(Math.max(0, Math.min(values.length - 1, index)));
  };

  const hv = hover != null ? values[hover] : null;
  const ago = hover != null ? (values.length - 1 - hover) * intervalSecs : 0;

  return (
    <div className="spark">
      <svg
        ref={ref}
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        width="100%"
        height={height}
        role="img"
        aria-label={`${label} history, latest ${values.length ? format(values[values.length - 1]) : "no data"}`}
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor="var(--c-secondary)" stopOpacity="0.28" />
            <stop offset="1" stopColor="var(--c-secondary)" stopOpacity="0" />
          </linearGradient>
        </defs>
        {[0.25, 0.5, 0.75].map((f) => (
          <line key={f} x1="0" x2={width} y1={height * f} y2={height * f} className="spark__grid" />
        ))}
        {area && <path d={area} fill={`url(#${gradientId})`} />}
        {values.length > 1 && <path d={line} className="spark__line" vectorEffect="non-scaling-stroke" />}
        {hover != null && (
          <line x1={x(hover)} x2={x(hover)} y1="0" y2={height} className="spark__cursor" vectorEffect="non-scaling-stroke" />
        )}
      </svg>
      {hv != null && (
        <div className="spark__tip mono">
          {format(hv)} <span className="muted">· {ago === 0 ? "now" : `${Math.round(ago)}s ago`}</span>
        </div>
      )}
    </div>
  );
}
