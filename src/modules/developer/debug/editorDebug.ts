/**
 * Debugger in the code editor: breakpoints in the glyph margin (conditional
 * ones through the context menu or F9 at the cursor) and the current line.
 */
import { promptText } from "@/stores/prompt";
import { monaco } from "../monaco";
import { pathKey } from "../lsp/convert";
import { useDebug } from "./store";

export function attachDebug(editor: monaco.editor.IStandaloneCodeEditor): monaco.IDisposable {
  const marks = editor.createDecorationsCollection();
  const current = editor.createDecorationsCollection();

  const path = () => {
    const m = editor.getModel();
    return m && m.uri.scheme === "file" ? m.uri.fsPath : null;
  };

  const render = () => {
    const p = path();
    const model = editor.getModel();
    if (!p || !model) {
      marks.clear();
      current.clear();
      return;
    }
    const s = useDebug.getState();
    const items = s.breakpoints[pathKey(p)]?.items ?? [];
    marks.set(
      items
        .filter((b) => b.line <= model.getLineCount())
        .map((b) => ({
          range: new monaco.Range(b.line, 1, b.line, 1),
          options: {
            stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
            glyphMarginClassName: `debug-bp${b.condition ? " debug-bp--cond" : ""}${b.verified === false ? " debug-bp--off" : ""}`,
            glyphMarginHoverMessage: { value: b.condition ? `Breakpoint when \`${b.condition}\`` : b.verified === false ? "Breakpoint (not bound to code)" : "Breakpoint" },
          },
        })),
    );
    const here = s.location && pathKey(s.location.path) === pathKey(p) && s.location.line <= model.getLineCount() ? s.location.line : null;
    current.set(here ? [{ range: new monaco.Range(here, 1, here, 1), options: { isWholeLine: true, className: "debug-line", glyphMarginClassName: "debug-arrow" } }] : []);
  };

  const condition = async (line: number) => {
    const p = path();
    if (!p) return;
    const existing = useDebug.getState().breakpoints[pathKey(p)]?.items.find((b) => b.line === line);
    const value = await promptText({
      title: `Breakpoint on line ${line}`,
      label: "Stop only when this expression is true (empty: always)",
      initial: existing?.condition ?? "",
      placeholder: "count > 10",
      confirmLabel: "Set",
      allowEmpty: true,
    });
    if (value !== null) useDebug.getState().toggleBreakpoint(p, line, value.trim());
  };

  const subs: monaco.IDisposable[] = [
    editor.onDidChangeModel(render),
    editor.onMouseDown((e) => {
      if (e.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN || !e.target.position) return;
      const p = path();
      if (p) useDebug.getState().toggleBreakpoint(p, e.target.position.lineNumber);
    }),
    // Breakpoints travel with their lines while editing.
    editor.onDidChangeModelContent(() => {
      const p = path();
      if (!p) return;
      const lines = marks.getRanges().map((r) => r.startLineNumber);
      if (lines.length) useDebug.getState().setBreakpointLines(p, lines);
    }),
    editor.addAction({
      id: "netrunner.debug.condition",
      label: "Debug: Conditional Breakpoint…",
      contextMenuGroupId: "9_debug",
      run: () => {
        const line = editor.getPosition()?.lineNumber;
        if (line) void condition(line);
      },
    }),
  ];
  const unsubscribe = useDebug.subscribe((s, prev) => {
    if (s.breakpoints !== prev.breakpoints || s.location !== prev.location) render();
  });
  render();
  return {
    dispose: () => {
      unsubscribe();
      subs.forEach((x) => x.dispose());
      marks.clear();
      current.clear();
    },
  };
}
