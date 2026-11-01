//! Project-wide file listing (Go to file), text search and replace for
//! DEVELOPER. Walks respect `.gitignore`; results and time are bounded.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use ignore::overrides::OverrideBuilder;
use ignore::WalkBuilder;
use regex::{Regex, RegexBuilder};
use serde::{Deserialize, Serialize};

use super::workspace;
use crate::error::{AppError, AppResult};

const MAX_FILES: usize = 50_000;
const MAX_MATCHES: usize = 2000;
const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;
const TIME_LIMIT: Duration = Duration::from_secs(8);
const PREVIEW_CHARS: usize = 240;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Query {
    pub pattern: String,
    #[serde(default)]
    pub regex: bool,
    #[serde(default)]
    pub case_sensitive: bool,
    #[serde(default)]
    pub whole_word: bool,
    /// Comma-separated globs, e.g. `src/**, *.ts`.
    #[serde(default)]
    pub include: String,
    #[serde(default)]
    pub exclude: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Match {
    /// 0-based line; column and length in UTF-16 units (as Monaco and LSP count).
    pub line: usize,
    pub column: usize,
    pub length: usize,
    pub preview: String,
    /// Where the match starts inside `preview` (UTF-16 units).
    pub preview_column: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileMatches {
    pub path: String,
    pub matches: Vec<Match>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub files: Vec<FileMatches>,
    pub total: usize,
    /// Stopped at the match or time limit.
    pub truncated: bool,
    pub searched: usize,
}

pub fn build_regex(q: &Query) -> AppResult<Regex> {
    if q.pattern.is_empty() {
        return Err(AppError::Invalid("enter text to search for".into()));
    }
    let core = if q.regex { q.pattern.clone() } else { regex::escape(&q.pattern) };
    let pattern = if q.whole_word { format!(r"\b(?:{core})\b") } else { core };
    RegexBuilder::new(&pattern)
        .case_insensitive(!q.case_sensitive)
        .size_limit(1 << 20)
        .build()
        .map_err(|e| AppError::Invalid(format!("invalid regular expression: {e}")))
}

fn globs(list: &str) -> impl Iterator<Item = &str> {
    list.split(',').map(str::trim).filter(|g| !g.is_empty())
}

/// Files of a project, `.gitignore` respected; `.git` and heavy folders skipped.
fn walk(root: &Path, include: &str, exclude: &str) -> AppResult<ignore::Walk> {
    let mut over = OverrideBuilder::new(root);
    for g in globs(include) {
        over.add(g).map_err(|e| AppError::Invalid(format!("bad include pattern '{g}': {e}")))?;
    }
    for g in globs(exclude).chain([".git", "node_modules", "target"]) {
        over.add(&format!("!{g}")).map_err(|e| AppError::Invalid(format!("bad exclude pattern '{g}': {e}")))?;
    }
    let overrides = over.build().map_err(|e| AppError::Invalid(e.to_string()))?;
    Ok(WalkBuilder::new(root).hidden(false).git_global(false).require_git(false).overrides(overrides).build())
}

fn files_of(root: &Path, include: &str, exclude: &str) -> AppResult<Vec<PathBuf>> {
    Ok(walk(root, include, exclude)?
        .flatten()
        .filter(|e| e.file_type().is_some_and(|t| t.is_file()))
        .take(MAX_FILES)
        .map(|e| e.into_path())
        .collect())
}

/// Paths relative to the root, with forward slashes (for Go to file).
pub fn list_files(root: &Path) -> AppResult<Vec<String>> {
    let mut out: Vec<String> = files_of(root, "", "")?
        .iter()
        .filter_map(|p| p.strip_prefix(root).ok())
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .collect();
    out.sort();
    Ok(out)
}

fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

fn read_text(path: &Path) -> Option<String> {
    let meta = std::fs::metadata(path).ok()?;
    if meta.len() > MAX_FILE_BYTES {
        return None;
    }
    let bytes = std::fs::read(path).ok()?;
    if bytes.iter().take(8192).any(|b| *b == 0) {
        return None;
    }
    String::from_utf8(bytes).ok()
}

fn preview(line: &str, start: usize) -> (String, usize) {
    // Keep some context before the match; trim very long lines.
    let before: String = line[..start].chars().rev().take(40).collect::<Vec<_>>().into_iter().rev().collect();
    let cut = line[..start].chars().count() > 40;
    let text: String = before.chars().chain(line[start..].chars()).take(PREVIEW_CHARS).collect();
    let text = text.trim_end().to_string();
    let lead = text.len() - text.trim_start().len();
    let shown = if cut { format!("…{}", text.trim_start()) } else { text.trim_start().to_string() };
    let col = utf16_len(&before) - utf16_len(&before[..lead.min(before.len())]) + usize::from(cut);
    (shown, col)
}

pub fn search(root: &Path, q: &Query) -> AppResult<SearchResult> {
    let re = build_regex(q)?;
    let started = Instant::now();
    let mut result = SearchResult { files: Vec::new(), total: 0, truncated: false, searched: 0 };
    for path in files_of(root, &q.include, &q.exclude)? {
        if started.elapsed() > TIME_LIMIT || result.total >= MAX_MATCHES {
            result.truncated = true;
            break;
        }
        let Some(text) = read_text(&path) else { continue };
        result.searched += 1;
        let mut matches = Vec::new();
        for (i, line) in text.lines().enumerate() {
            for m in re.find_iter(line) {
                if m.start() == m.end() {
                    continue;
                }
                let (preview, preview_column) = preview(line, m.start());
                matches.push(Match { line: i, column: utf16_len(&line[..m.start()]), length: utf16_len(m.as_str()), preview, preview_column });
                result.total += 1;
                if result.total >= MAX_MATCHES {
                    break;
                }
            }
            if result.total >= MAX_MATCHES {
                result.truncated = true;
                break;
            }
        }
        if !matches.is_empty() {
            result.files.push(FileMatches { path: workspace::display(&path), matches });
        }
    }
    Ok(result)
}

/// Replaces every match in the given files (paths from a search). Regex
/// mode expands `$1` groups; plain mode inserts the text literally.
pub fn replace(roots: &[PathBuf], q: &Query, replacement: &str, paths: &[String]) -> AppResult<usize> {
    let re = build_regex(q)?;
    let mut count = 0;
    for path in paths {
        let resolved = workspace::resolve(roots, path, true)?;
        let Some(text) = read_text(&resolved) else { continue };
        let n = re.find_iter(&text).filter(|m| m.start() != m.end()).count();
        if n == 0 {
            continue;
        }
        let next = if q.regex { re.replace_all(&text, replacement) } else { re.replace_all(&text, regex::NoExpand(replacement)) };
        workspace::write_file(roots, &workspace::display(&resolved), &next)?;
        count += n;
    }
    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("nr-search-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        std::fs::create_dir_all(dir.join("src")).unwrap();
        std::fs::create_dir_all(dir.join("dist")).unwrap();
        std::fs::create_dir_all(dir.join("node_modules").join("x")).unwrap();
        std::fs::write(dir.join(".gitignore"), "dist/\n").unwrap();
        std::fs::write(dir.join("src").join("a.ts"), "const Foo = 1;\nfoo(Foo); // 😀 Foo\n").unwrap();
        std::fs::write(dir.join("src").join("b.rs"), "fn foobar() {}\n").unwrap();
        std::fs::write(dir.join("dist").join("a.js"), "Foo").unwrap();
        std::fs::write(dir.join("node_modules").join("x").join("i.js"), "Foo").unwrap();
        std::fs::write(dir.join("blob.bin"), [0u8, b'F', b'o', b'o']).unwrap();
        std::fs::canonicalize(dir).unwrap()
    }

    fn q(pattern: &str) -> Query {
        Query { pattern: pattern.into(), regex: false, case_sensitive: false, whole_word: false, include: String::new(), exclude: String::new() }
    }

    #[test]
    fn lists_files_respecting_gitignore() {
        let root = project();
        let files = list_files(&root).unwrap();
        assert_eq!(files, vec![".gitignore", "blob.bin", "src/a.ts", "src/b.rs"]);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn finds_with_options_and_utf16_columns() {
        let root = project();
        let all = search(&root, &q("foo")).unwrap();
        assert_eq!(all.total, 5); // Foo, foo, Foo, Foo (a.ts) + foo (b.rs); not dist, node_modules or the binary
        let mut cs = q("Foo");
        cs.case_sensitive = true;
        let r = search(&root, &cs).unwrap();
        assert_eq!(r.total, 3);
        let a = r.files.iter().find(|f| f.path.ends_with("a.ts")).unwrap();
        // The emoji is two UTF-16 units: "foo(Foo); // 😀 " is 16 units.
        assert_eq!((a.matches[2].line, a.matches[2].column, a.matches[2].length), (1, 16, 3));
        let mut word = q("foo");
        word.whole_word = true;
        assert_eq!(search(&root, &word).unwrap().total, 4);
        let mut re = q(r"fn \w+\(");
        re.regex = true;
        assert_eq!(search(&root, &re).unwrap().files[0].matches[0].length, 10);
        let mut only_rs = q("foo");
        only_rs.include = "*.rs".into();
        assert_eq!(search(&root, &only_rs).unwrap().total, 1);
        let mut no_src = q("foo");
        no_src.exclude = "src".into();
        assert_eq!(search(&root, &no_src).unwrap().total, 0);
        let mut bad = q("(");
        bad.regex = true;
        assert!(search(&root, &bad).is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn replaces_literally_or_with_groups() {
        let root = project();
        let roots = vec![root.clone()];
        let a = workspace::display(&root.join("src").join("a.ts"));
        let mut cs = q("Foo");
        cs.case_sensitive = true;
        cs.whole_word = true;
        assert_eq!(replace(&roots, &cs, "$Bar", std::slice::from_ref(&a)).unwrap(), 3);
        assert_eq!(std::fs::read_to_string(&a).unwrap(), "const $Bar = 1;\nfoo($Bar); // 😀 $Bar\n");
        let mut re = q(r"foo\((\$Bar)\)");
        re.regex = true;
        assert_eq!(replace(&roots, &re, "call($1)", std::slice::from_ref(&a)).unwrap(), 1);
        assert!(std::fs::read_to_string(&a).unwrap().contains("call($Bar);"));
        // Outside the project is refused.
        assert!(replace(&roots, &q("x"), "y", &[r"C:\Windows\win.ini".into()]).is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn previews_keep_context() {
        let long = format!("{}needle tail", "x".repeat(100));
        let (text, col) = preview(&long, 100);
        assert!(text.starts_with('…'));
        assert_eq!(&text.chars().skip(col).take(6).collect::<String>(), "needle");
        let (text, col) = preview("    let needle = 1;", 8);
        assert_eq!((text.as_str(), col), ("let needle = 1;", 4));
    }
}
