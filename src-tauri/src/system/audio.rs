//! Sound devices and per-app volume through Windows Core Audio:
//! endpoints (IMMDeviceEnumerator), their volume and mute
//! (IAudioEndpointVolume), peak meters (IAudioMeterInformation) and app
//! sessions (IAudioSessionManager2 / ISimpleAudioVolume).
//!
//! Windows has no public API to change the default device. NETRUNNER uses the
//! widely used, undocumented `IPolicyConfig` interface for it; when that fails
//! the UI offers the Windows sound settings instead.

use serde::Serialize;

use crate::error::{AppError, AppResult};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    pub id: String,
    pub name: String,
    pub is_default: bool,
    /// 0–100.
    pub volume: u8,
    pub muted: bool,
    /// Current peak level, 0.0–1.0.
    pub peak: f32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioDevices {
    pub outputs: Vec<Device>,
    pub inputs: Vec<Device>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    /// Session instance identifier (stable while the app plays).
    pub id: String,
    pub pid: u32,
    pub name: String,
    pub volume: u8,
    pub muted: bool,
    pub peak: f32,
    pub system: bool,
}

pub fn to_percent(scalar: f32) -> u8 {
    (scalar.clamp(0.0, 1.0) * 100.0).round() as u8
}

pub fn to_scalar(percent: u8) -> f32 {
    f32::from(percent.min(100)) / 100.0
}

/// Display name for a session: its own name, else the process name without `.exe`.
pub fn session_name(display: &str, process: Option<&str>, system: bool) -> String {
    if system {
        return "System sounds".into();
    }
    let d = display.trim();
    if !d.is_empty() && !d.starts_with('@') {
        return d.to_string();
    }
    process.map(|p| p.trim_end_matches(".exe").trim_end_matches(".EXE").to_string()).filter(|p| !p.is_empty()).unwrap_or_else(|| "Unknown app".into())
}

