import { RotateCcw } from "lucide-react";
import { SETTINGS_DEFAULTS, useSettings, type SettingKey, type SettingsSchema } from "@/stores/settings";
import { reportError } from "@/stores/notifications";
import { WallpaperPicker } from "@/components/WallpaperPicker";
import { FONTS, PATTERNS, type BackgroundSpec } from "@/styles/appearance";

type BgKey = "appearance.background" | "appearance.dashboard_background";

const save = <K extends SettingKey>(key: K, value: SettingsSchema[K]) =>
  useSettings
    .getState()
    .set(key, value)
    .catch((err) => reportError("Could not save setting", err));

/** Sliders apply instantly and persist when they stop moving. */
const live = <K extends SettingKey>(key: K, value: SettingsSchema[K]) => useSettings.getState().setDebounced(key, value);

function BackgroundEditor({ settingKey, inheritLabel }: { settingKey: BgKey; inheritLabel: string }) {
  const spec = useSettings((s) => s.values[settingKey]);
  const set = (patch: Partial<BackgroundSpec>) => save(settingKey, { ...spec, ...patch });
  const setLive = (patch: Partial<BackgroundSpec>) => live(settingKey, { ...spec, ...patch });

  return (
    <div className="appearance-bg">
      <div className="segmented">
        {(
          [
            ["none", inheritLabel],
            ["image", "Image"],
            ["pattern", "Pattern"],
          ] as const
        ).map(([k, label]) => (
          <button
            key={k}
            aria-pressed={spec.kind === k}
            // Patterns are already dark; photos usually need more dimming for readable panels.
            onClick={() => void set(k === spec.kind ? {} : { kind: k, dim: k === "pattern" ? 10 : 45 })}
          >
            {label}
          </button>
        ))}
      </div>

      {spec.kind === "image" && <WallpaperPicker value={spec.image} onChange={(image) => void set({ image })} />}

      {spec.kind === "pattern" && (
        <div className="wallpapers">
          {PATTERNS.map((p) => (
            <button key={p.id} className="wallpaper pattern-swatch" aria-pressed={spec.pattern === p.id} onClick={() => void set({ pattern: p.id })}>
              <div className={`backdrop__pattern backdrop__pattern--${p.id}`} />
              <span>{p.label}</span>
            </button>
          ))}
        </div>
      )}

      {spec.kind !== "none" && (
        <div className="appearance-sliders">
          <label>
            <span className="row label">
              Darken <span className="mono">{spec.dim}%</span>
            </span>
            <input type="range" min={0} max={90} step={5} value={spec.dim} onChange={(e) => setLive({ dim: Number(e.target.value) })} />
          </label>
          {spec.kind === "image" && (
            <>
              <label>
                <span className="row label">
                  Blur <span className="mono">{spec.blur}px</span>
                </span>
                <input type="range" min={0} max={30} step={1} value={spec.blur} onChange={(e) => setLive({ blur: Number(e.target.value) })} />
              </label>
              <label>
                <span className="label">Fit</span>
                <select className="input" value={spec.fit} onChange={(e) => void set({ fit: e.target.value as BackgroundSpec["fit"] })}>
                  <option value="cover">Fill (crop)</option>
                  <option value="contain">Fit whole image</option>
                  <option value="center">Centre, original size</option>
                  <option value="tile">Tile</option>
                </select>
              </label>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export function AppearanceSettings() {
  const v = useSettings((s) => s.values);
  const slider = (key: SettingKey & `appearance.${string}`, label: string, min: number, max: number, step: number, unit: string, hint?: string) => (
    <label title={hint}>
      <span className="row label">
        {label}
        <span className="mono">
          {v[key] as number}
          {unit}
        </span>
      </span>
      <input type="range" min={min} max={max} step={step} value={v[key] as number} onChange={(e) => live(key, Number(e.target.value) as never)} />
    </label>
  );
  const toggle = (key: "appearance.scanlines" | "appearance.glow" | "appearance.vignette", label: string, hint: string) => (
    <label className="check" title={hint}>
      <input type="checkbox" checked={v[key]} onChange={(e) => void save(key, e.target.checked)} />
      {label}
    </label>
  );

  const reset = async () => {
    for (const key of Object.keys(SETTINGS_DEFAULTS).filter((k) => k.startsWith("appearance.")) as SettingKey[])
      await save(key, SETTINGS_DEFAULTS[key] as never);
  };

  return (
    <section className="panel settings-group" id="settings-appearance">
      <header className="panel__header">
        <h2 className="panel__title">Appearance</h2>
        <div className="panel__actions">
          <button className="btn btn--sm btn--ghost" onClick={() => void reset()}>
            <RotateCcw size={12} /> Reset
          </button>
        </div>
      </header>
      <div className="panel__body settings-rows">
        <div className="settings-row settings-row--stack">
          <div>
            <div>App background</div>
            <div className="field__hint">Behind every module. Raise panel transparency below to let it show through.</div>
          </div>
          <BackgroundEditor settingKey="appearance.background" inheritLabel="Theme colour" />
        </div>
        <div className="settings-row settings-row--stack">
          <div>
            <div>Dashboard background</div>
            <div className="field__hint">Only on COMMAND. “Same as app” shows the app background there too.</div>
          </div>
          <BackgroundEditor settingKey="appearance.dashboard_background" inheritLabel="Same as app" />
        </div>
        <div className="settings-row settings-row--stack">
          <div>Panels and text</div>
          <div className="appearance-sliders">
            {slider("appearance.panel_opacity", "Panel opacity", 30, 100, 5, "%", "Lower values let the background show through panels")}
            {slider("appearance.panel_blur", "Glass blur", 0, 24, 1, "px", "Frosted-glass blur behind panels")}
            {slider("appearance.radius", "Corner radius", 0, 16, 1, "px")}
            {slider("appearance.scale", "Interface scale", 70, 150, 5, "%", "Zoom of the whole NETRUNNER window")}
            <label>
              <span className="label">Interface font</span>
              <select className="input" value={v["appearance.font"]} onChange={(e) => void save("appearance.font", e.target.value as SettingsSchema["appearance.font"])}>
                {FONTS.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>
        <div className="settings-row">
          <div>
            <div>Effects</div>
            <div className="field__hint">Drawn over NETRUNNER's own interface; browser pages are not affected.</div>
          </div>
          <div className="appearance-effects">
            {toggle("appearance.glow", "Neon glow", "Glow around panels, titles and the clock")}
            {toggle("appearance.scanlines", "CRT scanlines", "Thin horizontal lines over the interface")}
            {toggle("appearance.vignette", "Vignette", "Darker window edges")}
          </div>
        </div>
      </div>
    </section>
  );
}
