import { useEffect, useRef, useState } from "react";
import { AppearanceSettings } from "./AppearanceSettings";
import { api } from "@/services/api";
import { refreshActivity } from "@/stores/activity";
import { confirmAction } from "@/stores/confirm";
import { RotateCcw } from "lucide-react";
import { ModuleHeader } from "@/components/ModuleHeader";
import { useSettings, type SettingsSchema } from "@/stores/settings";
import { useShell } from "@/stores/shell";
import { reportError } from "@/stores/notifications";
import { DEFAULT_THEME, THEME_PRESETS, THEME_TOKENS, TOKEN_LABELS, type ThemeColors } from "@/styles/theme";

const INTERVALS = [500, 1000, 1500, 3000, 5000];

/** Signed updates from github.com/occka/netrunner releases. */
function UpdatesSection() {
  const [info, setInfo] = useState<{ current: string; available: string | null; notes: string | null } | null>(null);
  const [busy, setBusy] = useState<"check" | "install" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const autoCheck = useSettings((s) => s.values["app.update_check"]);

  const check = async () => {
    setBusy("check");
    setError(null);
    try {
      setInfo(await api.app.checkUpdate());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const install = async () => {
    const ok = await confirmAction({
      title: "Install update",
      message: `Download and install NETRUNNER ${info?.available}? The app restarts when done.`,
      detail: "The package is verified against NETRUNNER's signing key before it is installed.",
      confirmLabel: "Install & restart",
    });
    if (!ok) return;
    setBusy("install");
    try {
      await api.app.installUpdate();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(null);
    }
  };

  return (
    <section className="panel settings-group" id="settings-updates">
      <header className="panel__header">
        <h2 className="panel__title">Updates</h2>
      </header>
      <div className="panel__body settings-rows">
        <div className="settings-row">
          <div>
            <div>
              {info?.available ? (
                <>
                  Version <b>{info.available}</b> is available (installed: {info.current})
                </>
              ) : info ? (
                <>NETRUNNER {info.current} is up to date</>
              ) : (
                "Check github.com/occka/netrunner for a newer release"
              )}
            </div>
            {info?.notes && <div className="field__hint">{info.notes}</div>}
            {error && <div className="field__error">{error}</div>}
          </div>
          {info?.available ? (
            <button className="btn btn--primary btn--sm" onClick={() => void install()} disabled={!!busy}>
              {busy === "install" ? "Installing…" : "Install & restart"}
            </button>
          ) : (
            <button className="btn btn--sm" onClick={() => void check()} disabled={!!busy}>
              {busy === "check" ? "Checking…" : "Check for updates"}
            </button>
          )}
        </div>
        <div className="settings-row">
          <div>Check automatically when NETRUNNER starts</div>
          <label className="check">
            <input
              type="checkbox"
              checked={autoCheck}
              onChange={(e) => void useSettings.getState().set("app.update_check", e.target.checked)}
            />
            Enabled
          </label>
        </div>
      </div>
    </section>
  );
}

/** Start-with-Windows state lives in the registry (HKCU Run), not in settings. */
function AutostartRow() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  useEffect(() => {
    api.app.autostartGet().then(setEnabled, () => setEnabled(null));
  }, []);
  const toggle = async (next: boolean) => {
    try {
      setEnabled(await api.app.autostartSet(next));
      refreshActivity();
    } catch (err) {
      reportError("Could not change start with Windows", err);
    }
  };
  return (
    <div className="settings-row">
      <div>
        <div>Start with Windows</div>
        <div className="field__hint">Adds NETRUNNER to your user's startup list (no administrator rights needed).</div>
      </div>
      <label className="check">
        <input type="checkbox" checked={!!enabled} disabled={enabled == null} onChange={(e) => void toggle(e.target.checked)} />
        {enabled == null ? "Unavailable" : "Enabled"}
      </label>
    </div>
  );
}

export default function SettingsModule() {
  const values = useSettings((s) => s.values);
  const section = useShell((s) => s.section);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!section) return;
    const el = scrollRef.current?.querySelector(`#settings-${section}`);
    el?.scrollIntoView({ behavior: "smooth", block: "start" });
    el?.classList.add("settings-group--flash");
    const id = window.setTimeout(() => el?.classList.remove("settings-group--flash"), 1200);
    return () => window.clearTimeout(id);
  }, [section]);

  const save = <K extends keyof SettingsSchema>(key: K, value: SettingsSchema[K]) =>
    useSettings
      .getState()
      .set(key, value)
      .catch((err) => reportError("Could not save setting", err));

  const setColor = (token: keyof ThemeColors, value: string) =>
    useSettings.getState().setDebounced("theme", { ...values.theme, [token]: value });
  const activePreset = THEME_PRESETS.find((p) => THEME_TOKENS.every((t) => p.colors[t] === values.theme[t]));

  return (
    <div className="module">
      <ModuleHeader id="settings" />
      <div className="module__scroll settings" ref={scrollRef}>
        <section className="panel settings-group" id="settings-theme">
          <header className="panel__header">
            <h2 className="panel__title">Theme</h2>
            <div className="panel__actions">
              <button className="btn btn--sm btn--ghost" onClick={() => void save("theme", DEFAULT_THEME)}>
                <RotateCcw size={12} /> Reset
              </button>
            </div>
          </header>
          <div className="panel__body">
            <div className="presets">
              {THEME_PRESETS.map((p) => (
                <button
                  key={p.id}
                  className="preset"
                  aria-pressed={activePreset?.id === p.id}
                  onClick={() => void save("theme", p.colors)}
                >
                  <span className="preset__swatches">
                    {(["background", "surface", "primary", "secondary", "critical"] as const).map((t) => (
                      <span key={t} style={{ background: p.colors[t] }} />
                    ))}
                  </span>
                  {p.name}
                </button>
              ))}
              {!activePreset && <span className="tag tag--accent">Custom palette</span>}
            </div>
            <div className="token-grid">
              {THEME_TOKENS.map((t) => (
                <label key={t} className="token">
                  {/* Fixed-size swatch; the native picker is an invisible hit area on top of it,
                      because WebView2 sizes <input type=color> inconsistently. */}
                  <span className="token__swatch" style={{ background: values.theme[t] }}>
                    <input
                      type="color"
                      value={values.theme[t]}
                      onChange={(e) => setColor(t, e.target.value)}
                      aria-label={TOKEN_LABELS[t]}
                    />
                  </span>
                  <span className="truncate">{TOKEN_LABELS[t]}</span>
                  <span className="mono muted">{values.theme[t]}</span>
                </label>
              ))}
            </div>
          </div>
        </section>

        <AppearanceSettings />

        <section className="panel settings-group" id="settings-monitoring">
          <header className="panel__header">
            <h2 className="panel__title">System monitoring</h2>
          </header>
          <div className="panel__body settings-rows">
            <div className="settings-row">
              <div>
                <div>Polling interval</div>
                <div className="field__hint">
                  Metrics are only collected while a metrics widget is on screen and the window is visible.
                </div>
              </div>
              <div className="segmented">
                {INTERVALS.map((ms) => (
                  <button key={ms} aria-pressed={values["monitor.interval_ms"] === ms} onClick={() => void save("monitor.interval_ms", ms)}>
                    {ms < 1000 ? `${ms}ms` : `${ms / 1000}s`}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </section>

        <section className="panel settings-group" id="settings-interface">
          <header className="panel__header">
            <h2 className="panel__title">Interface & motion</h2>
          </header>
          <div className="panel__body settings-rows">
            <div className="settings-row">
              <div>
                <div>Animations</div>
                <div className="field__hint">“System” follows the Windows reduced-motion preference.</div>
              </div>
              <div className="segmented">
                {(["system", "reduced", "full"] as const).map((m) => (
                  <button key={m} aria-pressed={values["ui.motion"] === m} onClick={() => void save("ui.motion", m)}>
                    {m}
                  </button>
                ))}
              </div>
            </div>
            <div className="settings-row">
              <div>Keep navigation expanded</div>
              <label className="check">
                <input type="checkbox" checked={values["nav.pinned"]} onChange={(e) => void save("nav.pinned", e.target.checked)} />
                Pinned
              </label>
            </div>
            <div className="settings-row">
              <div>
                <div>Show inspector</div>
                <div className="field__hint">Toggle anytime with Ctrl+I.</div>
              </div>
              <label className="check">
                <input
                  type="checkbox"
                  checked={values["inspector.visible"]}
                  onChange={(e) => void save("inspector.visible", e.target.checked)}
                />
                Visible
              </label>
            </div>
          </div>
        </section>

        <section className="panel settings-group" id="settings-startup">
          <header className="panel__header">
            <h2 className="panel__title">Startup & tray</h2>
          </header>
          <div className="panel__body settings-rows">
            <AutostartRow />
            <div className="settings-row">
              <div>
                <div>Start minimised to tray</div>
                <div className="field__hint">Only applies when Windows starts NETRUNNER at sign-in.</div>
              </div>
              <label className="check">
                <input
                  type="checkbox"
                  checked={values["app.start_minimized"]}
                  onChange={(e) => void save("app.start_minimized", e.target.checked)}
                />
                Minimised
              </label>
            </div>
            <div className="settings-row">
              <div>
                <div>Close button hides to tray</div>
                <div className="field__hint">NETRUNNER keeps running in the notification area. Quit from the tray menu.</div>
              </div>
              <label className="check">
                <input
                  type="checkbox"
                  checked={values["app.close_to_tray"]}
                  onChange={(e) => void save("app.close_to_tray", e.target.checked)}
                />
                Hide to tray
              </label>
            </div>
            <div className="settings-row">
              <div>Quit NETRUNNER completely</div>
              <button className="btn btn--sm" onClick={() => void api.app.quit()}>
                Quit
              </button>
            </div>
          </div>
        </section>

        <UpdatesSection />

        <section className="panel settings-group">
          <header className="panel__header">
            <h2 className="panel__title">Keyboard</h2>
          </header>
          <div className="panel__body">
            <dl className="shortcuts">
              <dt>
                <kbd>Ctrl</kbd> <kbd>K</kbd>
              </dt>
              <dd>Search & command palette</dd>
              <dt>
                <kbd>Ctrl</kbd> <kbd>I</kbd>
              </dt>
              <dd>Toggle inspector</dd>
              <dt>
                <kbd>↑</kbd> <kbd>↓</kbd>
              </dt>
              <dd>Move between navigation items</dd>
              <dt>
                <kbd>Enter</kbd>
              </dt>
              <dd>Launch focused Quick Access entry</dd>
            </dl>
          </div>
        </section>
      </div>
    </div>
  );
}
