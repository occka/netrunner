import { useEffect, useRef, useState } from "react";
import { usePrompt } from "@/stores/prompt";
import { Dialog } from "@/components/Dialog";

export function PromptHost() {
  const request = usePrompt((s) => s.request);
  const settle = usePrompt((s) => s.settle);
  if (!request) return null;
  return <PromptDialog key={request.title + request.initial} onDone={settle} {...request} />;
}

function PromptDialog({
  title,
  label,
  initial = "",
  placeholder,
  confirmLabel = "OK",
  selectStem,
  allowEmpty,
  onDone,
}: {
  title: string;
  label: string;
  initial?: string;
  placeholder?: string;
  confirmLabel?: string;
  selectStem?: boolean;
  allowEmpty?: boolean;
  onDone: (v: string | null) => void;
}) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    const dot = initial.lastIndexOf(".");
    if (selectStem && dot > 0) el.setSelectionRange(0, dot);
    else el.select();
  }, [initial, selectStem]);

  return (
    <Dialog
      title={title}
      onClose={() => onDone(null)}
      footer={
        <>
          <button className="btn" onClick={() => onDone(null)}>
            Cancel
          </button>
          <button className="btn btn--primary" type="submit" form="prompt-form" disabled={!allowEmpty && !value.trim()}>
            {confirmLabel}
          </button>
        </>
      }
    >
      <form
        id="prompt-form"
        className="field"
        onSubmit={(e) => {
          e.preventDefault();
          if (allowEmpty || value.trim()) onDone(value.trim());
        }}
      >
        <span className="label">{label}</span>
        <input ref={ref} className="input input--mono" value={value} placeholder={placeholder} onChange={(e) => setValue(e.target.value)} spellCheck={false} />
      </form>
    </Dialog>
  );
}
