import { describe, expect, it } from "vitest";
import { runPlan } from "../src/modules/developer/run";
import { languageFor } from "../src/modules/developer/languages";

describe("runPlan", () => {
  it("builds PowerShell commands with safe quoting", () => {
    expect(runPlan("D:\\proj\\main.py")?.command).toBe("python 'D:\\proj\\main.py'");
    expect(runPlan("D:\\it's\\a.js")?.command).toBe("node 'D:\\it''s\\a.js'");
  });

  it("compiles C sources next to the source file", () => {
    expect(runPlan("D:\\p\\hello.c")?.command).toBe("gcc 'D:\\p\\hello.c' -o 'D:\\p\\hello.exe'; if ($?) { & 'D:\\p\\hello.exe' }");
  });

  it("uses project runners when present", () => {
    expect(runPlan("D:\\p\\src\\main.rs", { hasCargo: true })?.command).toBe("cargo run");
    expect(runPlan("D:\\p\\Program.cs")).toBeNull();
    expect(runPlan("D:\\p\\Program.cs", { hasCsproj: true })?.command).toBe("dotnet run");
  });

  it("returns null for non-runnable files", () => {
    expect(runPlan("D:\\p\\README.md")).toBeNull();
  });
});

describe("languageFor", () => {
  it("maps extensions to Monaco languages", () => {
    expect(languageFor("a.tsx")).toBe("typescript");
    expect(languageFor("C:\\x\\Main.CS")).toBe("csharp");
    expect(languageFor("Dockerfile")).toBe("dockerfile");
    expect(languageFor("noext")).toBe("plaintext");
  });
});
