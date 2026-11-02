import { useCallback, useEffect, useMemo, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { BrainCircuit, Bug, CircleAlert, GitPullRequest, Search, DownloadCloud, FolderGit2, FolderOpen, GitBranch, SquareTerminal, Wrench, X } from "lucide-react";
import { ModuleHeader } from "@/components/ModuleHeader";
import { api } from "@/services/api";
import { useQuickAccess } from "@/stores/quickAccess";
import { notify, reportError } from "@/stores/notifications";
import { currentKey, useDev, type IdeMode, type SidePanel } from "./store";
import { CloneDialog } from "./CloneDialog";
import { AiPanel } from "./AiPanel";
import { FileTree } from "./FileTree";
import { EditorArea } from "./EditorArea";
import { TerminalPanel } from "./TerminalPanel";
import { GitPanel } from "./GitPanel";
import { ToolsPanel } from "./ToolsPanel";
import { SearchPanel } from "./SearchPanel";
import { QuickOpen } from "./QuickOpen";
import { RunBar } from "./RunBar";
import { DebugPanel, startForActiveFile } from "./debug/DebugPanel";
import { useDebug } from "./debug/store";
import { monaco } from "./monaco";
import { CiBadge, GitHubPanel } from "./GitHubPanel";
import { LanguagesPanel } from "./lsp/LanguagesPanel";
import { ProblemsPanel } from "./lsp/ProblemsPanel";
import { runInTerminal } from "./terminals";
import { startLsp } from "./lsp/client";
import { restoreSession, startEditorPrefs } from "./editorPrefs";
import { runPlan } from "./run";

const MODES: { id: IdeMode; label: string }[] = [
  { id: "code", label: "Code" },
  { id: "debug", label: "Debug" },
  { id: "ai", label: "AI" },
];
const SIDES: { id: SidePanel; label: string; icon: typeof FolderOpen }[] = [
  { id: "explorer", label: "Explorer", icon: FolderOpen },
  { id: "search", label: "Search", icon: Search },
  { id: "git", label: "Git", icon: GitBranch },
  { id: "github", label: "GitHub", icon: GitPullRequest },
  { id: "problems", label: "Problems", icon: CircleAlert },
  { id: "tools", label: "Tools", icon: Wrench },
];

/** F5, Shift+F5, F9, F10, F11, Shift+F11. True when the key was used. */
function handleDebugKey(e: KeyboardEvent): boolean {
  if (e.ctrlKey || e.altKey) return false;
  const root = useDev.getState().root;
  const d = useDebug.getState();
  if (!root) return false;
  switch (e.code) {
    case "F5":
      if (e.shiftKey) void d.stop();
      else if (d.status === "stopped") void d.resume("continue");
      else if (d.status === "idle") {
        useDev.getState().setMode("debug");
        void startForActiveFile(root);
      }
      return true;
    case "F9": {
      const s = useDev.getState();
      const tab = s.tabs.find((t) => t.key === currentKey(s) && t.kind === "file");
      const line = monaco.editor.getEditors().find((ed) => ed.hasTextFocus())?.getPosition()?.lineNumber;
      if (tab && line) d.toggleBreakpoint(tab.path, line);
      return !!(tab && line);
    }
    case "F10":
      if (d.status !== "stopped") return false;
      void d.resume("next");
      return true;
    case "F11":
      if (d.status !== "stopped") return false;
      void d.resume(e.shiftKey ? "stepOut" : "stepIn");
      return true;
    default:
      return false;
  }
}

export default function DeveloperModule() {
  const { projects, root, mode, side, terminalOpen, loadProjects, openProject, closeProject, setMode, setSide, toggleTerminal } = useDev();
  // Select the stable array, then derive: a filtering selector would return a
  // new array each render and loop under zustand v5.
  const entries = useQuickAccess((s) => s.entries);
  const projectEntries = useMemo(() => entries.filter((e) => e.kind === "project"), [entries]);
  const [cloneOpen, setCloneOpen] = useState(false);
  const [quickOpen, setQuickOpen] = useState(false);
  const [searchFocus, setSearchFocus] = useState(0);
  const closeQuickOpen = useCallback(() => setQuickOpen(false), []);

  useEffect(() => {
    loadProjects().catch((err) => reportError("Could not load projects", err));
    startLsp();
    startEditorPrefs();
    useDebug.getState().loadBreakpoints();
  }, [loadProjects]);

  useEffect(() => {
    if (root) void restoreSession(root);
  }, [root]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === "`") {
        e.preventDefault();
        toggleTerminal();
      } else if (handleDebugKey(e)) {
        e.preventDefault();
      } else if (e.ctrlKey && !e.shiftKey && !e.altKey && e.code === "KeyP" && useDev.getState().root) {
        e.preventDefault();
        setQuickOpen(true);
      } else if (e.ctrlKey && e.shiftKey && e.code === "KeyF" && useDev.getState().root) {
        e.preventDefault();
        setSide("search");
        setSearchFocus((n) => n + 1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleTerminal, setSide]);

  const pickFolder = async () => {
    const dir = await openDialog({ directory: true, multiple: false, title: "Open project folder" });
    if (typeof dir === "string") await openProject(dir);
  };

  const run = async (path: string) => {
    if (!root) return;
    const listing = await api.dev.listDir(root).catch(() => []);
    const plan = runPlan(path, {
      hasCargo: listing.some((e) => e.name === "Cargo.toml"),
      hasCsproj: listing.some((e) => e.name.endsWith(".csproj")),
    });
    if (!plan) return notify.warn("No run command for this file type", "Use the terminal to run it manually.");
    toggleTerminal(true);
    if (await runInTerminal("Run", plan.command, root)) notify.info(`Running with ${plan.description}`);
  };

  const showTerminal = terminalOpen;

  return (
    <div className="module ide">
      <ModuleHeader id="developer" subtitle={root ? <span className="mono">{root}</span> : "Open a project folder to start."}>
        {root && <CiBadge root={root} />}
        {root && <RunBar root={root} />}
        <div className="segmented" role="tablist" aria-label="IDE mode">
          {MODES.map((m) => (
            <button key={m.id} aria-pressed={mode === m.id} onClick={() => setMode(m.id)}>
              {m.label}
            </button>
          ))}
        </div>
        <button className="icon-btn" aria-pressed={showTerminal} title="Toggle terminal (Ctrl+`)" onClick={() => toggleTerminal()}>
          <SquareTerminal size={15} />
        </button>
      </ModuleHeader>

      <div className="ide-projects">
        {projects.map((p) => (
          <div key={p} className="ide-project" aria-selected={p === root} onClick={() => p !== root && void openProject(p)} title={p}>
            <FolderGit2 size={12} />
            <span className="truncate">{p.split(/[\\/]/).pop()}</span>
            <button className="editor-tab__close" aria-label="Close project" onClick={(e) => (e.stopPropagation(), void closeProject(p))}>
              <X size={10} />
            </button>
          </div>
        ))}
        <button className="btn btn--sm" onClick={() => void pickFolder()}>
          <FolderOpen size={12} /> Open folder
        </button>
        <button className="btn btn--sm btn--ghost" onClick={() => setCloneOpen(true)}>
          <DownloadCloud size={12} /> Clone
        </button>
        {projectEntries
          .filter((e) => !projects.some((p) => p.toLowerCase() === e.target.toLowerCase()))
          .slice(0, 4)
          .map((e) => (
            <button key={e.id} className="btn btn--sm btn--ghost" title={`Quick Access project: ${e.target}`} onClick={() => void openProject(e.target)}>
              + {e.name}
            </button>
          ))}
      </div>

      {!root ? (
        <div className="empty ide-empty">
          <FolderGit2 size={34} strokeWidth={1} />
          <div>No project open.</div>
          <div className="muted">NETRUNNER only reads and writes files inside folders you open here.</div>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn btn--primary" onClick={() => void pickFolder()}>
              <FolderOpen size={14} /> Open folder
            </button>
            <button className="btn" onClick={() => setCloneOpen(true)}>
              <DownloadCloud size={14} /> Clone repository
            </button>
          </div>
        </div>
      ) : (
        <div className={`ide-body ide-body--${mode}`}>
          <aside className="ide-side">
              <div className="ide-side__tabs" role="tablist">
                {SIDES.map((s) => (
                  <button key={s.id} role="tab" aria-selected={side === s.id} title={s.label} onClick={() => setSide(s.id)}>
                    <s.icon size={14} />
                    <span>{s.label}</span>
                  </button>
                ))}
              </div>
              <div className="ide-side__body">
                {side === "explorer" && <FileTree root={root} />}
                {side === "search" && <SearchPanel root={root} focusTick={searchFocus} />}
                {side === "git" && <GitPanel root={root} />}
                {side === "github" && <GitHubPanel root={root} />}
                {side === "problems" && <ProblemsPanel root={root} />}
                {side === "tools" && (
                  <>
                    <LanguagesPanel root={root} />
                    <ToolsPanel />
                  </>
                )}
              </div>
            </aside>
          <div className="ide-center">
            <EditorArea onRun={(p) => void run(p)} />
            {showTerminal && <TerminalPanel />}
          </div>
          {mode === "debug" && (
            <aside className="ide-right">
              <div className="tree__head">
                <Bug size={13} className="muted" />
                <span className="label">Debug</span>
              </div>
              <DebugPanel root={root} />
            </aside>
          )}
          {mode === "ai" && (
            <aside className="ide-right ide-right--ai">
              <div className="tree__head">
                <BrainCircuit size={13} className="muted" />
                <span className="label">Neural</span>
              </div>
              <AiPanel root={root} />
            </aside>
          )}
        </div>
      )}
      {cloneOpen && <CloneDialog onClose={() => setCloneOpen(false)} />}
      {quickOpen && root && <QuickOpen root={root} onClose={closeQuickOpen} />}
    </div>
  );
}
