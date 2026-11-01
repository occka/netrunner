import { useCallback, useEffect, useState } from "react";
import { Archive, Copy, GitCompare as CompareIcon, GitPullRequestArrow } from "lucide-react";
import { api } from "@/services/api";
import { confirmAction } from "@/stores/confirm";
import { notify } from "@/stores/notifications";
import { useContextMenu } from "@/components/ContextMenu";
import type { ChangedFile, GitStash, GraphRow } from "@/types/dev";
import { useDev } from "./store";
import { languageFor } from "./languages";

type Run = (label: string, fn: () => Promise<unknown>, success?: string) => Promise<void>;

/** Commit graph of all branches; a commit's menu copies its hash or cherry-picks it. */
export function GitHistory({ root, branch, run }: { root: string; branch: string | null; run: Run }) {
  const revision = useDev((s) => s.revision);
  const [rows, setRows] = useState<GraphRow[]>([]);
  useEffect(() => {
    api.git
      .graph(root, 150)
      .then(setRows)
      .catch(() => setRows([]));
  }, [root, revision]);

  const menu = (e: React.MouseEvent, r: GraphRow) => {
    if (!r.hash) return;
    e.preventDefault();
    const hash = r.hash;
    useContextMenu.getState().open(e.clientX, e.clientY, [
      { id: "copy", label: "Copy hash", icon: Copy, run: () => navigator.clipboard.writeText(hash).then(() => notify.info("Hash copied", hash)) },
      {
        id: "pick",
        label: `Cherry-pick onto ${branch ?? "the current branch"}`,
        icon: GitPullRequestArrow,
        run: async () => {
          const ok = await confirmAction({
            title: "Cherry-pick",
            message: `Apply commit ${hash} ("${r.subject}") onto ${branch ?? "the current branch"} as a new commit?`,
            detail: "If it conflicts, Git stops and marks the conflicts in the files; resolve them in the editor, then commit.",
            confirmLabel: "Cherry-pick",
          });
          if (ok) await run("Cherry-pick", () => api.git.cherryPick(root, hash), `Cherry-picked ${hash}`);
        },
      },
    ]);
  };

  return (
    <section>
      <div className="git__group-head label">History</div>
      <div className="git-graph">
        {rows.map((r, i) => (
          <div key={i} className="git-graph__row" onContextMenu={(e) => menu(e, r)} onClick={(e) => menu(e, r)} title={r.hash ? `${r.hash} · ${r.author} · ${r.date}` : undefined}>
            <span className="git-graph__lines mono">{r.graph}</span>
            {r.hash && <span className="mono git-commit__hash">{r.hash}</span>}
            {r.refs && <span className="git-graph__refs">{r.refs}</span>}
            <span className="truncate">{r.subject}</span>
          </div>
        ))}
        {!rows.length && <div className="muted git__clean">No commits yet</div>}
      </div>
    </section>
  );
}

/** Files changed on one branch since it left another; click for a diff. */
export function GitCompare({ root, branches, current }: { root: string; branches: string[]; current: string | null }) {
  const defaultBase = branches.find((b) => b === "main") ?? branches.find((b) => b === "master") ?? branches[0] ?? "";
  const [base, setBase] = useState(defaultBase);
  const [head, setHead] = useState(current ?? "");
  const [files, setFiles] = useState<ChangedFile[] | null>(null);
  const [open, setOpen] = useState(false);

  const compare = async () => {
    try {
      setFiles(await api.git.compare(root, base, head));
    } catch (err) {
      notify.error("Could not compare branches", (err as { message?: string })?.message ?? String(err));
    }
  };

  const showFile = async (f: ChangedFile) => {
    const [original, modified] = await Promise.all([api.git.fileAt(root, base, f.path), api.git.fileAt(root, head, f.path)]);
    useDev.getState().openTextDiff(`branches:${base}...${head}:${f.path}`, `${f.path.split("/").pop()} (${base} ↔ ${head})`, `${base} ↔ ${head}: ${f.path}`, languageFor(f.path), original, modified);
  };

  return (
    <section>
      <div className="git__group-head label">
        Compare branches
        <button className="btn btn--ghost btn--sm" onClick={() => setOpen((v) => !v)}>
          <CompareIcon size={11} /> {open ? "Hide" : "Compare…"}
        </button>
      </div>
      {open && (
        <div className="git-compare">
          <select className="input" value={base} onChange={(e) => setBase(e.target.value)} title="Base">
            {branches.map((b) => (
              <option key={b}>{b}</option>
            ))}
          </select>
          <span className="muted">…</span>
          <select className="input" value={head} onChange={(e) => setHead(e.target.value)} title="Compare">
            {branches.map((b) => (
              <option key={b}>{b}</option>
            ))}
          </select>
          <button className="btn btn--sm" disabled={!base || !head || base === head} onClick={() => void compare()}>
            Go
          </button>
        </div>
      )}
      {open && files && (
        <div>
          {files.map((f) => (
            <button key={f.path} className="problems__item" onClick={() => void showFile(f)}>
              <span className="mono git-file__status">{f.status}</span>
              <span className="truncate">{f.path}</span>
            </button>
          ))}
          {!files.length && <div className="muted git__clean">No differences</div>}
        </div>
      )}
    </section>
  );
}

/** Stash: save local changes aside, then apply, pop or drop them. */
export function GitStashes({ root, run }: { root: string; run: Run }) {
  const revision = useDev((s) => s.revision);
  const [list, setList] = useState<GitStash[]>([]);
  const [message, setMessage] = useState("");
  const [untracked, setUntracked] = useState(true);
  const reload = useCallback(() => {
    api.git
      .stashList(root)
      .then(setList)
      .catch(() => setList([]));
  }, [root]);
  useEffect(reload, [reload, revision]);

  const drop = async (s: GitStash) => {
    const ok = await confirmAction({ title: "Drop stash", message: `Delete ${s.name} ("${s.message}")?`, detail: "Its changes are lost.", confirmLabel: "Drop", danger: true });
    if (ok) await run("Drop stash", () => api.git.stashAction(root, "drop", s.index), `Dropped ${s.name}`);
  };

  return (
    <section>
      <div className="git__group-head label">Stash · {list.length}</div>
      <div className="git-stash__form">
        <input className="input" placeholder="Stash message (optional)" value={message} onChange={(e) => setMessage(e.target.value)} />
        <label className="check" title="Also stash new files">
          <input type="checkbox" checked={untracked} onChange={(e) => setUntracked(e.target.checked)} /> new files
        </label>
        <button
          className="btn btn--sm"
          onClick={() =>
            void run(
              "Stash",
              async () => {
                await api.git.stashSave(root, message, untracked);
                setMessage("");
              },
              "Changes stashed",
            )
          }
        >
          <Archive size={11} /> Stash
        </button>
      </div>
      {list.map((s) => (
        <div key={s.name} className="git-stash">
          <span className="mono muted">{s.name}</span>
          <span className="truncate" title={s.message}>
            {s.message}
          </span>
          <button className="btn btn--ghost btn--sm" onClick={() => void run("Apply stash", () => api.git.stashAction(root, "apply", s.index), `Applied ${s.name}`)}>
            Apply
          </button>
          <button className="btn btn--ghost btn--sm" onClick={() => void run("Pop stash", () => api.git.stashAction(root, "pop", s.index), `Popped ${s.name}`)}>
            Pop
          </button>
          <button className="btn btn--ghost btn--sm" onClick={() => void drop(s)}>
            Drop
          </button>
        </div>
      ))}
    </section>
  );
}
