/**
 * Monaco is bundled locally (no CDN): the loader is pointed at the npm package
 * and language workers are built by Vite as separate worker chunks.
 */
import * as monaco from "monaco-editor";
import { loader } from "@monaco-editor/react";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import jsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import cssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import htmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";
import type { ThemeColors } from "@/styles/theme";
export { languageFor } from "./languages";

self.MonacoEnvironment = {
  getWorker(_id: string, label: string) {
    if (label === "json") return new jsonWorker();
    if (label === "css" || label === "scss" || label === "less") return new cssWorker();
    if (label === "html" || label === "handlebars" || label === "razor") return new htmlWorker();
    if (label === "typescript" || label === "javascript") return new tsWorker();
    return new editorWorker();
  },
};

loader.config({ monaco });

const strip = (hex: string) => hex.replace("#", "");

/** Builds the editor theme from the current NETRUNNER palette. */
export function applyMonacoTheme(c: ThemeColors) {
  monaco.editor.defineTheme("netrunner", {
    base: "vs-dark",
    inherit: true,
    rules: [
      { token: "comment", foreground: strip(c.muted), fontStyle: "italic" },
      { token: "keyword", foreground: strip(c.primary) },
      { token: "string", foreground: strip(c.success) },
      { token: "number", foreground: strip(c.warning) },
      { token: "type", foreground: strip(c.secondary) },
      { token: "type.identifier", foreground: strip(c.secondary) },
    ],
    colors: {
      "editor.background": c.surface,
      "editor.foreground": c.text,
      "editorLineNumber.foreground": c.muted + "99",
      "editorLineNumber.activeForeground": c.primary,
      "editorCursor.foreground": c.primary,
      "editor.selectionBackground": c.primary + "33",
      "editor.lineHighlightBackground": c.elevated,
      "editor.lineHighlightBorder": c.elevated,
      "editorIndentGuide.background1": c.border,
      "editorWidget.background": c.elevated,
      "editorWidget.border": c.border,
      "editorSuggestWidget.selectedBackground": c.primary + "26",
      "scrollbarSlider.background": c.border + "aa",
      "diffEditor.insertedTextBackground": c.success + "22",
      "diffEditor.removedTextBackground": c.critical + "22",
      "minimap.background": c.surface,
    },
  });
  monaco.editor.setTheme("netrunner");
}

export { monaco };
