import { useCallback, useEffect, useState } from "react";
import { ArrowDown, ArrowUp, GitBranch, GitCommitHorizontal, Minus, Plus, RefreshCw, Undo2 } from "lucide-react";
import { api } from "@/services/api";
import { confirmAction } from "@/stores/confirm";
import { promptText } from "@/stores/prompt";
import { notify, reportError } from "@/stores/notifications";
import { refreshActivity } from "@/stores/activity";
import { formatRelative } from "@/utils/format";
import { useDev } from "./store";
import type { Commit, GitFile, RepoStatus } from "@/types/dev";

const LABEL: Record<string, string> = { M: "Modified", A: "Added", D: "Deleted", R: "Renamed", C: "Copied", U: "Conflict", "?": "Untracked" };

export function GitPanel({ root }: { root: string }) {
  const revision = useDev((s) => s.revision);
  const openDiff = useDev((s) => s.openDiff);
  const [status, setStatus] = useState<RepoStatus | null>(null);
  const [branches, setBranches] = useState<string[]>([]);
  const [log, setLog] = useState<Commit[]>([]);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const s = await api.git.status(root);
      setStatus(s);
      setError(null);
      if (s.isRepo) {
        const [b, l] = await Promise.all([api.git.branches(root), api.git.log(root, 30)]);
        setBranches(b);
        setLog(l);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [root]);

  useEffect(() => {
    void refresh();
    const id = window.setInterval(() => !document.hidden && void refresh(), 6000);
    return () => window.clearInterval(id);
  }, [refresh, revision]);

  const run = async (label: string, fn: () => Promise<unknown>, success?: string) => {
    setBusy(label);
    try {
      await fn();
      if (success) notify.success(success);
      refreshActivity();
    } catch (err) {
      reportError(`${label} failed`, err);
    } finally {
      setBusy(null);
      await refresh();
      useDev.getState().bump();
    }
  };

  if (error) return <div className="unavailable">{error}</div>;
  if (!status) return <div className="tree__loading label">Reading repository…</div>;
  if (!status.isRepo)
    return (
      <div className="empty">
        <GitBranch size={22} />
        <div>This project is not a Git repository.</div>
        <button className="btn btn--sm" onClick={() => void run("git init", () => api.git.init(root), "Repository initialised")}>
          Initialise repository
        </button>
      </div>
    );

  const staged = status.files.filter((f) => f.index !== "." && f.index !== "?");
  const unstaged = status.files.filter((f) => f.worktree !== "." && f.worktree !== "?");
  const untracked = status.files.filter((f) => f.worktree === "?");

  const commit = () =>
    run(
      "Commit",
      async () => {
        const hash = await api.git.commit(root, message);
        setMessage("");
        notify.success(`Committed ${hash}`);
      },
    );

  const push = async () => {
    const ok = await confirmAction({
      title: "Push commits",
      message: `Push ${status.ahead || "local"} commit(s) on ${status.branch ?? "this branch"} to ${status.upstream ?? "origin"}?`,
      detail: "Pushing publishes these commits to the remote repository. Review them in the history first.",
      confirmLabel: "Push",
    });
    if (ok) await run("Push", () => api.git.push(root), "Pushed");
  };

  const switchBranch = async (branch: string) => {
    if (branch === "__new__") {
      const name = await promptText({ title: "New branch", label: "Branch name", placeholder: "feature/my-change", confirmLabel: "Create & switch" });
      if (name) await run("Create branch", () => api.git.createBranch(root, name), `Switched to new branch ${name}`);
      return;
    }
    if (status.files.some((f) => f.worktree !== "?") && !(await confirmAction({ title: "Switch branch", message: `Switch to ${branch} with uncommitted changes? Git refuses if they would be overwritten.`, confirmLabel: "Switch" })))
      return;
    await run("Switch branch", () => api.git.checkout(root, branch), `Switched to ${branch}`);
  };

  const discard = async (f: GitFile) => {
    const untrackedFile = f.worktree === "?";
    const ok = await confirmAction({
      title: untrackedFile ? "Delete untracked file" : "Discard changes",
      message: untrackedFile ? `Move untracked "${f.path}" to the Recycle Bin?` : `Discard all unstaged changes in "${f.path}"?`,
      detail: untrackedFile ? undefined : "This cannot be undone.",
      confirmLabel: untrackedFile ? "Move to Recycle Bin" : "Discard",
      danger: true,
    });
    if (ok) await run("Discard", () => api.git.discard(root, f.path, untrackedFile));
  };

  const fileRow = (f: GitFile, group: "staged" | "unstaged" | "untracked") => {
    const code = group === "staged" ? f.index : f.worktree;
    return (
      <div key={`${group}:${f.path}`} className="git-file" onClick={() => group !== "untracked" && void openDiff(f.path, group === "staged")} title={f.origPath ? `${f.origPath} → ${f.path}` : f.path}>
        <span className={`git-file__code git-file__code--${code === "?" ? "u" : code.toLowerCase()}`} title={LABEL[code] ?? code}>
          {code === "?" ? "U" : code}
        </span>
        <span className="truncate">{f.path}</span>
        <span className="git-file__actions" onClick={(e) => e.stopPropagation()}>
          {group !== "staged" && (
            <button className="icon-btn icon-btn--sm" title="Discard" onClick={() => void discard(f)}>
              <Undo2 size={12} />
            </button>
          )}
          {group === "staged" ? (
            <button className="icon-btn icon-btn--sm" title="Unstage" onClick={() => void run("Unstage", () => api.git.unstage(root, [f.path]))}>
              <Minus size={12} />
            </button>
          ) : (
            <button className="icon-btn icon-btn--sm" title="Stage" onClick={() => void run("Stage", () => api.git.stage(root, [f.path]))}>
              <Plus size={12} />
            </button>
          )}
        </span>
      </div>
    );
  };

  return (
    <div className="git">
      <div className="git__branch">
        <GitBranch size={13} />
        <select className="select" value={status.branch ?? ""} onChange={(e) => void switchBranch(e.target.value)} disabled={!!busy}>
          {!status.branch && <option value="">(detached HEAD)</option>}
          {branches.map((b) => (
            <option key={b} value={b}>
              {b}
            </option>
          ))}
          <option value="__new__">+ New branch…</option>
        </select>
        <button className="icon-btn icon-btn--sm" title="Refresh" onClick={() => void refresh()}>
          <RefreshCw size={12} className={busy ? "spin" : undefined} />
        </button>
      </div>
      <div className="git__sync">
        <button className="btn btn--sm" disabled={!!busy || !status.upstream} onClick={() => void run("Pull", () => api.git.pull(root), "Pulled")} title={status.upstream ? `Fast-forward from ${status.upstream}` : "No upstream branch"}>
          <ArrowDown size={11} /> Pull {status.behind > 0 && <span className="mono">{status.behind}</span>}
        </button>
        <button className="btn btn--sm" disabled={!!busy} onClick={() => void push()}>
          <ArrowUp size={11} /> Push {status.ahead > 0 && <span className="mono">{status.ahead}</span>}
        </button>
        {busy && <span className="label muted">{busy}…</span>}
      </div>

      <div className="git__commit">
        <textarea
          className="textarea"
          placeholder={`Commit message (Ctrl+Enter) · ${staged.length} staged`}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && e.ctrlKey && staged.length && message.trim()) void commit();
          }}
        />
        <button className="btn btn--primary btn--sm" disabled={!staged.length || !message.trim() || !!busy} onClick={() => void commit()}>
          <GitCommitHorizontal size={12} /> Commit
        </button>
      </div>

      <div className="git__groups">
        {staged.length > 0 && (
          <section>
            <div className="git__group-head label">
              Staged · {staged.length}
              <button className="btn btn--ghost btn--sm" onClick={() => void run("Unstage", () => api.git.unstage(root, staged.map((f) => f.path)))}>
                Unstage all
              </button>
            </div>
            {staged.map((f) => fileRow(f, "staged"))}
          </section>
        )}
        <section>
          <div className="git__group-head label">
            Changes · {unstaged.length + untracked.length}
            {unstaged.length + untracked.length > 0 && (
              <button className="btn btn--ghost btn--sm" onClick={() => void run("Stage", () => api.git.stage(root, [...unstaged, ...untracked].map((f) => f.path)))}>
                Stage all
              </button>
            )}
          </div>
          {unstaged.map((f) => fileRow(f, "unstaged"))}
          {untracked.map((f) => fileRow(f, "untracked"))}
          {unstaged.length + untracked.length === 0 && <div className="muted git__clean">Working tree clean</div>}
        </section>
        <section>
          <div className="git__group-head label">History</div>
          {log.map((c) => (
            <div key={c.hash} className="git-commit" title={`${c.hash} · ${c.author} · ${c.date}`}>
              <span className="mono git-commit__hash">{c.hash}</span>
              <span className="truncate">{c.subject}</span>
              <span className="muted git-commit__when">{formatRelative(new Date(c.date))}</span>
            </div>
          ))}
          {log.length === 0 && <div className="muted git__clean">No commits yet</div>}
        </section>
      </div>
    </div>
  );
}
