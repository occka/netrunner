//! Power status and power plans (switching plans works as a standard user).

use serde::Serialize;
use windows_sys::core::GUID;
use windows_sys::Win32::Foundation::LocalFree;
use windows_sys::Win32::System::Power::{
    GetSystemPowerStatus, PowerEnumerate, PowerGetActiveScheme, PowerReadFriendlyName, PowerSetActiveScheme,
    ACCESS_SCHEME, SYSTEM_POWER_STATUS,
};

use crate::error::{AppError, AppResult};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PowerPlan {
    pub guid: String,
    pub name: String,
    pub active: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PowerInfo {
    /// None when Windows reports the AC state as unknown.
    pub on_ac_power: Option<bool>,
    pub has_battery: bool,
    pub battery_percent: Option<u8>,
    pub battery_seconds_left: Option<u32>,
    pub battery_saver: bool,
    pub plans: Vec<PowerPlan>,
}

fn guid_string(g: &GUID) -> String {
    format!(
        "{:08x}-{:04x}-{:04x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        g.data1, g.data2, g.data3, g.data4[0], g.data4[1], g.data4[2], g.data4[3], g.data4[4], g.data4[5], g.data4[6], g.data4[7]
    )
}

fn parse_guid(s: &str) -> Option<GUID> {
    let hex: String = s.chars().filter(|c| c.is_ascii_hexdigit()).collect();
    if hex.len() != 32 {
        return None;
    }
    let n = u128::from_str_radix(&hex, 16).ok()?;
    Some(GUID::from_u128(n))
}

fn friendly_name(scheme: &GUID) -> String {
    let mut size = 0u32;
    // SAFETY: two-call pattern; the buffer is sized by the first call.
    unsafe {
        PowerReadFriendlyName(std::ptr::null_mut(), scheme, std::ptr::null(), std::ptr::null(), std::ptr::null_mut(), &mut size);
        let mut buf = vec![0u8; size as usize];
        if PowerReadFriendlyName(std::ptr::null_mut(), scheme, std::ptr::null(), std::ptr::null(), buf.as_mut_ptr(), &mut size) != 0 {
            return guid_string(scheme);
        }
        let wide: Vec<u16> = buf.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).take_while(|c| *c != 0).collect();
        String::from_utf16_lossy(&wide)
    }
}

fn active_scheme() -> Option<GUID> {
    let mut ptr: *mut GUID = std::ptr::null_mut();
    // SAFETY: Windows allocates the GUID; we copy it and free it with LocalFree.
    unsafe {
        if PowerGetActiveScheme(std::ptr::null_mut(), &mut ptr) != 0 || ptr.is_null() {
            return None;
        }
        let guid = *ptr;
        LocalFree(ptr as _);
        Some(guid)
    }
}

fn plans() -> Vec<PowerPlan> {
    let active = active_scheme().map(|g| guid_string(&g));
    let mut out = Vec::new();
    for index in 0..32u32 {
        let mut guid: GUID = unsafe { std::mem::zeroed() };
        let mut size = std::mem::size_of::<GUID>() as u32;
        // SAFETY: buffer is a GUID-sized out-parameter.
        let status = unsafe {
            PowerEnumerate(std::ptr::null_mut(), std::ptr::null(), std::ptr::null(), ACCESS_SCHEME, index, &mut guid as *mut GUID as *mut u8, &mut size)
        };
        if status != 0 {
            break;
        }
        let id = guid_string(&guid);
        out.push(PowerPlan { active: active.as_deref() == Some(id.as_str()), name: friendly_name(&guid), guid: id });
    }
    out
}

pub fn info() -> PowerInfo {
    let mut st: SYSTEM_POWER_STATUS = unsafe { std::mem::zeroed() };
    // SAFETY: valid out-pointer.
    let ok = unsafe { GetSystemPowerStatus(&mut st) } != 0;
    let has_battery = ok && st.BatteryFlag != 128 && st.BatteryFlag != 255;
    PowerInfo {
        on_ac_power: if ok && st.ACLineStatus != 255 { Some(st.ACLineStatus == 1) } else { None },
        has_battery,
        battery_percent: (has_battery && st.BatteryLifePercent != 255).then_some(st.BatteryLifePercent),
        battery_seconds_left: (has_battery && st.BatteryLifeTime != u32::MAX).then_some(st.BatteryLifeTime),
        battery_saver: ok && st.SystemStatusFlag == 1,
        plans: plans(),
    }
}

pub fn set_active(guid: &str) -> AppResult<String> {
    let plan = plans().into_iter().find(|p| p.guid.eq_ignore_ascii_case(guid)).ok_or_else(|| AppError::NotFound("power plan not found".into()))?;
    let g = parse_guid(&plan.guid).ok_or_else(|| AppError::Invalid("bad power plan id".into()))?;
    // SAFETY: GUID pointer is valid for the call.
    let status = unsafe { PowerSetActiveScheme(std::ptr::null_mut(), &g) };
    if status != 0 {
        return Err(AppError::Launch(format!("Windows refused to switch power plan (error {status})")));
    }
    Ok(plan.name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn guid_round_trip() {
        let s = "381b4222-f694-41f0-9685-ff5bb260df2e";
        assert_eq!(guid_string(&parse_guid(s).unwrap()), s);
    }
}
