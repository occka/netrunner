//! Known language servers: which files they handle, where to find them and
//! the official install command. NETRUNNER never installs a server by itself;
//! the UI types the command into a visible terminal after the user confirms.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::dev::process;
use crate::services::launcher::expand_env;

pub const SETTINGS_KEY: &str = "developer.lsp_servers";

pub struct Spec {
    pub id: &'static str,
    pub name: &'static str,
    pub server: &'static str,
    /// Executable names tried in order (`.cmd` shims of npm are found too).
    pub exes: &'static [&'static str],
    pub args: &'static [&'static str],
    /// Extension → LSP language id.
    pub files: &'static [(&'static str, &'static str)],
    /// None when the server prints no version without starting.
    pub version_args: Option<&'static [&'static str]>,
    pub install: Option<&'static str>,
    pub docs: &'static str,
}

const NPM_VERSION: Option<&[&str]> = Some(&["--version"]);

pub const SPECS: &[Spec] = &[
    Spec {
        id: "typescript",
        name: "TypeScript / JavaScript",
        server: "typescript-language-server",
        exes: &["typescript-language-server"],
        args: &["--stdio"],
        files: &[
            ("ts", "typescript"),
            ("mts", "typescript"),
            ("cts", "typescript"),
            ("tsx", "typescriptreact"),
            ("js", "javascript"),
            ("mjs", "javascript"),
            ("cjs", "javascript"),
            ("jsx", "javascriptreact"),
        ],
        version_args: NPM_VERSION,
        // TypeScript 7 (native) ships no tsserver.js, which this server drives.
        install: Some("npm i -g typescript@5 typescript-language-server"),
        docs: "https://github.com/typescript-language-server/typescript-language-server",
    },
    Spec {
        id: "rust",
        name: "Rust",
        server: "rust-analyzer",
        exes: &["rust-analyzer"],
        args: &[],
        files: &[("rs", "rust")],
        version_args: Some(&["--version"]),
        install: Some("rustup component add rust-analyzer"),
        docs: "https://rust-analyzer.github.io/",
    },
    Spec {
        id: "python",
        name: "Python",
        server: "pyright",
        exes: &["pyright-langserver", "basedpyright-langserver"],
        args: &["--stdio"],
        files: &[("py", "python"), ("pyw", "python"), ("pyi", "python")],
        version_args: None,
        install: Some("npm i -g pyright"),
        docs: "https://github.com/microsoft/pyright",
    },
    Spec {
        id: "go",
        name: "Go",
        server: "gopls",
        exes: &["gopls"],
        args: &[],
        files: &[("go", "go")],
        version_args: Some(&["version"]),
        install: Some("go install golang.org/x/tools/gopls@latest"),
        docs: "https://go.dev/gopls",
    },
    Spec {
        id: "cpp",
        name: "C / C++",
        server: "clangd",
        exes: &["clangd"],
        args: &[],
        files: &[("c", "c"), ("h", "c"), ("cpp", "cpp"), ("cc", "cpp"), ("cxx", "cpp"), ("hpp", "cpp"), ("hh", "cpp"), ("hxx", "cpp")],
        version_args: Some(&["--version"]),
        install: Some("winget install LLVM.LLVM"),
        docs: "https://clangd.llvm.org/",
    },
    Spec {
        id: "csharp",
        name: "C#",
        server: "csharp-ls",
        exes: &["csharp-ls"],
        args: &[],
        files: &[("cs", "csharp"), ("csx", "csharp")],
        version_args: Some(&["--version"]),
        install: Some("dotnet tool install -g csharp-ls"),
        docs: "https://github.com/razzmatazz/csharp-language-server",
    },
    Spec {
        id: "java",
        name: "Java",
        server: "jdtls",
        exes: &["jdtls"],
        args: &[],
        files: &[("java", "java")],
        version_args: None,
        install: None,
        docs: "https://download.eclipse.org/jdtls/milestones/",
    },
    Spec {
        id: "html",
        name: "HTML",
        server: "vscode-html-language-server",
        exes: &["vscode-html-language-server"],
        args: &["--stdio"],
        files: &[("html", "html"), ("htm", "html")],
        version_args: None,
        install: Some("npm i -g vscode-langservers-extracted"),
        docs: "https://github.com/hrsh7th/vscode-langservers-extracted",
    },
    Spec {
        id: "css",
        name: "CSS / SCSS / Less",
        server: "vscode-css-language-server",
        exes: &["vscode-css-language-server"],
        args: &["--stdio"],
        files: &[("css", "css"), ("scss", "scss"), ("less", "less")],
        version_args: None,
        install: Some("npm i -g vscode-langservers-extracted"),
        docs: "https://github.com/hrsh7th/vscode-langservers-extracted",
    },
    Spec {
        id: "json",
        name: "JSON",
        server: "vscode-json-language-server",
        exes: &["vscode-json-language-server"],
        args: &["--stdio"],
        files: &[("json", "json"), ("jsonc", "jsonc")],
        version_args: None,
        install: Some("npm i -g vscode-langservers-extracted"),
        docs: "https://github.com/hrsh7th/vscode-langservers-extracted",
    },
    Spec {
        id: "yaml",
        name: "YAML",
        server: "yaml-language-server",
        exes: &["yaml-language-server"],
        args: &["--stdio"],
        files: &[("yaml", "yaml"), ("yml", "yaml")],
        version_args: None,
        install: Some("npm i -g yaml-language-server"),
        docs: "https://github.com/redhat-developer/yaml-language-server",
    },
    Spec {
        id: "lua",
        name: "Lua",
        server: "lua-language-server",
        exes: &["lua-language-server"],
        args: &[],
        files: &[("lua", "lua")],
        version_args: Some(&["--version"]),
        install: Some("winget install LuaLS.lua-language-server"),
        docs: "https://luals.github.io/",
    },
    Spec {
        id: "bash",
        name: "Bash",
        server: "bash-language-server",
        exes: &["bash-language-server"],
        args: &["start"],
        files: &[("sh", "shellscript"), ("bash", "shellscript")],
        version_args: NPM_VERSION,
        install: Some("npm i -g bash-language-server"),
        docs: "https://github.com/bash-lsp/bash-language-server",
    },
    Spec {
        id: "php",
        name: "PHP",
        server: "intelephense",
        exes: &["intelephense"],
        args: &["--stdio"],
        files: &[("php", "php")],
        version_args: None,
        install: Some("npm i -g intelephense"),
        docs: "https://intelephense.com/",
    },
    Spec {
        id: "markdown",
        name: "Markdown",
        server: "marksman",
        exes: &["marksman"],
        args: &["server"],
        files: &[("md", "markdown"), ("markdown", "markdown")],
        version_args: Some(&["--version"]),
        install: Some("winget install Artempyanykh.Marksman"),
        docs: "https://github.com/artempyanykh/marksman",
    },
    Spec {
        id: "toml",
        name: "TOML",
        server: "taplo",
        exes: &["taplo"],
        args: &["lsp", "stdio"],
        files: &[("toml", "toml")],
        version_args: Some(&["--version"]),
        install: Some("npm i -g @taplo/cli"),
        docs: "https://taplo.tamasfe.dev/",
    },
    Spec {
        id: "kotlin",
        name: "Kotlin",
        server: "kotlin-language-server",
        exes: &["kotlin-language-server"],
        args: &[],
        files: &[("kt", "kotlin"), ("kts", "kotlin")],
        version_args: None,
        install: None,
        docs: "https://github.com/fwcd/kotlin-language-server",
    },
    Spec {
        id: "ruby",
        name: "Ruby",
        server: "solargraph",
        exes: &["solargraph"],
        args: &["stdio"],
        files: &[("rb", "ruby")],
        version_args: Some(&["--version"]),
        install: Some("gem install solargraph"),
        docs: "https://solargraph.org/",
    },
    Spec {
        id: "zig",
        name: "Zig",
        server: "zls",
        exes: &["zls"],
        args: &[],
        files: &[("zig", "zig")],
        version_args: Some(&["--version"]),
        install: None,
        docs: "https://github.com/zigtools/zls",
    },
    Spec {
        id: "dart",
        name: "Dart",
        server: "dart language-server",
        exes: &["dart"],
        args: &["language-server", "--protocol=lsp"],
        files: &[("dart", "dart")],
        version_args: Some(&["--version"]),
        install: None,
        docs: "https://dart.dev/tools/dart-tool",
    },
];

