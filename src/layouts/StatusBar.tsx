import { useEffect, useState } from "react";
import { PanelRight } from "lucide-react";
import { api } from "@/services/api";
import { MODULE_BY_ID, STATUS_LABEL } from "@/app/modules";
import { useShell } from "@/stores/shell";
import { useSetting, useSettings } from "@/stores/settings";
import { useMonitor } from "@/hooks/useSystemSnapshot";
import { reportError } from "@/stores/notifications";
import type { AppInfo } from "@/types/entities";

export function StatusBar() {
  const module = useShell((s) => s.module);
  const inspectorVisible = useSetting("inspector.visible");
  const interval = useSetting("monitor.interval_ms");
  const monitoring = useMonitor((s) => s.subscribers > 0);
  const monitorError = useMonitor((s) => s.error);
  const [info, setInfo] = useState<AppInfo | null>(null);
  const def = MODULE_BY_ID[module];

  useEffect(() => {
    api.appInfo().then(setInfo, () => setInfo(null));
  }, []);

  return (
    <footer className="statusbar">
      <span className="statusbar__item">
        <span className="dot statusbar__ok" />
        NETRUNNER {info ? `v${info.version}` : ""}
      </span>
      <span className="statusbar__item">LOCAL DB {info ? `· SCHEMA v${info.schemaVersion}` : "· —"}</span>
      <span className="statusbar__item">
        {def.label.toUpperCase()} · {STATUS_LABEL[def.status].toUpperCase()}
      </span>
      <span className="statusbar__spacer" />
      {monitorError ? (
        <span className="statusbar__item statusbar__warn" title={monitorError}>
          MONITOR ERROR
        </span>
      ) : (
        <span className="statusbar__item" title="System monitoring polls only while a metrics widget is visible">
          MONITOR {monitoring ? `ACTIVE · ${(interval / 1000).toFixed(1)}s` : "IDLE"}
        </span>
      )}
      <button
        className="statusbar__btn"
        aria-pressed={inspectorVisible}
        title="Toggle inspector (Ctrl+I)"
        onClick={() =>
          useSettings
            .getState()
            .set("inspector.visible", !inspectorVisible)
            .catch((err) => reportError("Could not save inspector state", err))
        }
      >
        <PanelRight size={12} />
        INSPECTOR
      </button>
    </footer>
  );
}
