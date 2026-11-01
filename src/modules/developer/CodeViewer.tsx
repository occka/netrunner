import { useEffect } from "react";
import { Editor } from "@monaco-editor/react";
import { useSettings } from "@/stores/settings";
import { applyMonacoTheme, languageFor } from "./monaco";

/** Read-only Monaco view of a file that is not on disk (e.g. a GitHub file). Lazy-loaded with Monaco. */
export default function CodeViewer({ path, content }: { path: string; content: string }) {
  const theme = useSettings((s) => s.values.theme);
  useEffect(() => applyMonacoTheme(theme), [theme]);
  return (
    <Editor
      path={`github:/${path}`}
      value={content}
      language={languageFor(path)}
      theme="netrunner"
      options={{
        readOnly: true,
        domReadOnly: true,
        fontFamily: '"JetBrains Mono", Consolas, monospace',
        fontSize: 13,
        minimap: { enabled: true, scale: 1 },
        scrollBeyondLastLine: false,
        automaticLayout: true,
        renderWhitespace: "selection",
      }}
    />
  );
}
