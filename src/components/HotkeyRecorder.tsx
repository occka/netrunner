import { useEffect, useState } from "react";
import { comboFromEvent } from "@/utils/hotkeys";

/**
 * Press-to-record shortcut field. Esc cancels; Backspace or Delete without a
 * modifier clears. While recording no other shortcut reacts to the keys.
 */
export function HotkeyRecorder({ value, placeholder = "Not set", onChange }: { value: string; placeholder?: string; onChange: (keys: string) => void }) {
  const [recording, setRecording] = useState(false);

  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.code === "Escape") return setRecording(false);
      const plain = !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey;
      if (plain && (e.code === "Backspace" || e.code === "Delete")) {
        setRecording(false);
        return onChange("");
      }
      const combo = comboFromEvent(e);
      if (!combo) return; // only modifiers so far
      setRecording(false);
      onChange(combo);
    };
    const stop = () => setRecording(false);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", stop);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", stop);
    };
  }, [recording, onChange]);

  return (
    <button type="button" className={`hotkey-rec${recording ? " hotkey-rec--on" : ""}`} onClick={() => setRecording((r) => !r)} title="Click, then press the keys. Esc cancels, Backspace clears.">
      {recording ? "Press keys…" : value ? <kbd>{value}</kbd> : <span className="muted">{placeholder}</span>}
    </button>
  );
}
