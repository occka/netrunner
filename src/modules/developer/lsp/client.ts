/**
 * A light LSP client on top of Monaco (no monaco-languageclient: it pulls in
 * the VS Code API). Open editor tabs are mirrored to the language servers in
 * the backend; Monaco providers are registered once for every language and
 * answer only for models whose file has a ready server.
 */
import { Channel } from "@tauri-apps/api/core";
import { create } from "zustand";
import { api } from "@/services/api";
import { confirmAction } from "@/stores/confirm";
import { notify, reportError } from "@/stores/notifications";
import type { LspDiagnostic, LspEvent, LspOpened, LspRange, LspTextEdit, LspWorkspaceEdit } from "@/types/dev";
import { monaco } from "../monaco";
import { languageFor } from "../languages";
import { reloadHooks, saveHooks, useDev, type EditorTab } from "../store";
import { useSettings } from "@/stores/settings";
import { applySaveFixes } from "../editorPrefs";
import { onTaskProblems } from "../tasks";
import { runInTerminal } from "../terminals";
import {
  applyTextEdits,
  completionKind,
  diagnosticCode,
  locations,
  markerSeverity,
  markupToMarkdown,
  pathKey,
  symbolKind,
  toLspPosition,
  toLspRange,
  toMonacoRange,
  uriToPath,
  workspaceEditFiles,
} from "./convert";

type Caps = Record<string, any>;

export interface DocState {
  path: string;
  state: LspOpened["state"] | "opening";
  version: number;
  uri?: string;
  server?: string;
  spec?: string;
  name?: string;
  install?: string | null;
  message?: string;
}

export interface ServerState {
  spec: string;
  state: "starting" | "ready" | "crashed" | "stopped";
  message: string | null;
  progress: string | null;
}

interface LspStore {
  docs: Record<string, DocState>;
  servers: Record<string, ServerState>;
  diagnostics: Record<string, { path: string; items: LspDiagnostic[] }>;
  /** Problems found in task output (compiler errors from Run/Test). */
  taskDiagnostics: Record<string, { path: string; items: LspDiagnostic[] }>;
  /** Bumped when a Go to Definition target waits to be revealed. */
  revealTick: number;
}

export const useLsp = create<LspStore>(() => ({ docs: {}, servers: {}, diagnostics: {}, taskDiagnostics: {}, revealTick: 0 }));

const capabilities = new Map<string, Caps>();
const MARKER_OWNER = "lsp";
const TASK_OWNER = "task";
const CHANGE_DEBOUNCE_MS = 150;

const setDoc = (path: string, patch: Partial<DocState>) =>
  useLsp.setState((s) => {
    const key = pathKey(path);
    const prev = s.docs[key] ?? { path, state: "opening" as const, version: 1 };
    return { docs: { ...s.docs, [key]: { ...prev, ...patch } } };
  });

const setServer = (key: string, patch: Partial<ServerState> & { spec: string }) =>
  useLsp.setState((s) => ({
    servers: { ...s.servers, [key]: { ...(s.servers[key] ?? { state: "starting", message: null, progress: null }), ...patch } },
  }));

// ---------- Models ----------

export const fileModelUri = (path: string) => monaco.Uri.file(path);

export function modelFor(path: string): monaco.editor.ITextModel | null {
  const key = pathKey(path);
  return monaco.editor.getModels().find((m) => m.uri.scheme === "file" && pathKey(m.uri.fsPath) === key) ?? null;
}

/** Read-only models of files that are not open as tabs, for peek views. */
export const previewModels = new Set<string>();
const MAX_PREVIEWS = 200;

async function ensureModels(paths: string[]) {
  for (const path of [...new Set(paths.map(pathKey))].slice(0, 30)) {
    if (modelFor(path)) continue;
    try {
      const f = await api.dev.readFile(path);
      if (f.binary || modelFor(f.path)) continue;
      const model = monaco.editor.createModel(f.content, languageFor(f.path), fileModelUri(f.path));
      previewModels.add(model.uri.toString());
    } catch {
      // Outside the open projects (e.g. a library's sources): no preview.
    }
  }
  if (previewModels.size > MAX_PREVIEWS) {
    for (const uri of [...previewModels].slice(0, previewModels.size - MAX_PREVIEWS)) {
      monaco.editor.getModel(monaco.Uri.parse(uri))?.dispose();
      previewModels.delete(uri);
    }
  }
}

/** The URI of the existing model for a path (paths from servers may differ in case). */
const resourceFor = (path: string) => modelFor(path)?.uri ?? fileModelUri(path);

