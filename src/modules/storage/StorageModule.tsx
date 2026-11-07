import { useEffect, useState } from "react";
import {
  open as openDialog,
  save as saveDialog,
} from "@tauri-apps/plugin-dialog";
import {
  Download,
  FolderOpen,
  RotateCcw,
  Save,
  Trash2,
  Upload,
} from "lucide-react";
import { ModuleHeader } from "@/components/ModuleHeader";
import { usePolled } from "@/hooks/usePolled";
import { api } from "@/services/api";
import { useActivity } from "@/stores/activity";
import { confirmAction } from "@/stores/confirm";
import { notify, reportError } from "@/stores/notifications";
import { useSetting, useSettings } from "@/stores/settings";
import type { AppInfo, DbBackup } from "@/types/entities";
import { formatBytes } from "@/utils/format";

const KIND_LABEL: Record<DbBackup["kind"], string> = {
  manual: "Manual",
  auto: "Automatic",
  migration: "Before an update",
  damaged: "Damaged original",
  restore: "Before a restore",
};

const RESTORE_WARNING =
  "NETRUNNER restarts and the database is replaced by this copy: settings, profiles, layouts, notes, chats and history go back to that point. The current database is kept as a backup first.";

function Backups() {
  const { data, reload } = usePolled(() => api.storage.backups(), 0);
  const every = useSetting("storage.backup_every_days");
  const keep = useSetting("storage.backup_keep");
  const [busy, setBusy] = useState(false);
  const set = (
    key: "storage.backup_every_days" | "storage.backup_keep",
    value: number,
  ) =>
    void useSettings
      .getState()
      .set(key, value)
      .catch((err) => reportError("Could not save the setting", err));

  const run = async (what: () => Promise<void>, done?: string) => {
    setBusy(true);
    try {
      await what();
      if (done) notify.success(done);
      await reload();
    } catch (err) {
      reportError("Storage action failed", err);
    } finally {
      setBusy(false);
    }
  };

  const exportTo = async () => {
    const path = await saveDialog({
      title: "Export NETRUNNER data",
      defaultPath: `netrunner-export-${new Date().toISOString().slice(0, 10)}.db`,
      filters: [{ name: "NETRUNNER data", extensions: ["db"] }],
    });
    if (path) await run(() => api.storage.exportTo(path), "Exported");
  };

  const importFrom = async () => {
    const picked = await openDialog({
      multiple: false,
      title: "Import NETRUNNER data",
      filters: [{ name: "NETRUNNER data", extensions: ["db"] }],
    });
    const path = Array.isArray(picked) ? picked[0] : picked;
    if (!path) return;
    if (
      await confirmAction({
        title: "Import data",
        message: RESTORE_WARNING,
        confirmLabel: "Import and restart",
        danger: true,
      })
    )
      await run(() => api.storage.importFrom(path));
  };

  const restore = async (b: DbBackup) => {
    if (
      await confirmAction({
        title: `Restore ${new Date(b.created * 1000).toLocaleString()}`,
        message: RESTORE_WARNING,
        confirmLabel: "Restore and restart",
        danger: true,
      })
    )
      await run(() => api.storage.restore(b.name));
  };

  const remove = async (b: DbBackup) => {
    if (
      await confirmAction({
        title: "Delete backup",
        message: `Delete ${b.name}? This cannot be undone.`,
        confirmLabel: "Delete",
        danger: true,
      })
    )
      await run(() => api.storage.remove(b.name));
  };

  return (
    <section className="panel settings-group">
      <header className="panel__header">
        <h2 className="panel__title">Backups</h2>
      </header>
      <div className="panel__body settings-rows">
        <div className="settings-row">
          <div>
            <div>Automatic backup</div>
            <div className="muted">
              A copy of the whole database, made in the background.
            </div>
          </div>
          <select
            className="select"
            value={every}
            onChange={(e) =>
              set("storage.backup_every_days", Number(e.target.value))
            }
          >
            <option value={0}>Off</option>
            <option value={1}>Every day</option>
            <option value={7}>Every week</option>
            <option value={30}>Every month</option>
          </select>
        </div>
        <div className="settings-row">
          <div>Automatic backups kept</div>
          <input
            className="input storage-keep"
            type="number"
            min={1}
            max={50}
            value={keep}
            onChange={(e) =>
              set(
                "storage.backup_keep",
                Math.min(50, Math.max(1, Number(e.target.value) || 1)),
              )
            }
          />
        </div>
        <div className="settings-row">
          <div className="muted">
            Exports are the whole database: settings, profiles, layouts, notes,
            NEURAL chats and browsing history. Keep them private. Files of
            NEURAL chat folders are not included.
          </div>
        </div>
        <div className="storage-actions">
          <button
            className="btn btn--sm btn--primary"
            disabled={busy}
            onClick={() =>
              void run(() => api.storage.backupNow(), "Backup saved")
            }
          >
            <Save size={12} /> Back up now
          </button>
          <button
            className="btn btn--sm"
            disabled={busy}
            onClick={() => void exportTo()}
          >
            <Download size={12} /> Export…
          </button>
          <button
            className="btn btn--sm"
            disabled={busy}
            onClick={() => void importFrom()}
          >
            <Upload size={12} /> Import…
          </button>
          <button
            className="btn btn--sm btn--ghost"
            onClick={() =>
              void api.storage
                .openFolder()
                .catch((err) => reportError("Could not open the folder", err))
            }
          >
            <FolderOpen size={12} /> Open folder
          </button>
        </div>
        {data && data.length > 0 ? (
          <table className="table storage-backups">
            <tbody>
              {data.map((b) => (
                <tr key={b.name}>
                  <td>{new Date(b.created * 1000).toLocaleString()}</td>
                  <td>
                    <span className="tag">{KIND_LABEL[b.kind]}</span>
                  </td>
                  <td className="num mono">{formatBytes(b.size)}</td>
                  <td className="actions">
                    <button
                      className="btn btn--sm btn--ghost"
                      disabled={busy || b.kind === "damaged"}
                      title={
                        b.kind === "damaged"
                          ? "This is the damaged original kept by a repair"
                          : "Go back to this copy"
                      }
                      onClick={() => void restore(b)}
                    >
                      <RotateCcw size={12} /> Restore
                    </button>
                    <button
                      className="icon-btn icon-btn--sm"
                      disabled={busy}
                      title="Delete this backup"
                      onClick={() => void remove(b)}
                    >
                      <Trash2 size={12} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="muted">No backups yet.</p>
        )}
      </div>
    </section>
  );
}

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
                <dt className="label">Backups</dt>
                <dd className="mono" data-selectable>
                  {info.dataDir}\backups
                </dd>
                <dt className="label">Logs</dt>
                <dd className="muted">
                  Windows log directory for com.netrunner.app (netrunner.log)
                </dd>
              </dl>
            )}
            <p className="muted">
              Everything is stored locally in SQLite. Nothing is uploaded. The
              database is also backed up before every update that changes it,
              and checked and repaired at start if it is damaged.
            </p>
          </div>
        </section>
        <Backups />
        <section className="panel settings-group">
          <header className="panel__header">
            <h2 className="panel__title">Activity log</h2>
          </header>
          <div className="panel__body settings-rows">
            <div className="settings-row">
              <div>
                <div>
                  {activityCount} recent entries loaded (the log keeps the
                  newest 2000)
                </div>
              </div>
              <button
                className="btn btn--danger btn--sm"
                onClick={() => void clearLog()}
              >
                Clear log
              </button>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
