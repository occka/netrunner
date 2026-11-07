//! ZIP archives in FILES: list what is inside, extract to a new folder next to
//! the archive. Entry names come from the file, so each is checked to stay
//! inside the target folder, and sizes are capped against archive bombs.

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::error::{AppError, AppResult};

const LIST_LIMIT: usize = 1000;
const MAX_ENTRIES: usize = 100_000;
const MAX_TOTAL: u64 = 20 * 1024 * 1024 * 1024;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveEntry {
    pub name: String,
    pub size: u64,
    pub is_dir: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Listing {
    pub entries: Vec<ArchiveEntry>,
    pub total: usize,
    pub unpacked_bytes: u64,
    pub encrypted: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Extracted {
    pub folder: String,
    pub files: usize,
    /// Entries whose name pointed outside the folder.
    pub skipped: usize,
}

pub fn is_zip(path: &Path) -> bool {
    path.extension().and_then(|e| e.to_str()).is_some_and(|e| e.eq_ignore_ascii_case("zip"))
}

fn open(path: &Path) -> AppResult<zip::ZipArchive<fs::File>> {
    zip::ZipArchive::new(fs::File::open(path)?).map_err(|e| AppError::Invalid(format!("not a readable ZIP archive: {e}")))
}

pub fn list(path: &Path) -> AppResult<Listing> {
    let mut archive = open(path)?;
    let total = archive.len();
    let mut entries = Vec::new();
    let (mut unpacked_bytes, mut encrypted) = (0u64, false);
    for i in 0..total.min(MAX_ENTRIES) {
        let Ok(file) = archive.by_index_raw(i) else { continue };
        unpacked_bytes = unpacked_bytes.saturating_add(file.size());
        encrypted |= file.encrypted();
        if entries.len() < LIST_LIMIT {
            let name = file.name().map(|n| n.into_owned()).unwrap_or_else(|_| String::from_utf8_lossy(file.name_raw()).into_owned());
            entries.push(ArchiveEntry { name, size: file.size(), is_dir: file.is_dir() });
        }
    }
    Ok(Listing { entries, total, unpacked_bytes, encrypted })
}

/// An entry's name as a path inside the target folder, or `None` if it could
/// leave it or is not a valid Windows name. Not zip's `enclosed_name`: in zip
/// 9.2 that panics on names with non-ASCII letters.
pub fn safe_relative(name: &str) -> Option<PathBuf> {
    let name = name.replace('\\', "/");
    if name.starts_with('/') {
        return None;
    }
    let mut out = PathBuf::new();
    for part in name.split('/').filter(|p| !p.is_empty()) {
        let reserved = {
            let stem = part.split('.').next().unwrap_or("").to_ascii_lowercase();
            matches!(stem.as_str(), "con" | "prn" | "aux" | "nul") || ((stem.starts_with("com") || stem.starts_with("lpt")) && stem.len() == 4 && stem.ends_with(|c: char| c.is_ascii_digit()))
        };
        let bad_char = part.chars().any(|c| c.is_control() || matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*'));
        if part == "." || part == ".." || bad_char || reserved || part.ends_with('.') || part.ends_with(' ') {
            return None;
        }
        out.push(part);
    }
    (!out.as_os_str().is_empty()).then_some(out)
}

/// A folder named after the archive that does not exist yet.
fn target_folder(path: &Path) -> AppResult<PathBuf> {
    let parent = path.parent().ok_or_else(|| AppError::Invalid("archive has no folder".into()))?;
    let stem = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "archive".into());
    (0..1000)
        .map(|n| if n == 0 { parent.join(&stem) } else { parent.join(format!("{stem} ({n})")) })
        .find(|p| !p.exists())
        .ok_or_else(|| AppError::Invalid("no free folder name".into()))
}

/// Extracts everything into a new folder beside the archive. The caller has
/// checked that this folder may be modified.
pub fn extract(path: &Path) -> AppResult<Extracted> {
    let mut archive = open(path)?;
    if archive.len() > MAX_ENTRIES {
        return Err(AppError::Invalid(format!("more than {MAX_ENTRIES} entries")));
    }
    let listing = list(path)?;
    if listing.encrypted {
        return Err(AppError::Invalid("password-protected archives are not supported".into()));
    }
    if listing.unpacked_bytes > MAX_TOTAL {
        return Err(AppError::Invalid("the archive unpacks to more than 20 GB".into()));
    }
    let folder = target_folder(path)?;
    fs::create_dir_all(&folder)?;
    let (mut files, mut skipped) = (0, 0);
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| AppError::Invalid(format!("damaged archive: {e}")))?;
        // Refuses absolute paths and `..`, the classic zip-slip.
        let name = entry.name().map(|n| n.into_owned()).unwrap_or_else(|_| String::from_utf8_lossy(entry.name_raw()).into_owned());
        let Some(relative) = safe_relative(&name) else {
            skipped += 1;
            continue;
        };
        let out = folder.join(&relative);
        if entry.is_dir() || name.ends_with('/') {
            fs::create_dir_all(&out)?;
            continue;
        }
        if let Some(parent) = out.parent() {
            fs::create_dir_all(parent)?;
        }
        // The header may lie about the size: never write more than it said.
        let declared = entry.size();
        let mut writer = fs::File::create(&out)?;
        let written = std::io::copy(&mut (&mut entry).take(declared + 1), &mut writer)?;
        if written > declared {
            drop(writer);
            let _ = fs::remove_file(&out);
            return Err(AppError::Invalid(format!("{} is larger than the archive says", relative.display())));
        }
        files += 1;
    }
    Ok(Extracted { folder: folder.display().to_string(), files, skipped })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn make_zip(path: &Path, entries: &[(&str, &[u8])]) {
        let mut w = zip::ZipWriter::new(fs::File::create(path).unwrap());
        for (name, data) in entries {
            w.start_file(*name, zip::write::SimpleFileOptions::default()).unwrap();
            w.write_all(data).unwrap();
        }
        w.finish().unwrap();
    }

    #[test]
    fn lists_and_extracts_without_escaping_the_folder() {
        let dir = std::env::temp_dir().join(format!("nr-zip-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let zip_path = dir.join("pack.zip");
        make_zip(&zip_path, &[("папка/файл.txt", "привет".as_bytes()), ("a.txt", b"hello"), ("../evil.txt", b"no"), ("C:/Windows/evil.txt", b"no")]);

        let listing = list(&zip_path).unwrap();
        assert_eq!(listing.total, 4);
        assert!(listing.entries.iter().any(|e| e.name == "папка/файл.txt" && e.size == "привет".len() as u64));

        let out = extract(&zip_path).unwrap();
        assert_eq!((out.files, out.skipped), (2, 2));
        assert_eq!(fs::read_to_string(dir.join("pack").join("папка").join("файл.txt")).unwrap(), "привет");
        assert!(!dir.join("evil.txt").exists());
        // A second extraction goes to a new folder.
        assert!(extract(&zip_path).unwrap().folder.ends_with("pack (1)"));

        for bad in ["../x", "/x", "a/../../x", "C:/x", r"a\..\..\x", "con.txt", "a/LPT1", "x:stream", "dots.", ""] {
            assert!(safe_relative(bad).is_none(), "{bad}");
        }
        assert_eq!(safe_relative(r"папка\файл.txt"), Some(PathBuf::from("папка").join("файл.txt")));

        fs::write(dir.join("fake.zip"), b"not a zip").unwrap();
        assert!(list(&dir.join("fake.zip")).is_err());
        let _ = fs::remove_dir_all(&dir);
    }
}