function readyDoc(model: monaco.editor.ITextModel): (DocState & { server: string; uri: string }) | null {
  if (model.uri.scheme !== "file") return null;
  const d = useLsp.getState().docs[pathKey(model.uri.fsPath)];
  return d?.state === "ready" && d.server && d.uri ? (d as DocState & { server: string; uri: string }) : null;
}

const caps = (d: { server: string }): Caps => capabilities.get(d.server) ?? {};

// ---------- Document sync ----------

const pendingText = new Map<string, { text: string; timer: number }>();

async function flush(path: string) {
  const key = pathKey(path);
  const pending = pendingText.get(key);
  if (!pending) return;
  const doc = useLsp.getState().docs[key];
  if (doc?.state !== "ready" || !doc.uri) return;
  clearTimeout(pending.timer);
  pendingText.delete(key);
  const version = doc.version + 1;
  setDoc(path, { version });
  await api.lsp.change(doc.uri, version, pending.text).catch(() => undefined);
}

function scheduleChange(path: string, text: string) {
  const key = pathKey(path);
  const prev = pendingText.get(key);
  if (prev) clearTimeout(prev.timer);
  pendingText.set(key, { text, timer: window.setTimeout(() => void flush(path), CHANGE_DEBOUNCE_MS) });
}

async function openDoc(tab: EditorTab) {
  setDoc(tab.path, { path: tab.path, state: "opening", version: 1 });
  let res: LspOpened;
  try {
    res = await api.lsp.open(tab.path, 1, tab.content);
  } catch (err) {
    res = { state: "failed", spec: "", name: "", message: String((err as { message?: string })?.message ?? err) };
  }
  const stillOpen = useDev.getState().tabs.some((t) => t.kind === "file" && pathKey(t.path) === pathKey(tab.path));
  if (res.state === "ready") {
    capabilities.set(res.server, res.capabilities);
    setDoc(tab.path, { state: "ready", uri: res.uri, server: res.server, spec: res.spec, name: res.name, version: 1 });
    if (!useLsp.getState().servers[res.server]) setServer(res.server, { spec: res.spec, state: "ready" });
    setBuiltins(res.spec, false);
    if (!stillOpen) return closeDoc(tab.path);
    applyMarkers(tab.path);
    void flush(tab.path);
  } else if (res.state === "unsupported") {
    setDoc(tab.path, { state: "unsupported" });
  } else {
    setDoc(tab.path, {
      state: res.state,
      spec: res.spec,
      name: res.name,
      install: res.state === "missing" ? res.install : null,
      message: res.state === "failed" ? res.message : undefined,
    });
  }
}

function closeDoc(path: string) {
  const key = pathKey(path);
  const doc = useLsp.getState().docs[key];
  const pending = pendingText.get(key);
  if (pending) clearTimeout(pending.timer);
  pendingText.delete(key);
  useLsp.setState((s) => {
    const docs = { ...s.docs };
    delete docs[key];
    return { docs };
  });
  if (doc?.uri) void api.lsp.close(doc.uri).catch(() => undefined);
}

function sync(tabs: EditorTab[], prev: EditorTab[]) {
  const files = (list: EditorTab[]) => new Map(list.filter((t) => t.kind === "file" && !t.binary).map((t) => [pathKey(t.path), t]));
  const now = files(tabs);
  const before = files(prev);
  for (const [key, tab] of now) {
    const old = before.get(key);
    if (!old) void openDoc(tab);
    else if (old.content !== tab.content) scheduleChange(tab.path, tab.content);
  }
  for (const [key, tab] of before) if (!now.has(key)) closeDoc(tab.path);
}

/** Opens again every document of a server kind (after Install, Locate… or Enable). */
export function retrySpec(spec: string) {
  for (const tab of useDev.getState().tabs) {
    const d = useLsp.getState().docs[pathKey(tab.path)];
    if (tab.kind === "file" && d && d.spec === spec && d.state !== "ready") void openDoc(tab);
  }
}

export async function restartServer(server: string) {
  try {
    await api.lsp.restart(server);
    setServer(server, { spec: server.split("|")[0], state: "ready", message: null });
    for (const [, d] of Object.entries(useLsp.getState().docs)) if (d.server === server) void flush(d.path);
  } catch (err) {
    reportError("Could not restart the language server", err);
  }
}

// ---------- Diagnostics ----------

/** Language-server and task markers for a file's model (if it is open). */
export function applyMarkers(path: string) {
  const model = modelFor(path);
  if (!model) return;
  const s = useLsp.getState();
  setMarkers(model, MARKER_OWNER, s.diagnostics[pathKey(path)]?.items ?? []);
  setMarkers(model, TASK_OWNER, s.taskDiagnostics[pathKey(path)]?.items ?? []);
}