#[cfg(windows)]
// IPolicyConfig keeps the COM method names.
#[allow(non_snake_case)]
mod win {
    use super::*;
    use windows::core::{interface, Interface, IUnknown, IUnknown_Vtbl, HRESULT, PCWSTR, PWSTR};
    use windows::Win32::Devices::FunctionDiscovery::PKEY_Device_FriendlyName;
    use windows::Win32::Media::Audio::Endpoints::{IAudioEndpointVolume, IAudioMeterInformation};
    use windows::Win32::Media::Audio::{
        eCapture, eCommunications, eConsole, eMultimedia, eRender, AudioSessionStateExpired, EDataFlow, IAudioSessionControl2, IAudioSessionManager2, IMMDevice,
        IMMDeviceEnumerator, ISimpleAudioVolume, MMDeviceEnumerator, DEVICE_STATE_ACTIVE, ERole,
    };
    use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CoTaskMemFree, CLSCTX_ALL, COINIT_MULTITHREADED, STGM_READ};

    fn com() {
        // SAFETY: initialising COM for this thread; "already initialised" is fine.
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        }
    }

    fn err(what: &str) -> impl Fn(windows::core::Error) -> AppError + '_ {
        move |e| AppError::Internal(format!("{what}: {e}"))
    }

    fn enumerator() -> AppResult<IMMDeviceEnumerator> {
        com();
        // SAFETY: plain COM object creation; the result is checked.
        unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).map_err(err("audio devices unavailable")) }
    }

    fn pwstr(p: PWSTR) -> String {
        // SAFETY: `p` is a COM-allocated string returned by the API; read once, then freed.
        unsafe {
            let s = p.to_string().unwrap_or_default();
            CoTaskMemFree(Some(p.0 as _));
            s
        }
    }

    fn device_id(d: &IMMDevice) -> String {
        // SAFETY: GetId returns a COM string that `pwstr` frees.
        unsafe { d.GetId().map(pwstr).unwrap_or_default() }
    }

    fn friendly_name(d: &IMMDevice) -> String {
        // SAFETY: reading one property from the device's property store.
        unsafe {
            d.OpenPropertyStore(STGM_READ)
                .and_then(|store| store.GetValue(&PKEY_Device_FriendlyName))
                .map(|v| v.to_string())
                .unwrap_or_else(|_| "Audio device".into())
        }
    }

    fn describe(d: &IMMDevice, default_id: &str) -> Device {
        let id = device_id(d);
        // SAFETY: activating standard Core Audio interfaces on an active endpoint.
        let (volume, muted, peak) = unsafe {
            let vol = d.Activate::<IAudioEndpointVolume>(CLSCTX_ALL, None).ok();
            let meter = d.Activate::<IAudioMeterInformation>(CLSCTX_ALL, None).ok();
            (
                vol.as_ref().and_then(|v| v.GetMasterVolumeLevelScalar().ok()).map(to_percent).unwrap_or(0),
                vol.as_ref().and_then(|v| v.GetMute().ok()).map(|b| b.as_bool()).unwrap_or(false),
                meter.and_then(|m| m.GetPeakValue().ok()).unwrap_or(0.0),
            )
        };
        Device { is_default: id == default_id, name: friendly_name(d), id, volume, muted, peak }
    }

    fn list(e: &IMMDeviceEnumerator, flow: EDataFlow) -> Vec<Device> {
        // SAFETY: enumerating active endpoints; every call is checked.
        unsafe {
            let default_id = e.GetDefaultAudioEndpoint(flow, eConsole).map(|d| device_id(&d)).unwrap_or_default();
            let Ok(coll) = e.EnumAudioEndpoints(flow, DEVICE_STATE_ACTIVE) else { return Vec::new() };
            let n = coll.GetCount().unwrap_or(0);
            (0..n).filter_map(|i| coll.Item(i).ok()).map(|d| describe(&d, &default_id)).collect()
        }
    }

    pub fn devices() -> AppResult<AudioDevices> {
        let e = enumerator()?;
        Ok(AudioDevices { outputs: list(&e, eRender), inputs: list(&e, eCapture) })
    }

    fn device(id: &str) -> AppResult<IMMDevice> {
        let e = enumerator()?;
        let wide: Vec<u16> = id.encode_utf16().chain(Some(0)).collect();
        // SAFETY: `wide` is a NUL-terminated UTF-16 string that outlives the call.
        unsafe { e.GetDevice(PCWSTR(wide.as_ptr())).map_err(|_| AppError::NotFound("audio device not found".into())) }
    }

    fn endpoint_volume(id: Option<&str>) -> AppResult<IAudioEndpointVolume> {
        let d = match id {
            Some(id) => device(id)?,
            // SAFETY: default playback endpoint lookup; checked.
            None => unsafe { enumerator()?.GetDefaultAudioEndpoint(eRender, eConsole).map_err(|_| AppError::NotFound("no default playback device".into()))? },
        };
        // SAFETY: activating the endpoint's volume interface.
        unsafe { d.Activate(CLSCTX_ALL, None).map_err(err("cannot open the volume control")) }
    }

    pub fn set_device_volume(id: Option<&str>, percent: u8) -> AppResult<()> {
        let v = endpoint_volume(id)?;
        // SAFETY: setting a scalar in 0..=1; no event context.
        unsafe { v.SetMasterVolumeLevelScalar(to_scalar(percent), std::ptr::null()).map_err(err("cannot set the volume")) }
    }

    pub fn set_device_mute(id: &str, mute: bool) -> AppResult<()> {
        let v = endpoint_volume(Some(id))?;
        // SAFETY: as above.
        unsafe { v.SetMute(mute, std::ptr::null()).map_err(err("cannot change mute")) }
    }

    /// Undocumented interface behind the Windows sound settings (Windows 7–11).
    #[interface("f8679f50-850a-41cf-9c72-430f290290c8")]
    unsafe trait IPolicyConfig: IUnknown {
        fn GetMixFormat(&self, device: PCWSTR, format: *mut *mut core::ffi::c_void) -> HRESULT;
        fn GetDeviceFormat(&self, device: PCWSTR, default: i32, format: *mut *mut core::ffi::c_void) -> HRESULT;
        fn ResetDeviceFormat(&self, device: PCWSTR) -> HRESULT;
        fn SetDeviceFormat(&self, device: PCWSTR, endpoint: *mut core::ffi::c_void, mix: *mut core::ffi::c_void) -> HRESULT;
        fn GetProcessingPeriod(&self, device: PCWSTR, default: i32, period: *mut i64, min: *mut i64) -> HRESULT;
        fn SetProcessingPeriod(&self, device: PCWSTR, period: *mut i64) -> HRESULT;
        fn GetShareMode(&self, device: PCWSTR, mode: *mut core::ffi::c_void) -> HRESULT;
        fn SetShareMode(&self, device: PCWSTR, mode: *mut core::ffi::c_void) -> HRESULT;
        fn GetPropertyValue(&self, device: PCWSTR, store: i32, key: *const core::ffi::c_void, value: *mut core::ffi::c_void) -> HRESULT;
        fn SetPropertyValue(&self, device: PCWSTR, store: i32, key: *const core::ffi::c_void, value: *mut core::ffi::c_void) -> HRESULT;
        fn SetDefaultEndpoint(&self, device: PCWSTR, role: ERole) -> HRESULT;
        fn SetEndpointVisibility(&self, device: PCWSTR, visible: i32) -> HRESULT;
    }

    const CLSID_POLICY_CONFIG: windows::core::GUID = windows::core::GUID::from_u128(0x870af99c_171d_4f9e_af0d_e63df40c2bc9);

    pub fn set_default(id: &str) -> AppResult<()> {
        device(id)?; // a real, present device
        com();
        let wide: Vec<u16> = id.encode_utf16().chain(Some(0)).collect();
        // SAFETY: creating the policy object and calling SetDefaultEndpoint with
        // a NUL-terminated id; failures are returned, never assumed away.
        unsafe {
            let unknown: IUnknown = CoCreateInstance(&CLSID_POLICY_CONFIG, None, CLSCTX_ALL)
                .map_err(|e| AppError::Launch(format!("Windows did not allow changing the default device here ({e}); use the Windows sound settings")))?;
            let policy: IPolicyConfig = unknown.cast().map_err(|e| AppError::Launch(format!("the default-device interface is not available on this Windows ({e})")))?;
            for role in [eConsole, eMultimedia, eCommunications] {
                policy.SetDefaultEndpoint(PCWSTR(wide.as_ptr()), role).ok().map_err(|e| AppError::Launch(format!("could not set the default device: {e}")))?;
            }
        }
        Ok(())
    }

    /// Process names by pid: the mixer polls several times a second.
    static NAMES: std::sync::Mutex<Option<std::collections::HashMap<u32, String>>> = std::sync::Mutex::new(None);

    fn process_name(pid: u32) -> Option<String> {
        use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};
        let mut cache = NAMES.lock().ok()?;
        let cache = cache.get_or_insert_with(Default::default);
        if let Some(n) = cache.get(&pid) {
            return Some(n.clone());
        }
        let mut sys = System::new();
        let p = Pid::from_u32(pid);
        sys.refresh_processes_specifics(ProcessesToUpdate::Some(&[p]), true, ProcessRefreshKind::nothing());
        let name = sys.process(p).map(|x| x.name().to_string_lossy().into_owned())?;
        // Pids get reused: forget everything now and then.
        if cache.len() > 256 {
            cache.clear();
        }
        cache.insert(pid, name.clone());
        Some(name)
    }

    fn for_sessions(device_id: Option<&str>, mut f: impl FnMut(&IAudioSessionControl2, &ISimpleAudioVolume) -> bool) -> AppResult<()> {
        let d = match device_id {
            Some(id) => device(id)?,
            // SAFETY: default endpoint lookup; checked.
            None => unsafe { enumerator()?.GetDefaultAudioEndpoint(eRender, eConsole).map_err(|_| AppError::NotFound("no default playback device".into()))? },
        };
        // SAFETY: session enumeration on the device; each session interface is checked.
        unsafe {
            let mgr: IAudioSessionManager2 = d.Activate(CLSCTX_ALL, None).map_err(err("app volumes unavailable"))?;
            let list = mgr.GetSessionEnumerator().map_err(err("app volumes unavailable"))?;
            for i in 0..list.GetCount().unwrap_or(0) {
                let Ok(ctl) = list.GetSession(i) else { continue };
                if ctl.GetState().is_ok_and(|s| s == AudioSessionStateExpired) {
                    continue;
                }
                let (Ok(c2), Ok(vol)) = (ctl.cast::<IAudioSessionControl2>(), ctl.cast::<ISimpleAudioVolume>()) else { continue };
                if !f(&c2, &vol) {
                    break;
                }
            }
        }
        Ok(())
    }

    fn session_id(c: &IAudioSessionControl2) -> String {
        // SAFETY: COM string freed by `pwstr`.
        unsafe { c.GetSessionInstanceIdentifier().map(pwstr).unwrap_or_default() }
    }

    pub fn sessions(device_id: Option<&str>) -> AppResult<Vec<Session>> {
        let mut out = Vec::new();
        for_sessions(device_id, |c, v| {
            // SAFETY: reading properties of a live session.
            unsafe {
                let pid = c.GetProcessId().unwrap_or(0);
                let system = c.IsSystemSoundsSession() == windows::Win32::Foundation::S_OK;
                let display = c.GetDisplayName().map(pwstr).unwrap_or_default();
                let peak = c.cast::<IAudioMeterInformation>().ok().and_then(|m| m.GetPeakValue().ok()).unwrap_or(0.0);
                out.push(Session {
                    id: session_id(c),
                    name: session_name(&display, process_name(pid).as_deref(), system),
                    pid,
                    volume: v.GetMasterVolume().map(to_percent).unwrap_or(0),
                    muted: v.GetMute().map(|b| b.as_bool()).unwrap_or(false),
                    peak,
                    system,
                });
            }
            true
        })?;
        out.sort_by(|a, b| a.system.cmp(&b.system).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
        Ok(out)
    }

    /// Volume/mute of the session with `id`, or of every session of a process name.
    pub fn set_session(target: &SessionTarget, volume: Option<u8>, mute: Option<bool>) -> AppResult<usize> {
        let mut n = 0;
        for_sessions(None, |c, v| {
            let hit = match target {
                SessionTarget::Id(id) => session_id(c) == *id,
                // SAFETY: reading the session's process id.
                SessionTarget::Process(name) => unsafe { c.GetProcessId() }
                    .ok()
                    .and_then(process_name)
                    .is_some_and(|p| p.trim_end_matches(".exe").eq_ignore_ascii_case(name.trim_end_matches(".exe"))),
            };
            if hit {
                // SAFETY: changing volume or mute of a live session.
                unsafe {
                    if let Some(p) = volume {
                        let _ = v.SetMasterVolume(to_scalar(p), std::ptr::null());
                    }
                    if let Some(m) = mute {
                        let _ = v.SetMute(m, std::ptr::null());
                    }
                }
                n += 1;
            }
            !matches!(target, SessionTarget::Id(_)) || !hit
        })?;
        Ok(n)
    }
}

