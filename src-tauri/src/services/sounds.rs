//! Alarm sounds: the built-in synthesized ones plus audio files the user
//! imported. Files are copied into `<data>/sounds/` under generated names, so
//! a sound id can never point outside that folder; the original file name is
//! kept in `names.json` for display.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;

use crate::error::{AppError, AppResult};
use crate::services::alarms::BUILTIN_SOUNDS;

const MAX_BYTES: u64 = 20 * 1024 * 1024;
const MAX_FILES: usize = 32;
const TYPES: &[&str] = &["mp3", "wav", "ogg", "flac"];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Sound {
    pub id: String,
    pub name: String,
    pub builtin: bool,
}

pub fn dir(data_dir: &Path) -> PathBuf {
    data_dir.join("sounds")
}

fn check_id(id: &str) -> AppResult<()> {
    let ext = id.rsplit('.').next().unwrap_or("");
    let ok = id.starts_with("snd-")
        && id.len() < 64
        && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.')
        && id.matches('.').count() == 1
        && TYPES.contains(&ext);
    if ok {
        Ok(())
    } else {
        Err(AppError::Invalid("invalid sound name".into()))
    }
}

fn names(data_dir: &Path) -> BTreeMap<String, String> {
    std::fs::read(dir(data_dir).join("names.json"))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

fn save_names(data_dir: &Path, map: &BTreeMap<String, String>) -> AppResult<()> {
    std::fs::write(dir(data_dir).join("names.json"), serde_json::to_vec_pretty(map)?)?;
    Ok(())
}

/// Path of an imported sound, or `None` for a built-in one.
pub fn file(data_dir: &Path, id: &str) -> AppResult<Option<PathBuf>> {
    if BUILTIN_SOUNDS.iter().any(|(b, _)| *b == id) {
        return Ok(None);
    }
    check_id(id)?;
    Ok(Some(dir(data_dir).join(id)))
}

pub fn list(data_dir: &Path) -> AppResult<Vec<Sound>> {
    let mut out: Vec<Sound> =
        BUILTIN_SOUNDS.iter().map(|(id, name)| Sound { id: (*id).into(), name: (*name).into(), builtin: true }).collect();
    let titles = names(data_dir);
    if let Ok(entries) = std::fs::read_dir(dir(data_dir)) {
        let mut files: Vec<Sound> = entries
            .flatten()
            .filter_map(|e| {
                let id = e.file_name().to_string_lossy().to_string();
                check_id(&id).ok()?;
                let name = titles.get(&id).cloned().unwrap_or_else(|| id.clone());
                Some(Sound { id, name, builtin: false })
            })
            .collect();
        files.sort_by_key(|s| s.name.to_lowercase());
        out.extend(files);
    }
    Ok(out)
}

pub fn import(data_dir: &Path, source: &Path) -> AppResult<Sound> {
    let ext = source
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
        .filter(|e| TYPES.contains(&e.as_str()))
        .ok_or_else(|| AppError::Invalid("pick an MP3, WAV, OGG or FLAC file".into()))?;
    let meta = std::fs::metadata(source)?;
    if !meta.is_file() {
        return Err(AppError::Invalid("not a file".into()));
    }
    if meta.len() > MAX_BYTES {
        return Err(AppError::Invalid("sounds up to 20 MB are supported".into()));
    }
    let target = dir(data_dir);
    std::fs::create_dir_all(&target)?;
    if list(data_dir)?.iter().filter(|s| !s.builtin).count() >= MAX_FILES {
        return Err(AppError::Invalid(format!("remove some sounds first ({MAX_FILES} at most)")));
    }
    let stamp = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    let id = (0..100)
        .map(|n| format!("snd-{stamp:x}-{n}.{ext}"))
        .find(|n| !target.join(n).exists())
        .ok_or_else(|| AppError::Internal("cannot name the sound".into()))?;
    std::fs::copy(source, target.join(&id))?;
    let name: String = source.file_stem().map(|s| s.to_string_lossy().chars().take(60).collect()).unwrap_or_else(|| id.clone());
    let mut titles = names(data_dir);
    titles.insert(id.clone(), name.clone());
    save_names(data_dir, &titles)?;
    Ok(Sound { id, name, builtin: false })
}

pub fn delete(data_dir: &Path, id: &str) -> AppResult<()> {
    check_id(id)?;
    match std::fs::remove_file(dir(data_dir).join(id)) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e.into()),
        _ => {}
    }
    let mut titles = names(data_dir);
    if titles.remove(id).is_some() {
        save_names(data_dir, &titles)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sound_lifecycle() {
        let root = std::env::temp_dir().join(format!("nr-snd-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let src = root.join("Утренний звонок.MP3");
        std::fs::write(&src, b"ID3fake").unwrap();
        let s = import(&root, &src).unwrap();
        assert!(s.id.starts_with("snd-") && s.id.ends_with(".mp3"));
        assert_eq!(s.name, "Утренний звонок");
        let all = list(&root).unwrap();
        assert_eq!(all.iter().filter(|s| s.builtin).count(), BUILTIN_SOUNDS.len());
        assert!(all.iter().any(|x| x.id == s.id && x.name == "Утренний звонок"));
        assert!(file(&root, "pulse").unwrap().is_none());
        assert!(file(&root, &s.id).unwrap().is_some());
        assert!(file(&root, "snd-..\\..\\x.mp3").is_err());
        assert!(import(&root, &root.join("notes.txt")).is_err());
        delete(&root, &s.id).unwrap();
        assert_eq!(list(&root).unwrap().len(), BUILTIN_SOUNDS.len());
        let _ = std::fs::remove_dir_all(&root);
    }
}
