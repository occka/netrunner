import { useEffect, useRef, useState } from "react";
import { CaseSensitive, ChevronDown, ChevronRight, Regex, Replace, Search, WholeWord } from "lucide-react";
import { api } from "@/services/api";
import { confirmAction } from "@/stores/confirm";
import { notify, reportError } from "@/stores/notifications";
import type { SearchQuery, SearchResult } from "@/types/dev";
import { isDirty, relativeToRoot, useDev } from "./store";
import { openAt } from "./lsp/client";

/** Search (and replace) across the project's files, Ctrl+Shift+F. */
export function SearchPanel({ root, focusTick }: { root: string; focusTick: number }) {
  const [query, setQuery] = useState<SearchQuery>({ pattern: "", regex: false, caseSensitive: false, wholeWord: false, include: "", exclude: "" });
  const [replacement, setReplacement] = useState("");
  const [showReplace, setShowReplace] = useState(false);
  const [result, setResult] = useState<SearchResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const input = useRef<HTMLInputElement>(null);
  const seq = useRef(0);

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, [focusTick]);

  // Search as you type, after a short pause.
  useEffect(() => {
    if (!query.pattern) {
      setResult(null);
      setError(null);
      return;
    }
    const id = ++seq.current;
    const timer = window.setTimeout(async () => {
      setBusy(true);
      try {
        const r = await api.dev.search(root, query);
        if (id === seq.current) {
          setResult(r);
          setError(null);
        }
      } catch (err) {
        if (id === seq.current) {
          setResult(null);
          setError((err as { message?: string })?.message ?? String(err));
        }
      } finally {
        if (id === seq.current) setBusy(false);
      }
    }, 300);
    return () => window.clearTimeout(timer);
  }, [root, query]);

  const toggle = (key: "regex" | "caseSensitive" | "wholeWord") => setQuery((q) => ({ ...q, [key]: !q[key] }));

  const replaceAll = async () => {
    if (!result?.files.length) return;
    const paths = result.files.map((f) => f.path);
    const dirty = useDev.getState().tabs.filter((t) => isDirty(t) && paths.some((p) => p.toLowerCase() === t.path.toLowerCase()));
    if (dirty.length) return notify.warn("Save first", `Unsaved changes in ${dirty.map((t) => t.name).join(", ")}. Save or close them before replacing.`);
    const ok = await confirmAction({
      title: "Replace in files",
      message: `Replace ${result.total} match(es) in ${paths.length} file(s) with "${replacement}"?`,
      detail: paths
        .slice(0, 15)
        .map((p) => relativeToRoot(root, p))
        .join("\n") + (paths.length > 15 ? `\n… and ${paths.length - 15} more` : ""),
      confirmLabel: "Replace all",
      danger: true,
    });
    if (!ok) return;
    try {
      const n = await api.dev.replace(query, replacement, paths);
      await useDev.getState().reloadFromDisk(paths);
      useDev.getState().bump();
      notify.success(`Replaced ${n} match(es)`, "Git shows the changes; nothing was committed.");
      setQuery((q) => ({ ...q }));
    } catch (err) {
      reportError("Replace failed", err);
    }
  };

  const toggleFile = (path: string) =>
    setCollapsed((c) => {
      const next = new Set(c);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  return (
    <div className="search-panel">
      <div className="tree__head">
        <span className="label">Search</span>
        {busy && <span className="muted">searching…</span>}
      </div>
      <div className="search-panel__form">
        <div className="search-panel__row">
          <button className="icon-btn icon-btn--sm" title="Toggle replace" onClick={() => setShowReplace((v) => !v)}>
            {showReplace ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </button>
          <div className="search-panel__field">
            <Search size={12} className="muted" />
            <input
              ref={input}
              className="input search-panel__input"
              placeholder="Search in project"
              value={query.pattern}
              onChange={(e) => setQuery((q) => ({ ...q, pattern: e.target.value }))}
            />
            <button className="icon-btn icon-btn--sm" aria-pressed={query.caseSensitive} title="Match case" onClick={() => toggle("caseSensitive")}>
              <CaseSensitive size={13} />
            </button>
            <button className="icon-btn icon-btn--sm" aria-pressed={query.wholeWord} title="Whole word" onClick={() => toggle("wholeWord")}>
              <WholeWord size={13} />
            </button>
            <button className="icon-btn icon-btn--sm" aria-pressed={query.regex} title="Regular expression" onClick={() => toggle("regex")}>
              <Regex size={13} />
            </button>
          </div>
        </div>
        {showReplace && (
          <div className="search-panel__row">
            <span style={{ width: 22 }} />
            <div className="search-panel__field">
              <Replace size={12} className="muted" />
              <input
                className="input search-panel__input"
                placeholder={query.regex ? "Replace ($1 for groups)" : "Replace"}
                value={replacement}
                onChange={(e) => setReplacement(e.target.value)}
              />
              <button className="btn btn--sm" disabled={!result?.total} onClick={() => void replaceAll()} title="Replace every match (asks first)">
                All
              </button>
            </div>
          </div>
        )}
        <input
          className="input search-panel__input"
          placeholder="Files to include (e.g. src/**, *.ts)"
          value={query.include}
          onChange={(e) => setQuery((q) => ({ ...q, include: e.target.value }))}
        />
        <input
          className="input search-panel__input"
          placeholder="Files to exclude"
          value={query.exclude}
          onChange={(e) => setQuery((q) => ({ ...q, exclude: e.target.value }))}
        />
      </div>
      {error && <p className="tools__note text-crit">{error}</p>}
      {result && (
        <p className="muted tools__note">
          {result.total} result(s) in {result.files.length} file(s)
          {result.truncated ? " — stopped at the limit; narrow the search" : ""}
        </p>
      )}
      <div className="search-panel__results">
        {result?.files.map((f) => (
          <div key={f.path} className="problems__file">
            <button className="problems__path search-panel__file mono" onClick={() => toggleFile(f.path)} title={f.path}>
              {collapsed.has(f.path) ? <ChevronRight size={11} /> : <ChevronDown size={11} />}
              <span className="truncate">{relativeToRoot(root, f.path)}</span>
              <span className="muted">{f.matches.length}</span>
            </button>
            {!collapsed.has(f.path) &&
              f.matches.map((m, i) => (
                <button
                  key={i}
                  className="problems__item search-panel__match"
                  onClick={() =>
                    void openAt(f.path, { startLineNumber: m.line + 1, startColumn: m.column + 1, endLineNumber: m.line + 1, endColumn: m.column + m.length + 1 })
                  }
                >
                  <span className="muted mono problems__pos">{m.line + 1}</span>
                  <span className="problems__msg mono">
                    {m.preview.slice(0, m.previewColumn)}
                    <mark>{m.preview.slice(m.previewColumn, m.previewColumn + m.length)}</mark>
                    {m.preview.slice(m.previewColumn + m.length)}
                  </span>
                </button>
              ))}
          </div>
        ))}
      </div>
    </div>
  );
}
