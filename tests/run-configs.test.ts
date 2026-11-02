import { describe, expect, it } from "vitest";
import { detectConfigs, parseLaunchJson } from "@/modules/developer/runConfigs";

describe("run configurations", () => {
  it("detects scripts and toolchains from project files", () => {
    const pkg = JSON.stringify({ scripts: { dev: "vite", build: "vite build", test: "vitest run", typecheck: "tsc" } });
    const c = detectConfigs("D:\\p", ["package.json", "pnpm-lock.yaml", "src-tauri"], { "package.json": pkg, "src-tauri/Cargo.toml": "[package]" });
    expect(c.map((x) => `${x.group}:${x.command}`)).toEqual([
      "run:pnpm run dev",
      "build:pnpm run build",
      "test:pnpm run test",
      "run:pnpm run typecheck",
      "run:cargo run",
      "test:cargo test",
      "build:cargo build",
      "test:cargo clippy --all-targets",
    ]);
    expect(c.find((x) => x.command === "cargo test")?.cwd).toBe("D:\\p\\src-tauri");
    expect(detectConfigs("D:\\g", ["go.mod", "Makefile", "gradlew.bat", "build.gradle"], {}).map((x) => x.command)).toEqual([
      "go run .",
      "go test ./...",
      "go build ./...",
      ".\\gradlew.bat run",
      ".\\gradlew.bat test",
      ".\\gradlew.bat build",
      "make",
      "make test",
    ]);
    expect(detectConfigs("D:\\x", ["package.json"], { "package.json": "{oops" })).toEqual([]);
  });

  it("reads .netrunner/launch.json with comments", () => {
    const text = `{
      // mine
      "configurations": [
        { "name": "Serve", "command": "npm start", "cwd": "web" },
        { "name": "E2E", "command": "npx playwright test", "group": "test" }, /* no command: */
        { "name": "Broken" }
      ]
    }`;
    expect(parseLaunchJson("D:\\p", text)).toEqual([
      { id: "launch|Serve", name: "Serve", command: "npm start", cwd: "D:\\p\\web", group: "run", source: "launch.json" },
      { id: "launch|E2E", name: "E2E", command: "npx playwright test", cwd: "D:\\p", group: "test", source: "launch.json" },
    ]);
  });
});
