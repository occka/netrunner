import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { ChevronRight, Code2, ExternalLink, File, Folder, GitBranch, Link2 } from "lucide-react";
import { api } from "@/services/api";
import { reportError } from "@/stores/notifications";
import { useShell } from "@/stores/shell";
import { useDev } from "@/modules/developer/store";
import { formatBytes } from "@/utils/format";
import type { GitHubEntry, GitHubFile, GitHubRepo } from "@/types/dev";

// Monaco (~3.6 MB) loads only when a file is opened.
const CodeViewer = lazy(() => import("@/modules/developer/CodeViewer"));

function openExternal(url: string | null | undefined) {
  if (url && /^https:\/\/github\.com\//.test(url)) api.app.openUrl(url).catch((e) => reportError("Could not open browser", e));
}

/**
 * Opens the local clone in DEVELOPER, and a file in it when given (repository
 * path with forward slashes). The local copy may differ from the branch viewed.
 */
export async function openInDeveloper(local: string, repoPath?: string) {
  const dev = useDev.getState();
  if (dev.root?.toLowerCase() !== local.toLowerCase()) await dev.openProject(local);
  if (useDev.getState().root?.toLowerCase() !== local.toLowerCase()) return; // cancelled (unsaved changes)
  useShell.getState().navigate("developer");
  if (repoPath) await useDev.getState().openFile(`${local}\\${repoPath.replace(/\//g, "\\")}`);
}

/** Repository browser: branches, folders and read-only file view. */
export function RepoCode({ repo, local, onLink }: { repo: GitHubRepo; local: string | null; onLink: () => void }) {
  const [owner, name] = repo.fullName.split("/");
  const [branch, setBranch] = useState(repo.defaultBranch ?? "");
  const [branches, setBranches] = useState<string[]>([]);
  const [path, setPath] = useState("");
  const [entries, setEntries] = useState<GitHubEntry[] | null>(null);
  const [file, setFile] = useState<GitHubFile | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setBranch(repo.defaultBranch ?? "");
    setPath("");
    setFile(null);
    api.github.branches(owner, name).then(setBranches, () => setBranches([]));
  }, [owner, name, repo.defaultBranch]);

  const load = useCallback(
    async (dir: string) => {
      setLoading(true);
      setError(null);
      try {
        setEntries(await api.github.contents(owner, name, dir, branch || undefined));
        setPath(dir);
        setFile(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    },
    [owner, name, branch],
  );

  useEffect(() => {
    void load("");
  }, [load]);

  const openFile = async (p: string) => {
    setLoading(true);
    setError(null);
    try {
      setFile(await api.github.file(owner, name, p, branch || undefined));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const crumbs = (file?.path ?? path).split("/").filter(Boolean);
  const dirOfFile = file ? file.path.split("/").slice(0, -1).join("/") : path;

  return (
    <div className="gh-code">
      <div className="gh-code__bar">
        <label className="gh-code__branch" title="Branch">
          <GitBranch size={12} />
          <select className="select select--sm" value={branch} onChange={(e) => setBranch(e.target.value)}>
            {!branches.includes(branch) && <option value={branch}>{branch || "default"}</option>}
            {branches.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
        </label>
        <nav className="gh-code__crumbs mono">
          <button onClick={() => void load("")}>{name}</button>
          {crumbs.map((c, i) => {
            const target = crumbs.slice(0, i + 1).join("/");
            const isFile = !!file && i === crumbs.length - 1;
            return (
              <span key={target}>
                <ChevronRight size={11} className="muted" />
                {isFile ? <b>{c}</b> : <button onClick={() => void load(target)}>{c}</button>}
              </span>
            );
          })}
        </nav>
        <span className="gh-code__actions">
          {local ? (
            <button
              className="btn btn--sm btn--primary"
              title={`Open the local clone (${local})${file ? " at this file" : ""}`}
              onClick={() => void openInDeveloper(local, file?.path)}
            >
              <Code2 size={12} /> Open in Developer
            </button>
          ) : (
            <button className="btn btn--sm" onClick={onLink} title="No local clone found. Pick the folder where it is.">
              <Link2 size={12} /> Link local folder
            </button>
          )}
          {file && (
            <button className="btn btn--sm btn--ghost" onClick={() => openExternal(file.htmlUrl)}>
              <ExternalLink size={12} /> GitHub
            </button>
          )}
        </span>
      </div>
      {error && <div className="unavailable">{error}</div>}
      {file ? (
        <div className="gh-code__file">
          {file.content !== null ? (
            <Suspense fallback={<div className="label">Loading editor…</div>}>
              <CodeViewer path={file.path} content={file.content} />
            </Suspense>
          ) : (
            <div className="empty">
              {file.binary ? "Binary file" : "This file is too large to show here"} ({formatBytes(file.size)}). Open it on GitHub
              {local ? " or in Developer" : ""}.
              <button className="btn btn--sm btn--ghost" onClick={() => void load(dirOfFile)}>
                Back to folder
              </button>
            </div>
          )}
        </div>
      ) : (
        <ul className="gh-code__list">
          {path && (
            <li>
              <button className="gh-code__entry" onClick={() => void load(path.split("/").slice(0, -1).join("/"))}>
                <Folder size={13} className="muted" />
                <span>..</span>
              </button>
            </li>
          )}
          {entries?.map((e) => (
            <li key={e.path}>
              <button
                className="gh-code__entry"
                disabled={e.kind === "submodule" || e.kind === "symlink"}
                title={e.kind === "submodule" ? "Submodule (another repository)" : e.path}
                onClick={() => void (e.kind === "dir" ? load(e.path) : openFile(e.path))}
              >
                {e.kind === "dir" ? <Folder size={13} className="gh-code__dir" /> : <File size={13} className="muted" />}
                <span>{e.name}</span>
                <span className="muted mono">{e.kind === "file" ? formatBytes(e.size) : e.kind === "dir" ? "" : e.kind}</span>
              </button>
            </li>
          ))}
          {loading && !entries && <li className="label">Loading…</li>}
        </ul>
      )}
    </div>
  );
}