function setMarkers(model: monaco.editor.ITextModel, owner: string, items: LspDiagnostic[]) {
  monaco.editor.setModelMarkers(
    model,
    owner,
    items.map((d) => ({
      ...toMonacoRange(d.range),
      severity: markerSeverity(d.severity),
      message: d.message,
      source: d.source,
      code: diagnosticCode(d),
      tags: d.tags?.filter((t) => t === 1 || t === 2),
    })),
  );
}

const overlaps = (a: LspRange, b: LspRange) =>
  !(a.end.line < b.start.line || (a.end.line === b.start.line && a.end.character < b.start.character) || b.end.line < a.start.line || (b.end.line === a.start.line && b.end.character < a.start.character));

// ---------- Events ----------

function onEvent(e: LspEvent) {
  switch (e.type) {
    case "diagnostics": {
      const path = e.path ?? uriToPath(e.uri);
      if (!path) return;
      useLsp.setState((s) => ({ diagnostics: { ...s.diagnostics, [pathKey(path)]: { path, items: e.diagnostics } } }));
      applyMarkers(path);
      break;
    }
    case "status": {
      setServer(e.server, { spec: e.spec, state: e.state, message: e.message, progress: null });
      if (e.state === "crashed") {
        notify.warn(`Language server ${e.spec} stopped unexpectedly`, "It restarts on the next edit (up to 3 times in 5 minutes).");
        setBuiltins(e.spec, true);
      }
      break;
    }
    case "progress": {
      const v = e.value;
      if (!v) return;
      const server = useLsp.getState().servers[e.server];
      // "report" may carry only a percentage; keep the title from "begin".
      const text = [v.title, v.message, v.percentage != null ? `${v.percentage}%` : null].filter(Boolean).join(" · ");
      const progress = v.kind === "end" ? null : text || server?.progress || null;
      setServer(e.server, { spec: server?.spec ?? e.server.split("|")[0], progress });
      break;
    }
    case "applyEdit":
      void applyWorkspaceEdit(e.edit, e.label ?? "Language server edit");
      break;
    case "log":
      if (e.level <= 1) console.warn(`[lsp ${e.server}]`, e.message);
      break;
  }
}

// ---------- Edits ----------

/** Applies a WorkspaceEdit: open tabs are edited in place (undoable), closed files are written after confirmation. */
export async function applyWorkspaceEdit(edit: LspWorkspaceEdit, label: string): Promise<boolean> {
  const { files, resourceOps } = workspaceEditFiles(edit);
  if (resourceOps) notify.warn(`${label}: ${resourceOps} file create/rename/delete step(s) skipped`, "Do them in the explorer if needed.");
  const dev = useDev.getState();
  const tabFor = (path: string) => dev.tabs.find((t) => t.kind === "file" && pathKey(t.path) === pathKey(path));
  const closed = files.filter((f) => !tabFor(f.path));
  if (closed.length) {
    const ok = await confirmAction({
      title: label,
      message: `This changes ${closed.length} file(s) that are not open. Write them now?`,
      detail: closed
        .slice(0, 12)
        .map((f) => f.path)
        .join("\n") + (closed.length > 12 ? `\n… and ${closed.length - 12} more` : ""),
      confirmLabel: "Write files",
    });
    if (!ok) return false;
  }
  try {
    for (const f of files) {
      const tab = tabFor(f.path);
      const model = modelFor(f.path);
      const monacoEdits = f.edits.map((e: LspTextEdit) => ({ range: toMonacoRange(e.range), text: e.newText }));
      if (tab) {
        if (model) {
          model.pushEditOperations([], monacoEdits, () => null);
          useDev.getState().setContent(tab.key, model.getValue());
        } else {
          useDev.getState().setContent(tab.key, applyTextEdits(tab.content, f.edits));
        }
      } else {
        const current = await api.dev.readFile(f.path);
        const next = applyTextEdits(current.content, f.edits);
        await api.dev.writeFile(f.path, next);
        if (model) model.setValue(next);
      }
    }
    if (files.length > 1) notify.success(`${label}: ${files.length} files changed`);
    useDev.getState().bump();
    return true;
  } catch (err) {
    reportError(`${label} failed`, err);
    return false;
  }
}

/** Formats a file through its server; returns false when no server can. */
export async function formatFile(path: string): Promise<boolean> {
  const model = modelFor(path);
  if (!model) return false;
  const d = readyDoc(model);
  if (!d || !caps(d).documentFormattingProvider) return false;
  await flush(path);
  const options = model.getOptions();
  const edits = await api.lsp
    .request<LspTextEdit[] | null>(d.server, "textDocument/formatting", {
      textDocument: { uri: d.uri },
      options: { tabSize: options.tabSize, insertSpaces: options.insertSpaces },
    })
    .catch(() => null);
  if (!edits?.length) return true;
  model.pushEditOperations([], edits.map((e) => ({ range: toMonacoRange(e.range), text: e.newText })), () => null);
  const tab = useDev.getState().tabs.find((t) => t.kind === "file" && pathKey(t.path) === pathKey(path));
  if (tab) useDev.getState().setContent(tab.key, model.getValue());
  return true;
}

