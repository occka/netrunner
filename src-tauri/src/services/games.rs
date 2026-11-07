//! Installed game discovery from launcher data on disk: Steam app manifests,
//! Epic Games Launcher manifests, GOG Galaxy, Ubisoft Connect and HoYoPlay
//! registry entries, Riot Client product settings and Prism Launcher instances.
//! Read-only; launching goes through each launcher's URI, its command line or
//! the game's exe.

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
    let (riot_found, riot) = riot_games();
    let (hoyo_found, hoyo) = hoyoplay_games();
    let (ubisoft_found, ubisoft) = ubisoft_games();
    let sources = vec![
        SourceStatus { source: "steam", detected: steam_found, count: steam.len() },
        SourceStatus { source: "epic", detected: epic_found, count: epic.len() },
        SourceStatus { source: "gog", detected: gog_found, count: gog.len() },
        SourceStatus { source: "riot", detected: riot_found, count: riot.len() },
        SourceStatus { source: "hoyoplay", detected: hoyo_found, count: hoyo.len() },
        SourceStatus { source: "ubisoft", detected: ubisoft_found, count: ubisoft.len() },
        SourceStatus { source: "prism", detected: prism_found, count: prism.len() },
    ];
    let mut games: Vec<Game> = steam.into_iter().chain(epic).chain(gog).chain(riot).chain(hoyo).chain(ubisoft).chain(prism).collect();
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

// ---------- Riot Client ----------

/// Product ids in Riot's metadata folders and how players know them.
const RIOT_PRODUCTS: &[(&str, &str)] = &[
    ("valorant", "VALORANT"),
    ("league_of_legends", "League of Legends"),
    ("teamfighttactics", "Teamfight Tactics"),
    ("bacon", "Legends of Runeterra"),
    ("lion", "2XKO"),
];

/// A `key: "value"` line of Riot's flat YAML.
fn yaml_value(text: &str, key: &str) -> Option<String> {
    text.lines().find_map(|line| {
        let rest = line.trim().strip_prefix(key)?.strip_prefix(':')?;
        Some(rest.trim().trim_matches('"').to_string()).filter(|v| !v.is_empty())
    })
}

/// `valorant.live` with its product settings → (product, patchline, install folder).
/// Folders such as `league_of_legends.live.game_patch` are not products.
fn riot_product(folder: &str, settings: &str) -> Option<(String, String, String)> {
    let (product, patchline) = folder.split_once('.')?;
    let plain = |s: &str| !s.is_empty() && s.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_');
    if !plain(product) || !plain(patchline) {
        return None;
    }
    let path = yaml_value(settings, "product_install_full_path")?.replace('/', "\\");
    Some((product.to_string(), patchline.to_string(), path))
}

fn riot_client() -> Option<PathBuf> {
    let program_data = std::env::var_os("ProgramData")?;
    let text = std::fs::read_to_string(Path::new(&program_data).join(r"Riot Games\RiotClientInstalls.json")).ok()?;
    let v: serde_json::Value = serde_json::from_str(&text).ok()?;
    ["rc_default", "rc_live"].iter().filter_map(|k| v[*k].as_str()).map(|p| PathBuf::from(p.replace('/', "\\"))).find(|p| p.is_file())
}

/// Games installed through the Riot Client. Its metadata keeps products that were
/// uninstalled, so only those whose folder still exists count.
fn riot_games() -> (bool, Vec<Game>) {
    let (Some(program_data), Some(client)) = (std::env::var_os("ProgramData"), riot_client()) else { return (false, Vec::new()) };
    let mut games = Vec::new();
    for entry in std::fs::read_dir(Path::new(&program_data).join(r"Riot Games\Metadata")).into_iter().flatten().flatten() {
        let folder = entry.file_name().to_string_lossy().into_owned();
        let Ok(settings) = std::fs::read_to_string(entry.path().join(format!("{folder}.product_settings.yaml"))) else { continue };
        let Some((product, patchline, path)) = riot_product(&folder, &settings) else { continue };
        if !Path::new(&path).is_dir() {
            continue;
        }
        let base = RIOT_PRODUCTS.iter().find(|(id, _)| *id == product).map_or(product.as_str(), |(_, name)| name);
        games.push(Game {
            id: format!("riot:{product}.{patchline}"),
            source: "riot",
            name: if patchline == "live" { base.to_string() } else { format!("{base} ({})", patchline.to_uppercase()) },
            install_dir: Some(path),
            size_bytes: None,
            launch_target: client.display().to_string(),
            launch_dir: client.parent().map(Path::to_path_buf),
        });
    }
    (true, games)
}

// ---------- HoYoPlay ----------

/// Game id prefixes ("hk4e_global" → "hk4e"), names and executables, global first.
const HOYO_GAMES: &[(&str, &str, &[&str])] = &[
    ("hk4e", "Genshin Impact", &["GenshinImpact.exe", "YuanShen.exe"]),
    ("hkrpg", "Honkai: Star Rail", &["StarRail.exe"]),
    ("nap", "Zenless Zone Zero", &["ZenlessZoneZero.exe"]),
    ("bh3", "Honkai Impact 3rd", &["BH3.exe"]),
];

