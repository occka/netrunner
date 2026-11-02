import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, CircleCheck, CircleDot, CircleX, ExternalLink, GitBranchPlus, GitPullRequest, Loader2, RefreshCw, Upload } from "lucide-react";
import { api } from "@/services/api";
import { confirmAction } from "@/stores/confirm";
import { notify, reportError } from "@/stores/notifications";
import { useShell } from "@/stores/shell";
import type { GhChecks, GhComment, GhOrigin, GhPrDetail, GhPrFile, GitHubIssue } from "@/types/dev";
import { useDev } from "./store";
import { languageFor } from "./languages";

const open = (url: string) => void api.app.openUrl(url);

export function ChecksIcon({ state, size = 12 }: { state: GhChecks["state"] | undefined; size?: number }) {
  if (state === "success") return <CircleCheck size={size} className="text-ok" />;
  if (state === "failure") return <CircleX size={size} className="text-crit" />;
  if (state === "pending") return <Loader2 size={size} className="spin text-warn" />;
  return <CircleDot size={size} className="muted" />;
}

function ChecksList({ checks }: { checks: GhChecks | null }) {
  if (!checks) return <div className="muted gh__note">Loading checks…</div>;
  if (!checks.checks.length) return <div className="muted gh__note">No CI checks for this commit.</div>;
  return (
    <div>
      {checks.checks.map((c, i) => (
        <button key={i} className="problems__item" onClick={() => c.url && open(c.url)} title={c.url ?? undefined}>
          <ChecksIcon state={c.status !== "completed" ? "pending" : c.conclusion === "success" || c.conclusion === "skipped" || c.conclusion === "neutral" ? "success" : "failure"} />
          <span className="truncate">{c.name}</span>
          <span className="muted">{c.conclusion ?? c.status}</span>
        </button>
      ))}
    </div>
  );
}

/** DEVELOPER ↔ GITHUB for the open project: publish, pull requests, CI, issues. */
export function GitHubPanel({ root }: { root: string }) {
  const revision = useDev((s) => s.revision);
  const [connected, setConnected] = useState<boolean | null>(null);
  const [origin, setOrigin] = useState<GhOrigin | null | undefined>(undefined);
  const [view, setView] = useState<"pulls" | "issues" | "new-pr">("pulls");
  const [pr, setPr] = useState<number | null>(null);

  const seq = useRef(0);
  const load = useCallback(async () => {
    const id = ++seq.current;
    const [st, o] = await Promise.all([api.github.status().catch(() => null), api.gh.origin(root).catch(() => null)]);
    // A slower answer for the previous project must not win.
    if (id !== seq.current) return;
    setConnected(!!st?.connected);
    setOrigin(o);
  }, [root]);
  useEffect(() => {
    setPr(null);
    void load();
  }, [load, revision]);

  if (connected === null || origin === undefined) return <div className="tree__loading label">Reading GitHub…</div>;
  if (!connected)
    return (
      <div className="dev-gh">
        <p className="muted gh__note">Connect GitHub in the GITHUB module to publish projects, open pull requests and see CI here.</p>
        <button className="btn btn--sm" onClick={() => useShell.getState().navigate("github")}>
          Open GITHUB
        </button>
      </div>
    );
  if (!origin) return <PublishForm root={root} onDone={() => void load()} />;
  if (pr !== null) return <PrDetailView root={root} origin={origin} number={pr} onBack={() => setPr(null)} />;

  return (
    <div className="dev-gh">
      <div className="tree__head">
        <span className="label truncate" title={`${origin.owner}/${origin.repo}`}>
          {origin.owner}/{origin.repo}
        </span>
        <button className="icon-btn icon-btn--sm" title="Open on GitHub" onClick={() => open(`https://github.com/${origin.owner}/${origin.repo}`)}>
          <ExternalLink size={12} />
        </button>
        <button className="icon-btn icon-btn--sm" title="Refresh" onClick={() => void load()}>
          <RefreshCw size={12} />
        </button>
      </div>
      <div className="segmented gh__tabs">
        <button aria-pressed={view === "pulls"} onClick={() => setView("pulls")}>
          Pull requests
        </button>
        <button aria-pressed={view === "issues"} onClick={() => setView("issues")}>
          Issues
        </button>
        <button aria-pressed={view === "new-pr"} onClick={() => setView("new-pr")} disabled={!origin.branch}>
          New PR
        </button>
      </div>
      {view === "pulls" && <IssueList origin={origin} pulls onPick={(n) => setPr(n)} root={root} />}
      {view === "issues" && <IssueList origin={origin} pulls={false} root={root} />}
      {view === "new-pr" && <NewPrForm root={root} origin={origin} onCreated={(n) => (setView("pulls"), setPr(n))} />}
    </div>
  );
}

