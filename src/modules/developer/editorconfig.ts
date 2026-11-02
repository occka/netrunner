/**
 * EditorConfig (https://editorconfig.org) support: parsing, glob matching and
 * merging the files from a file's folder up to the project root.
 */

export interface EditorConfig {
  indentStyle?: "tab" | "space";
  indentSize?: number;
  tabWidth?: number;
  trimTrailingWhitespace?: boolean;
  insertFinalNewline?: boolean;
  endOfLine?: "lf" | "crlf";
}

interface Section {
  glob: string;
  props: Record<string, string>;
}

export interface ParsedFile {
  root: boolean;
  sections: Section[];
}

export function parseEditorConfig(text: string): ParsedFile {
  const out: ParsedFile = { root: false, sections: [] };
  let current: Section | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const header = /^\[(.*)\]$/.exec(line);
    if (header) {
      current = { glob: header[1], props: {} };
      out.sections.push(current);
      continue;
    }
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim().toLowerCase();
    const value = line.slice(eq + 1).trim().toLowerCase();
    if (current) current.props[key] = value;
    else if (key === "root") out.root = value === "true";
  }
  return out;
}

/** EditorConfig glob → RegExp over a path relative to the .editorconfig folder (forward slashes). */
export function globToRegExp(glob: string): RegExp {
  // A glob without "/" matches the file name in any folder.
  const anywhere = !glob.includes("/");
  const g = glob.startsWith("/") ? glob.slice(1) : glob;
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*") {
      if (g[i + 1] === "*") {
        re += ".*";
        i++;
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "{") {
      const end = g.indexOf("}", i);
      if (end < 0) {
        re += "\\{";
        continue;
      }
      const body = g.slice(i + 1, end);
      const range = /^(-?\d+)\.\.(-?\d+)$/.exec(body);
      re += range ? "-?\\d+" : `(?:${body.split(",").map((p) => globToRegExp(p).source.replace(/^\^(?:\(\?:\.\*\/\)\?)?|\$$/g, "")).join("|")})`;
      i = end;
    } else if (c === "[") {
      const end = g.indexOf("]", i);
      if (end < 0) {
        re += "\\[";
        continue;
      }
      const body = g.slice(i + 1, end).replace(/^!/, "^").replace(/\\/g, "\\\\");
      re += `[${body}]`;
      i = end;
    } else re += c.replace(/[.+^$()|\\]/g, "\\$&");
  }
  return new RegExp(`^${anywhere ? "(?:.*/)?" : ""}${re}$`);
}

function apply(into: EditorConfig, props: Record<string, string>) {
  const num = (v: string | undefined) => (v && /^\d+$/.test(v) ? Number(v) : undefined);
  if (props.indent_style === "tab" || props.indent_style === "space") into.indentStyle = props.indent_style;
  if (props.indent_size === "tab") into.indentSize = undefined;
  else if (num(props.indent_size)) into.indentSize = num(props.indent_size);
  if (num(props.tab_width)) into.tabWidth = num(props.tab_width);
  if (props.trim_trailing_whitespace === "true" || props.trim_trailing_whitespace === "false") into.trimTrailingWhitespace = props.trim_trailing_whitespace === "true";
  if (props.insert_final_newline === "true" || props.insert_final_newline === "false") into.insertFinalNewline = props.insert_final_newline === "true";
  if (props.end_of_line === "lf" || props.end_of_line === "crlf") into.endOfLine = props.end_of_line;
}

/**
 * Settings for one file. `files` are the parsed .editorconfig files from the
 * project root down to the file's folder, each with the file's path relative
 * to that folder. Closer files and later sections win.
 */
export function resolveEditorConfig(files: { parsed: ParsedFile; relative: string }[]): EditorConfig {
  const out: EditorConfig = {};
  // Start from the nearest root=true file.
  let start = 0;
  files.forEach((f, i) => {
    if (f.parsed.root) start = i;
  });
  for (const f of files.slice(start)) {
    for (const s of f.parsed.sections) if (globToRegExp(s.glob).test(f.relative)) apply(out, s.props);
  }
  if (out.indentSize === undefined && out.indentStyle === "tab" && out.tabWidth) out.indentSize = out.tabWidth;
  if (out.tabWidth === undefined && out.indentSize) out.tabWidth = out.indentSize;
  return out;
}
