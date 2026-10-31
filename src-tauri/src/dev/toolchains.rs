//! Detects installed language toolchains. NETRUNNER never bundles compilers or
//! interpreters; it finds the user's own and lets them override paths.

use std::collections::HashMap;
use std::path::PathBuf;
use std::time::Duration;

use serde::Serialize;

use super::process;

pub const PATHS_KEY: &str = "developer.toolchain_paths";

struct Probe {
    id: &'static str,
    name: &'static str,
    language: &'static str,
    exe: &'static str,
    args: &'static [&'static str],
}

const PROBES: &[Probe] = &[
    Probe { id: "python", name: "Python", language: "Python", exe: "python", args: &["--version"] },
    Probe { id: "node", name: "Node.js", language: "JavaScript / TypeScript", exe: "node", args: &["--version"] },
    Probe { id: "dotnet", name: ".NET SDK", language: "C#", exe: "dotnet", args: &["--version"] },
    Probe { id: "java", name: "Java (JDK)", language: "Java", exe: "javac", args: &["-version"] },
    Probe { id: "gcc", name: "GCC", language: "C / C++", exe: "gcc", args: &["--version"] },
    Probe { id: "clang", name: "Clang", language: "C / C++", exe: "clang", args: &["--version"] },
    Probe { id: "cargo", name: "Rust (Cargo)", language: "Rust", exe: "cargo", args: &["--version"] },
    Probe { id: "go", name: "Go", language: "Go", exe: "go", args: &["version"] },
    Probe { id: "php", name: "PHP", language: "PHP", exe: "php", args: &["--version"] },
    Probe { id: "git", name: "Git", language: "Version control", exe: "git", args: &["--version"] },
];

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Toolchain {
    pub id: &'static str,
    pub name: &'static str,
    pub language: &'static str,
    pub found: bool,
    pub version: Option<String>,
    pub path: Option<String>,
    /// True when the path came from the user's override setting.
    pub custom_path: bool,
}

fn first_line(s: &str) -> Option<String> {
    s.lines().map(str::trim).find(|l| !l.is_empty()).map(str::to_string)
}

fn locate(exe: &str) -> Option<String> {
    let out = process::run("where.exe", &[exe], None, Duration::from_secs(3)).ok()?;
    out.ok().then(|| first_line(&out.stdout_str())).flatten()
}

/// MSVC is not on PATH outside a developer prompt; vswhere finds it.
fn detect_msvc() -> Toolchain {
    let vswhere = PathBuf::from(super::super::services::launcher::expand_env(
        r"%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe",
    ));
    let found = vswhere.is_file().then(|| {
        process::run(
            &vswhere.to_string_lossy(),
            &["-latest", "-products", "*", "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64", "-property", "installationPath"],
            None,
            Duration::from_secs(5),
        )
        .ok()
        .and_then(|o| first_line(&o.stdout_str()))
    });
    let path = found.flatten();
    Toolchain {
        id: "msvc",
        name: "MSVC (Visual C++)",
        language: "C / C++",
        found: path.is_some(),
        version: path.as_ref().map(|_| "Visual Studio Build Tools".to_string()),
        path,
        custom_path: false,
    }
}

pub fn detect(overrides: &HashMap<String, String>) -> Vec<Toolchain> {
    let mut handles = Vec::new();
    for probe in PROBES {
        let custom = overrides.get(probe.id).filter(|p| !p.trim().is_empty()).cloned();
        handles.push(std::thread::spawn(move || {
            let exe = custom.clone().unwrap_or_else(|| probe.exe.to_string());
            let output = process::run(&exe, probe.args, None, Duration::from_secs(8)).ok();
            // Some tools (javac, older gcc) print their version to stderr.
            let version = output.as_ref().filter(|o| o.ok()).and_then(|o| first_line(&o.stdout_str()).or_else(|| first_line(&o.stderr)));
            Toolchain {
                id: probe.id,
                name: probe.name,
                language: probe.language,
                found: version.is_some(),
                path: if version.is_some() { custom.clone().or_else(|| locate(probe.exe)) } else { custom.clone() },
                version,
                custom_path: custom.is_some(),
            }
        }));
    }
    let mut out: Vec<Toolchain> = handles.into_iter().filter_map(|h| h.join().ok()).collect();
    out.insert(5, detect_msvc());
    out
}
