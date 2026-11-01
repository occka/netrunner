//! Game banners for the GAMES banner view. Steam artwork comes from Steam's
//! own local cache when present, otherwise it is downloaded once from Steam's
//! CDN and kept in `<data>/artwork/`. The UI gets data URLs (its CSP allows no
//! remote images). Other launchers get a generated cover in the UI.

use std::path::{Path, PathBuf};
use std::time::Duration;

use base64::Engine as _;

use crate::error::{AppError, AppResult};

const MAX_BYTES: usize = 2 * 1024 * 1024;

/// Steam app id from a library id like `steam:1024890`.
fn steam_appid(id: &str) -> AppResult<&str> {
    let appid = id.strip_prefix("steam:").ok_or_else(|| AppError::NotFound("no artwork for this launcher".into()))?;
    if appid.is_empty() || appid.len() > 12 || !appid.chars().all(|c| c.is_ascii_digit()) {
        return Err(AppError::Invalid("invalid Steam app id".into()));
    }
    Ok(appid)
}

/// Steam's own cached header image (new and old cache layouts).
fn steam_local(appid: &str) -> Option<PathBuf> {
    let cache = super::games::steam_root()?.join("appcache").join("librarycache");
    [cache.join(appid).join("header.jpg"), cache.join(format!("{appid}_header.jpg"))].into_iter().find(|p| p.is_file())
}

fn data_url(bytes: &[u8]) -> String {
    let mime = if bytes.starts_with(&[0x89, b'P', b'N', b'G']) { "image/png" } else { "image/jpeg" };
    format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes))
}

fn looks_like_image(b: &[u8]) -> bool {
    b.starts_with(&[0xFF, 0xD8, 0xFF]) || b.starts_with(&[0x89, b'P', b'N', b'G'])
}

/// A banner for a library game as a data URL, or NotFound when there is none.
pub async fn banner(data_dir: &Path, id: &str) -> AppResult<String> {
    let appid = steam_appid(id)?;
    if let Some(local) = steam_local(appid) {
        if let Ok(bytes) = std::fs::read(local) {
            if looks_like_image(&bytes) && bytes.len() <= MAX_BYTES {
                return Ok(data_url(&bytes));
            }
        }
    }
    let cached = data_dir.join("artwork").join(format!("steam-{appid}.jpg"));
    if let Ok(bytes) = std::fs::read(&cached) {
        return Ok(data_url(&bytes));
    }
    let url = format!("https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/{appid}/header.jpg");
    let resp = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| AppError::Internal(e.to_string()))?
        .get(url)
        .send()
        .await
        .map_err(|e| AppError::Internal(format!("artwork download failed: {e}")))?;
    if !resp.status().is_success() {
        return Err(AppError::NotFound("Steam has no header image for this app".into()));
    }
    let bytes = resp.bytes().await.map_err(|e| AppError::Internal(e.to_string()))?;
    if bytes.len() > MAX_BYTES || !looks_like_image(&bytes) {
        return Err(AppError::NotFound("Steam returned no usable image".into()));
    }
    if let Some(dir) = cached.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(&cached, &bytes);
    Ok(data_url(&bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_steam_ids_with_digits() {
        assert_eq!(steam_appid("steam:1024890").unwrap(), "1024890");
        assert!(steam_appid("epic:abc").is_err());
        assert!(steam_appid("steam:12/../x").is_err());
        assert!(looks_like_image(&[0xFF, 0xD8, 0xFF, 0xE0]) && !looks_like_image(b"<html>"));
    }
}
