import { describe, expect, it } from "vitest";
import { parentOf, useFiles } from "../src/modules/files/store";

describe("parentOf", () => {
  it("walks up Windows paths and stops at the drive root", () => {
    expect(parentOf("C:\\Users\\me\\Documents")).toBe("C:\\Users\\me");
    expect(parentOf("C:\\Users")).toBe("C:\\");
    expect(parentOf("C:\\")).toBeNull();
    expect(parentOf("D:\\Games\\")).toBe("D:\\");
  });
});

describe("files navigation history", () => {
  it("supports back and forward", () => {
    const s = useFiles.getState();
    s.navigate("C:\\A");
    s.navigate("C:\\A\\B");
    s.goBack();
    expect(useFiles.getState().tabs[0].path).toBe("C:\\A");
    s.goForward();
    expect(useFiles.getState().tabs[0].path).toBe("C:\\A\\B");
    s.goBack();
    s.navigate("C:\\C");
    expect(useFiles.getState().tabs[0].forward).toEqual([]);
  });
});
