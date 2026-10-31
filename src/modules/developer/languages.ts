/** File extension → Monaco language id. Kept free of Monaco imports so it stays cheap. */
const LANGUAGES: Record<string, string> = {
  py: "python", pyw: "python", js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript",
  ts: "typescript", mts: "typescript", tsx: "typescript", json: "json", jsonc: "json", html: "html", htm: "html",
  css: "css", scss: "scss", less: "less", md: "markdown", markdown: "markdown", rs: "rust", go: "go",
  java: "java", kt: "kotlin", cs: "csharp", csx: "csharp", c: "c", h: "c", cpp: "cpp", cc: "cpp", cxx: "cpp",
  hpp: "cpp", hh: "cpp", php: "php", sql: "sql", xml: "xml", csproj: "xml", svg: "xml", yaml: "yaml", yml: "yaml",
  ini: "ini", cfg: "ini", toml: "ini", ps1: "powershell", psm1: "powershell", bat: "bat", cmd: "bat", sh: "shell",
  bash: "shell", rb: "ruby", lua: "lua", swift: "swift", dart: "dart", r: "r", vue: "html", svelte: "html",
};

export function languageFor(path: string): string {
  const name = path.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  if (name === "dockerfile") return "dockerfile";
  if (name === "makefile") return "makefile";
  const ext = name.includes(".") ? name.split(".").pop()! : "";
  return LANGUAGES[ext] ?? "plaintext";
}

