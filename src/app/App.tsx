import { useEffect, useState } from "react";
import { AlertOctagon } from "lucide-react";
import { useAppearance, useSettings } from "@/stores/settings";
import { useProfiles } from "@/stores/profiles";
import { useQuickAccess } from "@/stores/quickAccess";
import { refreshActivity } from "@/stores/activity";
import { notify } from "@/stores/notifications";
import { api } from "@/services/api";
import { applyTheme } from "@/styles/theme";
import { AppShell } from "@/layouts/AppShell";
import { Logo } from "@/components/Logo";

type Boot = { state: "loading" } | { state: "ready" } | { state: "failed"; message: string };

export function App() {
  const [boot, setBoot] = useState<Boot>({ state: "loading" });
  const theme = useSettings((s) => s.values.theme);
  const motion = useSettings((s) => s.values["ui.motion"]);

  useEffect(() => {
    // Only the data needed for the first screen is loaded here; heavier
    // subsystems (system monitor, module code) initialise on demand.
    Promise.all([
      useSettings.getState().load(),
      useProfiles.getState().load(),
      useQuickAccess.getState().load(),
    ])
      .then(() => {
        refreshActivity();
        setBoot({ state: "ready" });
        // Quiet startup update check; failures (offline, no release yet) are ignored.
        if (useSettings.getState().values["app.update_check"] && !import.meta.env.DEV) {
          api.app
            .checkUpdate()
            .then((u) => u.available && notify.info(`Update ${u.available} available`, "Settings → Updates to install it."))
            .catch(() => undefined);
        }
      })
      .catch((err: unknown) => setBoot({ state: "failed", message: err instanceof Error ? err.message : String(err) }));
  }, []);

  useEffect(() => applyTheme(theme), [theme]);
  useAppearance();

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.motion = motion;
  }, [motion]);

  if (boot.state === "ready") return <AppShell />;

  return (
    <div className="boot" data-tauri-drag-region>
      <Logo size={44} />
      <div className="boot__title">NETRUNNER</div>
      {boot.state === "loading" ? (
        <div className="boot__status label">Initialising local workspace…</div>
      ) : (
        <div className="boot__error">
          <AlertOctagon size={16} />
          <div>
            <div className="label">Backend unavailable</div>
            <div data-selectable>{boot.message}</div>
            <div className="muted">
              NETRUNNER must run inside its desktop shell (<code>npm run app:dev</code>), not a plain browser tab.
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
