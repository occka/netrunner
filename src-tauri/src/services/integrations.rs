//! Known external applications. Each integration reports four separate
//! capabilities so the UI never implies more control than exists:
//! launch · detect running · read status · control.

use std::collections::HashSet;
use std::path::PathBuf;

use serde::Serialize;

use super::launcher::expand_env;
use crate::system::network::Adapter;

struct Known {
    id: &'static str,
    name: &'static str,
    category: &'static str,
    /// Candidate executables (env vars expanded); first existing one wins.
    paths: &'static [&'static str],
    args: &'static str,
    processes: &'static [&'static str],
    /// For VPN clients: adapter description fragment that indicates a tunnel.
    vpn_adapter: Option<&'static str>,
}

const KNOWN: &[Known] = &[
    Known { id: "discord", name: "Discord", category: "Communication", paths: &[r"%LOCALAPPDATA%\Discord\Update.exe"], args: "--processStart Discord.exe", processes: &["discord.exe"], vpn_adapter: None },
    Known { id: "telegram", name: "Telegram", category: "Communication", paths: &[r"%APPDATA%\Telegram Desktop\Telegram.exe", r"%LOCALAPPDATA%\Programs\Telegram Desktop\Telegram.exe"], args: "", processes: &["telegram.exe"], vpn_adapter: None },
    Known { id: "steam", name: "Steam", category: "Games", paths: &[r"%ProgramFiles(x86)%\Steam\steam.exe", r"%ProgramFiles%\Steam\steam.exe"], args: "", processes: &["steam.exe"], vpn_adapter: None },
    Known { id: "epic", name: "Epic Games Launcher", category: "Games", paths: &[r"%ProgramFiles(x86)%\Epic Games\Launcher\Portal\Binaries\Win64\EpicGamesLauncher.exe", r"%ProgramFiles%\Epic Games\Launcher\Portal\Binaries\Win64\EpicGamesLauncher.exe"], args: "", processes: &["epicgameslauncher.exe"], vpn_adapter: None },
    Known { id: "gog", name: "GOG Galaxy", category: "Games", paths: &[r"%ProgramFiles(x86)%\GOG Galaxy\GalaxyClient.exe", r"%ProgramFiles%\GOG Galaxy\GalaxyClient.exe"], args: "", processes: &["galaxyclient.exe"], vpn_adapter: None },
    Known { id: "spotify", name: "Spotify", category: "Media", paths: &[r"%APPDATA%\Spotify\Spotify.exe"], args: "", processes: &["spotify.exe"], vpn_adapter: None },
    Known { id: "obs", name: "OBS Studio", category: "Media", paths: &[r"%ProgramFiles%\obs-studio\bin\64bit\obs64.exe"], args: "", processes: &["obs64.exe"], vpn_adapter: None },
    Known { id: "vscode", name: "Visual Studio Code", category: "Development", paths: &[r"%LOCALAPPDATA%\Programs\Microsoft VS Code\Code.exe", r"%ProgramFiles%\Microsoft VS Code\Code.exe"], args: "", processes: &["code.exe"], vpn_adapter: None },
    Known { id: "wireguard", name: "WireGuard", category: "VPN", paths: &[r"%ProgramFiles%\WireGuard\wireguard.exe"], args: "", processes: &["wireguard.exe"], vpn_adapter: Some("wireguard") },
    Known { id: "openvpn", name: "OpenVPN GUI", category: "VPN", paths: &[r"%ProgramFiles%\OpenVPN\bin\openvpn-gui.exe"], args: "", processes: &["openvpn-gui.exe", "openvpn.exe"], vpn_adapter: Some("openvpn") },
    Known { id: "nordvpn", name: "NordVPN", category: "VPN", paths: &[r"%ProgramFiles%\NordVPN\NordVPN.exe"], args: "", processes: &["nordvpn.exe"], vpn_adapter: Some("nordlynx") },
    Known { id: "protonvpn", name: "Proton VPN", category: "VPN", paths: &[r"%ProgramFiles%\Proton\VPN\ProtonVPN.Launcher.exe", r"%ProgramFiles%\Proton Technologies\ProtonVPN\ProtonVPN.exe"], args: "", processes: &["protonvpn.exe", "protonvpn.client.exe"], vpn_adapter: Some("proton") },
    Known { id: "hwinfo", name: "HWiNFO", category: "Hardware", paths: &[r"%ProgramFiles%\HWiNFO64\HWiNFO64.EXE"], args: "", processes: &["hwinfo64.exe"], vpn_adapter: None },
    Known { id: "afterburner", name: "MSI Afterburner", category: "Hardware", paths: &[r"%ProgramFiles(x86)%\MSI Afterburner\MSIAfterburner.exe"], args: "", processes: &["msiafterburner.exe"], vpn_adapter: None },
];

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Capability {
    pub available: bool,
    pub detail: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Integration {
    pub id: &'static str,
    pub name: &'static str,
    pub category: &'static str,
    pub installed: bool,
    pub path: Option<String>,
    pub args: &'static str,
    pub running: bool,
    pub launch: Capability,
    pub detect: Capability,
    pub status: Capability,
    pub control: Capability,
}

fn locate(k: &Known) -> Option<PathBuf> {
    k.paths.iter().map(|p| PathBuf::from(expand_env(p))).find(|p| p.is_file())
}

pub fn list(running: &HashSet<String>, adapters: &[Adapter]) -> Vec<Integration> {
    KNOWN
        .iter()
        .map(|k| {
            let path = locate(k);
            let is_running = k.processes.iter().any(|p| running.contains(*p));
            let status = match k.vpn_adapter {
                Some(hint) => {
                    let up = adapters.iter().any(|a| a.up && a.description.to_lowercase().contains(hint));
                    Capability {
                        available: true,
                        detail: if up {
                            format!("Tunnel adapter active ({hint})")
                        } else {
                            "No matching tunnel adapter is up".into()
                        },
                    }
                }
                None => Capability { available: false, detail: "No documented local status interface".into() },
            };
            Integration {
                id: k.id,
                name: k.name,
                category: k.category,
                installed: path.is_some(),
                launch: Capability {
                    available: path.is_some(),
                    detail: if path.is_some() { "Executable found".into() } else { "Not found in standard locations".into() },
                },
                detect: Capability { available: true, detail: format!("Process: {}", k.processes.join(", ")) },
                status,
                control: Capability { available: false, detail: "No supported control interface".into() },
                path: path.map(|p| p.display().to_string()),
                args: k.args,
                running: is_running,
            }
        })
        .collect()
}

/// Returns (exe, args) for launching a detected integration.
pub fn launch_target(id: &str) -> Option<(PathBuf, &'static str)> {
    let k = KNOWN.iter().find(|k| k.id == id)?;
    Some((locate(k)?, k.args))
}