export async function didSave(path: string) {
  await flush(path);
  const d = useLsp.getState().docs[pathKey(path)];
  if (d?.state === "ready" && d.uri) await api.lsp.save(d.uri).catch(() => undefined);
}

export async function installServer(name: string, command: string) {
  const ok = await confirmAction({
    title: `Install the ${name} language server`,
    message: `Run "${command}" in a DEVELOPER terminal?`,
    detail: "The command runs visibly, with your permissions, and may download packages. NETRUNNER never installs anything by itself.",
    confirmLabel: "Run in terminal",
  });
  if (!ok) return;
  useDev.getState().toggleTerminal(true);
  await runInTerminal("Install", command, useDev.getState().root);
  notify.info("Installing in the terminal", "When it finishes, use Retry in the status bar or the Languages panel.");
}

// ---------- Navigation ----------

let pendingReveal: { path: string; range: monaco.IRange } | null = null;

/** Called by the editor after it switched to a model; reveals a pending Go to Definition target. */
export function takeReveal(path: string): monaco.IRange | null {
  if (!pendingReveal || pathKey(pendingReveal.path) !== pathKey(path)) return null;
  const r = pendingReveal.range;
  pendingReveal = null;
  return r;
}

/** Opens a file tab and selects a range (or puts the cursor at a position). */
export async function openAt(path: string, selection: monaco.IRange | monaco.IPosition | null | undefined) {
  const range: monaco.IRange | null = !selection
    ? null
    : "startLineNumber" in selection
      ? selection
      : { startLineNumber: selection.lineNumber, startColumn: selection.column, endLineNumber: selection.lineNumber, endColumn: selection.column };
  pendingReveal = range ? { path, range } : null;
  previewModels.delete(fileModelUri(path).toString());
  await useDev.getState().openFile(path);
  useLsp.setState((s) => ({ revealTick: s.revealTick + 1 }));
}

// ---------- Built-in Monaco language features ----------

function setBuiltins(spec: string, enabled: boolean) {
  const ts = monaco.languages.typescript;
  if (spec === "typescript") {
    const mode = {
      completionItems: enabled,
      hovers: enabled,
      documentSymbols: enabled,
      definitions: enabled,
      references: enabled,
      documentHighlights: enabled,
      rename: enabled,
      diagnostics: enabled,
      documentRangeFormattingEdits: enabled,
      signatureHelp: enabled,
      onTypeFormattingEdits: enabled,
      codeActions: enabled,
      inlayHints: enabled,
    };
    ts.typescriptDefaults.setModeConfiguration(mode);
    ts.javascriptDefaults.setModeConfiguration(mode);
  } else if (spec === "json") {
    monaco.languages.json.jsonDefaults.setModeConfiguration({
      documentFormattingEdits: enabled,
      documentRangeFormattingEdits: enabled,
      completionItems: enabled,
      hovers: enabled,
      documentSymbols: enabled,
      tokens: true,
      colors: true,
      foldingRanges: true,
      diagnostics: enabled,
      selectionRanges: true,
    });
  }
}

// ---------- Providers ----------

const COMPLETION_TRIGGERS = [".", ":", "<", '"', "'", "/", "@", "#", "(", ",", "$", ">", "-", "*", "&", "=", "[", "{", " "];
const LSP_COMMAND = "netrunner.lsp.codeAction";

async function request<T>(d: { server: string; path: string }, method: string, params: unknown): Promise<T | null> {
  await flush(d.path);
  try {
    return await api.lsp.request<T>(d.server, method, params);
  } catch {
    return null;
  }
}

function toLocations(result: unknown, reveal = true): Promise<monaco.languages.Location[]> {
  const list = locations(result)
    .map((l) => ({ path: uriToPath(l.uri), range: l.range }))
    .filter((l): l is { path: string; range: LspRange } => !!l.path);
  const load = reveal ? ensureModels(list.map((l) => l.path)) : Promise.resolve();
  return load.then(() => list.map((l) => ({ uri: resourceFor(l.path), range: toMonacoRange(l.range) })));
}

