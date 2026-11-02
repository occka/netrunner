import { ThermometerSnowflake } from "lucide-react";
import { useSystemSnapshot } from "@/hooks/useSystemSnapshot";
import { Sampling } from "./common";
import type { WidgetProps } from "./registry";

export default function ThermalWidget(_: WidgetProps) {
  const { snapshot } = useSystemSnapshot();
  if (!snapshot) return <Sampling />;

  const list = snapshot.sensors?.temperatures.length ? snapshot.sensors.temperatures : snapshot.temperatures;
  const fans = snapshot.sensors?.fans ?? [];

  if (list.length === 0 && fans.length === 0) {
    return (
      <div className="na-widget">
        <ThermometerSnowflake size={22} />
        <div className="label">No temperature sensors exposed</div>
        <p>
          Windows did not report any thermal zones to NETRUNNER (common without administrator rights). If you use HWiNFO, turn on its
          Shared Memory Support and the HWiNFO source in Settings → System monitoring.
        </p>
      </div>
    );
  }

  return (
    <div className="thermal">
      {list.map((t) => {
        const tone = t.celsius >= 90 ? "crit" : t.celsius >= 75 ? "warn" : "ok";
        return (
          <div key={t.label} className="thermal__row">
            <span className="truncate">{t.label}</span>
            <span className="mono">{t.celsius.toFixed(0)} °C</span>
            {tone !== "ok" && <span className={`tag tag--${tone}`}>{tone === "crit" ? "Critical" : "Hot"}</span>}
          </div>
        );
      })}
      {fans.map((f) => (
        <div key={f.label} className="thermal__row">
          <span className="truncate">{f.label}</span>
          <span className="mono">{f.rpm.toFixed(0)} RPM</span>
        </div>
      ))}
      {!fans.length && <div className="label muted">Fans: available through HWiNFO (Settings → System monitoring)</div>}
    </div>
  );
}
