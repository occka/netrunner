import { useEffect, useState } from "react";
import { RotateCcw } from "lucide-react";
import { HotkeyRecorder } from "@/components/HotkeyRecorder";
import { useHotkeys } from "@/stores/hotkeys";
import { useQuickAccess } from "@/stores/quickAccess";
import { reportError } from "@/stores/notifications";

/** Every NETRUNNER key: record a new one, see conflicts, reset to the defaults. */
export function HotkeySettings() {
  const bindings = useHotkeys((s) => s.bindings);
  const load = useHotkeys((s) => s.load);
  const setKey = useHotkeys((s) => s.set);
  const reset = useHotkeys((s) => s.reset);
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => void load().catch((err) => reportError("Could not read the shortcuts", err)), [load]);

  const change = async (id: string, keys: string) => {
    try {
      await setKey(id, keys);
      setErrors((e) => ({ ...e, [id]: "" }));
      if (id.startsWith("entry:")) await useQuickAccess.getState().load();
    } catch (err) {
      setErrors((e) => ({ ...e, [id]: (err as { message?: string })?.message ?? String(err) }));
    }
  };

  return (
    <section className="panel settings-group" id="settings-keyboard">
      <header className="panel__header">
        <h2 className="panel__title">Keyboard</h2>
        <button className="btn btn--sm btn--ghost" style={{ marginLeft: "auto" }} onClick={() => void reset().then(() => setErrors({}), (err) => reportError("Could not reset", err))}>
          <RotateCcw size={12} /> Reset to defaults
        </button>
      </header>
      <div className="panel__body settings-rows">
        {bindings.map((b) => (
          <div key={b.id} className="settings-row">
            <div>
              <div>{b.label}</div>
              <div className="field__hint">
                {b.global ? "Works in any program" : "Works in the NETRUNNER window"}
                {b.default ? ` · default ${b.default}` : ""}
              </div>
              {errors[b.id] ? <div className="field__error">{errors[b.id]}</div> : b.error ? <div className="field__error">{b.keys}: {b.error}. Choose another key.</div> : null}
            </div>
            <HotkeyRecorder value={b.keys} onChange={(keys) => void change(b.id, keys)} />
          </div>
        ))}
        <p className="field__hint">Give any Quick Access entry its own key in its editor. Entry keys work everywhere; an entry of one profile reacts only while that profile is active.</p>
        <dl className="shortcuts">
          <dt>
            <kbd>↑</kbd> <kbd>↓</kbd>
          </dt>
          <dd>Move between navigation items</dd>
          <dt>
            <kbd>Enter</kbd>
          </dt>
          <dd>Launch focused Quick Access entry</dd>
          <dt>
            <kbd>Ctrl</kbd> <kbd>P</kbd> · <kbd>Ctrl</kbd> <kbd>Shift</kbd> <kbd>F</kbd>
          </dt>
          <dd>DEVELOPER: go to file, search in project</dd>
          <dt>
            <kbd>F12</kbd> · <kbd>F2</kbd> · <kbd>Shift</kbd> <kbd>Alt</kbd> <kbd>F</kbd>
          </dt>
          <dd>DEVELOPER: definition, rename, format</dd>
        </dl>
      </div>
    </section>
  );
}
