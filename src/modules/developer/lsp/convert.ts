/**
 * Pure conversions between LSP and Monaco shapes. Both count columns in
 * UTF-16 code units, so positions only shift from 0-based to 1-based.
 * Kept free of Monaco imports so tests can run without a DOM.
 */
import type { LspDiagnostic, LspPosition, LspRange, LspTextEdit, LspWorkspaceEdit } from "@/types/dev";

export interface MonacoRangeLike {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
}

/** `file:///d%3A/x/y.ts` → `D:\x\y.ts`. Null for non-file URIs. */
export function uriToPath(uri: string): string | null {
  const m = /^file:\/\/([^/]*)(\/.*)?$/i.exec(uri);
  if (!m) return null;
  const host = m[1];
  let path = decodeURIComponent(m[2] ?? "/");
  if (host && host.toLowerCase() !== "localhost") return `\\\\${host}${path.replace(/\//g, "\\")}`;
  if (/^\/[a-zA-Z]:/.test(path)) path = path.slice(1);
  path = path.replace(/\//g, "\\");
  return path.replace(/^([a-z]):/, (_, d: string) => `${d.toUpperCase()}:`);
}

/** Case-insensitive key for Windows paths. */
export const pathKey = (p: string) => p.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();

export const toLspPosition = (lineNumber: number, column: number): LspPosition => ({ line: lineNumber - 1, character: column - 1 });

export const toMonacoRange = (r: LspRange): MonacoRangeLike => ({
  startLineNumber: r.start.line + 1,
  startColumn: r.start.character + 1,
  endLineNumber: r.end.line + 1,
  endColumn: r.end.character + 1,
});

export const toLspRange = (r: MonacoRangeLike): LspRange => ({
  start: toLspPosition(r.startLineNumber, r.startColumn),
  end: toLspPosition(r.endLineNumber, r.endColumn),
});

/** LSP DiagnosticSeverity → Monaco MarkerSeverity (Error 8, Warning 4, Info 2, Hint 1). */
export function markerSeverity(severity: number | undefined): number {
  switch (severity) {
    case 2:
      return 4;
    case 3:
      return 2;
    case 4:
      return 1;
    default:
      return 8;
  }
}

export function diagnosticCode(d: LspDiagnostic): string | undefined {
  if (d.code == null) return undefined;
  return typeof d.code === "object" ? String(d.code.value) : String(d.code);
}

// LSP CompletionItemKind (1-based) → Monaco CompletionItemKind.
const COMPLETION_KINDS: Record<number, number> = {
  1: 18, 2: 0, 3: 1, 4: 2, 5: 3, 6: 4, 7: 5, 8: 7, 9: 8, 10: 9, 11: 12, 12: 13, 13: 15,
  14: 17, 15: 27, 16: 19, 17: 20, 18: 21, 19: 23, 20: 16, 21: 14, 22: 6, 23: 10, 24: 11, 25: 24,
};
export const completionKind = (kind: number | undefined) => COMPLETION_KINDS[kind ?? 1] ?? 18;

/** LSP SymbolKind starts at File = 1; Monaco's at File = 0. */
export const symbolKind = (kind: number) => Math.max(0, Math.min(25, kind - 1));

type Markup = string | { kind?: string; value: string; language?: string };

/** MarkedString | MarkedString[] | MarkupContent → markdown strings. */
export function markupToMarkdown(contents: Markup | Markup[] | null | undefined): string[] {
  if (contents == null) return [];
  const list = Array.isArray(contents) ? contents : [contents];
  return list
    .map((c) => {
      if (typeof c === "string") return c;
      if (c.language) return "```" + c.language + "\n" + c.value + "\n```";
      if (c.kind === "plaintext") return c.value.replace(/[\\`*_{}[\]()#+\-.!<>]/g, "\\$&");
      return c.value;
    })
    .filter((s) => s.trim().length > 0);
}

/** Offset of an LSP position in `text` (lines split on \n; \r\n counts as part of the line end). */
export function offsetAt(text: string, pos: LspPosition): number {
  let offset = 0;
  for (let line = 0; line < pos.line; line++) {
    const next = text.indexOf("\n", offset);
    if (next < 0) return text.length;
    offset = next + 1;
  }
  const lineEnd = text.indexOf("\n", offset);
  const end = lineEnd < 0 ? text.length : lineEnd > offset && text[lineEnd - 1] === "\r" ? lineEnd - 1 : lineEnd;
  return Math.min(offset + pos.character, end);
}

/** Applies text edits (all relative to the original text) to a string. */
export function applyTextEdits(text: string, edits: LspTextEdit[]): string {
  const resolved = edits
    .map((e, i) => ({ start: offsetAt(text, e.range.start), end: offsetAt(text, e.range.end), text: e.newText, i }))
    // Back to front so earlier offsets stay valid; equal starts keep their order.
    .sort((a, b) => b.start - a.start || b.i - a.i);
  let out = text;
  for (const e of resolved) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return out;
}

export interface FileEdits {
  path: string;
  edits: LspTextEdit[];
}

/**
 * Text edits of a WorkspaceEdit grouped by file. File creates, renames and
 * deletes are reported separately: NETRUNNER does not apply them silently.
 */
export function workspaceEditFiles(edit: LspWorkspaceEdit): { files: FileEdits[]; resourceOps: number } {
  const byPath = new Map<string, FileEdits>();
  const add = (uri: string, edits: LspTextEdit[]) => {
    const path = uriToPath(uri);
    if (!path || !edits.length) return;
    const key = pathKey(path);
    const entry = byPath.get(key) ?? { path, edits: [] };
    entry.edits.push(...edits);
    byPath.set(key, entry);
  };
  let resourceOps = 0;
  if (edit.documentChanges) {
    for (const change of edit.documentChanges) {
      if ("textDocument" in change) add(change.textDocument.uri, change.edits);
      else resourceOps++;
    }
  } else if (edit.changes) {
    for (const [uri, edits] of Object.entries(edit.changes)) add(uri, edits);
  }
  return { files: [...byPath.values()], resourceOps };
}

/** Normalises Location | Location[] | LocationLink[] to {uri, range} pairs. */
export function locations(result: unknown): { uri: string; range: LspRange }[] {
  if (!result) return [];
  const list = Array.isArray(result) ? result : [result];
  return list
    .map((l: { uri?: string; range?: LspRange; targetUri?: string; targetSelectionRange?: LspRange; targetRange?: LspRange }) =>
      l.targetUri ? { uri: l.targetUri, range: (l.targetSelectionRange ?? l.targetRange)! } : { uri: l.uri!, range: l.range! },
    )
    .filter((l) => typeof l.uri === "string" && !!l.range);
}
