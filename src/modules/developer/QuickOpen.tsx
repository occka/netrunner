import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/services/api";
import { reportError } from "@/stores/notifications";
import { fuzzyFilter } from "./fuzzy";
import { fileIcon } from "./fileIcons";
import { useDev } from "./store";

/** Go to file (Ctrl+P): fuzzy search over the project's files. */
export function QuickOpen({ root, onClose }: { root: string; onClose: () => void }) {
  const revision = useDev((s) => s.revision);
  const [files, setFiles] = useState<string[] | null>(null);
  const [text, setText] = useState("");
  const [index, setIndex] = useState(0);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.dev
      .files(root)
      .then(setFiles)
      .catch((err) => {
        reportError("Could not list project files", err);
        onClose();
      });
  }, [root, revision, onClose]);

  const hits = useMemo(() => fuzzyFilter(text, files ?? []), [text, files]);
  useEffect(() => setIndex(0), [text]);
  useEffect(() => list.current?.children[index]?.scrollIntoView({ block: "nearest" }), [index]);

  const open = (rel: string) => {
    onClose();
    void useDev.getState().openFile(`${root.replace(/[\\/]+$/, "")}\\${rel.replace(/\//g, "\\")}`);
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") onClose();
    else if (e.key === "ArrowDown") setIndex((i) => Math.min(i + 1, hits.length - 1));
    else if (e.key === "ArrowUp") setIndex((i) => Math.max(i - 1, 0));
    else if (e.key === "Enter" && hits[index]) open(hits[index].path);
    else return;
    e.preventDefault();
  };

  return (
    <div className="quick-open__backdrop" onMouseDown={onClose}>
      <div className="quick-open" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label="Go to file">
        <input
          autoFocus
          className="input"
          placeholder={files ? `Go to file (${files.length} files)` : "Listing files…"}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
        />
        <div className="quick-open__list" ref={list} role="listbox">
          {hits.map((h, i) => {
            const slash = h.path.lastIndexOf("/");
            const Icon = fileIcon({ name: h.path.slice(slash + 1), isDir: false });
            const marked = new Set(h.positions);
            return (
              <div
                key={h.path}
                role="option"
                aria-selected={i === index}
                className="quick-open__item"
                onMouseEnter={() => setIndex(i)}
                onClick={() => open(h.path)}
              >
                <Icon size={12} />
                <span className="truncate mono">
                  {[...h.path].map((ch, k) => (marked.has(k) ? <b key={k}>{ch}</b> : ch))}
                </span>
              </div>
            );
          })}
          {files && !hits.length && <div className="muted quick-open__empty">No matching files</div>}
        </div>
      </div>
    </div>
  );
}
