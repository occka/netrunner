//! Startup applications, read the same way Task Manager does: Run registry keys
//! and Startup folders, with the enabled state stored under
//! `Explorer\StartupApproved`. Per-user entries can be toggled; machine-wide
//! entries need administrator rights and are reported as read-only.

use std::path::PathBuf;

use serde::Serialize;
use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ, KEY_SET_VALUE, REG_BINARY};
use winreg::{RegKey, RegValue};

use crate::error::{AppError, AppResult};

const RUN: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
const RUN32: &str = r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Run";
const APPROVED: &str = r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Scope {
    UserRun,
    MachineRun,
    MachineRun32,
    UserFolder,
    CommonFolder,
}

impl Scope {
    const ALL: [Scope; 5] = [Scope::UserRun, Scope::MachineRun, Scope::MachineRun32, Scope::UserFolder, Scope::CommonFolder];

    fn id(self) -> &'static str {
        match self {
            Scope::UserRun => "hkcu-run",
            Scope::MachineRun => "hklm-run",
            Scope::MachineRun32 => "hklm-run32",
            Scope::UserFolder => "user-folder",
            Scope::CommonFolder => "common-folder",
        }
    }
    fn label(self) -> &'static str {
        match self {
            Scope::UserRun => "Registry (current user)",
            Scope::MachineRun => "Registry (all users)",
            Scope::MachineRun32 => "Registry (all users, 32-bit)",
            Scope::UserFolder => "Startup folder (current user)",
            Scope::CommonFolder => "Startup folder (all users)",
        }
    }
    fn hive(self) -> RegKey {
        match self {
            Scope::UserRun | Scope::UserFolder => RegKey::predef(HKEY_CURRENT_USER),
            _ => RegKey::predef(HKEY_LOCAL_MACHINE),
        }
    }
    fn approved_subkey(self) -> String {
        let leaf = match self {
            Scope::UserRun | Scope::MachineRun => "Run",
            Scope::MachineRun32 => "Run32",
            Scope::UserFolder | Scope::CommonFolder => "StartupFolder",
        };
        format!(r"{APPROVED}\{leaf}")
    }
    fn writable(self) -> bool {
        matches!(self, Scope::UserRun | Scope::UserFolder)
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartupEntry {
    pub id: String,
    pub name: String,
    pub command: String,
    pub source: String,
    pub enabled: bool,
    /// False for machine-wide entries (need administrator rights).
    pub can_toggle: bool,
}

fn folder(scope: Scope) -> Option<PathBuf> {
    let base = match scope {
        Scope::UserFolder => std::env::var_os("APPDATA")?,
        Scope::CommonFolder => std::env::var_os("ProgramData")?,
        _ => return None,
    };
    Some(PathBuf::from(base).join(r"Microsoft\Windows\Start Menu\Programs\Startup"))
}

/// Explorer convention: first byte even = enabled, odd = disabled; a missing
/// value means enabled.
fn approved_state(scope: Scope, name: &str) -> bool {
    scope
        .hive()
        .open_subkey_with_flags(scope.approved_subkey(), KEY_READ)
        .and_then(|k| k.get_raw_value(name))
        .map(|v| v.bytes.first().map_or(true, |b| b % 2 == 0))
        .unwrap_or(true)
}

pub fn list() -> Vec<StartupEntry> {
    let mut out = Vec::new();
    for scope in Scope::ALL {
        let mut push = |name: String, command: String| {
            out.push(StartupEntry {
                id: format!("{}:{}", scope.id(), name),
                enabled: approved_state(scope, &name),
                name,
                command,
                source: scope.label().into(),
                can_toggle: scope.writable(),
            })
        };
        match scope {
            Scope::UserRun | Scope::MachineRun | Scope::MachineRun32 => {
                let path = if scope == Scope::MachineRun32 { RUN32 } else { RUN };
                if let Ok(key) = scope.hive().open_subkey_with_flags(path, KEY_READ) {
                    for (name, _) in key.enum_values().flatten() {
                        let command: String = key.get_value(&name).unwrap_or_default();
                        if !name.is_empty() {
                            push(name, command);
                        }
                    }
                }
            }
            Scope::UserFolder | Scope::CommonFolder => {
                if let Some(dir) = folder(scope) {
                    for entry in std::fs::read_dir(&dir).into_iter().flatten().flatten() {
                        let file = entry.file_name().to_string_lossy().into_owned();
                        if file.eq_ignore_ascii_case("desktop.ini") {
                            continue;
                        }
                        push(file, entry.path().display().to_string());
                    }
                }
            }
        }
    }
    out.sort_by_key(|e| e.name.to_lowercase());
    out
}

pub fn set_enabled(id: &str, enabled: bool) -> AppResult<()> {
    let (scope_id, name) = id.split_once(':').ok_or_else(|| AppError::Invalid("bad startup id".into()))?;
    let scope = Scope::ALL
        .into_iter()
        .find(|s| s.id() == scope_id)
        .ok_or_else(|| AppError::Invalid("unknown startup source".into()))?;
    if !scope.writable() {
        return Err(AppError::Invalid("machine-wide startup entries require administrator rights".into()));
    }
    if !list().iter().any(|e| e.id == id) {
        return Err(AppError::NotFound(format!("startup entry '{name}' not found")));
    }
    let (key, _) = scope.hive().create_subkey_with_flags(scope.approved_subkey(), KEY_SET_VALUE)?;
    let mut bytes = vec![0u8; 12];
    bytes[0] = if enabled { 0x02 } else { 0x03 };
    key.set_raw_value(name, &RegValue { bytes, vtype: REG_BINARY })?;
    Ok(())
}