function PublishForm({ root, onDone }: { root: string; onDone: () => void }) {
  const [name, setName] = useState(root.split(/[\\/]/).pop() ?? "");
  const [description, setDescription] = useState("");
  const [isPrivate, setPrivate] = useState(true);
  const [busy, setBusy] = useState(false);

  const publish = async () => {
    const ok = await confirmAction({
      title: "Publish to GitHub",
      message: `Create the ${isPrivate ? "private" : "PUBLIC"} repository "${name}" on your GitHub account and push this project to it?`,
      detail: isPrivate ? "Only you (and people you invite) can see a private repository." : "Anyone on the internet can see a public repository and its whole history.",
      confirmLabel: "Publish",
      danger: !isPrivate,
    });
    if (!ok) return;
    setBusy(true);
    try {
      const repo = await api.gh.publish(root, name.trim(), description, isPrivate);
      notify.success("Published", repo.html_url);
      useDev.getState().bump();
      onDone();
    } catch (err) {
      reportError("Could not publish", err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="dev-gh">
      <div className="tree__head">
        <span className="label">Publish to GitHub</span>
      </div>
      <p className="muted gh__note">This project has no GitHub remote. Publishing creates a repository on your account, adds it as origin and pushes the current branch.</p>
      <div className="gh__form">
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Repository name" />
        <input className="input" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Description (optional)" />
        <label className="check">
          <input type="checkbox" checked={isPrivate} onChange={(e) => setPrivate(e.target.checked)} /> Private
        </label>
        <button className="btn btn--primary btn--sm" disabled={!name.trim() || busy} onClick={() => void publish()}>
          <Upload size={12} /> {busy ? "Publishing…" : "Publish"}
        </button>
      </div>
    </div>
  );
}

function IssueList({ origin, pulls, root, onPick }: { origin: GhOrigin; pulls: boolean; root: string; onPick?: (n: number) => void }) {
  const [items, setItems] = useState<GitHubIssue[] | null>(null);
  const [closedToo, setClosedToo] = useState(false);
  const [checks, setChecks] = useState<Record<number, GhChecks["state"]>>({});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setItems(null);
    api.github
      .issues(origin.owner, origin.repo, pulls, closedToo ? "all" : "open")
      .then(async (list) => {
        if (!alive) return;
        setItems(list);
        if (!pulls) return;
        // CI state of the first open pull requests.
        for (const p of list.slice(0, 10)) {
          const d = await api.gh.pr(origin.owner, origin.repo, p.number).catch(() => null);
          const c = d ? await api.gh.checks(origin.owner, origin.repo, d.head.sha).catch(() => null) : null;
          if (alive && c) setChecks((m) => ({ ...m, [p.number]: c.state }));
        }
      })
      .catch((err) => alive && setError((err as { message?: string })?.message ?? String(err)));
    return () => {
      alive = false;
    };
  }, [origin.owner, origin.repo, pulls, closedToo]);

  const startWork = async (i: GitHubIssue) => {
    try {
      const branch = await api.gh.issueBranch(root, i.number, i.title);
      useDev.getState().bump();
      notify.success(`Switched to ${branch}`, `Work on #${i.number} here, then open a pull request.`);
    } catch (err) {
      reportError("Could not create the branch", err);
    }
  };

  const toggle = (
    <label className="check gh__note">
      <input type="checkbox" checked={closedToo} onChange={(e) => setClosedToo(e.target.checked)} /> Include closed
    </label>
  );
  if (error) return <p className="tools__note text-crit">{error}</p>;
  if (!items) return <div className="tree__loading label">Loading…</div>;
  if (!items.length)
    return (
      <>
        {toggle}
        <p className="muted gh__note">No {closedToo ? "" : "open "}{pulls ? "pull requests" : "issues"}.</p>
      </>
    );
  return (
    <div>
      {toggle}
      {items.map((i) => (
        <div key={i.number} className="gh__item">
          <button className="gh__item-main" onClick={() => (onPick ? onPick(i.number) : open(i.htmlUrl))} title={i.title}>
            {pulls && <ChecksIcon state={checks[i.number]} />}
            <span className="mono muted">#{i.number}</span>
            {i.state !== "open" && <span className="tag">{i.state}</span>}
            <span className="truncate">{i.title}</span>
          </button>
          <span className="muted gh__who">{i.user.login}</span>
          {!pulls && (
            <button className="btn btn--ghost btn--sm" title={`Create and switch to a branch for #${i.number}`} onClick={() => void startWork(i)}>
              <GitBranchPlus size={11} /> Start work
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

function NewPrForm({ root, origin, onCreated }: { root: string; origin: GhOrigin; onCreated: (n: number) => void }) {
  const [branches, setBranches] = useState<string[]>([]);
  const [base, setBase] = useState("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [draft, setDraft] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.github
      .branches(origin.owner, origin.repo)
      .then((b) => {
        setBranches(b);
        setBase((cur) => cur || (b.includes("main") ? "main" : b.includes("master") ? "master" : (b[0] ?? "")));
      })
      .catch(() => setBranches([]));
  }, [origin.owner, origin.repo]);

  useEffect(() => {
    if (!base) return;
    api.gh
      .commitsSince(root, base)
      .then((subjects) => {
        setTitle((t) => t || subjects.at(-1) || origin.branch || "");
        setBody((b) => b || subjects.map((s) => `- ${s}`).join("\n"));
      })
      .catch(() => undefined);
  }, [root, base, origin.branch]);

  const create = async () => {
    const ok = await confirmAction({
      title: "Create pull request",
      message: `Push ${origin.branch} and open a ${draft ? "draft " : ""}pull request into ${base} on ${origin.owner}/${origin.repo}?`,
      detail: "Pushing publishes the branch's commits; the pull request is visible to everyone who can see the repository.",
      confirmLabel: "Push and create",
    });
    if (!ok) return;
    setBusy(true);
    try {
      const pr = await api.gh.createPr(root, title, body, base, draft);
      notify.success(`Pull request #${pr.number} created`, pr.html_url);
      useDev.getState().bump();
      onCreated(pr.number);
    } catch (err) {
      reportError("Could not create the pull request", err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="gh__form">
      <div className="muted gh__note">
        <span className="mono">{origin.branch}</span> → base
      </div>
      <select className="input" value={base} onChange={(e) => setBase(e.target.value)}>
        {branches
          .filter((b) => b !== origin.branch)
          .map((b) => (
            <option key={b}>{b}</option>
          ))}
      </select>
      <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title" />
      <textarea className="textarea" rows={6} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Description" />
      <label className="check">
        <input type="checkbox" checked={draft} onChange={(e) => setDraft(e.target.checked)} /> Draft
      </label>
      <button className="btn btn--primary btn--sm" disabled={!title.trim() || !base || busy} onClick={() => void create()}>
        <GitPullRequest size={12} /> {busy ? "Creating…" : "Create pull request"}
      </button>
    </div>
  );
}

function PrDetailView({ root, origin, number, onBack }: { root: string; origin: GhOrigin; number: number; onBack: () => void }) {
  const [pr, setPr] = useState<GhPrDetail | null>(null);
  const [files, setFiles] = useState<GhPrFile[]>([]);
  const [checks, setChecks] = useState<GhChecks | null>(null);
  const [comments, setComments] = useState<GhComment[]>([]);
  const [draft, setDraft] = useState("");
  const { owner, repo } = origin;

  const load = useCallback(async () => {
    try {
      const d = await api.gh.pr(owner, repo, number);
      setPr(d);
      const [f, c] = await Promise.all([api.gh.prFiles(owner, repo, number), api.gh.comments(owner, repo, number)]);
      setFiles(f);
      setComments(c);
      setChecks(await api.gh.checks(owner, repo, d.head.sha).catch(() => ({ state: "none" as const, checks: [] })));
    } catch (err) {
      reportError("Could not load the pull request", err);
    }
  }, [owner, repo, number]);
  useEffect(() => void load(), [load]);

  const showDiff = async (f: GhPrFile) => {
    if (!pr) return;
    const text = (path: string, ref: string) =>
      api.github.file(owner, repo, path, ref).then(
        (x) => x.content ?? "",
        () => "",
      );
    const [original, modified] = await Promise.all([f.status === "added" ? "" : text(f.previous_filename ?? f.filename, pr.base.sha), f.status === "removed" ? "" : text(f.filename, pr.head.sha)]);
    useDev.getState().openTextDiff(`pr:${number}:${f.filename}`, `${f.filename.split("/").pop()} (#${number})`, `#${number}: ${f.filename}`, languageFor(f.filename), original, modified);
  };

  const checkout = async () => {
    try {
      const branch = await api.gh.checkoutPr(root, number);
      useDev.getState().bump();
      notify.success(`Checked out ${branch}`);
    } catch (err) {
      reportError("Could not check out the pull request", err);
    }
  };

  const comment = async () => {
    const ok = await confirmAction({ title: "Post comment", message: `Post this comment on #${number} as your GitHub account?`, detail: draft, confirmLabel: "Post" });
    if (!ok) return;
    try {
      await api.gh.addComment(owner, repo, number, draft);
      setDraft("");
      setComments(await api.gh.comments(owner, repo, number));
    } catch (err) {
      reportError("Could not post the comment", err);
    }
  };

  return (
    <div className="dev-gh">
      <div className="tree__head">
        <button className="icon-btn icon-btn--sm" title="Back" onClick={onBack}>
          <ArrowLeft size={12} />
        </button>
        <span className="label truncate">#{number}</span>
        {pr && (
          <button className="icon-btn icon-btn--sm" title="Open on GitHub" onClick={() => open(pr.html_url)}>
            <ExternalLink size={12} />
          </button>
        )}
      </div>
      {!pr ? (
        <div className="tree__loading label">Loading…</div>
      ) : (
        <>
          <div className="gh__pr-title">{pr.title}</div>
          <div className="muted gh__note">
            {pr.user.login} · <span className="mono">{pr.head.ref}</span> → <span className="mono">{pr.base.ref}</span>
            {pr.draft ? " · draft" : ""}
          </div>
          <div className="gh__actions">
            <button className="btn btn--sm" onClick={() => void checkout()} title={`Fetch into pr-${number} and switch to it`}>
              Checkout
            </button>
          </div>
          <div className="git__group-head label">
            Checks <ChecksIcon state={checks?.state} />
          </div>
          <ChecksList checks={checks} />
          <div className="git__group-head label">Files · {files.length}</div>
          {files.map((f) => (
            <button key={f.filename} className="problems__item" onClick={() => void showDiff(f)}>
              <span className="mono git-file__status">{f.status[0].toUpperCase()}</span>
              <span className="truncate">{f.filename}</span>
              <span className="muted mono">
                +{f.additions} −{f.deletions}
              </span>
            </button>
          ))}
          <div className="git__group-head label">Comments · {comments.length}</div>
          {comments.map((c) => (
            <div key={c.id} className="gh__comment">
              <div className="muted">
                {c.user.login} · {new Date(c.created_at).toLocaleString()}
              </div>
              <div className="gh__comment-body">{c.body}</div>
            </div>
          ))}
          <div className="gh__form">
            <textarea className="textarea" rows={3} value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Write a comment" />
            <button className="btn btn--sm" disabled={!draft.trim()} onClick={() => void comment()}>
              Comment
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/** CI state of the current branch, for the DEVELOPER header. */
export function CiBadge({ root }: { root: string }) {
  const revision = useDev((s) => s.revision);
  const [info, setInfo] = useState<{ origin: GhOrigin; checks: GhChecks } | null>(null);
  const [openList, setOpenList] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      if (document.hidden) return;
      const st = await api.github.status().catch(() => null);
      const origin = st?.connected ? await api.gh.origin(root).catch(() => null) : null;
      if (!origin?.branch) return alive && setInfo(null);
      const checks = await api.gh.checks(origin.owner, origin.repo, origin.branch).catch(() => null);
      if (alive) setInfo(checks ? { origin, checks } : null);
    };
    void load();
    const id = window.setInterval(() => void load(), 60_000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [root, revision]);

  if (!info || info.checks.state === "none") return null;
  return (
    <div className="ci-badge">
      <button className="icon-btn" title={`CI on ${info.origin.branch}: ${info.checks.state}`} onClick={() => setOpenList((v) => !v)}>
        <ChecksIcon state={info.checks.state} size={14} />
      </button>
      {openList && (
        <div className="ci-badge__list" onMouseLeave={() => setOpenList(false)}>
          <div className="label">
            CI · <span className="mono">{info.origin.branch}</span>
          </div>
          <ChecksList checks={info.checks} />
        </div>
      )}
    </div>
  );
}
