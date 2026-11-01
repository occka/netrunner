import { useEffect, useRef } from "react";
import { DiffEditor, Editor, type OnMount } from "@monaco-editor/react";
import { Code2, Lock, Play, X } from "lucide-react";
import { useSettings } from "@/stores/settings";
import { applyMonacoTheme, monaco } from "./monaco";
import { isDirty, useDev, type EditorTab } from "./store";
import { fileIcon } from "./fileIcons";
import { fileModelUri, previewModels, takeReveal, useLsp } from "./lsp/client";
import { LspStatus } from "./lsp/LspStatus";

/** File tabs use real file URIs so language servers and Go to Definition can address them. */
const modelUri = (tab: EditorTab) => (tab.kind === "file" ? fileModelUri(tab.path).toString() : `inmemory://nr/${encodeURIComponent(tab.key)}`);

/** The mounted code editor, so NEURAL can attach the user's current selection. */
let currentEditor: monaco.editor.IStandaloneCodeEditor | null = null;

export function getEditorSelection(): { label: string; text: string } | null {
  const ed = currentEditor;
  const sel = ed?.getSelection();
  const model = ed?.getModel();
  if (!ed || !sel || !model || sel.isEmpty()) return null;
  const tab = useDev.getState().tabs.find((t) => t.key === useDev.getState().active);
  const name = tab?.name ?? "editor";
  return { label: `${name}:${sel.startLineNumber}-${sel.endLineNumber}`, text: model.getValueInRange(sel) };
}

export function EditorArea({ onRun }: { onRun: (path: string) => void }) {
  const { tabs, active, setActive, closeTab, setContent, save } = useDev();
  const theme = useSettings((s) => s.values.theme);
  const tab = tabs.find((t) => t.key === active);
  const activeRef = useRef(active);
  activeRef.current = active;

  useEffect(() => applyMonacoTheme(theme), [theme]);

  // Free Monaco models of closed tabs (they hold undo history and text).
  const openKeys = tabs.map((t) => t.key).join("|");
  useEffect(() => {
    const keep = new Set(tabs.map((t) => monaco.Uri.parse(modelUri(t)).toString()));
    for (const uri of keep) previewModels.delete(uri);
    for (const model of monaco.editor.getModels()) {
      const uri = model.uri.toString();
      const ours = model.uri.scheme === "file" || uri.startsWith("inmemory://nr/");
      if (ours && !keep.has(uri) && !previewModels.has(uri)) model.dispose();
    }
  }, [openKeys]); // keyed on the joined tab keys, not the array identity

  // Go to Definition into another file: reveal the target once its tab is shown.
  const revealTick = useLsp((s) => s.revealTick);
  useEffect(() => {
    const ed = currentEditor;
    if (!ed || !tab || tab.kind !== "file") return;
    const range = takeReveal(tab.path);
    if (!range) return;
    ed.setSelection(range);
    ed.revealRangeInCenterIfOutsideViewport(range);
    ed.focus();
  }, [active, revealTick]); // the reveal waits for the tab switch, not for every tab change

  const onMount: OnMount = (editor) => {
    currentEditor = editor;
    editor.onDidDispose(() => {
      if (currentEditor === editor) currentEditor = null;
    });
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      if (activeRef.current) void useDev.getState().save(activeRef.current);
    });
  };

  return (
    <div className="editor-area">
      <div className="editor-tabs" role="tablist">
        {tabs.map((t) => {
          const Icon = fileIcon({ name: t.name, isDir: false });
          return (
            <div
              key={t.key}
              role="tab"
              aria-selected={t.key === active}
              className={`editor-tab${t.kind !== "file" ? " editor-tab--diff" : ""}`}
              onClick={() => setActive(t.key)}
              onAuxClick={(e) => e.button === 1 && void closeTab(t.key)}
              title={t.path}
            >
              <Icon size={12} />
              <span className="truncate">{t.name}</span>
              {isDirty(t) ? <span className="editor-tab__dirty" title="Unsaved changes" /> : null}
              <button
                className="editor-tab__close"
                aria-label={`Close ${t.name}`}
                onClick={(e) => {
                  e.stopPropagation();
                  void closeTab(t.key);
                }}
              >
                <X size={11} />
              </button>
            </div>
          );
        })}
      </div>

      <div className="editor-body">
        {!tab ? (
          <div className="empty editor-empty">
            <Code2 size={30} strokeWidth={1} />
            <div>Open a file from the explorer, or a change from the Git panel.</div>
            <div className="muted">Ctrl+P go to file · Ctrl+Shift+F search · Ctrl+S save · F12 definition · F2 rename · middle-click closes a tab</div>
          </div>
        ) : tab.binary ? (
          <div className="unavailable editor-binary">Binary file. It cannot be edited as text ({tab.path}).</div>
        ) : (tab.kind === "diff" || tab.kind === "proposal") && tab.diff ? (
          <DiffEditor
            key={tab.key}
            original={tab.diff.original}
            modified={tab.diff.modified}
            language={tab.language}
            theme="netrunner"
            options={{ readOnly: true, renderSideBySide: true, minimap: { enabled: false }, fontFamily: "JetBrains Mono", fontSize: 13 }}
          />
        ) : (
          <Editor
            path={modelUri(tab)}
            defaultValue={tab.saved}
            defaultLanguage={tab.language}
            theme="netrunner"
            onMount={onMount}
            onChange={(value) => setContent(tab.key, value ?? "")}
            options={{
              readOnly: tab.readOnly,
              fontFamily: '"JetBrains Mono", Consolas, monospace',
              fontSize: 13,
              fontLigatures: true,
              minimap: { enabled: true, scale: 1 },
              smoothScrolling: true,
              renderWhitespace: "selection",
              bracketPairColorization: { enabled: true },
              scrollBeyondLastLine: false,
              automaticLayout: true,
              tabSize: 4,
              detectIndentation: true,
            }}
          />
        )}
      </div>

      {tab && (
        <div className="editor-status">
          <span className="mono">{tab.language}</span>
          {tab.readOnly && (
            <span className="tag">
              <Lock size={10} /> Read-only
            </span>
          )}
          {tab.kind === "diff" && <span className="tag tag--info">{tab.diff?.staged ? "HEAD ↔ staged" : "staged ↔ working tree"}</span>}
          {tab.kind === "proposal" && <span className="tag tag--accent">AI proposal · current ↔ proposed</span>}
          {isDirty(tab) && <span className="tag tag--warn">Unsaved</span>}
          {tab.kind === "file" && !tab.binary && <LspStatus path={tab.path} />}
          <span className="editor-status__path mono truncate">{tab.path}</span>
          {tab.kind === "proposal" && (
            <>
              <button className="btn btn--sm btn--ghost" onClick={() => void closeTab(tab.key)}>
                Discard
              </button>
              <button className="btn btn--sm btn--primary" onClick={() => void useDev.getState().applyProposal(tab.key)}>
                Apply to file
              </button>
            </>
          )}
          {tab.kind === "file" && (
            <>
              <button className="btn btn--sm btn--ghost" disabled={!isDirty(tab)} onClick={() => void save(tab.key)}>
                Save
              </button>
              <button className="btn btn--sm" onClick={() => onRun(tab.path)} title="Run this file in a terminal">
                <Play size={11} /> Run
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
