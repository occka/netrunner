//! Master volume of the default output device (Core Audio endpoint volume).

use crate::error::{AppError, AppResult};

/// Sets the default playback device's master volume, 0–100 %.
#[cfg(windows)]
pub fn set_master_volume(percent: u8) -> AppResult<()> {
    use windows::Win32::Media::Audio::Endpoints::IAudioEndpointVolume;
    use windows::Win32::Media::Audio::{eConsole, eRender, IMMDeviceEnumerator, MMDeviceEnumerator};
    use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_MULTITHREADED};

    let level = f32::from(percent.min(100)) / 100.0;
    // SAFETY: plain COM calls on this thread; every interface pointer is
    // checked through `Result` and released when it goes out of scope.
    unsafe {
        // Already initialised (or initialised differently) is fine for these calls.
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        let enumerator: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)
            .map_err(|e| AppError::Internal(format!("audio devices unavailable: {e}")))?;
        let device = enumerator
            .GetDefaultAudioEndpoint(eRender, eConsole)
            .map_err(|_| AppError::NotFound("no default playback device".into()))?;
        let volume: IAudioEndpointVolume =
            device.Activate(CLSCTX_ALL, None).map_err(|e| AppError::Internal(format!("cannot open the volume control: {e}")))?;
        volume
            .SetMasterVolumeLevelScalar(level, std::ptr::null())
            .map_err(|e| AppError::Internal(format!("cannot set the volume: {e}")))?;
    }
    Ok(())
}

#[cfg(not(windows))]
pub fn set_master_volume(_percent: u8) -> AppResult<()> {
    Err(AppError::Invalid("volume control is available on Windows only".into()))
}
