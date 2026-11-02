/**
 * Key combinations as NETRUNNER stores them (`Ctrl+Alt+K`). Matching uses the
 * physical key (`event.code`), so shortcuts work on any keyboard layout.
 */
export interface KeyLike {
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
  code: string;
}

const NAMED = new Set(["Space", "Tab", "Enter", "Backspace", "Delete", "Insert", "Home", "End", "PageUp", "PageDown", "Backquote", "Minus", "Equal", "BracketLeft", "BracketRight", "Backslash", "Semicolon", "Quote", "Comma", "Period", "Slash"]);

/** The key's name, or null for modifiers and keys shortcuts cannot use. */
export function keyName(code: string): string | null {
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  if (/^F([1-9]|1\d|2[0-4])$/.test(code)) return code;
  if (code.startsWith("Arrow")) return code.slice(5);
  return NAMED.has(code) ? code : null;
}

export function comboFromEvent(e: KeyLike): string | null {
  const key = keyName(e.code);
  if (!key) return null;
  return [e.ctrlKey && "Ctrl", e.altKey && "Alt", e.shiftKey && "Shift", e.metaKey && "Win", key].filter(Boolean).join("+");
}

export const matchesCombo = (e: KeyLike, combo: string | undefined) => !!combo && comboFromEvent(e) === combo;
