//! Installed game discovery from launcher data on disk: Steam app manifests,
//! Epic Games Launcher manifests and GOG Galaxy registry entries. Read-only;
//! launching goes through each launcher's documented URI or the game's exe.

use std::path::{Path, PathBuf};

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Game {
    /// `<source>:<launcher id>`, stable across scans.
    pub id: String,
    pub source: &'static str,
    pub name: String,
    pub install_dir: Option<String>,
    pub size_bytes: Option<u64>,
    /// URI or executable handed to Windows on launch.
    #[serde(skip)]
    pub launch_target: String,
    #[serde(skip)]
    pub launch_dir: Option<PathBuf>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryScan {
    pub games: Vec<Game>,
    /// Launchers that were found on this machine.
    pub sources: Vec<SourceStatus>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceStatus {
    pub source: &'static str,
    pub detected: bool,
    pub count: usize,
}

pub fn scan() -> LibraryScan {
    let (steam_found, steam) = steam_games();
    let (epic_found, epic) = epic_games();
    let (gog_found, gog) = gog_games();
    let (prism_found, prism) = prism_instances();
    let sources = vec![
        SourceStatus { source: "steam", detected: steam_found, count: steam.len() },
        SourceStatus { source: "epic", detected: epic_found, count: epic.len() },
        SourceStatus { source: "gog", detected: gog_found, count: gog.len() },
        SourceStatus { source: "prism", detected: prism_found, count: prism.len() },
    ];
    let mut games: Vec<Game> = steam.into_iter().chain(epic).chain(gog).chain(prism).collect();
    games.sort_by_key(|g| g.name.to_lowercase());
    LibraryScan { games, sources }
}

pub fn find(id: &str) -> Option<Game> {
    scan().games.into_iter().find(|g| g.id == id)
}

/// Extracts `"key" "value"` pairs from Valve KeyValues text (flat scan; good
/// enough for appmanifest/libraryfolders fields NETRUNNER needs).
pub fn vdf_values(text: &str, key: &str) -> Vec<String> {
    let needle = format!("\"{key}\"");
    text.lines()
        .filter_map(|line| {
            let line = line.trim();
            let rest = line.strip_prefix(needle.as_str())?;
            let start = rest.find('"')? + 1;
            let end = rest[start..].rfind('"')? + start;
            Some(rest[start..end].replace("\\\\", "\\"))
        })
        .collect()
}

pub(crate) fn steam_root() -> Option<PathBuf> {
    use winreg::enums::HKEY_CURRENT_USER;
    let key = winreg::RegKey::predef(HKEY_CURRENT_USER).open_subkey(r"Software\Valve\Steam").ok()?;
    let path: String = key.get_value("SteamPath").ok()?;
    let path = PathBuf::from(path.replace('/', "\\"));
    path.is_dir().then_some(path)
}

/// Steam tools that are not games.
const STEAM_SKIP: &[&str] = &["228980", "1070560", "1391110", "1628350", "1493710", "2180100"];

fn steam_games() -> (bool, Vec<Game>) {
    let Some(root) = steam_root() else { return (false, Vec::new()) };
    let mut libraries = vec![root.join("steamapps")];
    if let Ok(text) = std::fs::read_to_string(root.join(r"steamapps\libraryfolders.vdf")) {
        for path in vdf_values(&text, "path") {
            let lib = PathBuf::from(path).join("steamapps");
            if !libraries.iter().any(|l| l.eq(&lib)) {
                libraries.push(lib);
            }
        }
    }
    let mut games = Vec::new();
    for lib in libraries {
        for entry in std::fs::read_dir(&lib).into_iter().flatten().flatten() {
            let file = entry.file_name().to_string_lossy().into_owned();
            if !(file.starts_with("appmanifest_") && file.ends_with(".acf")) {
                continue;
            }
            let Ok(text) = std::fs::read_to_string(entry.path()) else { continue };
            let first = |k: &str| vdf_values(&text, k).into_iter().next();
            let (Some(appid), Some(name)) = (first("appid"), first("name")) else { continue };
            if STEAM_SKIP.contains(&appid.as_str()) || name.starts_with("Proton ") || name.starts_with("Steam Linux Runtime") {
                continue;
            }
            games.push(Game {
                id: format!("steam:{appid}"),
                source: "steam",
                install_dir: first("installdir").map(|d| lib.join("common").join(d).display().to_string()),
                size_bytes: first("SizeOnDisk").and_then(|s| s.parse().ok()).filter(|s| *s > 0),
                launch_target: format!("steam://rungameid/{appid}"),
                launch_dir: None,
                name,
            });
        }
    }
    (true, games)
}

fn epic_games() -> (bool, Vec<Game>) {
    let Some(program_data) = std::env::var_os("ProgramData") else { return (false, Vec::new()) };
    let dir = Path::new(&program_data).join(r"Epic\EpicGamesLauncher\Data\Manifests");
    if !dir.is_dir() {
        return (false, Vec::new());
    }
    let mut games = Vec::new();
    for entry in std::fs::read_dir(&dir).into_iter().flatten().flatten() {
        if entry.path().extension().and_then(|e| e.to_str()) != Some("item") {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(entry.path()) else { continue };
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else { continue };
        let s = |k: &str| v.get(k).and_then(|x| x.as_str()).unwrap_or_default().to_string();
        let is_game = v
            .get("AppCategories")
            .and_then(|c| c.as_array())
            .map_or(true, |c| c.iter().any(|x| x.as_str() == Some("games")));
        let (ns, item, app) = (s("CatalogNamespace"), s("CatalogItemId"), s("AppName"));
        if !is_game || app.is_empty() || ns.is_empty() {
            continue;
        }
        games.push(Game {
            id: format!("epic:{app}"),
            source: "epic",
            name: Some(s("DisplayName")).filter(|n| !n.is_empty()).unwrap_or_else(|| app.clone()),
            install_dir: Some(s("InstallLocation")).filter(|d| !d.is_empty()),
            size_bytes: v.get("InstallSize").and_then(|x| x.as_u64()),
            launch_target: format!("com.epicgames.launcher://apps/{ns}%3A{item}%3A{app}?action=launch&silent=true"),
            launch_dir: None,
        });
    }
    (true, games)
}

fn gog_games() -> (bool, Vec<Game>) {
    use winreg::enums::HKEY_LOCAL_MACHINE;
    let Ok(root) = winreg::RegKey::predef(HKEY_LOCAL_MACHINE).open_subkey(r"SOFTWARE\WOW6432Node\GOG.com\Games") else {
        return (false, Vec::new());
    };
    let mut games = Vec::new();
    for id in root.enum_keys().flatten() {
        let Ok(key) = root.open_subkey(&id) else { continue };
        let get = |k: &str| key.get_value::<String, _>(k).ok().filter(|s| !s.is_empty());
        let (Some(name), Some(exe)) = (get("gameName"), get("exe")) else { continue };
        if !Path::new(&exe).is_file() {
            continue;
        }
        games.push(Game {
            id: format!("gog:{id}"),
            source: "gog",
            name,
            install_dir: get("path"),
            size_bytes: None,
            launch_dir: get("workingDir").or_else(|| get("path")).map(PathBuf::from),
            launch_target: exe,
        });
    }
    (true, games)
}

/// Locates Prism Launcher: the installer's uninstall entry, the default
/// per-user install, Scoop, then a portable copy next to its data.
fn prism_exe() -> Option<PathBuf> {
    use winreg::enums::HKEY_CURRENT_USER;
    let from_registry = winreg::RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey(r"Software\Microsoft\Windows\CurrentVersion\Uninstall\PrismLauncher")
        .ok()
        .and_then(|k| k.get_value::<String, _>("InstallLocation").ok())
        .map(|dir| PathBuf::from(dir.trim_matches('"')).join("prismlauncher.exe"));
    let candidates = [
        r"%LOCALAPPDATA%\Programs\PrismLauncher\prismlauncher.exe",
        r"%ProgramFiles%\PrismLauncher\prismlauncher.exe",
        r"%USERPROFILE%\scoop\apps\prismlauncher\current\prismlauncher.exe",
        r"%APPDATA%\PrismLauncher\prismlauncher.exe",
    ];
    from_registry
        .into_iter()
        .chain(candidates.iter().map(|c| PathBuf::from(super::launcher::expand_env(c))))
        .find(|p| p.is_file())
}

/// Reads a key from a flat `key=value` INI file (Prism/MultiMC config format).
fn ini_value(text: &str, key: &str) -> Option<String> {
    text.lines().find_map(|line| {
        let (k, v) = line.split_once('=')?;
        (k.trim() == key).then(|| v.trim().to_string()).filter(|v| !v.is_empty())
    })
}

/// Minecraft instances managed by Prism Launcher. Each instance launches via
/// Prism's documented `--launch <instance id>` command-line option.
fn prism_instances() -> (bool, Vec<Game>) {
    let Some(appdata) = std::env::var_os("APPDATA") else { return (false, Vec::new()) };
    let exe = prism_exe();
    // Portable installs keep their data next to the executable.
    let data_dirs: Vec<PathBuf> = [Some(Path::new(&appdata).join("PrismLauncher")), exe.as_ref().and_then(|e| e.parent().map(Path::to_path_buf))]
        .into_iter()
        .flatten()
        .filter(|d| d.join("prismlauncher.cfg").is_file() || d.join("instances").is_dir())
        .collect();
    let Some(data_dir) = data_dirs.first() else { return (exe.is_some(), Vec::new()) };
    let Some(exe) = exe else { return (false, Vec::new()) };

    let instances_dir = std::fs::read_to_string(data_dir.join("prismlauncher.cfg"))
        .ok()
        .and_then(|cfg| ini_value(&cfg, "InstanceDir"))
        .map(|d| {
            let p = PathBuf::from(&d);
            if p.is_absolute() { p } else { data_dir.join(p) }
        })
        .unwrap_or_else(|| data_dir.join("instances"));

    let mut games = Vec::new();
    for entry in std::fs::read_dir(&instances_dir).into_iter().flatten().flatten() {
        let dir = entry.path();
        let Ok(cfg) = std::fs::read_to_string(dir.join("instance.cfg")) else { continue };
        let id = entry.file_name().to_string_lossy().into_owned();
        let name = ini_value(&cfg, "name").unwrap_or_else(|| id.clone());
        games.push(Game {
            id: format!("prism:{id}"),
            source: "prism",
            // Copied instances often share a display name; the folder id disambiguates.
            name: if name == id { format!("Minecraft {name}") } else { format!("Minecraft {name} [{id}]") },
            install_dir: Some(dir.display().to_string()),
            size_bytes: None,
            launch_target: exe.display().to_string(),
            launch_dir: exe.parent().map(Path::to_path_buf),
        });
    }
    (true, games)
}

/// Command-line parameters needed to launch a game (only Prism needs any).
pub fn launch_params(game: &Game) -> String {
    match game.id.strip_prefix("prism:") {
        Some(instance) => format!("--launch \"{}\"", instance.replace('"', "")),
        None => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_ini_values() {
        let cfg = "[General]\nname=Fabric 1.21\nInstanceType=OneSix\nempty=\n";
        assert_eq!(ini_value(cfg, "name").as_deref(), Some("Fabric 1.21"));
        assert_eq!(ini_value(cfg, "empty"), None);
        assert_eq!(ini_value(cfg, "missing"), None);
    }

    #[test]
    fn prism_launch_params_quote_instance() {
        let g = Game {
            id: "prism:My Pack".into(),
            source: "prism",
            name: "x".into(),
            install_dir: None,
            size_bytes: None,
            launch_target: String::new(),
            launch_dir: None,
        };
        assert_eq!(launch_params(&g), "--launch \"My Pack\"");
    }

    #[test]
    fn parses_vdf_values() {
        let text = "\"AppState\"\n{\n\t\"appid\"\t\t\"1091500\"\n\t\"name\"\t\t\"Cyberpunk 2077\"\n\t\"installdir\"\t\t\"Cyberpunk 2077\"\n}";
        assert_eq!(vdf_values(text, "appid"), vec!["1091500"]);
        assert_eq!(vdf_values(text, "name"), vec!["Cyberpunk 2077"]);
        let libs = "\"libraryfolders\"\n{\n\"0\"\n{\n\t\t\"path\"\t\t\"D:\\\\SteamLibrary\"\n}\n}";
        assert_eq!(vdf_values(libs, "path"), vec!["D:\\SteamLibrary"]);
    }
}
