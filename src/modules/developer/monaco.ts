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

/** A colour between two #rrggbb colours, for shades the palette does not name. */
const mix = (a: string, b: string, amount: number) => {
  const channel = (hex: string, i: number) => parseInt(strip(hex).slice(i, i + 2), 16);
  return [0, 2, 4].map((i) => Math.round(channel(a, i) * (1 - amount) + channel(b, i) * amount).toString(16).padStart(2, "0")).join("");
};

/** Builds the editor theme from the current NETRUNNER palette. */
export function applyMonacoTheme(c: ThemeColors) {
  monaco.editor.defineTheme("netrunner", {
    base: "vs-dark",
    inherit: true,
    // Colours for language servers' tokens (see "semanticHighlighting.enabled" in the editor).
    rules: [
      // The base theme would colour these a fixed blue, whatever the palette.
      { token: "variable", foreground: strip(c.text) },
      { token: "function", foreground: mix(c.primary, c.text, 0.45) },
      { token: "method", foreground: mix(c.primary, c.text, 0.45) },
      { token: "macro", foreground: mix(c.warning, c.text, 0.3) },
      { token: "class", foreground: strip(c.secondary) },
      { token: "interface", foreground: strip(c.secondary) },
      { token: "enum", foreground: strip(c.secondary) },
      { token: "struct", foreground: strip(c.secondary) },
      { token: "namespace", foreground: strip(c.secondary) },
      { token: "typeParameter", foreground: strip(c.secondary), fontStyle: "italic" },
      { token: "enumMember", foreground: strip(c.warning) },
      { token: "parameter", fontStyle: "italic" },
      { token: "property", foreground: mix(c.secondary, c.text, 0.6) },
      { token: "decorator", foreground: mix(c.warning, c.text, 0.3) },
      { token: "regexp", foreground: strip(c.warning) },
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
