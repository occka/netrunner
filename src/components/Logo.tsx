export function Logo({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 1024 1024" aria-hidden="true">
      <path
        d="M120 64 H904 L960 120 V904 L904 960 H120 L64 904 V120 Z"
        fill="none"
        stroke="var(--c-primary)"
        strokeWidth="56"
      />
      <path d="M262 780 V244 H382 L642 588 V244 H762 V780 H642 L382 436 V780 Z" fill="var(--c-primary)" />
    </svg>
  );
}