interface LspCompletionItem {
  label: string;
  labelDetails?: { detail?: string; description?: string };
  kind?: number;
  detail?: string;
  documentation?: string | { kind: string; value: string };
  sortText?: string;
  filterText?: string;
  preselect?: boolean;
  insertText?: string;
  insertTextFormat?: number;
  textEdit?: { range: LspRange; newText: string } | { insert: LspRange; replace: LspRange; newText: string };
  additionalTextEdits?: LspTextEdit[];
  commitCharacters?: string[];
  command?: { title: string; command: string; arguments?: unknown[] };
  tags?: number[];
  deprecated?: boolean;
}

type Suggestion = monaco.languages.CompletionItem & { lspItem?: LspCompletionItem; lspServer?: string; lspPath?: string };

function toSuggestion(it: LspCompletionItem, fallback: monaco.IRange, server: string, path: string, editRange?: LspRange | { insert: LspRange; replace: LspRange }): Suggestion {
  const te = it.textEdit;
  const rangeOf = (r: LspRange | { insert: LspRange; replace: LspRange }) =>
    "insert" in r ? { insert: toMonacoRange(r.insert), replace: toMonacoRange(r.replace) } : toMonacoRange(r);
  const range = te ? ("range" in te ? toMonacoRange(te.range) : rangeOf(te)) : editRange ? rangeOf(editRange) : fallback;
  const doc = it.documentation;
  return {
    label: it.labelDetails ? { label: it.label, detail: it.labelDetails.detail, description: it.labelDetails.description } : it.label,
    kind: completionKind(it.kind),
    detail: it.detail,
    documentation: doc == null ? undefined : { value: markupToMarkdown(doc).join("\n\n") },
    sortText: it.sortText,
    filterText: it.filterText,
    preselect: it.preselect,
    insertText: te?.newText ?? it.insertText ?? it.label,
    insertTextRules: it.insertTextFormat === 2 ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet : undefined,
    range,
    additionalTextEdits: it.additionalTextEdits?.map((e) => ({ range: toMonacoRange(e.range), text: e.newText })),
    commitCharacters: it.commitCharacters,
    // Monaco knows the common editor commands servers ask for (parameter hints, re-suggest).
    command: it.command?.command.startsWith("editor.action.") ? { id: it.command.command, title: it.command.title } : undefined,
    tags: it.deprecated || it.tags?.includes(1) ? [monaco.languages.CompletionItemTag.Deprecated] : undefined,
    lspItem: it,
    lspServer: server,
    lspPath: path,
  };
}

let registered = false;

