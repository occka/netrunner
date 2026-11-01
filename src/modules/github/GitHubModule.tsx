import { useEffect, useMemo, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { DownloadCloud, ExternalLink, GitPullRequest, HardDrive, KeyRound, Lock, LogOut, RefreshCw, Star, CircleDot, Unlink } from "lucide-react";
import { ModuleHeader } from "@/components/ModuleHeader";
import { Tabs } from "@/components/Tabs";
import { api } from "@/services/api";
import { usePolled } from "@/hooks/usePolled";
import { confirmAction } from "@/stores/confirm";
import { notify, reportError } from "@/stores/notifications";
import { refreshActivity } from "@/stores/activity";
import { CloneDialog } from "@/modules/developer/CloneDialog";
import { useDev } from "@/modules/developer/store";
import { openInDeveloper, RepoCode } from "./RepoCode";
import { formatRelative } from "@/utils/format";
import type { GitHubIssue, GitHubRepo } from "@/types/dev";

/** Opens a GitHub page in the default browser. */
function openExternal(url: string) {
  if (!/^https:\/\/github\.com\//.test(url)) return;
  api.app.openUrl(url).catch((e) => reportError("Could not open browser", e));
}

export default function GitHubModule() {
  const status = usePolled(() => api.github.status());

  return (
    <div className="module">
      <ModuleHeader
        id="github"
        subtitle={status.data?.user ? <span className="mono">Signed in as {status.data.user.login}</span> : undefined}
      >
        {status.data?.connected && (
          <button
            className="btn btn--ghost"
            onClick={async () => {
              if (!(await confirmAction({ title: "Disconnect GitHub", message: "Remove the stored token from Windows Credential Manager?", confirmLabel: "Disconnect", danger: true })))
                return;
              await api.github.disconnect().catch((e) => reportError("Could not disconnect", e));
              refreshActivity();
              void status.reload();
            }}
          >
            <LogOut size={14} /> Disconnect
          </button>
        )}
      </ModuleHeader>
      <div className="module__scroll">
        {status.loading && !status.data ? (
          <div className="label">Checking connection…</div>
        ) : !status.data?.connected ? (
          <Connect onConnected={() => void status.reload()} />
        ) : status.data.error ? (
          <div className="unavailable">
            {status.data.error}. Disconnect and connect again with a new token.
          </div>
        ) : (
          <Repos />
        )}
      </div>
    </div>
  );
}

function Connect({ onConnected }: { onConnected: () => void }) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const user = await api.github.connect(token);
      setToken("");
      notify.success(`Connected as ${user.login}`);
      refreshActivity();
      onConnected();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel gh-connect">
      <header className="panel__header">
        <h2 className="panel__title">Connect GitHub</h2>
      </header>
      <form className="panel__body gh-connect__body" onSubmit={(e) => void submit(e)}>
        <p>
          NETRUNNER uses a GitHub <b>personal access token</b>. Create a fine-grained token at GitHub → Settings → Developer
          settings → Personal access tokens, with read access to <i>Metadata</i>, <i>Contents</i>, <i>Issues</i> and{" "}
          <i>Pull requests</i> for the repositories you want to see.
        </p>
        <ul className="muted">
          <li>The token is checked against GitHub, then stored only in Windows Credential Manager (DPAPI).</li>
          <li>It is never written to the NETRUNNER database or shown again.</li>
          <li>Clone, pull and push use your Git installation's own credentials (Git Credential Manager).</li>
        </ul>
        <label className="field">
          <span className="label">Token</span>
          <input
            className="input input--mono"
            type="password"
            autoComplete="off"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="github_pat_…"
          />
        </label>
        {error && <div className="field__error">{error}</div>}
        <div>
          <button className="btn btn--primary" type="submit" disabled={busy || token.trim().length < 20}>
            <KeyRound size={14} /> {busy ? "Verifying…" : "Connect"}
          </button>
        </div>
      </form>
    </section>
  );
}

function Repos() {
  const repos = usePolled(() => api.github.repos());
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<GitHubRepo | null>(null);
  const [cloneUrl, setCloneUrl] = useState<string | null>(null);
  const clones = usePolled(() => api.github.localClones());
  const projects = useDev((s) => s.projects);

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return (repos.data ?? []).filter((r) => !q || r.fullName.toLowerCase().includes(q) || (r.description ?? "").toLowerCase().includes(q));
  }, [repos.data, filter]);

  useEffect(() => {
    if (!selected && visible[0]) setSelected(visible[0]);
  }, [visible, selected]);

  return (
    <div className="gh">
      <div className="gh-list">
        <div className="toolbar">
          <input className="input" placeholder="Filter repositories…" value={filter} onChange={(e) => setFilter(e.target.value)} />
          <button className="icon-btn" title="Refresh" onClick={() => void repos.reload()}>
            <RefreshCw size={14} className={repos.loading ? "spin" : undefined} />
          </button>
        </div>
        {repos.error && <div className="unavailable">{repos.error}</div>}
        {visible.map((r) => (
          <button key={r.fullName} className="gh-repo" aria-selected={selected?.fullName === r.fullName} onClick={() => setSelected(r)}>
            <div className="gh-repo__name">
              {r.private && <Lock size={11} />}
              <span className="truncate">{r.fullName}</span>
            </div>
            <div className="gh-repo__meta muted">
              {localClone(r, clones.data, projects) && (
                <span title="Cloned on this computer">
                  <HardDrive size={10} /> local
                </span>
              )}
              {r.language && <span>{r.language}</span>}
              <span>
                <Star size={10} /> {r.stargazersCount}
              </span>
              {r.pushedAt && <span>pushed {formatRelative(new Date(r.pushedAt))}</span>}
            </div>
          </button>
        ))}
      </div>
      {selected && (
        <RepoDetail
          repo={selected}
          local={localClone(selected, clones.data, projects)}
          scanning={clones.loading}
          onRescan={() => void clones.reload()}
          onClone={() => setCloneUrl(selected.cloneUrl)}
        />
      )}
      {cloneUrl && (
        <CloneDialog
          initialUrl={cloneUrl}
          onClose={() => {
            setCloneUrl(null);
            void clones.reload();
          }}
        />
      )}
    </div>
  );
}

