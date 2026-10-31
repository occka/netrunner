import { Braces, File, FileCode2, FileImage, FileJson, FileText, FileTerminal, Folder, type LucideIcon } from "lucide-react";
import type { DirEntry } from "@/types/dev";

const CODE = new Set(["py", "js", "ts", "tsx", "jsx", "rs", "go", "java", "cs", "c", "h", "cpp", "hpp", "php", "rb", "kt", "swift", "lua", "dart", "vue", "svelte", "html", "css", "scss", "sql"]);
const IMAGES = new Set(["png", "jpg", "jpeg", "gif", "svg", "ico", "webp", "bmp"]);
const SCRIPTS = new Set(["ps1", "bat", "cmd", "sh"]);

export function fileIcon(e: Pick<DirEntry, "name" | "isDir">): LucideIcon {
  if (e.isDir) return Folder;
  const ext = e.name.includes(".") ? e.name.split(".").pop()!.toLowerCase() : "";
  if (ext === "json") return FileJson;
  if (ext === "toml" || ext === "yaml" || ext === "yml" || ext === "ini") return Braces;
  if (CODE.has(ext)) return FileCode2;
  if (IMAGES.has(ext)) return FileImage;
  if (SCRIPTS.has(ext)) return FileTerminal;
  if (ext === "md" || ext === "txt") return FileText;
  return File;
}
