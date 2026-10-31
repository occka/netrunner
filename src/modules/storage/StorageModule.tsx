import { useEffect, useState } from "react";
import { ModuleHeader } from "@/components/ModuleHeader";
import { api } from "@/services/api";
import { useActivity } from "@/stores/activity";
import { confirmAction } from "@/stores/confirm";
import { reportError } from "@/stores/notifications";
import type { AppInfo } from "@/types/entities";

export default function StorageModule() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const activityCount = useActivity((s) => s.entries.length);

  useEffect(() => {
    api.appInfo().then(setInfo, (e: Error) => setError(e.message));
  }, []);

  const clearLog = async () => {
    const ok = await confirmAction({
      title: "Clear activity log",
      message: "Permanently delete all activity log entries?",
      confirmLabel: "Clear log",
      danger: true,
    });
    if (!ok) return;
    try {
      await api.activity.clear();
      await useActivity.getState().refresh();
    } catch (err) {
      reportError("Could not clear activity log", err);
    }
  };

  return (
    <div className="module">
      <ModuleHeader id="storage" />
      <div className="module__scroll settings">
        <section className="panel settings-group">
          <header className="panel__header">
            <h2 className="panel__title">Local data</h2>
          </header>
          <div className="panel__body">
            {error && <div className="unavailable">{error}</div>}
            {info && (
              <dl className="kv">
                <dt className="label">Data directory</dt>
                <dd className="mono" data-selectable>
                  {info.dataDir}
                </dd>
                <dt className="label">Database</dt>
                <dd className="mono" data-selectable>
                  {info.databasePath ?? "in-memory"}
                </dd>
                <dt className="label">Schema version</dt>
                <dd className="mono">v{info.schemaVersion}</dd>
                <dt className="label">Migration backups</dt>
                <dd className="mono" data-selectable>
                  {info.dataDir}\backups
                </dd>
                <dt className="label">Logs</dt>
                <dd className="muted">Windows log directory for com.netrunner.app (netrunner.log)</dd>
              </dl>
            )}
            <p className="muted">
              Everything is stored locally in SQLite. Nothing is uploaded. The database is backed up automatically before a
              schema migration.
            </p>
          </div>
        </section>
        <section className="panel settings-group">
          <header className="panel__header">
            <h2 className="panel__title">Activity log</h2>
          </header>
          <div className="panel__body settings-rows">
            <div className="settings-row">
              <div>
                <div>{activityCount} recent entries loaded (the log keeps the newest 2000)</div>
              </div>
              <button className="btn btn--danger btn--sm" onClick={() => void clearLog()}>
                Clear log
              </button>
            </div>
          </div>
        </section>
        <div className="unavailable">Export, import and manual backups are planned.</div>
      </div>
    </div>
  );
}
