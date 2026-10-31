import { ThermometerSnowflake } from "lucide-react";
import { useSystemSnapshot } from "@/hooks/useSystemSnapshot";
import { Sampling } from "./common";
import type { WidgetProps } from "./registry";

export default function ThermalWidget(_: WidgetProps) {
  const { snapshot } = useSystemSnapshot();
  if (!snapshot) return <Sampling />;

  if (snapshot.temperatures.length === 0) {
    return (
      <div className="na-widget">
        <ThermometerSnowflake size={22} />
        <div className="label">No temperature sensors exposed</div>
        <p>
          Windows did not report any thermal zones to NETRUNNER (common without administrator rights). Dedicated sensor
          providers are planned for Phase 2. Fan speeds are not readable yet.
        </p>
      </div>
    );
  }

  return (
    <div className="thermal">
      {snapshot.temperatures.map((t) => {
        const tone = t.celsius >= 90 ? "crit" : t.celsius >= 75 ? "warn" : "ok";
        return (
          <div key={t.label} className="thermal__row">
            <span className="truncate">{t.label}</span>
            <span className="mono">{t.celsius.toFixed(0)} °C</span>
            {tone !== "ok" && <span className={`tag tag--${tone}`}>{tone === "crit" ? "Critical" : "Hot"}</span>}
          </div>
        );
      })}
      <div className="label muted">Fans: no provider yet</div>
    </div>
  );
}
