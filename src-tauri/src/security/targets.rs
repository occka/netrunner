//! Validation of launch targets (web URLs and launcher protocol URIs).

use crate::error::{AppError, AppResult};

/// Protocols NETRUNNER will hand to Windows for game entries. Keeping this an
/// allowlist stops a stored entry from invoking arbitrary protocol handlers.
const GAME_PROTOCOLS: &[&str] = &[
    "steam",
    "com.epicgames.launcher",
    "goggalaxy",
    "uplay",
    "ubisoft",
    "origin",
    "origin2",
    "battlenet",
    "xbox",
    "ms-xbl-3d8b930f",
];

/// Accepts only absolute http(s) URLs.
pub fn validate_web_url(raw: &str) -> AppResult<String> {
    let parsed = url::Url::parse(raw.trim())
        .map_err(|_| AppError::Invalid(format!("'{raw}' is not a valid URL")))?;
    match parsed.scheme() {
        "http" | "https" if parsed.host_str().is_some() => Ok(parsed.to_string()),
        _ => Err(AppError::Invalid("websites must use http:// or https://".into())),
    }
}

/// Returns `Some(scheme)` if the target is a URI with an allowlisted game
/// launcher protocol, `None` if it looks like a filesystem path.
pub fn game_protocol(raw: &str) -> AppResult<Option<String>> {
    let trimmed = raw.trim();
    // Drive-letter paths ("C:\...") parse as a URL with a one-letter scheme.
    if looks_like_path(trimmed) {
        return Ok(None);
    }
    match url::Url::parse(trimmed) {
        Ok(parsed) => {
            let scheme = parsed.scheme().to_ascii_lowercase();
            if GAME_PROTOCOLS.contains(&scheme.as_str()) {
                Ok(Some(scheme))
            } else {
                Err(AppError::Invalid(format!(
                    "protocol '{scheme}:' is not an allowed game launcher protocol"
                )))
            }
        }
        Err(_) => Ok(None),
    }
}

pub fn looks_like_path(raw: &str) -> bool {
    let bytes = raw.as_bytes();
    let drive = bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && matches!(bytes[2], b'\\' | b'/');
    drive || raw.starts_with("\\\\") || raw.starts_with('%')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn web_urls() {
        assert!(validate_web_url("https://github.com").is_ok());
        assert!(validate_web_url("http://localhost:3000/x").is_ok());
        assert!(validate_web_url("file:///C:/x").is_err());
        assert!(validate_web_url("javascript:alert(1)").is_err());
        assert!(validate_web_url("github.com").is_err());
    }

    #[test]
    fn game_targets() {
        assert_eq!(game_protocol("steam://rungameid/1091500").unwrap(), Some("steam".into()));
        assert_eq!(game_protocol("C:\\Games\\game.exe").unwrap(), None);
        assert_eq!(game_protocol("\\\\server\\share\\g.exe").unwrap(), None);
        assert!(game_protocol("ms-settings:privacy").is_err());
    }
}
