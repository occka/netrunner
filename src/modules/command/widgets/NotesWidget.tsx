import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { GripVertical, Plus, X } from "lucide-react";
import { Sampling } from "./common";
import { boardKey, listenForNoteChanges, useNotes } from "./notesStore";
import type { WidgetProps } from "./registry";
import type { ConfigOf, NOTES_SETTINGS } from "./settings";
import type { NoteItem } from "@/types/notes";

type Config = ConfigOf<typeof NOTES_SETTINGS>;

export default function NotesWidget({ config: c }: WidgetProps<Config>) {
  const board = boardKey(c.board);
  const data = useNotes((s) => s.boards[board]);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"tasks" | "note">("tasks");

  useEffect(() => {
    listenForNoteChanges();
    setError(null);
    useNotes
      .getState()
      .load(board)
      .catch((e: Error) => setError(e.message));
  }, [board]);

  if (error) return <div className="unavailable">{error}</div>;
  if (!data) return <Sampling />;
  const view = c.view === "tabs" ? tab : c.view;
  const left = data.items.filter((i) => !i.done).length;

  return (
    <div className="notes">
      {c.view === "tabs" && (
        <div className="segmented notes__tabs">
          <button aria-pressed={tab === "tasks"} onClick={() => setTab("tasks")}>
            Tasks{left ? ` · ${left}` : ""}
          </button>
          <button aria-pressed={tab === "note"} onClick={() => setTab("note")}>
            Note
          </button>
        </div>
      )}
      {view === "tasks" ? <Tasks board={board} items={data.items} config={c} /> : <NotePad board={board} text={data.text} />}
    </div>
  );
}

function Tasks({ board, items, config: c }: { board: string; items: NoteItem[]; config: Config }) {
  const { add, update, remove, reorder, clearDone } = useNotes.getState();
  const [draft, setDraft] = useState("");
  // Pointer-driven reordering (HTML drag-and-drop is taken by the window's file drop handler).
  const [drag, setDrag] = useState<{ id: number; order: number[] } | null>(null);

  const visible = items.filter((i) => !(c.hideDone && i.done));
  const byId = new Map(items.map((i) => [i.id, i]));
  const shown = drag ? drag.order.map((id) => byId.get(id)).filter((i): i is NoteItem => !!i) : visible;
  const done = items.length - items.filter((i) => !i.done).length;

  const startDrag = (e: ReactPointerEvent, id: number) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({ id, order: visible.map((i) => i.id) });
  };
  const moveDrag = (e: ReactPointerEvent) => {
    if (!drag) return;
    const target = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>("[data-note-id]");
    const overId = Number(target?.dataset.noteId);
    if (!overId || overId === drag.id) return;
    const order = drag.order.filter((id) => id !== drag.id);
    order.splice(order.indexOf(overId) + (drag.order.indexOf(overId) > drag.order.indexOf(drag.id) ? 1 : 0), 0, drag.id);
    setDrag({ ...drag, order });
  };
  const endDrag = () => {
    if (!drag) return;
    const before = visible.map((i) => i.id).join();
    if (drag.order.join() !== before) reorder(board, drag.order);
    setDrag(null);
  };

  return (
    <>
      <form
        className="notes__add"
        onSubmit={(e) => {
          e.preventDefault();
          if (!draft.trim()) return;
          void add(board, draft, c.addTop);
          setDraft("");
        }}
      >
        <input className="input" placeholder="Add a task…" value={draft} maxLength={500} onChange={(e) => setDraft(e.target.value)} />
        <button className="icon-btn icon-btn--sm" title="Add" disabled={!draft.trim()}>
          <Plus size={13} />
        </button>
      </form>
      {shown.length === 0 ? (
        <div className="empty">{items.length ? "All done." : "No tasks yet."}</div>
      ) : (
        <ul className="notes__list">
          {shown.map((item) => (
            <li key={item.id} className="notes__item" data-note-id={item.id} data-done={item.done} data-dragging={drag?.id === item.id}>
              <span
                className="notes__grip"
                title="Drag to reorder"
                onPointerDown={(e) => startDrag(e, item.id)}
                onPointerMove={moveDrag}
                onPointerUp={endDrag}
                onPointerCancel={() => setDrag(null)}
              >
                <GripVertical size={12} />
              </span>
              <input
                type="checkbox"
                className="notes__check"
                checked={item.done}
                onChange={(e) => update(board, item.id, { done: e.target.checked })}
              />
              <EditableText text={item.text} onSave={(text) => update(board, item.id, { text })} />
              <button className="icon-btn icon-btn--sm notes__del" title="Delete" onClick={() => remove(board, item.id)}>
                <X size={12} />
              </button>
            </li>
          ))}
        </ul>
      )}
      {items.length > 0 && (
        <div className="notes__foot muted">
          <span>
            {items.length - done} left{c.hideDone && done ? ` · ${done} done hidden` : ""}
          </span>
          {done > 0 && (
            <button className="btn btn--sm btn--ghost" onClick={() => clearDone(board)}>
              Clear done
            </button>
          )}
        </div>
      )}
    </>
  );
}

/** Task text; double-click to edit, Enter or leaving the field saves, Esc cancels. */
function EditableText({ text, onSave }: { text: string; onSave: (text: string) => void }) {
  const [editing, setEditing] = useState<string | null>(null);
  if (editing === null)
    return (
      <span className="notes__text" title="Double-click to edit" onDoubleClick={() => setEditing(text)}>
        {text}
      </span>
    );
  const commit = () => {
    const value = editing.trim();
    if (value && value !== text) onSave(value);
    setEditing(null);
  };
  return (
    <input
      className="input notes__edit"
      autoFocus
      value={editing}
      maxLength={500}
      onChange={(e) => setEditing(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        if (e.key === "Escape") setEditing(null);
      }}
    />
  );
}

/** Free-text note, saved half a second after typing stops. */
function NotePad({ board, text }: { board: string; text: string }) {
  const [draft, setDraft] = useState(text);
  const pending = useRef<{ timer: number; value: string } | null>(null);

  // Take changes from other widgets and windows unless this one has unsaved typing.
  useEffect(() => {
    if (!pending.current) setDraft(text);
  }, [text]);

  // Save what is pending when the widget goes away (tab switch, closing the overlay).
  useEffect(
    () => () => {
      if (pending.current) {
        window.clearTimeout(pending.current.timer);
        useNotes.getState().setText(board, pending.current.value);
      }
    },
    [board],
  );

  return (
    <textarea
      className="textarea notes__pad"
      placeholder="Write anything. Saved on this computer only."
      value={draft}
      spellCheck={false}
      onChange={(e) => {
        const value = e.target.value;
        setDraft(value);
        if (pending.current) window.clearTimeout(pending.current.timer);
        pending.current = {
          value,
          timer: window.setTimeout(() => {
            pending.current = null;
            useNotes.getState().setText(board, value);
          }, 500),
        };
      }}
    />
  );
}
