import { useState } from "react";
import { Cookie as CookieIcon, FolderOpen, Globe, RefreshCw, RotateCcw, Trash2, VenetianMask, X } from "lucide-react";
import { api } from "@/services/api";
import { usePolled } from "@/hooks/usePolled";
import { useSetting, useSettings, type SettingKey, type SettingsSchema } from "@/stores/settings";
import { confirmAction } from "@/stores/confirm";
import { notify, reportError } from "@/stores/notifications";
import { formatBytes, formatRelative, parseDbTime } from "@/utils/format";
import { stripTabs, useBrowser } from "./store";

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

/** Finds an open tab by title or address, and brings closed ones back. */
export function TabsPanel() {
  const { tabs, sleeping, order, closed, groups, members, activeId, activate, close, reopen, addGroup, setGroup, renameGroup, removeGroup } = useBrowser();
  const [query, setQuery] = useState("");
  const [groupName, setGroupName] = useState("");
  const q = query.trim().toLowerCase();
  const matches = (t: { title: string; url: string }) => !q || t.title.toLowerCase().includes(q) || t.url.toLowerCase().includes(q);
  const open = stripTabs({ tabs, sleeping, order }).filter(matches);
  const shownClosed = closed.map((t, i) => ({ ...t, i })).filter(matches);

  return (
    <div className="browser__panel-stack">
      <input
        className="input"
        autoFocus
        placeholder="Search tabs"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && open[0]) activate(open[0].id);
        }}
      />
      <h3 className="label">Open ({open.length})</h3>
      <ul className="browser__list">
        {open.map((t) => (
          <li key={t.id}>
            {t.private ? <VenetianMask size={12} /> : t.favicon ? <img src={t.favicon} alt="" width={12} height={12} /> : <Globe size={12} />}
            <button className="link-btn truncate" title={t.url} onClick={() => activate(t.id)}>
              {t.title || t.url}
            </button>
            {groups.length > 0 && (
              <select className="select browser__group-pick" title="Group of this tab" value={members[t.id] ?? ""} onChange={(e) => setGroup(t.id, e.target.value || null)}>
                <option value="">No group</option>
                {groups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </select>
            )}
            <button className="icon-btn icon-btn--sm" title="Close tab" onClick={() => void close(t.id)}>
              <X size={12} />
            </button>
          </li>
        ))}
      </ul>
      <h3 className="label">Groups</h3>
      {groups.map((g) => (
        <div key={g.id} className="browser__site">
          <span className="browser__group-dot" style={{ background: g.color }} />
          <input className="input" aria-label="Group name" value={g.name} onChange={(e) => renameGroup(g.id, e.target.value)} />
          <button className="icon-btn icon-btn--sm" title="End the group: its tabs stay open" onClick={() => removeGroup(g.id)}>
            <X size={12} />
          </button>
        </div>
      ))}
      <form
        className="browser__site"
        onSubmit={(e) => {
          e.preventDefault();
          if (!activeId) return;
          addGroup(groupName, activeId);
          setGroupName("");
        }}
      >
        <input className="input" placeholder="New group name" value={groupName} onChange={(e) => setGroupName(e.target.value)} />
        <button className="btn btn--sm" type="submit" disabled={!activeId} title="Creates a group with the current tab in it">
          Group this tab
        </button>
      </form>
      {closed.length > 0 && (
        <>
          <h3 className="label">Recently closed</h3>
          <ul className="browser__list">
            {shownClosed.map((t) => (
              <li key={`${t.i}-${t.url}`}>
                <RotateCcw size={12} className="muted" />
                <button className="link-btn truncate" title={`${t.url}\nCtrl+Shift+T opens the latest`} onClick={() => void reopen(t.i)}>
                  {t.title || t.url}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

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
          {d.state === "running" && d.total != null && d.total > 0 ? (
            <progress className="browser__progress" value={d.received} max={d.total} title={`${formatBytes(d.received)} of ${formatBytes(d.total)}`} />
          ) : (
            d.state === "running" && d.received > 0 && <span className="muted mono">{formatBytes(d.received)}</span>
          )}
          <span className={`tag ${d.state === "done" ? "tag--ok" : d.state === "failed" ? "tag--crit" : "tag--info"}`}>{d.state}</span>
          {d.state === "running" && (
            <button className="icon-btn icon-btn--sm" title="Cancel download" onClick={() => void api.browser.cancelDownload(d.url).catch((err) => reportError("Could not cancel", err))}>
              <X size={12} />
            </button>
          )}
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

/** How pages look: dark mode, accent colour and, per site, transparency. */
export function AppearancePanel({ site }: { site: string }) {
  const dark = useSetting("browser.page_dark");
  const accent = useSetting("browser.page_accent");
  const accentOff = useSetting("browser.page_accent_off");
  const transparent = useSetting("browser.page_transparent");
  const tint = useSetting("browser.page_tint");
  // The dark mode that WebView2 was started with: "All sites" takes effect at the next start.
  const [startedForce] = useState(dark === "force");
  const isClear = !!site && transparent.includes(site);
  const isPlain = !!site && accentOff.includes(site);
  const flip = (list: string[], on: boolean) => (on ? [...list, site] : list.filter((s) => s !== site));

  return (
    <div className="browser__panel-stack">
      <h3 className="label">Dark pages</h3>
      <div className="segmented">
        {(
          [
            ["off", "Off"],
            ["prefer", "Dark sites"],
            ["force", "All sites"],
          ] as const
        ).map(([v, label]) => (
          <button key={v} aria-pressed={dark === v} onClick={() => void save("browser.page_dark", v)}>
            {label}
          </button>
        ))}
      </div>
      <p className="muted browser__hint">
        Dark sites: pages that have their own dark theme use it. All sites: the browser also darkens the rest, sometimes with odd colours.
      </p>
      {(dark === "force") !== startedForce && <p className="browser__hint browser__notice">Restart NETRUNNER to {dark === "force" ? "turn on" : "turn off"} All sites.</p>}

      <h3 className="label">Accent</h3>
      <label className="check browser__opt">
        <input type="checkbox" checked={accent} onChange={(e) => void save("browser.page_accent", e.target.checked)} />
        <span>
          Theme colour for scrollbars, selection, checkboxes and sliders
          <span className="muted browser__hint">Works on nearly every site. It changes only how the page looks here.</span>
        </span>
      </label>
      {site && accent && (
        <label className="check browser__opt">
          <input type="checkbox" checked={isPlain} onChange={(e) => void save("browser.page_accent_off", flip(accentOff, e.target.checked))} />
          <span>
            Not on <span className="mono">{site}</span>
          </span>
        </label>
      )}

      <h3 className="label">Transparency (experimental)</h3>
      {site ? (
        <label className="check browser__opt">
          <input type="checkbox" checked={isClear} onChange={(e) => void save("browser.page_transparent", flip(transparent, e.target.checked))} />
          <span>
            Show NETRUNNER's background behind <span className="mono">{site}</span>
            <span className="muted browser__hint">Sites paint their own blocks, so it works on some sites and only partly on others. Text can get harder to read.</span>
          </span>
        </label>
      ) : (
        <p className="muted browser__hint">Open a site to turn this on for it.</p>
      )}
      <label className="browser__range">
        <span>Dark layer over the background: {tint}%</span>
        <input type="range" min={0} max={100} step={5} value={tint} onChange={(e) => void save("browser.page_tint", Number(e.target.value))} />
      </label>
      {transparent.length > 0 && (
        <ul className="browser__lists">
          {transparent.map((s) => (
            <li key={s} className="browser__site">
              <span className="mono truncate">{s}</span>
              <button className="btn btn--sm btn--ghost" onClick={() => void save("browser.page_transparent", transparent.filter((x) => x !== s))}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Logins for this site, kept in Windows Credential Manager. The password box is
 * NETRUNNER's own: pages cannot see it, and they can never trigger a fill.
 */
function SiteLogins({ site, tabId }: { site: string; tabId: string }) {
  const { data, reload } = usePolled(() => api.browser.logins(), 0);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const mine = (data ?? []).filter((l) => l.host === site);
  return (
    <>
      <h3 className="label">Logins for {site}</h3>
      <ul className="browser__list">
        {mine.map((l) => (
          <li key={l.username}>
            <span className="mono truncate">{l.username || "(no user name)"}</span>
            <button className="btn btn--sm" title="Fill the login form on this page" onClick={() => void api.browser.loginFill(tabId, l.username).catch((err) => reportError("Could not fill the login", err))}>
              Fill
            </button>
            <button
              className="icon-btn icon-btn--sm"
              title="Delete this login"
              onClick={async () => {
                if (await confirmAction({ title: "Delete login", message: `Delete the saved login "${l.username}" for ${site}?`, confirmLabel: "Delete", danger: true }))
                  await api.browser.loginDelete(site, l.username).then(reload, (err) => reportError("Could not delete the login", err));
              }}
            >
              <Trash2 size={12} />
            </button>
          </li>
        ))}
      </ul>
      <form
        className="browser__panel-stack"
        onSubmit={(e) => {
          e.preventDefault();
          void api.browser.loginSave(site, username.trim(), password).then(
            () => {
              setUsername("");
              setPassword("");
              return reload();
            },
            (err) => reportError("Could not save the login", err),
          );
        }}
      >
        <input className="input" placeholder="User name" autoComplete="off" spellCheck={false} value={username} onChange={(e) => setUsername(e.target.value)} />
        <input className="input" type="password" placeholder="Password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        <button className="btn btn--sm" type="submit" disabled={!password}>
          Save login for {site}
        </button>
      </form>
    </>
  );
}

/** What the current site has stored. Values are not shown: they are often login tokens. */
function SiteCookies({ tabId }: { tabId: string }) {
  const { data, reload } = usePolled(() => api.browser.cookies(tabId), 0);
  const remove = async (list: NonNullable<typeof data>) => {
    try {
      await Promise.all(list.map((c) => api.browser.deleteCookie(tabId, c)));
      window.setTimeout(() => void reload(), 200);
    } catch (err) {
      reportError("Could not delete the cookie", err);
    }
  };
  return (
    <>
      <h3 className="label">
        <CookieIcon size={11} /> Cookies on this page ({data?.length ?? 0})
      </h3>
      {data && data.length > 0 ? (
        <>
          <ul className="browser__list">
            {data.map((c) => (
              <li key={`${c.domain}${c.path}${c.name}`} title={`${c.domain}${c.path}${c.secure ? " · secure" : ""}${c.httpOnly ? " · hidden from scripts" : ""}`}>
                <span className="mono truncate">{c.name}</span>
                <span className="muted truncate">{c.domain}</span>
                <span className="muted">{c.expires == null ? "session" : new Date(c.expires * 1000).toLocaleDateString()}</span>
                <button className="icon-btn icon-btn--sm" title="Delete this cookie" onClick={() => void remove([c])}>
                  <Trash2 size={12} />
                </button>
              </li>
            ))}
          </ul>
          <button className="btn btn--sm btn--ghost" onClick={() => void remove(data)}>
            <Trash2 size={12} /> Delete all of these
          </button>
        </>
      ) : (
        <p className="muted browser__hint">None.</p>
      )}
    </>
  );
}

export function PrivacyPanel({ site, tabId }: { site: string; tabId: string | null }) {
  const { data: status, reload } = usePolled(() => api.browser.status(), 3000);
  const { data: perms, reload: reloadPerms } = usePolled(() => api.browser.permissions());
  const [updating, setUpdating] = useState(false);
  const v = {
    adblock: useSetting("browser.adblock"),
    cosmetic: useSetting("browser.cosmetic"),
    youtube: useSetting("browser.youtube_ads"),
    noScript: useSetting("browser.no_script"),
    noAutoplay: useSetting("browser.no_autoplay"),
    passwords: useSetting("browser.passwords"),
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
      {site && tabId && (
        <label className="check browser__opt">
          <input
            type="checkbox"
            checked={v.noScript.includes(site)}
            onChange={(e) =>
              void save("browser.no_script", e.target.checked ? [...v.noScript, site] : v.noScript.filter((s) => s !== site)).then(() =>
                api.browser.action(tabId, "reload").catch(() => undefined),
              )
            }
          />
          <span>
            Turn JavaScript off on <span className="mono">{site}</span>
            <span className="muted browser__hint">Safer and quieter, but many sites stop working. The page reloads.</span>
          </span>
        </label>
      )}
      {site && (
        <label className="check browser__opt">
          <input
            type="checkbox"
            checked={v.noAutoplay.includes(site)}
            onChange={(e) => void save("browser.no_autoplay", e.target.checked ? [...v.noAutoplay, site] : v.noAutoplay.filter((s) => s !== site))}
          />
          <span>
            Stop sound and video starting by themselves on <span className="mono">{site}</span>
            <span className="muted browser__hint">Until you click on the page. Applies to the next tab you open.</span>
          </span>
        </label>
      )}
      {tabId && <SiteCookies key={`${tabId}${site}`} tabId={tabId} />}
      {toggle("browser.passwords", "Saved logins", v.passwords, "Kept in Windows Credential Manager. Filled only when you click Fill, only on the exact site they were saved for, only over HTTPS.")}
      {v.passwords && site && tabId && <SiteLogins key={site} site={site} tabId={tabId} />}

      <h3 className="label">Blocking</h3>
      {toggle("browser.adblock", "Block ads, trackers and malware sites", v.adblock)}
      {toggle("browser.cosmetic", "Hide empty ad frames on pages", v.cosmetic, "Cosmetic filters")}
      {toggle("browser.youtube_ads", "Remove ads on YouTube", v.youtube, "Applies to the next tab you open. Turn it off if YouTube misbehaves. YouTube changes often, so an ad can still slip through.")}
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
