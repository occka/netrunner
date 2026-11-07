//! Duplicate files below a folder, for FILES. Files are grouped by size, then by
//! a hash of their first 64 KB, and only then by a hash of the whole content, so
//! most files are never read in full. Bounded in files and time.

use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::error::AppResult;

const MAX_FILES: usize = 300_000;
const MAX_GROUPS: usize = 500;
const HEAD: u64 = 64 * 1024;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Group {
    pub size: u64,
    pub paths: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    /// Largest waste first.
    pub groups: Vec<Group>,
    pub scanned: usize,
    /// False when a limit stopped the scan early.
    pub complete: bool,
}

fn hash(path: &Path, limit: Option<u64>) -> Option<[u8; 32]> {
    let file = fs::File::open(path).ok()?;
    let mut reader: Box<dyn Read> = match limit {
        Some(n) => Box::new(file.take(n)),
        None => Box::new(file),
    };
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 256 * 1024];
    loop {
        let n = reader.read(&mut buf).ok()?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Some(hasher.finalize().into())
}

/// Splits each group by a key; groups of one are dropped.
fn refine(groups: Vec<Vec<PathBuf>>, key: impl Fn(&Path) -> Option<[u8; 32]>, deadline: Instant, complete: &mut bool) -> Vec<Vec<PathBuf>> {
    let mut out = Vec::new();
    for group in groups {
        if Instant::now() > deadline {
            *complete = false;
            break;
        }
        let mut by: HashMap<[u8; 32], Vec<PathBuf>> = HashMap::new();
        for p in group {
            if let Some(k) = key(&p) {
                by.entry(k).or_default().push(p);
            }
        }
        out.extend(by.into_values().filter(|g| g.len() > 1));
    }
    out
}

pub fn find(root: &Path, min_size: u64, budget: Duration) -> AppResult<Report> {
    let deadline = Instant::now() + budget;
    let mut complete = true;
    let mut by_size: HashMap<u64, Vec<PathBuf>> = HashMap::new();
    let mut scanned = 0;
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        if scanned >= MAX_FILES || Instant::now() > deadline {
            complete = false;
            break;
        }
        let Ok(rd) = fs::read_dir(&dir) else { continue };
        for e in rd.flatten() {
            let Ok(meta) = e.metadata() else { continue };
            if meta.file_type().is_symlink() {
                continue;
            }
            if meta.is_dir() {
                stack.push(e.path());
            } else if meta.len() >= min_size.max(1) {
                scanned += 1;
                by_size.entry(meta.len()).or_default().push(e.path());
            }
        }
    }
    let candidates: Vec<Vec<PathBuf>> = by_size.into_values().filter(|g| g.len() > 1).collect();
    let heads = refine(candidates, |p| hash(p, Some(HEAD)), deadline, &mut complete);
    let same = refine(heads, |p| hash(p, None), deadline, &mut complete);

    let mut groups: Vec<Group> = same
        .into_iter()
        .map(|mut g| {
            g.sort();
            let size = fs::metadata(&g[0]).map(|m| m.len()).unwrap_or(0);
            Group { size, paths: g.into_iter().map(|p| p.display().to_string()).collect() }
        })
        .collect();
    groups.sort_by_key(|g| std::cmp::Reverse(g.size * (g.paths.len() as u64 - 1)));
    groups.truncate(MAX_GROUPS);
    Ok(Report { groups, scanned, complete })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_identical_files_only() {
        let dir = std::env::temp_dir().join(format!("nr-dups-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("sub")).unwrap();
        let big = vec![7u8; 200_000];
        let mut other = big.clone();
        *other.last_mut().unwrap() = 8; // same size and same first 64 KB, different end
        fs::write(dir.join("a.bin"), &big).unwrap();
        fs::write(dir.join("sub").join("a copy.bin"), &big).unwrap();
        fs::write(dir.join("almost.bin"), &other).unwrap();
        fs::write(dir.join("x.txt"), b"same").unwrap();
        fs::write(dir.join("y.txt"), b"same").unwrap();
        fs::write(dir.join("z.txt"), b"diff").unwrap();

        let report = find(&dir, 1, Duration::from_secs(30)).unwrap();
        assert!(report.complete);
        assert_eq!(report.groups.len(), 2);
        assert_eq!(report.groups[0].size, 200_000, "largest waste first");
        assert_eq!(report.groups[0].paths.len(), 2);
        assert!(!report.groups[0].paths.iter().any(|p| p.ends_with("almost.bin")));
        assert_eq!(report.groups[1].paths.len(), 2);
        assert!(find(&dir, 1000, Duration::from_secs(30)).unwrap().groups.len() == 1, "small files can be left out");
        let _ = fs::remove_dir_all(&dir);
    }
}
