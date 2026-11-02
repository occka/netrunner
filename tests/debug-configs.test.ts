import { describe, expect, it } from "vitest";
import { autoDebugConfig, debugConfigsFromLaunch, frameLabel, needsBuiltProgram, nativeDebugConfig, shiftedBreakpoints } from "@/modules/developer/debug/configs";

describe("debug configurations", () => {
  it("chooses an adapter by file type", () => {
    const py = autoDebugConfig("D:\\p\\src\\main.py", "D:\\p")!;
    expect(py.adapter).toBe("debugpy");
    expect(py.config).toMatchObject({ program: "D:\\p\\src\\main.py", cwd: "D:\\p", console: "internalConsole" });
    expect(autoDebugConfig("D:\\p\\cmd\\main.go", "D:\\p")?.config).toMatchObject({ program: "D:\\p\\cmd", mode: "debug" });
    expect(autoDebugConfig("D:\\p\\main.rs", "D:\\p")).toBeNull();
    expect(needsBuiltProgram("a.rs") && needsBuiltProgram("b.CPP") && !needsBuiltProgram("c.py")).toBe(true);
    expect(nativeDebugConfig("D:\\p\\target\\debug\\app.exe", "D:\\p").adapter).toBe("codelldb");
  });

  it("reads debug blocks from launch.json", () => {
    const list = debugConfigsFromLaunch(
      {
        configurations: [
          { name: "Server", debug: { adapter: "debugpy", program: "srv.py", args: ["--port", "1"] } },
          { name: "Attach", debug: { adapter: "debugpy", request: "attach", connect: { port: 5678 } } },
          { name: "No debug block" },
          { name: "Unknown", debug: { adapter: "gdb" } },
        ],
      },
      "D:\\p",
    );
    expect(list.map((c) => [c.name, c.request])).toEqual([["Server", "launch"], ["Attach", "attach"]]);
    expect(list[0].config).toMatchObject({ program: "srv.py", type: "python", cwd: "D:\\p", args: ["--port", "1"] });
    expect(list[1].config).toMatchObject({ connect: { port: 5678 } });
  });

  it("labels frames and shifts breakpoints", () => {
    expect(frameLabel({ name: "f", line: 3, source: { path: "D:\\p\\a.py" } })).toBe("a.py:3");
    expect(frameLabel({ name: "f", line: 3 })).toBe("line 3");
    expect(shiftedBreakpoints([{ line: 2, condition: "x" }, { line: 9 }], [3, 10])).toEqual([{ line: 3, condition: "x" }, { line: 10 }]);
  });
});
