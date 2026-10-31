import { describe, expect, it } from "vitest";
import {
  CLOCK_SETTINGS,
  FRAME_SETTINGS,
  compactConfig,
  isVisible,
  resolveConfig,
} from "../src/modules/command/widgets/settings";

describe("widget settings", () => {
  it("fills defaults and drops invalid values", () => {
    const c = resolveConfig(CLOCK_SETTINGS, { hourCycle: "h12", timeSize: 9999, seconds: "bogus", junk: 1 });
    expect(c.hourCycle).toBe("h12");
    expect(c.timeSize).toBe(400);
    expect(c.seconds).toBe("small");
    expect("junk" in c).toBe(false);
  });

  it("snaps ranges to their step", () => {
    expect(resolveConfig(FRAME_SETTINGS, { "frame.scale": 123 })["frame.scale"]).toBe(125);
  });

  it("stores only values that differ from the defaults", () => {
    const values = { ...resolveConfig(CLOCK_SETTINGS, undefined), hourCycle: "h24", calendar: true };
    expect(compactConfig(CLOCK_SETTINGS, values)).toEqual({ hourCycle: "h24" });
  });

  it("hides dependent fields", () => {
    const size = CLOCK_SETTINGS.find((f) => f.key === "timeSize")!;
    expect(isVisible(size, { fit: false })).toBe(true);
    expect(isVisible(size, { fit: true })).toBe(false);
  });
});