function registerProviders() {
  if (registered) return;
  registered = true;
  const all = "*";

  monaco.languages.registerCompletionItemProvider(all, {
    triggerCharacters: COMPLETION_TRIGGERS,
    async provideCompletionItems(model, position, context) {
      const d = readyDoc(model);
      const cp = d && caps(d).completionProvider;
      if (!d || !cp) return undefined;
      const triggerChar = context.triggerCharacter;
      const byChar = context.triggerKind === monaco.languages.CompletionTriggerKind.TriggerCharacter;
      if (byChar && !(cp.triggerCharacters ?? []).includes(triggerChar)) return undefined;
      const res = await request<LspCompletionItem[] | { isIncomplete?: boolean; items: LspCompletionItem[]; itemDefaults?: { editRange?: LspRange } }>(
        d,
        "textDocument/completion",
        {
          textDocument: { uri: d.uri },
          position: toLspPosition(position.lineNumber, position.column),
          context: byChar ? { triggerKind: 2, triggerCharacter: triggerChar } : { triggerKind: context.triggerKind === 2 ? 3 : 1 },
        },
      );
      if (!res) return undefined;
      const items = Array.isArray(res) ? res : res.items;
      const word = model.getWordUntilPosition(position);
      const fallback = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
      const editRange = Array.isArray(res) ? undefined : res.itemDefaults?.editRange;
      return {
        incomplete: !Array.isArray(res) && !!res.isIncomplete,
        suggestions: items.slice(0, 2000).map((it) => toSuggestion(it, fallback, d.server, d.path, editRange)),
      };
    },
    async resolveCompletionItem(item: Suggestion) {
      if (!item.lspItem || !item.lspServer || !capabilities.get(item.lspServer)?.completionProvider?.resolveProvider) return item;
      const r = await request<LspCompletionItem>({ server: item.lspServer, path: item.lspPath ?? "" }, "completionItem/resolve", item.lspItem);
      if (!r) return item;
      if (r.documentation != null) item.documentation = { value: markupToMarkdown(r.documentation).join("\n\n") };
      if (r.detail) item.detail = r.detail;
      if (r.additionalTextEdits) item.additionalTextEdits = r.additionalTextEdits.map((e) => ({ range: toMonacoRange(e.range), text: e.newText }));
      return item;
    },
  });

  monaco.languages.registerHoverProvider(all, {
    async provideHover(model, position) {
      const d = readyDoc(model);
      if (!d || !caps(d).hoverProvider) return undefined;
      const res = await request<{ contents: Parameters<typeof markupToMarkdown>[0]; range?: LspRange }>(d, "textDocument/hover", {
        textDocument: { uri: d.uri },
        position: toLspPosition(position.lineNumber, position.column),
      });
      const contents = markupToMarkdown(res?.contents);
      if (!contents.length) return undefined;
      return { contents: contents.map((value) => ({ value })), range: res?.range ? toMonacoRange(res.range) : undefined };
    },
  });

  monaco.languages.registerSignatureHelpProvider(all, {
    signatureHelpTriggerCharacters: ["(", ",", "<"],
    signatureHelpRetriggerCharacters: [")"],
    async provideSignatureHelp(model, position) {
      const d = readyDoc(model);
      if (!d || !caps(d).signatureHelpProvider) return undefined;
      const res = await request<{
        signatures: { label: string; documentation?: string | { kind: string; value: string }; parameters?: { label: string | [number, number]; documentation?: string | { kind: string; value: string } }[]; activeParameter?: number }[];
        activeSignature?: number;
        activeParameter?: number;
      }>(d, "textDocument/signatureHelp", { textDocument: { uri: d.uri }, position: toLspPosition(position.lineNumber, position.column) });
      if (!res?.signatures?.length) return undefined;
      const md = (x: unknown) => (x == null ? undefined : { value: markupToMarkdown(x as string).join("\n\n") });
      return {
        value: {
          signatures: res.signatures.map((s) => ({
            label: s.label,
            documentation: md(s.documentation),
            parameters: (s.parameters ?? []).map((p) => ({ label: p.label, documentation: md(p.documentation) })),
            activeParameter: s.activeParameter,
          })),
          activeSignature: res.activeSignature ?? 0,
          activeParameter: res.activeParameter ?? 0,
        },
        dispose() {},
      };
    },
  });

  const locationProvider = (method: string, capability: string) => ({
    async provide(model: monaco.editor.ITextModel, position: monaco.Position) {
      const d = readyDoc(model);
      if (!d || !caps(d)[capability]) return undefined;
      const res = await request(d, method, { textDocument: { uri: d.uri }, position: toLspPosition(position.lineNumber, position.column) });
      return toLocations(res);
    },
  });
  const def = locationProvider("textDocument/definition", "definitionProvider");
  monaco.languages.registerDefinitionProvider(all, { provideDefinition: def.provide });
  const typeDef = locationProvider("textDocument/typeDefinition", "typeDefinitionProvider");
  monaco.languages.registerTypeDefinitionProvider(all, { provideTypeDefinition: typeDef.provide });
  const impl = locationProvider("textDocument/implementation", "implementationProvider");
  monaco.languages.registerImplementationProvider(all, { provideImplementation: impl.provide });

  monaco.languages.registerReferenceProvider(all, {
    async provideReferences(model, position, context) {
      const d = readyDoc(model);
      if (!d || !caps(d).referencesProvider) return undefined;
      const res = await request(d, "textDocument/references", {
        textDocument: { uri: d.uri },
        position: toLspPosition(position.lineNumber, position.column),
        context: { includeDeclaration: context.includeDeclaration },
      });
      return toLocations(res);
    },
  });

  monaco.languages.registerDocumentHighlightProvider(all, {
    async provideDocumentHighlights(model, position) {
      const d = readyDoc(model);
      if (!d || !caps(d).documentHighlightProvider) return undefined;
      const res = await request<{ range: LspRange; kind?: number }[]>(d, "textDocument/documentHighlight", {
        textDocument: { uri: d.uri },
        position: toLspPosition(position.lineNumber, position.column),
      });
      return res?.map((h) => ({ range: toMonacoRange(h.range), kind: Math.max(0, (h.kind ?? 1) - 1) }));
    },
  });

  monaco.languages.registerDocumentSymbolProvider(all, {
    displayName: "Language server",
    async provideDocumentSymbols(model) {
      const d = readyDoc(model);
      if (!d || !caps(d).documentSymbolProvider) return undefined;
      type Sym = { name: string; detail?: string; kind: number; range?: LspRange; selectionRange?: LspRange; children?: Sym[]; location?: { range: LspRange }; containerName?: string };
      const res = await request<Sym[]>(d, "textDocument/documentSymbol", { textDocument: { uri: d.uri } });
      const conv = (s: Sym): monaco.languages.DocumentSymbol => {
        const range = toMonacoRange(s.range ?? s.location!.range);
        return {
          name: s.name,
          detail: s.detail ?? "",
          kind: symbolKind(s.kind),
          tags: [],
          containerName: s.containerName,
          range,
          selectionRange: s.selectionRange ? toMonacoRange(s.selectionRange) : range,
          children: s.children?.map(conv),
        };
      };
      return res?.filter((s) => s.range || s.location).map(conv);
    },
  });

  monaco.languages.registerRenameProvider(all, {
    async resolveRenameLocation(model, position) {
      const d = readyDoc(model);
      const rp = d && caps(d).renameProvider;
      const word = model.getWordAtPosition(position);
      const wordRange = word ? new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn) : null;
      if (!d || !rp) return wordRange ? { range: wordRange, text: word!.word, rejectReason: "No language server can rename here" } : undefined;
      if (typeof rp === "object" && rp.prepareProvider) {
        const res = await request<LspRange | { range: LspRange; placeholder: string } | { defaultBehavior: boolean } | null>(d, "textDocument/prepareRename", {
          textDocument: { uri: d.uri },
          position: toLspPosition(position.lineNumber, position.column),
        });
        if (!res) return { range: wordRange ?? new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column), text: "", rejectReason: "This symbol cannot be renamed" };
        if ("range" in res) return { range: toMonacoRange(res.range), text: res.placeholder };
        if ("start" in res) {
          const range = toMonacoRange(res);
          return { range, text: model.getValueInRange(range) };
        }
      }
      return wordRange ? { range: wordRange, text: word!.word } : undefined;
    },
    async provideRenameEdits(model, position, newName) {
      const d = readyDoc(model);
      if (!d || !caps(d).renameProvider) return undefined;
      const edit = await request<LspWorkspaceEdit>(d, "textDocument/rename", {
        textDocument: { uri: d.uri },
        position: toLspPosition(position.lineNumber, position.column),
        newName,
      });
      if (!edit) return { edits: [], rejectReason: "The language server returned no changes" };
      // Applied here (open tabs undoably, closed files after confirmation) instead of Monaco's bulk edit, which only knows open models.
      await applyWorkspaceEdit(edit, `Rename to ${newName}`);
      return { edits: [] };
    },
  });

  const formatOptions = (o: monaco.languages.FormattingOptions) => ({ tabSize: o.tabSize, insertSpaces: o.insertSpaces });
  monaco.languages.registerDocumentFormattingEditProvider(all, {
    displayName: "Language server",
    async provideDocumentFormattingEdits(model, options) {
      const d = readyDoc(model);
      if (!d || !caps(d).documentFormattingProvider) return undefined;
      const res = await request<LspTextEdit[]>(d, "textDocument/formatting", { textDocument: { uri: d.uri }, options: formatOptions(options) });
      return res?.map((e) => ({ range: toMonacoRange(e.range), text: e.newText }));
    },
  });
  monaco.languages.registerDocumentRangeFormattingEditProvider(all, {
    displayName: "Language server",
    async provideDocumentRangeFormattingEdits(model, range, options) {
      const d = readyDoc(model);
      if (!d || !caps(d).documentRangeFormattingProvider) return undefined;
      const res = await request<LspTextEdit[]>(d, "textDocument/rangeFormatting", {
        textDocument: { uri: d.uri },
        range: toLspRange(range),
        options: formatOptions(options),
      });
      return res?.map((e) => ({ range: toMonacoRange(e.range), text: e.newText }));
    },
  });

  monaco.editor.registerCommand(LSP_COMMAND, (_accessor, server: string, action: Caps) => void runCodeAction(server, action));
  monaco.languages.registerCodeActionProvider(all, {
    async provideCodeActions(model, range, context) {
      const d = readyDoc(model);
      if (!d || !caps(d).codeActionProvider) return undefined;
      const lspRange = toLspRange(range);
      const diagnostics = (useLsp.getState().diagnostics[pathKey(d.path)]?.items ?? []).filter((x) => overlaps(x.range, lspRange));
      const res = await request<Caps[]>(d, "textDocument/codeAction", {
        textDocument: { uri: d.uri },
        range: lspRange,
        context: { diagnostics, only: context.only ? [context.only] : undefined, triggerKind: context.trigger === 1 ? 1 : 2 },
      });
      const actions: monaco.languages.CodeAction[] = (res ?? []).map((a) => ({
        title: a.title,
        kind: typeof a.command === "string" ? undefined : a.kind,
        isPreferred: a.isPreferred,
        disabled: a.disabled?.reason,
        command: { id: LSP_COMMAND, title: a.title, arguments: [d.server, a] },
      }));
      return { actions, dispose() {} };
    },
  });

  monaco.languages.registerInlayHintsProvider(all, {
    async provideInlayHints(model, range) {
      const d = readyDoc(model);
      if (!d || !caps(d).inlayHintProvider) return undefined;
      const res = await request<{ position: { line: number; character: number }; label: string | { value: string }[]; kind?: number; paddingLeft?: boolean; paddingRight?: boolean }[]>(
        d,
        "textDocument/inlayHint",
        { textDocument: { uri: d.uri }, range: toLspRange(range) },
      );
      return {
        hints: (res ?? []).map((h) => ({
          label: typeof h.label === "string" ? h.label : h.label.map((p) => p.value).join(""),
          position: { lineNumber: h.position.line + 1, column: h.position.character + 1 },
          kind: h.kind === 2 ? monaco.languages.InlayHintKind.Parameter : monaco.languages.InlayHintKind.Type,
          paddingLeft: h.paddingLeft,
          paddingRight: h.paddingRight,
        })),
        dispose() {},
      };
    },
  });

  monaco.editor.registerEditorOpener({
    openCodeEditor(_source, resource, selectionOrPosition) {
      if (resource.scheme !== "file") return false;
      void openAt(resource.fsPath, selectionOrPosition);
      return true;
    },
  });
}

