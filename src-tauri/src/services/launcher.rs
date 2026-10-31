//! Executes Quick Access entries.
//!
//! Applications, files, folders and URLs go through `ShellExecuteW`, the same
//! mechanism Explorer uses: it honours file associations, `.lnk` shortcuts and
//! UAC manifests (an app that needs elevation shows the normal Windows prompt).
//! Shell commands always run in a new, visible console window.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use super::quick_access::Entry;
use crate::error::{AppError, AppResult};
use crate::security::{command_policy, targets};

/// Launches an entry. `confirmed` must be true for command entries that
/// require confirmation; otherwise `ConfirmationRequired` is returned.
pub fn launch(entry: &Entry, confirmed: bool) -> AppResult<()> {
    match entry.kind.as_str() {
        "website" => shell_open(&targets::validate_web_url(&entry.target)?, "", None),
        "folder" | "project" => {
            let path = existing_path(&entry.target, PathKind::Dir)?;
            shell_open(&path.to_string_lossy(), "", None)
        }
        "file" => {
            let path = existing_path(&entry.target, PathKind::File)?;
            shell_open(&path.to_string_lossy(), "", path.parent())
        }
        "game" if targets::game_protocol(&entry.target)?.is_some() => shell_open(entry.target.trim(), "", None),
        "app" | "game" => launch_program(entry),
        "command" => run_command(entry, confirmed),
        other => Err(AppError::Invalid(format!("unknown entry type '{other}'"))),
    }
}

/// Opens Explorer with the entry's target selected.
pub fn reveal(entry: &Entry) -> AppResult<()> {
    let has_location = matches!(entry.kind.as_str(), "app" | "game" | "file" | "folder" | "project")
        && targets::game_protocol(&entry.target).ok().flatten().is_none();
    if !has_location {
        return Err(AppError::Invalid("this entry has no file system location".into()));
    }
    let path = existing_path(&entry.target, PathKind::Any)?;
    let mut command = Command::new("explorer.exe");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // Explorer parses its own command line and expects /select,"<path>".
        command.raw_arg(format!("/select,\"{}\"", path.display()));
    }
    #[cfg(not(windows))]
    command.arg(&path);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|err| AppError::Launch(format!("could not open Explorer: {err}")))?;
    Ok(())
}

fn launch_program(entry: &Entry) -> AppResult<()> {
    let expanded = expand_env(&entry.target);
    let path = Path::new(&expanded);
    // Bare names such as "notepad.exe" are resolved by Windows (PATH / App Paths).
    if path.is_absolute() && !path.exists() {
        return Err(AppError::Launch(format!("target not found: {}", path.display())));
    }
    let working_dir = resolve_working_dir(&entry.working_dir, path.parent())?;
    shell_open(&expanded, &entry.args, working_dir.as_deref())
}

fn run_command(entry: &Entry, confirmed: bool) -> AppResult<()> {
    let assessment = command_policy::assess(&entry.target);
    if (entry.require_confirm || assessment.dangerous) && !confirmed {
        let detail = if assessment.dangerous {
            format!("This command {}.", assessment.reasons.join(", "))
        } else {
            "This command is marked as requiring confirmation.".to_string()
        };
        return Err(AppError::ConfirmationRequired(detail));
    }

    let mut command = match entry.shell.as_str() {
        "cmd" => {
            let mut c = Command::new("cmd.exe");
            c.arg("/K");
            c
        }
        "powershell" => {
            let mut c = Command::new("powershell.exe");
            c.args(["-NoLogo", "-NoExit", "-Command"]);
            c
        }
        other => return Err(AppError::Invalid(format!("unsupported shell '{other}'"))),
    };
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;
        // Passed verbatim: cmd /K and powershell -Command treat the rest of the
        // command line as the command text, so no re-quoting is wanted.
        command.raw_arg(&entry.target).creation_flags(CREATE_NEW_CONSOLE);
    }
    #[cfg(not(windows))]
    command.arg(&entry.target);

    if let Some(dir) = resolve_working_dir(&entry.working_dir, None)? {
        command.current_dir(dir);
    }
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|err| AppError::Launch(format!("could not start {}: {err}", entry.shell)))?;
    Ok(())
}

enum PathKind {
    File,
    Dir,
    Any,
}

fn existing_path(raw: &str, kind: PathKind) -> AppResult<PathBuf> {
    let path = PathBuf::from(expand_env(raw));
    let ok = match kind {
        PathKind::File => path.is_file(),
        PathKind::Dir => path.is_dir(),
        PathKind::Any => path.exists(),
    };
    if ok {
        Ok(path)
    } else {
        Err(AppError::Launch(format!("path not found: {}", path.display())))
    }
}

