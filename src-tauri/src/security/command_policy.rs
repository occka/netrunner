//! Heuristic detection of destructive or high-risk shell commands.
//!
//! This is a safety net that forces an explicit confirmation step; it is not a
//! sandbox. Every command entry still runs in a visible console window.

use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CommandAssessment {
    pub dangerous: bool,
    pub reasons: Vec<String>,
}

/// (pattern, reason). Patterns are matched against the lower-cased command
/// with runs of whitespace collapsed to a single space.
const RULES: &[(&str, &str)] = &[
    (" format ", "formats a drive"),
    ("format-volume", "formats a volume"),
    ("clear-disk", "erases a disk"),
    ("initialize-disk", "re-initializes a disk"),
    ("diskpart", "runs the disk partitioning tool"),
    ("del /s", "recursively deletes files"),
    ("del /q", "deletes files without prompting"),
    ("erase /s", "recursively deletes files"),
    ("rd /s", "recursively removes directories"),
    ("rmdir /s", "recursively removes directories"),
    ("remove-item", "deletes files or registry keys"),
    ("rm -rf", "recursively deletes files"),
    ("rm -r", "recursively deletes files"),
    ("cipher /w", "wipes free disk space"),
    ("reg delete", "deletes registry keys"),
    ("remove-itemproperty", "deletes registry values"),
    ("bcdedit", "modifies boot configuration"),
    ("shutdown", "shuts down or restarts the computer"),
    ("stop-computer", "shuts down the computer"),
    ("restart-computer", "restarts the computer"),
    ("takeown", "takes ownership of files"),
    ("icacls", "changes file permissions"),
    ("set-executionpolicy", "changes the PowerShell execution policy"),
    ("invoke-expression", "executes dynamically built code"),
    (" iex ", "executes dynamically built code"),
    ("downloadstring", "downloads and may execute remote code"),
    ("invoke-webrequest", "downloads remote content"),
    ("start-bitstransfer", "downloads remote content"),
    ("vssadmin delete", "deletes shadow copies / restore points"),
    ("wmic shadowcopy delete", "deletes shadow copies"),
    ("net user", "modifies user accounts"),
    ("stop-process", "terminates processes"),
    ("taskkill", "terminates processes"),
    ("sc delete", "deletes a Windows service"),
    ("sc stop", "stops a Windows service"),
    ("stop-service", "stops a Windows service"),
    ("-verb runas", "requests administrator elevation"),
];

pub fn assess(command: &str) -> CommandAssessment {
    let normalized = command.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase();
    // Padding lets word patterns like " iex " match at either end of a command.
    let haystack = format!(" {normalized} ");
    let mut reasons: Vec<String> = Vec::new();
    for (pattern, reason) in RULES {
        if haystack.contains(pattern) && !reasons.iter().any(|r| r == reason) {
            reasons.push((*reason).to_string());
        }
    }
    CommandAssessment { dangerous: !reasons.is_empty(), reasons }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flags_destructive_commands() {
        assert!(assess("rd /S /Q C:\\temp").dangerous);
        assert!(assess("Remove-Item -Recurse  C:\\x").dangerous);
        assert!(assess("shutdown /r /t 0").dangerous);
        assert!(assess("irm https://x | iex").dangerous);
        assert!(assess("format").dangerous);
    }

    #[test]
    fn allows_ordinary_commands() {
        assert!(!assess("git status").dangerous);
        assert!(!assess("npm run dev").dangerous);
        assert!(!assess("ipconfig /all").dangerous);
        assert!(!assess("Get-ChildItem").dangerous);
        assert!(!assess("Get-Date -Format yyyy").dangerous);
    }
}
