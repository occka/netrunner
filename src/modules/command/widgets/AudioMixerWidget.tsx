import { api } from "@/services/api";
import { usePolled } from "@/hooks/usePolled";
import { VolumeControl } from "@/components/AudioControls";
import { reportError } from "@/stores/notifications";
import type { WidgetProps } from "./registry";
import type { AUDIO_SETTINGS, ConfigOf } from "./settings";

/** Default output device and the apps playing on it. */
export default function AudioMixerWidget({ config: c }: WidgetProps<ConfigOf<typeof AUDIO_SETTINGS>>) {
  const interval = c.meters ? 500 : 3000;
  const devices = usePolled(() => api.audio.devices(), interval);
  const sessions = usePolled(() => (c.apps > 0 ? api.audio.sessions() : Promise.resolve([])), interval);
  const out = devices.data?.outputs.find((d) => d.isDefault);

  if (devices.error) return <div className="unavailable">{devices.error}</div>;
  if (!devices.data) return null;
  if (!out) return <div className="unavailable">No default output device.</div>;

  // The loudest apps first, so the list stays useful when it is cut short.
  const apps = [...(sessions.data ?? [])].filter((s) => !s.system).sort((a, b) => b.peak - a.peak || a.name.localeCompare(b.name)).slice(0, c.apps);

  return (
    <div className="audio-mixer">
      <div className="audio-row__head">
        <span className="truncate" title={out.name}>
          {out.name}
        </span>
      </div>
      <VolumeControl
        label={out.name}
        volume={out.volume}
        muted={out.muted}
        peak={c.meters ? out.peak : undefined}
        onVolume={(v) => void api.audio.setVolume(out.id, v).catch((e) => reportError("Could not set the volume", e))}
        onMute={(m) => void api.audio.setMute(out.id, m).then(devices.reload, (e) => reportError("Could not change mute", e))}
      />
      {apps.map((s) => (
        <div key={s.id} className="audio-mixer__app">
          <div className="muted truncate" title={s.name}>
            {s.name}
          </div>
          <VolumeControl
            label={s.name}
            volume={s.volume}
            muted={s.muted}
            peak={c.meters ? s.peak : undefined}
            onVolume={(v) => void api.audio.sessionSet(s.id, v).catch((e) => reportError("Could not set the app's volume", e))}
            onMute={(m) => void api.audio.sessionSet(s.id, undefined, m).then(sessions.reload, (e) => reportError("Could not change mute", e))}
          />
        </div>
      ))}
      {c.apps > 0 && !apps.length && <div className="muted">No app is using sound.</div>}
    </div>
  );
}