pub fn spec(id: &str) -> Option<&'static Spec> {
    SPECS.iter().find(|s| s.id == id)
}

fn extension(path: &Path) -> String {
    path.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default()
}

/// The server spec and LSP language id for a file.
pub fn for_file(path: &Path) -> Option<(&'static Spec, &'static str)> {
    let ext = extension(path);
    SPECS.iter().find_map(|s| s.files.iter().find(|(e, _)| *e == ext).map(|(_, lang)| (s, *lang)))
}

/// The user's per-server choices (`developer.lsp_servers`).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserChoice {
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub disabled: bool,
}

pub type Choices = HashMap<String, UserChoice>;

pub fn choices(conn: &rusqlite::Connection) -> Choices {
    crate::services::settings::get(conn, SETTINGS_KEY)
        .ok()
        .flatten()
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default()
}

/// Folders where installers put executables that may be missing from the
/// PATH NETRUNNER was started with (it often starts at sign-in, before an install).
fn typical_dirs() -> Vec<PathBuf> {
    [
        r"%APPDATA%\npm",
        r"%USERPROFILE%\.cargo\bin",
        r"%USERPROFILE%\go\bin",
        r"%USERPROFILE%\.dotnet\tools",
        r"%LOCALAPPDATA%\Microsoft\WinGet\Links",
        r"%ProgramFiles%\LLVM\bin",
        r"%LOCALAPPDATA%\Programs\Python\Python313\Scripts",
        r"%LOCALAPPDATA%\Programs\Python\Python314\Scripts",
    ]
    .iter()
    .map(|d| PathBuf::from(expand_env(d)))
    .filter(|d| d.is_dir())
    .collect()
}