/** The local clone of a repository: linked or found by the scan, else an open project with the same folder name. */
function localClone(repo: GitHubRepo, clones: Record<string, string> | null, projects: string[]): string | null {
  const found = clones?.[repo.fullName.toLowerCase()];
  if (found) return found;
  return projects.find((p) => p.toLowerCase().endsWith(`\\${repo.name.toLowerCase()}`)) ?? null;
}

function RepoDetail({
  repo,
  local,
  scanning,
  onRescan,
  onClone,
}: {
  repo: GitHubRepo;
  local: string | null;
  scanning: boolean;
  onRescan: () => void;
  onClone: () => void;
}) {
  const [tab, setTab] = useState<"code" | "pulls" | "issues">("code");
  const [owner, name] = repo.fullName.split("/");
  const items = usePolled(() => (tab === "code" ? Promise.resolve([]) : api.github.issues(owner, name, tab === "pulls")), 0);
  const { reload } = items;

  // usePolled loads on mount; reload when the repository or tab changes.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    void reload();
  }, [repo.fullName, tab, reload]);

  const link = async () => {
    const path = await openDialog({ title: `Folder with your clone of ${repo.fullName}`, directory: true, multiple: false });
    if (typeof path !== "string") return;
    try {
      await api.github.linkLocal(repo.fullName, path);
      onRescan();
    } catch (err) {
      reportError("Could not link the folder", err);
    }
  };

  return (
    <section className="panel gh-detail">
      <header className="panel__header">
        <h2 className="panel__title truncate">{repo.fullName}</h2>
        <div className="panel__actions">
          <button className="btn btn--sm btn--ghost" onClick={() => openExternal(repo.htmlUrl)}>
            <ExternalLink size={12} /> GitHub
          </button>
          <button className="icon-btn icon-btn--sm" title="Look for local clones again" onClick={onRescan}>
            <RefreshCw size={12} className={scanning ? "spin" : undefined} />
          </button>
          {local ? (
            <button className="btn btn--sm btn--primary" onClick={() => void openInDeveloper(local)}>
              Open in Developer
            </button>
          ) : (
            <button className="btn btn--sm btn--primary" onClick={onClone}>
              <DownloadCloud size={12} /> Clone
            </button>
          )}
        </div>
      </header>
      <div className="panel__body">
        {repo.description && <p className="gh-detail__desc">{repo.description}</p>}
        <div className="gh-detail__tags">
          {local ? (
            <span className="tag tag--info gh-local" title="Local clone">
              <HardDrive size={10} /> {local}
              <button
                className="icon-btn icon-btn--sm"
                title="Forget a folder linked by hand"
                onClick={() => void api.github.linkLocal(repo.fullName, null).then(onRescan, (e) => reportError("Could not unlink", e))}
              >
                <Unlink size={10} />
              </button>
            </span>
          ) : (
            <span className="tag">{scanning ? "Looking for a local clone…" : "Not cloned on this computer"}</span>
          )}
          {repo.private && <span className="tag">Private</span>}
          {repo.fork && <span className="tag">Fork</span>}
          {repo.defaultBranch && <span className="tag tag--info">{repo.defaultBranch}</span>}
        </div>
        <Tabs
          tabs={[
            { id: "code", label: "Code" },
            { id: "pulls", label: "Pull requests" },
            { id: "issues", label: "Issues" },
          ]}
          value={tab}
          onChange={setTab}
        />
        {tab === "code" && <RepoCode repo={repo} local={local} onLink={() => void link()} />}
        {tab !== "code" && items.error && <div className="unavailable">{items.error}</div>}
        {tab !== "code" && items.loading && <div className="label">Loading…</div>}
        {tab !== "code" && !items.loading && items.data?.length === 0 && (
          <div className="empty">No open {tab === "pulls" ? "pull requests" : "issues"}.</div>
        )}
        <div className="gh-items" hidden={tab === "code"}>
          {items.data?.map((i: GitHubIssue) => (
            <button key={i.number} className="gh-item" onClick={() => openExternal(i.htmlUrl)} title="Open on GitHub">
              {tab === "pulls" ? <GitPullRequest size={13} className="gh-item__icon" /> : <CircleDot size={13} className="gh-item__icon" />}
              <span className="mono muted">#{i.number}</span>
              <span className="truncate">{i.title}</span>
              {i.draft && <span className="tag">Draft</span>}
              <span className="muted gh-item__meta">
                {i.user.login} · {formatRelative(new Date(i.updatedAt))}
              </span>
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}
