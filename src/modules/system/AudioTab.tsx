import { ExternalLink } from "lucide-react";
import { api } from "@/services/api";
import { usePolled } from "@/hooks/usePolled";
import { VolumeControl } from "@/components/AudioControls";
import { notify, reportError } from "@/stores/notifications";
import type { AudioDevice } from "@/types/audio";

const POLL_MS = 500;

function DeviceList({ title, devices, reload }: { title: string; devices: AudioDevice[]; reload: () => void }) {
  const setDefault = async (d: AudioDevice) => {
    try {
      await api.audio.setDefault(d.id, d.name);
      notify.success(`Default device: ${d.name}`);
      reload();
    } catch (err) {
      reportError("Could not change the default device", err);
      notify.info("You can change it in the Windows sound settings", "Use the button at the top of this tab.");
    }
  };
  return (
    <section className="panel">
      <header className="panel__header">
        <h2 className="panel__title">{title}</h2>
      </header>
      <div className="panel__body audio-list">
        {!devices.length && <div className="muted">No active devices.</div>}
        {devices.map((d) => (
          <div key={d.id} className="audio-row">
            <div className="audio-row__head">
              <span className="truncate" title={d.name}>
                {d.name}
              </span>
              {d.isDefault ? (
                <span className="tag tag--ok">Default</span>
              ) : (
                <button className="btn btn--sm btn--ghost" onClick={() => void setDefault(d)}>
                  Set default
                </button>
              )}
            </div>
            <VolumeControl
              label={d.name}
              volume={d.volume}
              muted={d.muted}
              peak={d.peak}
              onVolume={(v) => void api.audio.setVolume(d.id, v).catch((e) => reportError("Could not set the volume", e))}
              onMute={(m) => void api.audio.setMute(d.id, m).then(reload, (e) => reportError("Could not change mute", e))}
            />
          </div>
        ))}
      </div>
    </section>
  );
}

/** Sound devices and per-app volume. Levels are polled only while this tab is open. */
export function AudioTab() {
  const devices = usePolled(() => api.audio.devices(), POLL_MS);
  const sessions = usePolled(() => api.audio.sessions(), POLL_MS);
  const defaultOutput = devices.data?.outputs.find((d) => d.isDefault);

  if (devices.error) return <div className="unavailable">{devices.error}</div>;
  if (!devices.data) return null;

  return (
    <div className="tab-pane audio">
      <div className="audio__top">
        <button className="btn btn--sm btn--ghost" onClick={() => void api.audio.openSettings().catch((e) => reportError("Could not open the sound settings", e))}>
          <ExternalLink size={12} /> Windows sound settings
        </button>
      </div>
      <DeviceList title="Output devices" devices={devices.data.outputs} reload={() => void devices.reload()} />
      <section className="panel">
        <header className="panel__header">
          <h2 className="panel__title">Apps{defaultOutput ? ` on ${defaultOutput.name}` : ""}</h2>
        </header>
        <div className="panel__body audio-list">
          {!sessions.data?.length && <div className="muted">No app is using sound right now.</div>}
          {sessions.data?.map((s) => (
            <div key={s.id} className="audio-row">
              <div className="audio-row__head">
                <span className="truncate" title={s.pid ? `${s.name} · process ${s.pid}` : s.name}>
                  {s.name}
                </span>
              </div>
              <VolumeControl
                label={s.name}
                volume={s.volume}
                muted={s.muted}
                peak={s.peak}
                onVolume={(v) => void api.audio.sessionSet(s.id, v).catch((e) => reportError("Could not set the app's volume", e))}
                onMute={(m) => void api.audio.sessionSet(s.id, undefined, m).then(sessions.reload, (e) => reportError("Could not change mute", e))}
              />
            </div>
          ))}
        </div>
      </section>
      <DeviceList title="Input devices" devices={devices.data.inputs} reload={() => void devices.reload()} />
    </div>
  );
}
