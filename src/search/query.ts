/**
 * Local search engine for the command palette. Pure functions only, so it is
 * unit-tested without the UI. Works fully offline; AI search is a later,
 * separate layer.
 */

export type SearchCategory =
  | "app"
  | "game"
  | "file"
  | "folder"
  | "web"
  | "cmd"
  | "project"
  | "module"
  | "widget"
  | "setting"
  | "profile"
  | "action";

export const CATEGORY_LABEL: Record<SearchCategory, string> = {
  app: "Application",
  game: "Game",
  file: "File",
  folder: "Folder",
  web: "Website",
  cmd: "Command",
  project: "Project",
  module: "Module",
  widget: "Widget",
  setting: "Setting",
  profile: "Profile",
  action: "Action",
};

const ALIASES: Record<string, SearchCategory> = {
  app: "app",
  apps: "app",
  application: "app",
  game: "game",
  games: "game",
  file: "file",
  files: "file",
  folder: "folder",
  dir: "folder",
  web: "web",
  website: "web",
  url: "web",
  cmd: "cmd",
  command: "cmd",
  project: "project",
  module: "module",
  widget: "widget",
  setting: "setting",
  settings: "setting",
  profile: "profile",
  action: "action",
};

export interface SearchItem {
  id: string;
  category: SearchCategory;
  title: string;
  subtitle?: string;
  keywords?: string[];
}

export interface ParsedQuery {
  filter: SearchCategory | null;
  text: string;
}

export function parseQuery(raw: string): ParsedQuery {
  const trimmed = raw.trimStart();
  const match = /^([a-z]+):(.*)$/i.exec(trimmed);
  if (match) {
    const category = ALIASES[match[1].toLowerCase()];
    // Unknown prefixes (e.g. a drive letter "C:") are treated as plain text.
    if (category) return { filter: category, text: match[2].trim().toLowerCase() };
  }
  return { filter: null, text: trimmed.trim().toLowerCase() };
}

function isSubsequence(needle: string, haystack: string): boolean {
  let i = 0;
  for (const ch of haystack) {
    if (ch === needle[i]) i++;
    if (i === needle.length) return true;
  }
  return needle.length === 0;
}

/** Relevance score; 0 means no match. */
export function scoreItem(item: SearchItem, text: string): number {
  if (!text) return 1;
  const title = item.title.toLowerCase();
  if (title === text) return 120;
  if (title.startsWith(text)) return 100 - Math.min(20, title.length - text.length);
  if (title.split(/[\s\-_.:/\\]+/).some((word) => word.startsWith(text))) return 80;
  if (title.includes(text)) return 60;
  if (item.keywords?.some((k) => k.toLowerCase().includes(text))) return 45;
  if (item.subtitle?.toLowerCase().includes(text)) return 35;
  if (text.length >= 2 && isSubsequence(text, title)) return 20;
  return 0;
}

export function search(items: SearchItem[], raw: string, limit = 40): SearchItem[] {
  const { filter, text } = parseQuery(raw);
  return items
    .filter((item) => !filter || item.category === filter)
    .map((item, index) => ({ item, index, score: scoreItem(item, text) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .map((r) => r.item);
}
