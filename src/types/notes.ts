/** Notes / to-do board (services/notes.rs). */
export interface NoteItem {
  id: number;
  text: string;
  done: boolean;
}

export interface NotesBoard {
  /** Normalised board name ("Main" when left blank). */
  name: string;
  /** Free-text note. */
  text: string;
  items: NoteItem[];
}
