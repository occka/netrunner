//! Windows services (read-only). Starting/stopping services requires
//! administrator rights, which NETRUNNER does not request.

use serde::Serialize;
use windows_sys::Win32::System::Services::{
    CloseServiceHandle, EnumServicesStatusExW, OpenSCManagerW, ENUM_SERVICE_STATUS_PROCESSW, SC_ENUM_PROCESS_INFO,
    SC_MANAGER_ENUMERATE_SERVICE, SERVICE_STATE_ALL, SERVICE_WIN32,
};

use crate::error::{AppError, AppResult};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceInfo {
    pub name: String,
    pub display_name: String,
    pub state: &'static str,
    pub pid: Option<u32>,
}

fn state_name(state: u32) -> &'static str {
    match state {
        1 => "stopped",
        2 => "starting",
        3 => "stopping",
        4 => "running",
        5 => "resuming",
        6 => "pausing",
        7 => "paused",
        _ => "unknown",
    }
}

unsafe fn pwstr(p: *const u16) -> String {
    if p.is_null() {
        return String::new();
    }
    let mut len = 0;
    while *p.add(len) != 0 {
        len += 1;
    }
    String::from_utf16_lossy(std::slice::from_raw_parts(p, len))
}

pub fn list() -> AppResult<Vec<ServiceInfo>> {
    // SAFETY: standard SCM enumeration; handles are closed on every path and
    // the buffer is sized from the first call's `needed` value.
    unsafe {
        let scm = OpenSCManagerW(std::ptr::null(), std::ptr::null(), SC_MANAGER_ENUMERATE_SERVICE);
        if scm.is_null() {
            return Err(AppError::Internal("cannot open the service control manager".into()));
        }
        let mut needed = 0u32;
        let mut count = 0u32;
        let mut resume = 0u32;
        EnumServicesStatusExW(
            scm, SC_ENUM_PROCESS_INFO, SERVICE_WIN32, SERVICE_STATE_ALL,
            std::ptr::null_mut(), 0, &mut needed, &mut count, &mut resume, std::ptr::null(),
        );
        let mut buf = vec![0u8; needed as usize + 4096];
        resume = 0;
        let ok = EnumServicesStatusExW(
            scm, SC_ENUM_PROCESS_INFO, SERVICE_WIN32, SERVICE_STATE_ALL,
            buf.as_mut_ptr(), buf.len() as u32, &mut needed, &mut count, &mut resume, std::ptr::null(),
        );
        if ok == 0 {
            CloseServiceHandle(scm);
            return Err(AppError::Internal("service enumeration failed".into()));
        }
        let items = std::slice::from_raw_parts(buf.as_ptr() as *const ENUM_SERVICE_STATUS_PROCESSW, count as usize);
        let mut out: Vec<ServiceInfo> = items
            .iter()
            .map(|s| ServiceInfo {
                name: pwstr(s.lpServiceName),
                display_name: pwstr(s.lpDisplayName),
                state: state_name(s.ServiceStatusProcess.dwCurrentState),
                pid: Some(s.ServiceStatusProcess.dwProcessId).filter(|p| *p != 0),
            })
            .collect();
        CloseServiceHandle(scm);
        out.sort_by_key(|s| s.display_name.to_lowercase());
        Ok(out)
    }
}
