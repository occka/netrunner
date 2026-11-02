import { useEffect, useRef, useState } from "react";
import { Volume2, VolumeX } from "lucide-react";

/**
 * Volume slider and mute button. While dragging it shows the drag position
 * (polling may lag behind) and sends changes at most ten times a second.
 */
export function VolumeControl({ label, volume, muted, peak, onVolume, onMute }: { label: string; volume: number; muted: boolean; peak?: number; onVolume: (percent: number) => void; onMute: (mute: boolean) => void }) {
  const [drag, setDrag] = useState<number | null>(null);
  const last = useRef(0);
  const timer = useRef(0);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const change = (v: number) => {
    setDrag(v);
    window.clearTimeout(timer.current);
    const wait = 100 - (Date.now() - last.current);
    timer.current = window.setTimeout(
      () => {
        last.current = Date.now();
        onVolume(v);
      },
      Math.max(0, wait),
    );
  };

  const shown = drag ?? volume;
  return (
    <div className="audio-control">
      <button className="icon-btn icon-btn--sm" aria-pressed={muted} aria-label={`${muted ? "Unmute" : "Mute"} ${label}`} title={muted ? "Unmute" : "Mute"} onClick={() => onMute(!muted)}>
        {muted ? <VolumeX size={13} /> : <Volume2 size={13} />}
      </button>
      <div className="audio-control__track">
        <input
          type="range"
          min={0}
          max={100}
          value={shown}
          aria-label={`${label} volume`}
          onChange={(e) => change(Number(e.target.value))}
          onPointerUp={() => window.setTimeout(() => setDrag(null), 500)}
          onKeyUp={() => window.setTimeout(() => setDrag(null), 500)}
        />
        {peak !== undefined && (
          <div className="audio-control__meter" aria-hidden>
            <span style={{ width: `${Math.round(Math.min(1, peak) * 100)}%` }} />
          </div>
        )}
      </div>
      <span className="mono audio-control__value">{shown}</span>
    </div>
  );
}
