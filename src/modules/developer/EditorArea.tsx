import { useEffect, useRef, useState } from "react";
import { DiffEditor, Editor, type OnMount } from "@monaco-editor/react";
import { Code2, Columns2, Lock, Play, X } from "lucide-react";
import { useSettings } from "@/stores/settings";
import { applyMonacoTheme, monaco } from "./monaco";
import { currentKey, isDirty, useDev, type EditorTab } from "./store";
import { fileIcon } from "./fileIcons";
import { applyMarkers, fileModelUri, previewModels, takeReveal, useLsp } from "./lsp/client";
import { LspStatus } from "./lsp/LspStatus";
import { applyFileConfig, cursorMemory, saveOnFocusChange, saveSessionSoon, takeRestoredCursor } from "./editorPrefs";
import { pathKey } from "./lsp/convert";
import { attachGit, registerConflictLenses } from "./gitEditor";

/** File tabs use real file URIs so language servers and Go to Definition can address them. */
const modelUri = (tab: EditorTab) => (tab.kind === "file" ? fileModelUri(tab.path).toString() : `inmemory://nr/${encodeURIComponent(tab.key)}`);

const TAB_MIME = "application/x-netrunner-tab";

/** The last focused code editor, so NEURAL can attach the user's current selection. */
let currentEditor: monaco.editor.IStandaloneCodeEditor | null = null;

export function getEditorSelection(): { label: string; text: string } | null {
  const ed = currentEditor;
  const sel = ed?.getSelection();
  const model = ed?.getModel();
  if (!ed || !sel || !model || sel.isEmpty()) return null;
  const s = useDev.getState();
  const name = s.tabs.find((t) => t.key === currentKey(s))?.name ?? "editor";
  return { label: `${name}:${sel.startLineNumber}-${sel.endLineNumber}`, text: model.getValueInRange(sel) };
}

export function EditorArea({ onRun }: { onRun: (path: string) => void }) {
  const tabs = useDev((s) => s.tabs);
  const split = useDev((s) => s.split);
  const theme = useSettings((s) => s.values.theme);

  useEffect(() => applyMonacoTheme(theme), [theme]);
  useEffect(registerConflictLenses, []);

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

  return (
    <div className={`editor-area${split ? " editor-area--split" : ""}`}>
      <EditorGroup group={0} onRun={onRun} />
      {split && <EditorGroup group={1} onRun={onRun} />}
    </div>
  );
}

