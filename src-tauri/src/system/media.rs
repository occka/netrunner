//! Now playing and transport controls through Windows' Global System Media
//! Transport Controls: the sessions shown in the volume flyout (Spotify,
//! browsers, NETRUNNER web overlays, media players).

use serde::Serialize;

use crate::error::{AppError, AppResult};

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MediaSession {
    pub app_id: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    /// `playing`, `paused`, `stopped`, `changing`, `closed`.
    pub status: String,
    pub position_secs: Option<f64>,
    pub duration_secs: Option<f64>,
    pub can_play_pause: bool,
    pub can_next: bool,
    pub can_previous: bool,
    /// PNG/JPEG album art as a data URL (cached per track).
    pub thumbnail: Option<String>,
    pub current: bool,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MediaStatus {
    pub available: bool,
    pub sessions: Vec<MediaSession>,
}

#[cfg(windows)]
mod imp {
    use std::collections::HashMap;
    use std::sync::{Mutex, OnceLock};

    use base64::Engine as _;
    use windows::Media::Control::{
        GlobalSystemMediaTransportControlsSession as Session, GlobalSystemMediaTransportControlsSessionManager as Manager,
        GlobalSystemMediaTransportControlsSessionPlaybackStatus as Status,
    };
    use windows::Storage::Streams::DataReader;

    use super::*;

    /// Album art by `app|title|artist`; art changes only with the track.
    fn art_cache() -> &'static Mutex<HashMap<String, Option<String>>> {
        static CACHE: OnceLock<Mutex<HashMap<String, Option<String>>>> = OnceLock::new();
        CACHE.get_or_init(Default::default)
    }

    fn manager() -> windows::core::Result<Manager> {
        Manager::RequestAsync()?.join()
    }

    fn thumbnail(session: &Session, key: &str) -> Option<String> {
        if let Some(hit) = art_cache().lock().ok()?.get(key) {
            return hit.clone();
        }
        let read = || -> windows::core::Result<Option<String>> {
            let props = session.TryGetMediaPropertiesAsync()?.join()?;
            let Ok(reference) = props.Thumbnail() else { return Ok(None) };
            let stream = reference.OpenReadAsync()?.join()?;
            let size = stream.Size()? as u32;
            if size == 0 || size > 2 * 1024 * 1024 {
                return Ok(None);
            }
            let reader = DataReader::CreateDataReader(&stream)?;
            reader.LoadAsync(size)?.join()?;
            let mut buf = vec![0u8; size as usize];
            reader.ReadBytes(&mut buf)?;
            let mime = if buf.starts_with(&[0x89, b'P', b'N', b'G']) { "image/png" } else { "image/jpeg" };
            Ok(Some(format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(buf))))
        };
        let art = read().ok().flatten();
        if let Ok(mut cache) = art_cache().lock() {
            if cache.len() > 32 {
                cache.clear();
            }
            cache.insert(key.to_string(), art.clone());
        }
        art
    }

    fn describe(session: &Session, current_id: &str) -> windows::core::Result<MediaSession> {
        let app_id = session.SourceAppUserModelId()?.to_string();
        let props = session.TryGetMediaPropertiesAsync()?.join()?;
        let info = session.GetPlaybackInfo()?;
        let controls = info.Controls()?;
        let status = match info.PlaybackStatus()? {
            Status::Playing => "playing",
            Status::Paused => "paused",
            Status::Stopped => "stopped",
            Status::Changing => "changing",
            _ => "closed",
        };
        let timeline = session.GetTimelineProperties().ok();
        // TimeSpan is in 100 ns ticks.
        let secs = |d: windows::Foundation::TimeSpan| d.Duration as f64 / 10_000_000.0;
        let (position, duration) = match &timeline {
            Some(t) => {
                let start = t.StartTime().map(secs).unwrap_or(0.0);
                let end = t.EndTime().map(secs).unwrap_or(0.0);
                let pos = t.Position().map(secs).unwrap_or(0.0);
                if end > start {
                    (Some((pos - start).max(0.0)), Some(end - start))
                } else {
                    (None, None)
                }
            }
            None => (None, None),
        };
        let title = props.Title()?.to_string();
        let artist = props.Artist()?.to_string();
        let key = format!("{app_id}|{title}|{artist}");
        Ok(MediaSession {
            current: app_id == current_id,
            thumbnail: thumbnail(session, &key),
            album: props.AlbumTitle().map(|s| s.to_string()).unwrap_or_default(),
            title,
            artist,
            status: status.into(),
            position_secs: position,
            duration_secs: duration,
            can_play_pause: controls.IsPlayPauseToggleEnabled().unwrap_or(false),
            can_next: controls.IsNextEnabled().unwrap_or(false),
            can_previous: controls.IsPreviousEnabled().unwrap_or(false),
            app_id,
        })
    }

    pub fn status() -> AppResult<MediaStatus> {
        let manager = match manager() {
            Ok(m) => m,
            Err(err) => {
                log::warn!("media sessions unavailable: {err}");
                return Ok(MediaStatus { available: false, sessions: vec![] });
            }
        };
        let current_id = manager.GetCurrentSession().and_then(|s| s.SourceAppUserModelId()).map(|s| s.to_string()).unwrap_or_default();
        let sessions = manager.GetSessions().map_err(|e| AppError::Internal(e.to_string()))?;
        let mut out: Vec<MediaSession> = sessions.into_iter().filter_map(|s| describe(&s, &current_id).ok()).collect();
        // Current session first, then playing ones.
        out.sort_by_key(|s| (!s.current, s.status != "playing"));
        Ok(MediaStatus { available: true, sessions: out })
    }

    pub fn control(app_id: &str, action: &str) -> AppResult<()> {
        let manager = manager().map_err(|e| AppError::Internal(format!("media sessions unavailable: {e}")))?;
        let sessions = manager.GetSessions().map_err(|e| AppError::Internal(e.to_string()))?;
        let session = sessions
            .into_iter()
            .find(|s| s.SourceAppUserModelId().map(|id| id == app_id).unwrap_or(false))
            .ok_or_else(|| AppError::NotFound("that player is no longer running".into()))?;
        let op = match action {
            "toggle" => session.TryTogglePlayPauseAsync(),
            "next" => session.TrySkipNextAsync(),
            "previous" => session.TrySkipPreviousAsync(),
            "stop" => session.TryStopAsync(),
            _ => return Err(AppError::Invalid(format!("unknown media action {action}"))),
        };
        let accepted = op.and_then(|o| o.join()).map_err(|e| AppError::Internal(e.to_string()))?;
        if !accepted {
            return Err(AppError::Invalid("the player refused this action".into()));
        }
        Ok(())
    }
}

#[cfg(windows)]
pub use imp::{control, status};

#[cfg(not(windows))]
pub fn status() -> AppResult<MediaStatus> {
    Ok(MediaStatus::default())
}

#[cfg(not(windows))]
pub fn control(_: &str, _: &str) -> AppResult<()> {
    Err(AppError::Invalid("media sessions need Windows".into()))
}

#[cfg(all(test, windows))]
mod smoke {
    /// Runs against the real session manager; nothing may be playing.
    #[test]
    fn media_status_does_not_fail() {
        let s = super::status().unwrap();
        for session in s.sessions {
            assert!(!session.app_id.is_empty());
        }
    }
}
