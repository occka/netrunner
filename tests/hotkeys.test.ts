import { describe, expect, it } from "vitest";
import { comboFromEvent, keyName, matchesCombo } from "@/utils/hotkeys";

const ev = (code: string, mods: Partial<{ ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }> = {}) => ({ ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, code, ...mods });

describe("hotkeys", () => {
  it("names physical keys", () => {
    expect(["KeyK", "Digit1", "F12", "F25", "ArrowUp", "Space", "ShiftLeft", "Escape"].map(keyName)).toEqual(["K", "1", "F12", null, "Up", "Space", null, null]);
  });

  it("builds combinations in the stored order", () => {
    expect(comboFromEvent(ev("KeyO", { shiftKey: true, altKey: true, ctrlKey: true }))).toBe("Ctrl+Alt+Shift+O");
    expect(comboFromEvent(ev("KeyK", { metaKey: true }))).toBe("Win+K");
    expect(comboFromEvent(ev("ControlLeft", { ctrlKey: true }))).toBeNull();
  });

  it("matches by physical key, so a Russian layout works too", () => {
    // Ctrl+K on a Russian layout: key is "л", code stays KeyK.
    expect(matchesCombo(ev("KeyK", { ctrlKey: true }), "Ctrl+K")).toBe(true);
    expect(matchesCombo(ev("KeyK", { ctrlKey: true, shiftKey: true }), "Ctrl+K")).toBe(false);
    expect(matchesCombo(ev("KeyK", { ctrlKey: true }), undefined)).toBe(false);
  });
});