function EditorGroup({ group, onRun }: { group: 0 | 1; onRun: (path: string) => void }) {
  const allTabs = useDev((s) => s.tabs);
  const right = useDev((s) => s.right);
  const active = useDev((s) => (group === 0 ? s.active : s.activeRight));
  const split = useDev((s) => s.split);
  const focused = useDev((s) => s.focus === group);
  const { setActive, closeTab, setContent, save, moveToGroup, toggleSplit, setFocus } = useDev.getState();
  const prefs = useSettings((s) => s.values["developer.editor"]);
  const tabs = allTabs.filter((t) => right.includes(t.key) === (group === 1));
  const tab = tabs.find((t) => t.key === active);
  const activeRef = useRef(active);
  activeRef.current = active;
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const [dropping, setDropping] = useState(false);

  // Go to Definition into another file: reveal the target once its tab is shown.
  const revealTick = useLsp((s) => s.revealTick);
  useEffect(() => {
    const ed = editorRef.current;
    if (!ed || !tab || tab.kind !== "file") return;
    const range = takeReveal(tab.path);
    if (!range) return;
    ed.setSelection(range);
    ed.revealRangeInCenterIfOutsideViewport(range);
    ed.focus();
  }, [active, revealTick]); // the reveal waits for the tab switch, not for every tab change

  const onModel = (editor: monaco.editor.IStandaloneCodeEditor) => {
    const model = editor.getModel();
    if (!model || model.uri.scheme !== "file") return;
    const path = model.uri.fsPath;
    void applyFileConfig(model, path);
    applyMarkers(path);
    const restored = takeRestoredCursor(path);
    if (restored) {
      const pos = { lineNumber: restored.line, column: restored.column };
      editor.setPosition(pos);
      editor.revealPositionInCenter(pos);
    }
  };

  const onMount: OnMount = (editor) => {
    editorRef.current = editor;
    currentEditor = editor;
    editor.onDidDispose(() => {
      if (currentEditor === editor) currentEditor = null;
    });
    editor.onDidFocusEditorText(() => {
      currentEditor = editor;
      useDev.getState().setFocus(group);
    });
    editor.onDidBlurEditorWidget(saveOnFocusChange);
    editor.onDidChangeModel(() => onModel(editor));
    const git = attachGit(editor);
    editor.onDidDispose(() => git.dispose());
    editor.onDidChangeCursorPosition((e) => {
      const model = editor.getModel();
      if (model?.uri.scheme !== "file") return;
      cursorMemory.set(pathKey(model.uri.fsPath), { line: e.position.lineNumber, column: e.position.column });
      saveSessionSoon();
    });
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      if (activeRef.current) void useDev.getState().save(activeRef.current);
    });
    // Ctrl+\ splits the editor, like VS Code.
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Backslash, () => {
      const key = activeRef.current;
      if (!key) return;
      if (group === 0) useDev.getState().moveToGroup(key, 1);
      else useDev.getState().moveToGroup(key, 0);
    });
    onModel(editor);
  };

  const onDrop = (e: React.DragEvent) => {
    const key = e.dataTransfer.getData(TAB_MIME);
    setDropping(false);
    if (!key) return;
    e.preventDefault();
    moveToGroup(key, group);
  };
  const dragProps = {
    onDragOver: (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes(TAB_MIME)) return;
      e.preventDefault();
      setDropping(true);
    },
    onDragLeave: () => setDropping(false),
    onDrop,
  };

  return (
    <div className={`editor-group${focused && split ? " editor-group--focused" : ""}${dropping ? " editor-group--drop" : ""}`} onMouseDown={() => setFocus(group)}>
      <div className="editor-tabs" role="tablist" {...dragProps}>
        {tabs.map((t) => {
          const Icon = fileIcon({ name: t.name, isDir: false });
          return (
            <div
              key={t.key}
              role="tab"
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData(TAB_MIME, t.key);
                e.dataTransfer.effectAllowed = "move";
              }}
              aria-selected={t.key === active}
              className={`editor-tab${t.kind !== "file" ? " editor-tab--diff" : ""}`}
              onClick={() => setActive(t.key)}
              onAuxClick={(e) => e.button === 1 && void closeTab(t.key)}
              title={`${t.path}\nDrag to the other side to split`}
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
        <span className="editor-tabs__spacer" />
        {group === 0 && !split && (
          <button className="icon-btn icon-btn--sm editor-tabs__action" title="Split editor (Ctrl+\)" onClick={toggleSplit}>
            <Columns2 size={13} />
          </button>
        )}
        {group === 1 && (
          <button className="icon-btn icon-btn--sm editor-tabs__action" title="Close the right group (its tabs move left)" onClick={toggleSplit}>
            <X size={13} />
          </button>
        )}
      </div>

      <div className="editor-body" {...dragProps}>
        {!tab ? (
          <div className="empty editor-empty">
            <Code2 size={30} strokeWidth={1} />
            {group === 1 ? (
              <div>Drag a tab here, or use “Open to the side” in the explorer.</div>
            ) : (
              <>
                <div>Open a file from the explorer, or a change from the Git panel.</div>
                <div className="muted">
                  Ctrl+P go to file · Ctrl+Shift+F search · Ctrl+S save · F12 definition · F2 rename · Ctrl+\ split · middle-click closes a tab
                </div>
              </>
            )}
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
            options={{ readOnly: true, renderSideBySide: true, minimap: { enabled: false }, fontFamily: prefs.fontFamily, fontSize: prefs.fontSize }}
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
              fontFamily: prefs.fontFamily,
              fontSize: prefs.fontSize,
              fontLigatures: true,
              minimap: { enabled: prefs.minimap, scale: 1 },
              wordWrap: prefs.wordWrap ? "on" : "off",
              smoothScrolling: true,
              renderWhitespace: "selection",
              bracketPairColorization: { enabled: true },
              scrollBeyondLastLine: false,
              automaticLayout: true,
              tabSize: prefs.tabSize,
              insertSpaces: prefs.insertSpaces,
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
          {tab.kind === "diff" && <span className="tag tag--info">{tab.diff?.label ? "compare" : tab.diff?.staged ? "HEAD ↔ staged" : "staged ↔ working tree"}</span>}
          {tab.kind === "proposal" && <span className="tag tag--accent">AI proposal · current ↔ proposed</span>}
          {isDirty(tab) && <span className="tag tag--warn">Unsaved</span>}
          {tab.kind === "file" && !tab.binary && <LspStatus path={tab.path} />}
          <span className="editor-status__path mono truncate">{tab.diff?.label ?? tab.path}</span>
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