async function runCodeAction(server: string, action: Caps) {
  const path = Object.values(useLsp.getState().docs).find((d) => d.server === server)?.path ?? "";
  const d = { server, path };
  let a = action;
  // A bare Command, or an action whose edit is computed on demand.
  if (typeof a.command !== "string" && !a.edit && capabilities.get(server)?.codeActionProvider?.resolveProvider) {
    a = (await request<Caps>(d, "codeAction/resolve", a)) ?? a;
  }
  if (a.edit && !(await applyWorkspaceEdit(a.edit, a.title))) return;
  const cmd = typeof a.command === "string" ? a : a.command;
  if (cmd?.command) {
    const known: string[] = capabilities.get(server)?.executeCommandProvider?.commands ?? [];
    if (known.includes(cmd.command)) await request(d, "workspace/executeCommand", { command: cmd.command, arguments: cmd.arguments });
  }
}

// ---------- Start ----------

let started = false;

/** Called when DEVELOPER mounts; keeps running while the app is open. */
export function startLsp() {
  if (started) return;
  started = true;
  const channel = new Channel<LspEvent>();
  channel.onmessage = onEvent;
  void api.lsp.subscribe(channel).catch((err) => reportError("Language servers are unavailable", err));
  registerProviders();
  // Development builds expose the editor internals for automated UI checks.
  if (import.meta.env.DEV) Object.assign(window, { __nr: { monaco, useLsp, useDev } });
  saveHooks.before = async (tab) => {
    if (useSettings.getState().values["developer.format_on_save"]) await formatFile(tab.path);
    applySaveFixes(tab);
  };
  saveHooks.after = (tab) => didSave(tab.path);
  onTaskProblems((list) => {
    const map: LspStore["taskDiagnostics"] = {};
    for (const { path, problem } of list ?? []) {
      const at = { line: problem.line - 1, character: Math.max(0, problem.column - 1) };
      (map[pathKey(path)] ??= { path, items: [] }).items.push({ range: { start: at, end: at }, severity: problem.severity, message: problem.message, source: problem.source });
    }
    const before = Object.values(useLsp.getState().taskDiagnostics).map((f) => f.path);
    useLsp.setState({ taskDiagnostics: map });
    for (const path of new Set([...before, ...Object.values(map).map((f) => f.path)])) applyMarkers(path);
  });
  // Replace in files rewrote an open file: update its model undoably.
  reloadHooks.add((path, content) => {
    const model = modelFor(path);
    if (model && model.getValue() !== content) model.pushEditOperations([], [{ range: model.getFullModelRange(), text: content }], () => null);
  });
  useDev.subscribe((s, prev) => {
    if (s.tabs !== prev.tabs) sync(s.tabs, prev.tabs);
  });
  sync(useDev.getState().tabs, []);
}

/** Language-server and task problems together, per file. */
export function mergeDiagnostics(a: LspStore["diagnostics"], b: LspStore["taskDiagnostics"]): LspStore["diagnostics"] {
  const out = { ...a };
  for (const [k, f] of Object.entries(b)) out[k] = { path: f.path, items: [...(out[k]?.items ?? []), ...f.items] };
  return out;
}

/** Error and warning counts for one file and for the whole project. */
export function problemCounts(diagnostics: LspStore["diagnostics"], path?: string) {
  const count = (items: LspDiagnostic[]) => ({
    errors: items.filter((d) => (d.severity ?? 1) === 1).length,
    warnings: items.filter((d) => d.severity === 2).length,
  });
  const all = Object.values(diagnostics).flatMap((f) => f.items);
  return { file: count(path ? (diagnostics[pathKey(path)]?.items ?? []) : []), total: count(all) };
}
