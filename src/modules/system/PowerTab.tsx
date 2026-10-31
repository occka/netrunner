import { BatteryCharging, Plug } from "lucide-react";
import { api } from "@/services/api";
import { usePolled } from "@/hooks/usePolled";
import { Meter } from "@/components/Meter";
import { notify, reportError } from "@/stores/notifications";
import { refreshActivity } from "@/stores/activity";
import { formatDuration } from "@/utils/format";

export function PowerTab() {
  const { data, error, reload } = usePolled(() => api.system.power(), 15000);

  const activate = async (guid: string, name: string) => {
    try {
      await api.system.setPowerPlan(guid);
      notify.success(`Power plan: ${name}`);
      refreshActivity();
      void reload();
    } catch (err) {
      reportError("Could not switch power plan", err);
    }
  };

  if (error) return <div className="unavailable">{error}</div>;
  if (!data) return null;

  return (
    <div className="tab-pane power">
      <section className="panel">
        <header className="panel__header">
          <h2 className="panel__title">Power source</h2>
        </header>
        <div className="panel__body power__status">
          <div className="power__row">
            <Plug size={16} />
            {data.onAcPower == null ? "AC state unknown" : data.onAcPower ? "Plugged in" : "On battery"}
            {data.batterySaver && <span className="tag tag--warn">Battery saver</span>}
          </div>
          {data.hasBattery ? (
            <div className="power__row power__battery">
              <BatteryCharging size={16} />
              <span className="mono">{data.batteryPercent ?? "—"}%</span>
              <Meter percent={data.batteryPercent} thresholds={null} label="Battery level" />
              {data.batterySecondsLeft != null && <span className="muted">{formatDuration(data.batterySecondsLeft)} left</span>}
            </div>
          ) : (
            <div className="muted">No battery detected (desktop system).</div>
          )}
        </div>
      </section>
      <section className="panel">
        <header className="panel__header">
          <h2 className="panel__title">Power plans</h2>
        </header>
        <div className="panel__body">
          {data.plans.length === 0 && (
            <div className="unavailable">
              No classic power plans reported. On Modern Standby systems Windows uses Power Mode in Settings instead.
            </div>
          )}
          <div className="plans">
            {data.plans.map((p) => (
              <button key={p.guid} className="plan" aria-pressed={p.active} disabled={p.active} onClick={() => void activate(p.guid, p.name)}>
                <span className="plan__name">{p.name}</span>
                <span className="mono muted">{p.guid}</span>
                {p.active && <span className="tag tag--ok">Active</span>}
              </button>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}
