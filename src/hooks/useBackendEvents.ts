import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { api } from "@/services/api";
import { useProfiles } from "@/stores/profiles";
import { useShell } from "@/stores/shell";
import { useQuickAccess } from "@/stores/quickAccess";
import { refreshActivity } from "@/stores/activity";
import { confirmAction } from "@/stores/confirm";
import { notify, reportError } from "@/stores/notifications";

/** Subscribes the main window to events emitted by the Rust automation engine. */
export function useBackendEvents() {
  useEffect(() => {
    const subs = [
      listen<{ rule: string; message: string }>("automation://notify", (e) => notify.info(e.payload.message, `Automation · ${e.payload.rule}`)),
      listen<{ rule: string; entryId: number }>("automation://confirm", async (e) => {
        const entry = useQuickAccess.getState().entries.find((x) => x.id === e.payload.entryId);
        if (!entry) return;
        const ok = await confirmAction({
          title: "Automation wants to run a command",
          message: `Rule "${e.payload.rule}" wants to run "${entry.name}".`,
          detail: entry.target,
          confirmLabel: "Run command",
          danger: true,
        });
        if (!ok) return;
        api.quickAccess.launch(entry.id, true).then(refreshActivity, (err) => reportError(`Could not run ${entry.name}`, err));
      }),
      listen("profiles://changed", () => void useProfiles.getState().load()),
      listen("automation://ran", () => refreshActivity()),
      // A link clicked in a widget (dashboard or overlay): open it as a BROWSER tab.
      listen<string>("browser://open-request", async (e) => {
        useShell.getState().navigate("browser");
        const { useBrowser } = await import("@/modules/browser/store");
        await useBrowser.getState().init();
        await useBrowser.getState().open(e.payload);
      }),
      // A tab came back from a web overlay: show it in BROWSER.
      listen<string>("browser://returned", async (e) => {
        useShell.getState().navigate("browser");
        const { useBrowser } = await import("@/modules/browser/store");
        await useBrowser.getState().init();
        await useBrowser.getState().refresh();
        useBrowser.getState().activate(e.payload);
      }),
    ];
    return () => subs.forEach((p) => void p.then((off) => off()));
  }, []);
}
