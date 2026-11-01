import { useState } from "react";
import { FolderOpen, RefreshCw, Trash2 } from "lucide-react";
import { api } from "@/services/api";
import { usePolled } from "@/hooks/usePolled";
import { useSetting, useSettings, type SettingKey, type SettingsSchema } from "@/stores/settings";
import { confirmAction } from "@/stores/confirm";
import { notify, reportError } from "@/stores/notifications";
import { formatBytes, formatRelative, parseDbTime } from "@/utils/format";
import { useBrowser } from "./store";

function hostOf(url: string) {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

const save = <K extends SettingKey>(key: K, value: SettingsSchema[K]) =>
  useSettings
    .getState()
    .set(key, value)
    .catch((err) => reportError("Could not save the setting", err));

export function BookmarksPanel() {
  const open = useBrowser((s) => s.open);
  const { data, reload } = usePolled(() => api.browser.bookmarks(), 3000);
  if (!data) return null;
  if (data.length === 0) return <div className="empty">No bookmarks. Use the star in the address bar.</div>;
  return (
    <ul className="browser__list">
      {data.map((b) => (
        <li key={b.id}>
          <button className="link-btn truncate" title={b.url} onClick={() => void open(b.url)}>
            {b.title || b.url}
          </button>
          <span className="muted mono truncate">{hostOf(b.url)}</span>
          <button
            className="icon-btn icon-btn--sm"
            title="Remove bookmark"
            onClick={() => void api.browser.removeBookmark(b.id).then(reload, (err) => reportError("Could not remove", err))}
          >
            <Trash2 size={12} />
          </button>
        </li>
      ))}
    </ul>
  );
}

export function HistoryPanel() {
  const open = useBrowser((s) => s.open);
  const [query, setQuery] = useState("");
  const enabled = useSetting("browser.history");
  const { data, reload } = usePolled(() => api.browser.history(query, 300), 0);

  return (
    <div className="browser__panel-stack">
      <input
        className="input"
        placeholder="Search history"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyUp={() => void reload()}
      />
      <label className="check">
        <input type="checkbox" checked={enabled} onChange={(e) => void save("browser.history", e.target.checked)} />
        Save history (private tabs never do)
      </label>
      <button
        className="btn btn--sm btn--ghost"
        onClick={async () => {
          if (!(await confirmAction({ title: "Clear history", message: "Delete the whole browsing history?", confirmLabel: "Clear", danger: true }))) return;
          await api.browser.clearHistory().catch((err) => reportError("Could not clear history", err));
          await reload();
        }}
      >
        <Trash2 size={12} /> Clear history
      </button>
      <ul className="browser__list">
        {data?.map((h) => (
          <li key={h.id}>
            <button className="link-btn truncate" title={h.url} onClick={() => void open(h.url)}>
              {h.title || h.url}
            </button>
            <span className="muted mono truncate">
              {hostOf(h.url)} · {formatRelative(parseDbTime(h.visitedAt))}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function DownloadsPanel() {
  const { data } = usePolled(() => api.browser.downloads(), 1500);
  if (!data) return null;
  if (data.length === 0) return <div className="empty">No downloads this session. Files go to your Downloads folder and are checked by SmartScreen.</div>;
  return (
    <ul className="browser__list">
      {[...data].reverse().map((d) => (
        <li key={d.id}>
          <span className="truncate" title={d.url}>
            {d.path?.split(/[\\/]/).pop() || hostOf(d.url)}
          </span>
          <span className={`tag ${d.state === "done" ? "tag--ok" : d.state === "failed" ? "tag--crit" : "tag--info"}`}>{d.state}</span>
          {d.path && d.state === "done" && (
            <button className="icon-btn icon-btn--sm" title="Show in folder" onClick={() => void api.files.reveal(d.path!).catch((err) => reportError("Could not open folder", err))}>
              <FolderOpen size={12} />
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

export function PrivacyPanel({ site }: { site: string }) {
  const { data: status, reload } = usePolled(() => api.browser.status(), 3000);
  const { data: perms, reload: reloadPerms } = usePolled(() => api.browser.permissions());
  const [updating, setUpdating] = useState(false);
  const v = {
    adblock: useSetting("browser.adblock"),
    cosmetic: useSetting("browser.cosmetic"),
    https: useSetting("browser.https_only"),
    gpc: useSetting("browser.gpc"),
    tracking: useSetting("browser.tracking"),
    autofill: useSetting("browser.autofill"),
    webrtc: useSetting("browser.webrtc_protect"),
    extensions: useSetting("browser.extensions"),
    lists: useSetting("browser.adblock_lists"),
    exceptions: useSetting("browser.adblock_exceptions"),
    restoreTabs: useSetting("browser.restore_tabs"),
  };
  const excepted = !!site && v.exceptions.includes(site);

  const toggleList = async (id: string, on: boolean) => {
    await save("browser.adblock_lists", on ? [...new Set([...v.lists, id])] : v.lists.filter((x) => x !== id));
    // Newly enabled lists are downloaded by the backend; show progress.
    window.setTimeout(() => void reload(), 800);
  };

  const update = async () => {
    setUpdating(true);
    try {
      const errors = await api.browser.updateLists();
      if (errors.length) notify.warn("Some lists were not updated", errors.map(([id, e]) => `${id}: ${e}`).join("\n"));
      else notify.success("Filter lists updated");
      await reload();
    } catch (err) {
      reportError("Could not update filter lists", err);
    } finally {
      setUpdating(false);
    }
  };

  const toggle = (key: SettingKey, label: string, checked: boolean, hint?: string) => (
    <label className="check browser__opt" title={hint}>
      <input type="checkbox" checked={checked} onChange={(e) => void save(key, e.target.checked as never)} />
      <span>
        {label}
        {hint && <span className="muted browser__hint">{hint}</span>}
      </span>
    </label>
  );

  return (
    <div className="browser__panel-stack">
      {site && (
        <div className="browser__site">
          <span className="mono truncate">{site}</span>
          <button
            className="btn btn--sm"
            onClick={() =>
              void save("browser.adblock_exceptions", excepted ? v.exceptions.filter((e) => e !== site) : [...v.exceptions, site]).then(() =>
                notify.info(excepted ? "Blocking on for this site" : "Blocking off for this site", "Reload the page to apply."),
              )
            }
          >
            {excepted ? "Turn blocking back on" : "Turn blocking off here"}
          </button>
        </div>
      )}

      <h3 className="label">Blocking</h3>
      {toggle("browser.adblock", "Block ads, trackers and malware sites", v.adblock)}
      {toggle("browser.cosmetic", "Hide empty ad frames on pages", v.cosmetic, "Cosmetic filters")}
      {status && (
        <div className="muted browser__hint">
          {status.blocker.building ? "Building filters… " : ""}
          {status.blocker.ready ? `${status.blocker.rules.toLocaleString()} rules loaded` : "Filters loading"} ·{" "}
          {status.blockedTotal.toLocaleString()} requests blocked this session
          {status.blocker.lastError && <div className="browser__error">Last update: {status.blocker.lastError}</div>}
        </div>
      )}
      <ul className="browser__lists">
        {status?.lists.map((l) => (
          <li key={l.id}>
            <label className="check">
              <input type="checkbox" checked={v.lists.includes(l.id)} onChange={(e) => void toggleList(l.id, e.target.checked)} />
              <span>
                {l.name}
                <span className="muted browser__hint">
                  {l.purpose}
                  {l.downloaded ? ` · ${formatBytes(l.sizeBytes)}, ${formatRelative(l.updatedAt ? new Date(l.updatedAt * 1000) : null)}` : " · not downloaded"}
                </span>
              </span>
            </label>
          </li>
        ))}
      </ul>
      <button className="btn btn--sm" disabled={updating} onClick={() => void update()}>
        <RefreshCw size={12} className={updating ? "spin" : undefined} /> {updating ? "Updating…" : "Update lists now"}
      </button>

      <h3 className="label">Privacy</h3>
      <label className="browser__opt">
        <span>Tracking prevention</span>
        <select className="input" value={v.tracking} onChange={(e) => void save("browser.tracking", e.target.value as SettingsSchema["browser.tracking"])}>
          <option value="strict">Strict (blocks most trackers, may break some sites)</option>
          <option value="balanced">Balanced</option>
          <option value="basic">Basic</option>
        </select>
      </label>
      {toggle("browser.restore_tabs", "Reopen tabs from last time", v.restoreTabs, "Private tabs are never saved; restored tabs load when you open them")}
      {toggle("browser.https_only", "HTTPS-only: upgrade unencrypted connections", v.https, "Local network addresses are exempt")}
      {toggle("browser.gpc", "Send Global Privacy Control and Do Not Track", v.gpc)}
      {toggle("browser.autofill", "Offer to save passwords and form data", v.autofill, "Off: nothing typed into sites is stored by the browser")}
      {toggle("browser.webrtc_protect", "Hide local IP addresses from WebRTC", v.webrtc, "Applies after restarting NETRUNNER")}

      <h3 className="label">Site permissions</h3>
      <p className="muted browser__hint">Camera, microphone, location, notifications and similar requests are denied unless you allow them here or from the prompt bar.</p>
      {perms?.length === 0 && <div className="muted">No site has extra permissions.</div>}
      <ul className="browser__list">
        {perms?.map((p) => (
          <li key={`${p.host}-${p.kind}`}>
            <span className="mono truncate">{p.host}</span>
            <span className="tag">{p.kind}</span>
            <button
              className="icon-btn icon-btn--sm"
              title="Revoke"
              onClick={() => void api.browser.setPermission(p.host, p.kind, false).then(reloadPerms, (err) => reportError("Could not revoke", err))}
            >
              <Trash2 size={12} />
            </button>
          </li>
        ))}
      </ul>

      <h3 className="label">Extensions</h3>
      {toggle("browser.extensions", "Load unpacked extensions", v.extensions, "Applies after restarting NETRUNNER")}
      {status && (
        <div className="muted browser__hint">
          Folder: <span className="mono" data-selectable>{status.extensionsDir}</span>. Put each unpacked extension (for example uBlock Origin Lite)
          in its own subfolder. Extensions run with the permissions they request; install only ones you trust.
        </div>
      )}

      <h3 className="label">Data</h3>
      <button
        className="btn btn--sm btn--danger"
        onClick={async () => {
          const ok = await confirmAction({
            title: "Clear browsing data",
            message: "Delete cookies, cache, site storage and history of the NETRUNNER browser? You will be signed out of sites.",
            confirmLabel: "Clear everything",
            danger: true,
          });
          if (!ok) return;
          try {
            await api.browser.clearData();
            notify.success("Browsing data cleared");
          } catch (err) {
            reportError("Could not clear data", err);
          }
        }}
      >
        <Trash2 size={12} /> Clear cookies, cache and history
      </button>
    </div>
  );
}