fn resolve_working_dir(raw: &str, fallback: Option<&Path>) -> AppResult<Option<PathBuf>> {
    if raw.trim().is_empty() {
        return Ok(fallback.filter(|p| p.is_dir()).map(Path::to_path_buf));
    }
    let dir = PathBuf::from(expand_env(raw));
    if dir.is_dir() {
        Ok(Some(dir))
    } else {
        Err(AppError::Launch(format!("working directory not found: {}", dir.display())))
    }
}

/// Expands `%VAR%` references (e.g. `%LOCALAPPDATA%\Discord\Update.exe`).
/// Unknown variables are left untouched.
pub fn expand_env(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut rest = raw.trim();
    while let Some(start) = rest.find('%') {
        out.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        match after.find('%') {
            Some(end) if end > 0 => {
                let name = &after[..end];
                match std::env::var(name) {
                    Ok(value) => out.push_str(&value),
                    Err(_) => {
                        out.push('%');
                        out.push_str(name);
                        out.push('%');
                    }
                }
                rest = &after[end + 1..];
            }
            _ => {
                out.push('%');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

#[cfg(windows)]
pub(crate) fn shell_open(target: &str, params: &str, dir: Option<&Path>) -> AppResult<()> {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::System::Com::{CoInitializeEx, COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE};
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    fn wide(s: &OsStr) -> Vec<u16> {
        s.encode_wide().chain(std::iter::once(0)).collect()
    }
    let verb = wide(OsStr::new("open"));
    let file = wide(OsStr::new(target));
    let params_w = wide(OsStr::new(params));
    let dir_w = dir.map(|d| wide(d.as_os_str()));

    // SAFETY: all pointers reference NUL-terminated buffers that outlive the
    // call. COM initialisation is recommended by the ShellExecute docs; an
    // "already initialised" result is harmless and intentionally ignored.
    let result = unsafe {
        CoInitializeEx(std::ptr::null(), (COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE) as u32);
        ShellExecuteW(
            std::ptr::null_mut(),
            verb.as_ptr(),
            file.as_ptr(),
            if params.is_empty() { std::ptr::null() } else { params_w.as_ptr() },
            dir_w.as_ref().map_or(std::ptr::null(), |d| d.as_ptr()),
            SW_SHOWNORMAL,
        )
    };
    // Values <= 32 are error codes (see ShellExecuteW documentation).
    let code = result as isize;
    if code > 32 {
        Ok(())
    } else {
        Err(AppError::Launch(format!("Windows could not open '{target}' ({})", shell_error(code))))
    }
}

#[cfg(windows)]
fn shell_error(code: isize) -> &'static str {
    match code {
        0 | 8 => "out of memory",
        2 => "file not found",
        3 => "path not found",
        5 => "access denied or elevation cancelled",
        11 => "invalid executable",
        26 => "sharing violation",
        27 | 31 => "no application is associated with this file type",
        28..=30 => "DDE failure",
        32 => "DLL not found",
        _ => "unknown error",
    }
}

#[cfg(not(windows))]
pub(crate) fn shell_open(_target: &str, _params: &str, _dir: Option<&Path>) -> AppResult<()> {
    Err(AppError::Launch("launching is only supported on Windows".into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expands_known_variables_only() {
        std::env::set_var("NETRUNNER_TEST_VAR", "C:\\X");
        assert_eq!(expand_env("%NETRUNNER_TEST_VAR%\\app.exe"), "C:\\X\\app.exe");
        assert_eq!(expand_env("%NOPE_NOT_SET_123%\\a"), "%NOPE_NOT_SET_123%\\a");
        assert_eq!(expand_env("100% done"), "100% done");
    }

    #[test]
    fn command_entries_require_confirmation_when_flagged() {
        let entry = Entry {
            id: 1,
            kind: "command".into(),
            name: "wipe".into(),
            target: "rd /s /q C:\\nope".into(),
            args: String::new(),
            working_dir: String::new(),
            shell: "cmd".into(),
            icon: String::new(),
            category: String::new(),
            favorite: false,
            require_confirm: false,
            sort_order: 0,
            launch_count: 0,
            last_launched_at: None,
            created_at: String::new(),
            updated_at: String::new(),
        };
        // Must refuse before spawning anything.
        assert!(matches!(launch(&entry, false), Err(AppError::ConfirmationRequired(_))));
    }
}
