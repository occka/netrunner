import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  BrainCircuit,
  ClipboardPaste,
  Copy,
  Eye,
  EyeOff,
  FolderOpen,
  FolderPlus,
  HardDrive,
  Home,
  Pencil,
  Plus,
  RefreshCw,
  Rocket,
  Scissors,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { ModuleHeader } from "@/components/ModuleHeader";
import { useContextMenu } from "@/components/ContextMenu";
import { api } from "@/services/api";
import { usePolled } from "@/hooks/usePolled";
import { useShell } from "@/stores/shell";
import { confirmAction } from "@/stores/confirm";
import { promptText } from "@/stores/prompt";
import { notify, reportError } from "@/stores/notifications";
import { emptyInput, useQuickAccess } from "@/stores/quickAccess";
import { refreshActivity } from "@/stores/activity";
import { prefillNeural } from "@/modules/neural/store";
import { fileIcon } from "@/modules/developer/fileIcons";
import { formatBytes } from "@/utils/format";
import { parentOf, useFiles } from "./store";
import type { ObjectAction } from "@/objects/types";
import type { FileEntry, FilePreview } from "@/types/neural";

type SortKey = "name" | "size" | "modified";

export default function FilesModule() {
  const { tabs, active, clipboard, navigate, goBack, goForward, openTab, closeTab, setActive, setClipboard } = useFiles();
  const tab = tabs.find((t) => t.id === active)!;
  const places = usePolled(() => api.files.places());
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: "name", desc: false });
  const [filter, setFilter] = useState("");
  const [showHidden, setShowHidden] = useState(false);
  const [address, setAddress] = useState(tab.path);
  const [search, setSearch] = useState<{ query: string; results: FileEntry[]; complete: boolean } | null>(null);
  const [searching, setSearching] = useState(false);
  const [preview, setPreview] = useState<{ path: string; data: FilePreview } | null>(null);
  const openMenu = useContextMenu((s) => s.open);
  const listRef = useRef<HTMLDivElement>(null);

  // Start new tabs in the user's home folder.
  useEffect(() => {
    if (!tab.path && places.data?.places[0]) navigate(places.data.places[0][1]);
  }, [tab.path, places.data, navigate]);

  const load = useCallback(async () => {
    if (!tab.path) return;
    try {
      setEntries(await api.files.list(tab.path));
      setError(null);
    } catch (err) {
      setEntries([]);
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [tab.path]);

  useEffect(() => {
    setAddress(tab.path);
    setSelected(new Set());
    setSearch(null);
    setPreview(null);
    void load();
  }, [tab.path, load]);

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const base = (search ? search.results : entries).filter((e) => (showHidden || !e.hidden) && (!q || e.name.toLowerCase().includes(q)));
    const dir = sort.desc ? -1 : 1;
    return [...base].sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      if (sort.key === "size") return ((a.size ?? 0) - (b.size ?? 0)) * dir;
      if (sort.key === "modified") return ((a.modified ?? 0) - (b.modified ?? 0)) * dir;
      return a.name.localeCompare(b.name, undefined, { numeric: true }) * dir;
    });
  }, [entries, search, filter, showHidden, sort]);

  const selection = shown.filter((e) => selected.has(e.path));

  const refresh = () => {
    void load();
    refreshActivity();
  };

  const run = async (label: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (err) {
      reportError(label, err);
    } finally {
      refresh();
    }
  };

  const openEntry = (e: FileEntry) => (e.isDir ? navigate(e.path) : run("Could not open", () => api.files.open(e.path)));

  const remove = async (items: FileEntry[]) => {
    if (!items.length) return;
    const ok = await confirmAction({
      title: "Move to Recycle Bin",
      message: items.length === 1 ? `Move "${items[0].name}" to the Recycle Bin?` : `Move ${items.length} items to the Recycle Bin?`,
      detail: "Items can be restored from the Recycle Bin.",
      confirmLabel: "Move to Recycle Bin",
      danger: true,
    });
    if (ok) await run("Could not delete", async () => notify.success(`Moved ${await api.files.remove(items.map((i) => i.path))} item(s) to the Recycle Bin`));
  };

  const rename = async (e: FileEntry) => {
    const name = await promptText({ title: "Rename", label: "New name", initial: e.name, selectStem: !e.isDir, confirmLabel: "Rename" });
    if (name && name !== e.name) await run("Could not rename", () => api.files.rename(e.path, name));
  };

  const newFolder = async () => {
    const name = await promptText({ title: "New folder", label: "Name", initial: "New folder", confirmLabel: "Create" });
    if (name) await run("Could not create folder", () => api.files.createDir(tab.path, name));
  };

  const paste = async () => {
    if (!clipboard) return;
    await run(clipboard.move ? "Could not move" : "Could not copy", async () => {
      const n = await api.files.transfer(clipboard.paths, tab.path, clipboard.move);
      notify.success(`${clipboard.move ? "Moved" : "Copied"} ${n} item(s)`);
      if (clipboard.move) setClipboard(null);
    });
  };

  const analyze = (e: FileEntry) => {
    prefillNeural(`Analyze this file: what is it, what does it do, and is anything wrong or risky in it?`, [{ kind: "file", path: e.path }]);
    useShell.getState().navigate("neural");
  };

  const addToQuickAccess = (e: FileEntry) => {
    const isApp = /\.(exe|lnk|bat|cmd)$/i.test(e.name);
    useQuickAccess.getState().openEditor(null, {
      ...emptyInput(e.isDir ? "folder" : isApp ? "app" : "file"),
      name: e.name.replace(/\.(exe|lnk)$/i, ""),
      target: e.path,
    });
  };

  const actionsFor = (e: FileEntry): ObjectAction[] => {
    const items = selected.has(e.path) ? selection : [e];
    return [
      { id: "open", label: e.isDir ? "Open" : "Open with default app", icon: FolderOpen, run: () => openEntry(e) },
      ...(e.isDir ? [{ id: "tab", label: "Open in new tab", icon: Plus, run: () => openTab(e.path) }] : []),
      { id: "copy", label: "Copy", icon: Copy, run: () => setClipboard({ paths: items.map((i) => i.path), move: false }) },
      { id: "cut", label: "Cut", icon: Scissors, run: () => setClipboard({ paths: items.map((i) => i.path), move: true }) },
      { id: "rename", label: "Rename…", icon: Pencil, run: () => rename(e) },
      { id: "reveal", label: "Show in Explorer", icon: FolderOpen, run: () => run("Could not open Explorer", () => api.files.reveal(e.path)) },
      { id: "qa", label: "Add to Quick Access", icon: Rocket, run: () => addToQuickAccess(e) },
      ...(!e.isDir ? [{ id: "ai", label: "Analyze with AI…", icon: BrainCircuit, run: () => analyze(e) }] : []),
      { id: "delete", label: items.length > 1 ? `Delete ${items.length} items` : "Delete", icon: Trash2, danger: true, run: () => remove(items) },
    ];
  };

  const click = (e: FileEntry, ev: React.MouseEvent) => {
    const next = new Set(ev.ctrlKey ? selected : []);
    if (ev.shiftKey && anchor) {
      const a = shown.findIndex((x) => x.path === anchor);
      const b = shown.findIndex((x) => x.path === e.path);
      shown.slice(Math.min(a, b), Math.max(a, b) + 1).forEach((x) => next.add(x.path));
    } else if (ev.ctrlKey && selected.has(e.path)) {
      next.delete(e.path);
    } else {
      next.add(e.path);
      setAnchor(e.path);
    }
    setSelected(next);
    if (!e.isDir && next.size === 1) {
      api.files.preview(e.path).then((data) => setPreview({ path: e.path, data }), () => setPreview(null));
    } else {
      setPreview(null);
    }
  };

  const onKeyDown = (ev: React.KeyboardEvent) => {
    if ((ev.target as HTMLElement).tagName === "INPUT") return;
    if (ev.key === "Delete") void remove(selection);
    else if (ev.key === "F2" && selection[0]) void rename(selection[0]);
    else if (ev.key === "Enter" && selection[0]) openEntry(selection[0]);
    else if (ev.key === "Backspace") {
      const p = parentOf(tab.path);
      if (p) navigate(p);
    } else if (ev.ctrlKey && ev.key.toLowerCase() === "a") {
      ev.preventDefault();
      setSelected(new Set(shown.map((x) => x.path)));
    } else if (ev.ctrlKey && ev.key.toLowerCase() === "c" && selection.length) setClipboard({ paths: selection.map((x) => x.path), move: false });
    else if (ev.ctrlKey && ev.key.toLowerCase() === "x" && selection.length) setClipboard({ paths: selection.map((x) => x.path), move: true });
    else if (ev.ctrlKey && ev.key.toLowerCase() === "v") void paste();
  };

  const runSearch = async (query: string) => {
    if (query.trim().length < 2) return setSearch(null);
    setSearching(true);
    try {
      const r = await api.files.search(tab.path, query);
      setSearch({ query, results: r.entries, complete: r.complete });
    } catch (err) {
      reportError("Search failed", err);
    } finally {
      setSearching(false);
    }
  };

  const sortBy = (key: SortKey) => setSort((s) => ({ key, desc: s.key === key ? !s.desc : false }));
  const crumbs = tab.path.split("\\").filter(Boolean);

  return (
    <div className="module files" onKeyDown={onKeyDown}>
      <ModuleHeader id="files">
        <form
          className="files-search"
          onSubmit={(e) => {
            e.preventDefault();
            void runSearch(new FormData(e.currentTarget).get("q") as string);
          }}
        >
          <Search size={13} className="muted" />
          <input name="q" className="input" placeholder={`Search in ${crumbs.at(-1) ?? "folder"}…`} />
          {searching && <RefreshCw size={12} className="spin muted" />}
        </form>
      </ModuleHeader>

      <div className="files-tabs">
        {tabs.map((t) => (
          <div key={t.id} className="files-tab" aria-selected={t.id === active} onClick={() => setActive(t.id)} title={t.path}>
            <span className="truncate">{t.path.split("\\").filter(Boolean).at(-1) ?? "…"}</span>
            {tabs.length > 1 && (
              <button className="editor-tab__close" aria-label="Close tab" onClick={(e) => (e.stopPropagation(), closeTab(t.id))}>
                <X size={10} />
              </button>
            )}
          </div>
        ))}
        <button className="icon-btn icon-btn--sm" title="New tab" onClick={() => openTab(tab.path)}>
          <Plus size={13} />
        </button>
      </div>

      <div className="files-bar">
        <button className="icon-btn" title="Back" disabled={!tab.back.length} onClick={goBack}>
          <ArrowLeft size={15} />
        </button>
        <button className="icon-btn" title="Forward" disabled={!tab.forward.length} onClick={goForward}>
          <ArrowRight size={15} />
        </button>
        <button className="icon-btn" title="Up (Backspace)" disabled={!parentOf(tab.path)} onClick={() => navigate(parentOf(tab.path)!)}>
          <ArrowUp size={15} />
        </button>
        <button className="icon-btn" title="Refresh" onClick={refresh}>
          <RefreshCw size={14} />
        </button>
        <form
          className="files-address"
          onSubmit={(e) => {
            e.preventDefault();
            if (address.trim()) navigate(address.trim().replace(/\//g, "\\"));
          }}
        >
          <input className="input input--mono" value={address} onChange={(e) => setAddress(e.target.value)} spellCheck={false} aria-label="Address" />
        </form>
        <input className="input files-filter" placeholder="Filter…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <button className="icon-btn" title="New folder" onClick={() => void newFolder()}>
          <FolderPlus size={15} />
        </button>
        <button className="icon-btn" title={clipboard ? `Paste ${clipboard.paths.length} item(s) (Ctrl+V)` : "Clipboard empty"} disabled={!clipboard} onClick={() => void paste()}>
          <ClipboardPaste size={15} />
        </button>
        <button className="icon-btn" title={showHidden ? "Hide hidden files" : "Show hidden files"} aria-pressed={showHidden} onClick={() => setShowHidden((v) => !v)}>
          {showHidden ? <Eye size={15} /> : <EyeOff size={15} />}
        </button>
      </div>

      <div className="files-body">
        <aside className="files-side">
          <div className="label files-side__title">Places</div>
          {places.data?.places.map(([name, path]) => (
            <button key={path} className="files-place" aria-current={tab.path === path ? "true" : undefined} onClick={() => navigate(path)}>
              <Home size={13} /> {name}
            </button>
          ))}
          <div className="label files-side__title">Drives</div>
          {places.data?.drives.map((d) => (
            <button key={d.path} className="files-place" aria-current={tab.path === d.path ? "true" : undefined} onClick={() => navigate(d.path)} title={d.label}>
              <HardDrive size={13} />
              <span className="truncate">{d.path}</span>
              <span className="muted mono files-place__free">{formatBytes(d.freeBytes)} free</span>
            </button>
          ))}
        </aside>

        <div className="files-main" tabIndex={0} ref={listRef}>
          {search && (
            <div className="files-banner">
              {search.results.length} result(s) for “{search.query}” in {tab.path}
              {!search.complete && " (stopped early: limit reached)"}
              <button className="btn btn--ghost btn--sm" onClick={() => setSearch(null)}>
                Clear search
              </button>
            </div>
          )}
          {clipboard && (
            <div className="files-banner files-banner--clip">
              {clipboard.move ? "Cut" : "Copied"}: {clipboard.paths.length} item(s). Open a folder and paste (Ctrl+V).
              <button className="btn btn--ghost btn--sm" onClick={() => setClipboard(null)}>
                Clear
              </button>
            </div>
          )}
          {error && <div className="unavailable">{error}</div>}
          <table className="table files-table">
            <thead>
              <tr>
                <th onClick={() => sortBy("name")}>Name {sort.key === "name" && (sort.desc ? "▼" : "▲")}</th>
                <th className="num" style={{ width: 110 }} onClick={() => sortBy("size")}>
                  Size {sort.key === "size" && (sort.desc ? "▼" : "▲")}
                </th>
                <th style={{ width: 160 }} onClick={() => sortBy("modified")}>
                  Modified {sort.key === "modified" && (sort.desc ? "▼" : "▲")}
                </th>
              </tr>
            </thead>
            <tbody>
              {shown.map((e) => {
                const Icon = fileIcon(e);
                return (
                  <tr
                    key={e.path}
                    aria-selected={selected.has(e.path)}
                    className={e.hidden ? "row--dim" : undefined}
                    onClick={(ev) => click(e, ev)}
                    onDoubleClick={() => openEntry(e)}
                    onContextMenu={(ev) => {
                      ev.preventDefault();
                      if (!selected.has(e.path)) setSelected(new Set([e.path]));
                      openMenu(ev.clientX, ev.clientY, actionsFor(e));
                    }}
                  >
                    <td className="truncate" title={search ? e.path : e.name}>
                      <Icon size={13} className={`files-icon${e.isDir ? " files-icon--dir" : ""}`} /> {search ? e.path : e.name}
                    </td>
                    <td className="num mono">{e.isDir ? "" : formatBytes(e.size)}</td>
                    <td className="mono muted">{e.modified ? new Date(e.modified).toLocaleString([], { dateStyle: "short", timeStyle: "short" }) : ""}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {!error && shown.length === 0 && <div className="empty">{search ? "No matches." : "This folder is empty."}</div>}
        </div>

        <aside className="files-preview">
          {selection.length > 1 ? (
            <div className="empty">
              {selection.length} items selected
              <div className="muted">{formatBytes(selection.reduce((s, e) => s + (e.size ?? 0), 0))} in files</div>
            </div>
          ) : !preview ? (
            <div className="empty muted">Select a file to preview it.</div>
          ) : (
            <>
              <div className="files-preview__head truncate" title={preview.path}>
                {preview.path.split("\\").pop()}
              </div>
              {preview.data.kind === "image" && <img className="files-preview__img" src={preview.data.dataUrl} alt="" />}
              {preview.data.kind === "text" && (
                <pre className="files-preview__text" data-selectable>
                  {preview.data.text}
                  {preview.data.truncated && "\n… (preview truncated)"}
                </pre>
              )}
              {preview.data.kind === "none" && <div className="unavailable">No preview: {preview.data.reason}</div>}
              <div className="files-preview__actions">
                <button className="btn btn--sm" onClick={() => run("Could not open", () => api.files.open(preview.path))}>
                  Open
                </button>
                {preview.data.kind === "text" && (
                  <button className="btn btn--sm" onClick={() => analyze(selection[0])} title="Attach this file to NEURAL; you review before sending">
                    <BrainCircuit size={12} /> Analyze with AI
                  </button>
                )}
              </div>
            </>
          )}
          <p className="muted files-note">Archive browsing and duplicate detection are planned. No background indexing runs: search scans on demand.</p>
        </aside>
      </div>
    </div>
  );
}
