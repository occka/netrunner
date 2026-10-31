import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Copy, FilePlus, FolderOpen, FolderPlus, Pencil, RefreshCw, Trash2 } from "lucide-react";
import { api } from "@/services/api";
import { useContextMenu } from "@/components/ContextMenu";
import { confirmAction } from "@/stores/confirm";
import { promptText } from "@/stores/prompt";
import { notify, reportError } from "@/stores/notifications";
import { fileIcon } from "./fileIcons";
import { useDev } from "./store";
import type { ObjectAction } from "@/objects/types";
import type { DirEntry } from "@/types/dev";

export function FileTree({ root }: { root: string }) {
  const revision = useDev((s) => s.revision);
  const [children, setChildren] = useState<Record<string, DirEntry[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set([root]));
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (dir: string) => {
    try {
      const list = await api.dev.listDir(dir);
      setChildren((c) => ({ ...c, [dir]: list }));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;

  // New project: start collapsed at the root.
  useEffect(() => {
    setExpanded(new Set([root]));
    setChildren({});
    void load(root);
  }, [root, load]);

  // After file-system changes, reload every folder that is currently expanded.
  useEffect(() => {
    if (revision === 0) return;
    expandedRef.current.forEach((d) => void load(d));
  }, [revision, load]);

  const toggle = (dir: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(dir)) next.delete(dir);
      else {
        next.add(dir);
        void load(dir);
      }
      return next;
    });
  };

  return (
    <div className="tree" role="tree">
      <div className="tree__head">
        <span className="label truncate" title={root}>
          {root.split(/[\\/]/).pop()}
        </span>
        <div className="panel__actions">
          <button className="icon-btn icon-btn--sm" title="New file" onClick={() => void newItem(root, false)}>
            <FilePlus size={13} />
          </button>
          <button className="icon-btn icon-btn--sm" title="New folder" onClick={() => void newItem(root, true)}>
            <FolderPlus size={13} />
          </button>
          <button className="icon-btn icon-btn--sm" title="Refresh" onClick={() => useDev.getState().bump()}>
            <RefreshCw size={13} />
          </button>
        </div>
      </div>
      {error && <div className="unavailable">{error}</div>}
      <div className="tree__body">
        <Level dir={root} depth={0} children={children} expanded={expanded} toggle={toggle} />
      </div>
    </div>
  );
}

async function newItem(parent: string, dir: boolean) {
  const name = await promptText({ title: dir ? "New folder" : "New file", label: "Name", placeholder: dir ? "src" : "main.py", confirmLabel: "Create" });
  if (!name) return;
  try {
    const path = await api.dev.create(parent, name, dir);
    useDev.getState().bump();
    if (!dir) void useDev.getState().openFile(path);
  } catch (err) {
    reportError("Could not create", err);
  }
}

function actionsFor(entry: DirEntry): ObjectAction[] {
  const dev = useDev.getState();
  return [
    ...(entry.isDir
      ? [
          { id: "new-file", label: "New file…", icon: FilePlus, run: () => newItem(entry.path, false) },
          { id: "new-folder", label: "New folder…", icon: FolderPlus, run: () => newItem(entry.path, true) },
        ]
      : [{ id: "open", label: "Open", icon: FolderOpen, run: () => dev.openFile(entry.path) }]),
    {
      id: "rename",
      label: "Rename…",
      icon: Pencil,
      run: async () => {
        const name = await promptText({ title: "Rename", label: "New name", initial: entry.name, selectStem: !entry.isDir, confirmLabel: "Rename" });
        if (!name || name === entry.name) return;
        try {
          await api.dev.rename(entry.path, name);
          dev.bump();
        } catch (err) {
          reportError("Could not rename", err);
        }
      },
    },
    {
      id: "copy-path",
      label: "Copy path",
      icon: Copy,
      run: async () => {
        await navigator.clipboard.writeText(entry.path);
        notify.info("Path copied");
      },
    },
    { id: "reveal", label: "Reveal in Explorer", icon: FolderOpen, run: () => api.dev.reveal(entry.path).catch((e) => reportError("Could not open Explorer", e)) },
    {
      id: "delete",
      label: "Move to Recycle Bin",
      icon: Trash2,
      danger: true,
      run: async () => {
        const ok = await confirmAction({
          title: "Delete",
          message: `Move ${entry.isDir ? "folder" : "file"} "${entry.name}" to the Recycle Bin?`,
          detail: `${entry.path}\n\nIt can be restored from the Recycle Bin.`,
          confirmLabel: "Move to Recycle Bin",
          danger: true,
        });
        if (!ok) return;
        try {
          await api.dev.remove(entry.path);
          const open = dev.tabs.filter((t) => t.kind === "file" && t.path.toLowerCase().startsWith(entry.path.toLowerCase()));
          useDev.setState((s) => ({ tabs: s.tabs.filter((t) => !open.includes(t)), active: open.some((t) => t.key === s.active) ? null : s.active }));
          dev.bump();
        } catch (err) {
          reportError("Could not delete", err);
        }
      },
    },
  ];
}

function Level({
  dir,
  depth,
  children,
  expanded,
  toggle,
}: {
  dir: string;
  depth: number;
  children: Record<string, DirEntry[]>;
  expanded: Set<string>;
  toggle: (dir: string) => void;
}) {
  const openFile = useDev((s) => s.openFile);
  const activePath = useDev((s) => s.tabs.find((t) => t.key === s.active)?.path);
  const openMenu = useContextMenu((s) => s.open);
  const list = children[dir];
  if (!list) return depth === 0 ? <div className="tree__loading label">Loading…</div> : null;

  return (
    <>
      {list.map((e) => {
        const isOpen = expanded.has(e.path);
        const Icon = fileIcon(e);
        return (
          <div key={e.path}>
            <button
              className="tree__row"
              role="treeitem"
              aria-expanded={e.isDir ? isOpen : undefined}
              aria-selected={!e.isDir && activePath === e.path}
              style={{ paddingLeft: 6 + depth * 12 }}
              title={e.heavy ? `${e.name} (generated / large folder)` : e.path}
              onClick={() => (e.isDir ? toggle(e.path) : void openFile(e.path))}
              onContextMenu={(ev) => {
                ev.preventDefault();
                openMenu(ev.clientX, ev.clientY, actionsFor(e));
              }}
            >
              {e.isDir ? isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} /> : <span className="tree__spacer" />}
              <Icon size={13} className={`tree__icon${e.isDir ? " tree__icon--dir" : ""}`} />
              <span className={`truncate${e.heavy ? " muted" : ""}`}>{e.name}</span>
            </button>
            {e.isDir && isOpen && <Level dir={e.path} depth={depth + 1} children={children} expanded={expanded} toggle={toggle} />}
          </div>
        );
      })}
    </>
  );
}