pub enum SessionTarget {
    Id(String),
    /// Every session of a process (`Spotify` or `Spotify.exe`), for automations.
    Process(String),
}

#[cfg(windows)]
pub use win::{devices, sessions, set_default, set_device_mute, set_device_volume, set_session};

/// Sets the default playback device's master volume, 0–100 %.
#[cfg(windows)]
pub fn set_master_volume(percent: u8) -> AppResult<()> {
    set_device_volume(None, percent)
}

/// Makes the output device whose name contains `name` (case-insensitive) the default.
#[cfg(windows)]
pub fn set_output_by_name(name: &str) -> AppResult<String> {
    let all = devices()?.outputs;
    let needle = name.trim().to_lowercase();
    let d = all
        .iter()
        .find(|d| d.name.to_lowercase() == needle)
        .or_else(|| all.iter().find(|d| d.name.to_lowercase().contains(&needle)))
        .ok_or_else(|| AppError::NotFound(format!("no output device matches '{name}'")))?;
    if !d.is_default {
        set_default(&d.id)?;
    }
    Ok(d.name.clone())
}

#[cfg(not(windows))]
pub fn set_master_volume(_percent: u8) -> AppResult<()> {
    Err(AppError::Invalid("volume control is available on Windows only".into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_levels_and_names() {
        assert_eq!((to_percent(0.555), to_percent(1.7), to_percent(-1.0)), (56, 100, 0));
        assert!((to_scalar(40) - 0.4).abs() < 1e-6);
        assert_eq!(session_name("", Some("Spotify.exe"), false), "Spotify");
        assert_eq!(session_name("@%SystemRoot%\\x.dll,-1", Some("svc.exe"), false), "svc");
        assert_eq!(session_name("Discord", Some("Discord.exe"), false), "Discord");
        assert_eq!(session_name("", None, true), "System sounds");
        assert_eq!(session_name("", None, false), "Unknown app");
    }

    /// Reads the machine's devices and writes back the values they already have.
    #[cfg(windows)]
    #[test]
    fn devices_round_trip_without_changes() {
        let Ok(all) = devices() else { return };
        for d in all.outputs.iter().chain(&all.inputs) {
            assert!(!d.id.is_empty() && !d.name.is_empty());
            assert!((0.0..=1.0).contains(&d.peak));
        }
        if let Some(d) = all.outputs.iter().find(|d| d.is_default) {
            set_device_volume(Some(&d.id), d.volume).unwrap();
            set_device_mute(&d.id, d.muted).unwrap();
            // Setting the current default again changes nothing.
            set_default(&d.id).unwrap();
            let after = devices().unwrap();
            let same = after.outputs.iter().find(|x| x.id == d.id).unwrap();
            assert!(same.is_default && same.volume.abs_diff(d.volume) <= 1 && same.muted == d.muted);
        }
        let s = sessions(None).unwrap();
        eprintln!("audio: {} outputs, {} inputs, {} sessions: {:?}", all.outputs.len(), all.inputs.len(), s.len(), s.iter().map(|x| &x.name).collect::<Vec<_>>());
        for x in &s {
            assert!(!x.name.is_empty());
            set_session(&SessionTarget::Id(x.id.clone()), Some(x.volume), Some(x.muted)).unwrap();
        }
    }
}