/// The game's name and executable in its install folder, for a known game id.
fn hoyo_game(biz: &str, dir: &Path) -> Option<(String, PathBuf)> {
    let prefix = biz.split('_').next()?;
    let (_, name, exes) = HOYO_GAMES.iter().find(|(p, ..)| *p == prefix)?;
    let exe = exes.iter().map(|e| dir.join(e)).find(|p| p.is_file())?;
    let name = if biz.ends_with("_cn") { format!("{name} (China)") } else { name.to_string() };
    Some((name, exe))
}

/// Games installed through HoYoPlay (global and Chinese versions), from the
/// launcher's per-user registry keys. They start from their own executable.
fn hoyoplay_games() -> (bool, Vec<Game>) {
    use winreg::enums::HKEY_CURRENT_USER;
    let mut found = false;
    let mut games = Vec::new();
    for root in [r"Software\Cognosphere\HYP", r"Software\miHoYo\HYP"] {
        let Ok(root) = winreg::RegKey::predef(HKEY_CURRENT_USER).open_subkey(root) else { continue };
        found = true;
        for version in root.enum_keys().flatten() {
            let Ok(version) = root.open_subkey(&version) else { continue };
            for biz in version.enum_keys().flatten() {
                let Ok(key) = version.open_subkey(&biz) else { continue };
                let Ok(dir) = key.get_value::<String, _>("GameInstallPath") else { continue };
                let dir = PathBuf::from(dir);
                let Some((name, exe)) = hoyo_game(&biz, &dir) else { continue };
                if games.iter().any(|g: &Game| g.id == format!("hoyoplay:{biz}")) {
                    continue;
                }
                games.push(Game {
                    id: format!("hoyoplay:{biz}"),
                    source: "hoyoplay",
                    name,
                    install_dir: Some(dir.display().to_string()),
                    size_bytes: None,
                    launch_target: exe.display().to_string(),
                    launch_dir: Some(dir),
                });
            }
        }
    }
    (found, games)
}

// ---------- Ubisoft Connect ----------

/// Games installed through Ubisoft Connect, launched with its `uplay://` link.
fn ubisoft_games() -> (bool, Vec<Game>) {
    use winreg::enums::HKEY_LOCAL_MACHINE;
    let Ok(root) = winreg::RegKey::predef(HKEY_LOCAL_MACHINE).open_subkey(r"SOFTWARE\WOW6432Node\Ubisoft\Launcher\Installs") else {
        return (false, Vec::new());
    };
    let mut games = Vec::new();
    for id in root.enum_keys().flatten() {
        if !id.chars().all(|c| c.is_ascii_digit()) {
            continue;
        }
        let Ok(key) = root.open_subkey(&id) else { continue };
        let Ok(dir) = key.get_value::<String, _>("InstallDir") else { continue };
        let dir = PathBuf::from(dir.replace('/', "\\"));
        if !dir.is_dir() {
            continue;
        }
        let name = dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| format!("Ubisoft game {id}"));
        games.push(Game {
            id: format!("ubisoft:{id}"),
            source: "ubisoft",
            name,
            install_dir: Some(dir.display().to_string()),
            size_bytes: None,
            launch_target: format!("uplay://launch/{id}/0"),
            launch_dir: None,
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

/// Command-line parameters needed to launch a game (Prism and the Riot Client).
pub fn launch_params(game: &Game) -> String {
    if let Some(instance) = game.id.strip_prefix("prism:") {
        return format!("--launch \"{}\"", instance.replace('"', ""));
    }
    if let Some((product, patchline)) = game.id.strip_prefix("riot:").and_then(|p| p.split_once('.')) {
        // The id came from riot_product, which allows only [a-z0-9_].
        return format!("--launch-product={product} --launch-patchline={patchline}");
    }
    String::new()
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
    fn reads_riot_products() {
        let settings = "patchline_patching_ask_policy: \"ask\"\nproduct_install_full_path: \"D:/Riot Games/VALORANT/live\"\nproduct_install_root: \"D:/Riot Games\"\n";
        assert_eq!(riot_product("valorant.live", settings), Some(("valorant".into(), "live".into(), r"D:\Riot Games\VALORANT\live".into())));
        assert_eq!(riot_product("league_of_legends.pbe", settings).map(|p| p.1), Some("pbe".into()));
        assert_eq!(riot_product("league_of_legends.live.game_patch", settings), None, "not a product");
        assert_eq!(riot_product("Riot Client", settings), None);
        assert_eq!(riot_product("valorant.live", "shortcut_name: \"VALORANT.lnk\""), None, "no install folder");
        let g = Game { id: "riot:valorant.live".into(), source: "riot", name: "x".into(), install_dir: None, size_bytes: None, launch_target: String::new(), launch_dir: None };
        assert_eq!(launch_params(&g), "--launch-product=valorant --launch-patchline=live");
    }

    #[test]
    fn finds_hoyoplay_executables() {
        let dir = std::env::temp_dir().join(format!("nr-hoyo-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(hoyo_game("hk4e_global", &dir).is_none(), "no executable yet");
        std::fs::write(dir.join("YuanShen.exe"), b"").unwrap();
        assert_eq!(hoyo_game("hk4e_cn", &dir).map(|g| g.0), Some("Genshin Impact (China)".into()));
        std::fs::write(dir.join("GenshinImpact.exe"), b"").unwrap();
        assert!(hoyo_game("hk4e_global", &dir).unwrap().1.ends_with("GenshinImpact.exe"));
        assert!(hoyo_game("unknown_global", &dir).is_none());
        let _ = std::fs::remove_dir_all(&dir);
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
