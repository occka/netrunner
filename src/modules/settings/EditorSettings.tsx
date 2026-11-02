import { DEFAULT_EDITOR, useSettings, type EditorPrefs } from "@/stores/settings";

const FONTS = [
  ['"JetBrains Mono", Consolas, monospace', "JetBrains Mono"],
  ['"Cascadia Code", "Cascadia Mono", Consolas, monospace', "Cascadia Code"],
  ['Consolas, "Courier New", monospace', "Consolas"],
  ['"Fira Code", Consolas, monospace', "Fira Code (if installed)"],
] as const;

/** DEVELOPER editor preferences. An .editorconfig in a project wins for its files. */
export function EditorSettings() {
  const prefs = useSettings((s) => s.values["developer.editor"]);
  const formatOnSave = useSettings((s) => s.values["developer.format_on_save"]);
  const set = useSettings((s) => s.set);
  const update = (patch: Partial<EditorPrefs>) => void set("developer.editor", { ...prefs, ...patch });
  const check = (key: "insertSpaces" | "wordWrap" | "minimap" | "trimTrailingWhitespace" | "insertFinalNewline", label: string) => (
    <label className="check">
      <input type="checkbox" checked={prefs[key]} onChange={(e) => update({ [key]: e.target.checked })} />
      {label}
    </label>
  );

  return (
    <section className="panel settings-group" id="settings-editor">
      <header className="panel__header">
        <h2 className="panel__title">Code editor</h2>
        <button className="btn btn--sm btn--ghost" style={{ marginLeft: "auto" }} onClick={() => void set("developer.editor", DEFAULT_EDITOR)}>
          Reset
        </button>
      </header>
      <div className="panel__body settings-rows">
        <div className="settings-row">
          <div>Font</div>
          <select className="input" value={prefs.fontFamily} onChange={(e) => update({ fontFamily: e.target.value })}>
            {FONTS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
            {!FONTS.some(([v]) => v === prefs.fontFamily) && <option value={prefs.fontFamily}>{prefs.fontFamily}</option>}
          </select>
        </div>
        <div className="settings-row">
          <div>Font size</div>
          <input
            className="input"
            type="number"
            min={8}
            max={32}
            value={prefs.fontSize}
            onChange={(e) => update({ fontSize: Math.min(32, Math.max(8, Number(e.target.value) || DEFAULT_EDITOR.fontSize)) })}
            style={{ width: 80 }}
          />
        </div>
        <div className="settings-row">
          <div>
            <div>Indentation</div>
            <div className="field__hint">Used for new files; existing files keep their detected indentation, and .editorconfig wins.</div>
          </div>
          <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
            <div className="segmented">
              {[2, 4, 8].map((n) => (
                <button key={n} aria-pressed={prefs.tabSize === n} onClick={() => update({ tabSize: n })}>
                  {n}
                </button>
              ))}
            </div>
            {check("insertSpaces", "Spaces")}
          </div>
        </div>
        <div className="settings-row">
          <div>View</div>
          <div style={{ display: "flex", gap: 12 }}>
            {check("wordWrap", "Word wrap")}
            {check("minimap", "Minimap")}
          </div>
        </div>
        <div className="settings-row">
          <div>
            <div>Auto save</div>
            <div className="field__hint">After a delay saves 1 s after you stop typing; on focus change saves when the editor or window loses focus.</div>
          </div>
          <div className="segmented">
            {(
              [
                ["off", "Off"],
                ["afterDelay", "After delay"],
                ["onFocusChange", "On focus change"],
              ] as const
            ).map(([v, label]) => (
              <button key={v} aria-pressed={prefs.autoSave === v} onClick={() => update({ autoSave: v })}>
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className="settings-row">
          <div>On save</div>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            <label className="check">
              <input type="checkbox" checked={formatOnSave} onChange={(e) => void set("developer.format_on_save", e.target.checked)} />
              Format (language server)
            </label>
            {check("trimTrailingWhitespace", "Trim trailing whitespace")}
            {check("insertFinalNewline", "Final newline")}
          </div>
        </div>
      </div>
    </section>
  );
}
