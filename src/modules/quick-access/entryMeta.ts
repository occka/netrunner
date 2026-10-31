import {
  AppWindow,
  Bot,
  Code2,
  FileText,
  Folder,
  FolderGit2,
  Gamepad2,
  Globe,
  Headphones,
  MessageSquare,
  Music,
  Shield,
  SquareTerminal,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import type { EntryKind, QuickAccessEntry } from "@/types/entities";

export interface EntryKindMeta {
  label: string;
  icon: LucideIcon;
  targetLabel: string;
  targetPlaceholder: string;
  /** Prefix used in the command palette (e.g. "app:discord"). */
  searchPrefix: string;
}

export const ENTRY_KIND_META: Record<EntryKind, EntryKindMeta> = {
  app: {
    label: "Application",
    icon: AppWindow,
    targetLabel: "Executable or shortcut",
    targetPlaceholder: "C:\\Program Files\\App\\app.exe",
    searchPrefix: "app",
  },
  game: {
    label: "Game",
    icon: Gamepad2,
    targetLabel: "Executable or launcher URI",
    targetPlaceholder: "steam://rungameid/1091500  or  D:\\Games\\game.exe",
    searchPrefix: "game",
  },
  file: { label: "File", icon: FileText, targetLabel: "File path", targetPlaceholder: "C:\\Users\\you\\notes.txt", searchPrefix: "file" },
  folder: { label: "Folder", icon: Folder, targetLabel: "Folder path", targetPlaceholder: "D:\\Projects", searchPrefix: "folder" },
  website: { label: "Website", icon: Globe, targetLabel: "URL", targetPlaceholder: "https://github.com", searchPrefix: "web" },
  command: {
    label: "Command",
    icon: SquareTerminal,
    targetLabel: "Command",
    targetPlaceholder: "git status",
    searchPrefix: "cmd",
  },
  project: {
    label: "Project",
    icon: FolderGit2,
    targetLabel: "Project folder",
    targetPlaceholder: "D:\\Projects\\website",
    searchPrefix: "project",
  },
};

export const ENTRY_KINDS = Object.keys(ENTRY_KIND_META) as EntryKind[];

/** Optional icon overrides selectable in the editor. */
export const ICON_CHOICES: Record<string, LucideIcon> = {
  terminal: SquareTerminal,
  code: Code2,
  chat: MessageSquare,
  music: Music,
  audio: Headphones,
  shield: Shield,
  tool: Wrench,
  ai: Bot,
  game: Gamepad2,
  web: Globe,
  folder: Folder,
};

export function entryIcon(entry: Pick<QuickAccessEntry, "kind" | "icon">): LucideIcon {
  return ICON_CHOICES[entry.icon] ?? ENTRY_KIND_META[entry.kind].icon;
}

export function entryActionLabel(entry: Pick<QuickAccessEntry, "kind">): string {
  switch (entry.kind) {
    case "app":
    case "game":
      return "Launch";
    case "command":
      return "Run";
    default:
      return "Open";
  }
}

export function entryHasLocation(entry: Pick<QuickAccessEntry, "kind" | "target">): boolean {
  if (entry.kind === "website" || entry.kind === "command") return false;
  if (entry.kind === "game" && /^[a-z][a-z0-9+.-]+:\/\//i.test(entry.target)) return false;
  return true;
}