fn executable_in(dir: &Path, exe: &str) -> Option<PathBuf> {
    ["exe", "cmd", "bat"].iter().map(|ext| dir.join(format!("{exe}.{ext}"))).find(|p| p.is_file())
}

fn on_path(exe: &str) -> Option<PathBuf> {
    let out = process::run("where.exe", &[exe], None, Duration::from_secs(3)).ok()?;
    if !out.ok() {
        return None;
    }
    let lines: Vec<PathBuf> = out.stdout_str().lines().map(str::trim).filter(|l| !l.is_empty()).map(PathBuf::from).collect();
    // `where` also lists extension-less npm shell scripts; only Windows executables can be started.
    lines.into_iter().find(|p| matches!(extension(p).as_str(), "exe" | "cmd" | "bat"))
}

/// rustup installs a `rust-analyzer` proxy even when the component is
/// missing; only `rustup which` tells whether the real binary exists.
fn rustup_rust_analyzer() -> Option<PathBuf> {
    let out = process::run("rustup", &["which", "rust-analyzer"], None, Duration::from_secs(5)).ok()?;
    out.ok().then(|| PathBuf::from(out.stdout_str().trim())).filter(|p| p.is_file())
}

/// Finds the server executable: user path, the project's `node_modules/.bin`,
/// PATH, then typical install folders.
pub fn locate(spec: &Spec, choice: Option<&UserChoice>, project: Option<&Path>) -> Option<PathBuf> {
    if let Some(p) = choice.and_then(|c| c.path.as_deref()).map(str::trim).filter(|p| !p.is_empty()) {
        return Some(PathBuf::from(p)).filter(|p| p.is_file());
    }
    if spec.id == "rust" {
        return rustup_rust_analyzer().or_else(|| {
            // A standalone rust-analyzer (not the rustup proxy).
            on_path("rust-analyzer").filter(|p| !p.to_string_lossy().to_lowercase().contains(r"\.cargo\bin"))
        });
    }
    for exe in spec.exes {
        // Without the `\\?\` prefix of canonical paths, so the UI and logs show a plain path.
        let bin = project.map(|root| PathBuf::from(crate::dev::workspace::display(root)).join("node_modules").join(".bin"));
        if let Some(found) = bin.and_then(|b| executable_in(&b, exe)) {
            return Some(found);
        }
        if let Some(found) = on_path(exe) {
            return Some(found);
        }
        if let Some(found) = typical_dirs().iter().find_map(|d| executable_in(d, exe)) {
            return Some(found);
        }
    }
    None
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerStatus {
    pub id: &'static str,
    pub name: &'static str,
    pub server: &'static str,
    pub extensions: Vec<&'static str>,
    pub found: bool,
    pub path: Option<String>,
    pub version: Option<String>,
    pub custom_path: bool,
    pub disabled: bool,
    pub install: Option<&'static str>,
    pub docs: &'static str,
}

fn version(spec: &Spec, exe: &Path) -> Option<String> {
    let args = spec.version_args?;
    let out = process::run(&exe.to_string_lossy(), args, None, Duration::from_secs(6)).ok()?;
    let text = if out.stdout.is_empty() { out.stderr.clone() } else { out.stdout_str() };
    text.lines().map(str::trim).find(|l| !l.is_empty()).map(|l| l.chars().take(80).collect())
}

/// Detects every known server (in parallel: each probe may start node).
pub fn detect_all(choices: &Choices, project: Option<&Path>) -> Vec<ServerStatus> {
    std::thread::scope(|scope| {
        let handles: Vec<_> = SPECS
            .iter()
            .map(|spec| {
                let choice = choices.get(spec.id);
                scope.spawn(move || {
                    let path = locate(spec, choice, project);
                    ServerStatus {
                        id: spec.id,
                        name: spec.name,
                        server: spec.server,
                        extensions: spec.files.iter().map(|(e, _)| *e).collect(),
                        found: path.is_some(),
                        version: path.as_deref().and_then(|p| version(spec, p)),
                        path: path.map(|p| p.display().to_string()),
                        custom_path: choice.and_then(|c| c.path.as_deref()).is_some_and(|p| !p.trim().is_empty()),
                        disabled: choice.is_some_and(|c| c.disabled),
                        install: spec.install,
                        docs: spec.docs,
                    }
                })
            })
            .collect();
        handles.into_iter().filter_map(|h| h.join().ok()).collect()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn files_map_to_servers() {
        let (s, lang) = for_file(Path::new(r"C:\p\src\App.TSX")).unwrap();
        assert_eq!((s.id, lang), ("typescript", "typescriptreact"));
        assert_eq!(for_file(Path::new("main.rs")).unwrap().0.server, "rust-analyzer");
        assert_eq!(for_file(Path::new("x.jsonc")).unwrap().1, "jsonc");
        assert!(for_file(Path::new("notes.txt")).is_none());
        assert!(for_file(Path::new("Makefile")).is_none());
    }

    #[test]
    fn registry_is_consistent() {
        let mut ids = std::collections::HashSet::new();
        let mut exts = std::collections::HashSet::new();
        for s in SPECS {
            assert!(ids.insert(s.id), "duplicate id {}", s.id);
            assert!(!s.exes.is_empty());
            for (e, _) in s.files {
                assert!(exts.insert(*e), "extension {e} is claimed twice");
            }
        }
    }

    #[test]
    fn user_path_wins_and_must_exist() {
        let spec = spec("python").unwrap();
        let missing = UserChoice { path: Some(r"C:\nope\pyright-langserver.cmd".into()), disabled: false };
        assert!(locate(spec, Some(&missing), None).is_none());
        let exe = std::env::current_exe().unwrap();
        let given = UserChoice { path: Some(exe.display().to_string()), disabled: false };
        assert_eq!(locate(spec, Some(&given), None), Some(exe));
    }
}
