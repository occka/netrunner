/**
 * Notes boards shared by every Notes widget in this window. Changes are
 * applied here at once and saved in the background; other windows (dashboard
 * vs overlays) reload a board when the backend reports `notes://changed`.
 */
import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { api } from "@/services/api";
import { reportError } from "@/stores/notifications";
import type { NoteItem, NotesBoard } from "@/types/notes";

interface NotesStore {
  boards: Record<string, NotesBoard>;
  load: (board: string) => Promise<void>;
  setText: (board: string, text: string) => void;
  add: (board: string, text: string, first: boolean) => Promise<void>;
  update: (board: string, id: number, change: { text?: string; done?: boolean }) => void;
  remove: (board: string, id: number) => void;
  reorder: (board: string, ids: number[]) => void;
  clearDone: (board: string) => void;
}

/** Same rule as the backend: blank means "Main". */
export const boardKey = (name: string) => name.trim() || "Main";

export const useNotes = create<NotesStore>((set, get) => {
  const patch = (board: string, fn: (b: NotesBoard) => NotesBoard) =>
    set((s) => (s.boards[board] ? { boards: { ...s.boards, [board]: fn(s.boards[board]) } } : s));
  const mapItems = (board: string, fn: (items: NoteItem[]) => NoteItem[]) => patch(board, (b) => ({ ...b, items: fn(b.items) }));
  // A failed save reloads the board so the widget never shows unsaved state as saved.
  const save = (board: string, title: string, op: Promise<unknown>) =>
    op.catch((err) => {
      reportError(title, err);
      void get().load(board);
    });

  return {
    boards: {},
    load: async (board) => {
      const b = await api.notes.board(board);
      set((s) => ({ boards: { ...s.boards, [board]: b } }));
    },
    setText: (board, text) => {
      patch(board, (b) => ({ ...b, text }));
      void save(board, "Could not save the note", api.notes.setText(board, text));
    },
    add: async (board, text, first) => {
      try {
        const item = await api.notes.add(board, text, first);
        mapItems(board, (items) => (first ? [item, ...items] : [...items, item]));
      } catch (err) {
        reportError("Could not add the task", err);
      }
    },
    update: (board, id, change) => {
      mapItems(board, (items) => items.map((i) => (i.id === id ? { ...i, ...change } : i)));
      void save(board, "Could not update the task", api.notes.update(id, change));
    },
    remove: (board, id) => {
      mapItems(board, (items) => items.filter((i) => i.id !== id));
      void save(board, "Could not delete the task", api.notes.remove(id));
    },
    reorder: (board, ids) => {
      mapItems(board, (items) => ids.map((id) => items.find((i) => i.id === id)).filter((i): i is NoteItem => !!i));
      void save(board, "Could not reorder tasks", api.notes.reorder(board, ids));
    },
    clearDone: (board) => {
      mapItems(board, (items) => items.filter((i) => !i.done));
      void save(board, "Could not clear completed tasks", api.notes.clearDone(board));
    },
  };
});

let listening = false;
/** Starts reloading boards changed by other windows (once per window). */
export function listenForNoteChanges() {
  if (listening) return;
  listening = true;
  const self = getCurrentWebview().label;
  void listen<{ board: string; source: string }>("notes://changed", ({ payload }) => {
    if (payload.source !== self && useNotes.getState().boards[payload.board]) void useNotes.getState().load(payload.board);
  });
}
