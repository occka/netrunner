//! Playtime tracker: a background thread that notices running library games
//! every 15 seconds and records play sessions. Reads process paths only.

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};
use tauri::{AppHandle, Emitter, Manager};

use crate::services::playtime::{self, Proc, Watched};
use crate::services::{alarms::now_ms, games, quick_access};
use crate::state::AppState;

const TICK: Duration = Duration::from_secs(15);
/// The library is rescanned this often (installs and uninstalls).
const RESCAN: Duration = Duration::from_secs(600);

static RUNNING: Mutex<Vec<String>> = Mutex::new(Vec::new());

/// Ids of library games running right now.
pub fn running() -> Vec<String> {
    RUNNING.lock().map(|r| r.clone()).unwrap_or_default()
}

fn watched(app: &AppHandle) -> Vec<Watched> {
    let mut list: Vec<Watched> = games::scan()
        .games
        .iter()
        .filter_map(|g| playtime::watched(&g.id, &g.name, g.source, g.install_dir.as_deref()))
        .collect();
    if let Some(state) = app.try_state::<AppState>() {
        if let Ok(entries) = state.db.conn().and_then(|c| quick_access::list(&c)) {
            list.extend(
                entries
                    .iter()
                    .filter(|e| e.kind == "game")
                    .filter_map(|e| playtime::watched_exe(&format!("qa:{}", e.id), &e.name, &e.target)),
            );
        }
    }
    list
}

pub fn start(app: &AppHandle) {
    let app = app.clone();
    std::thread::Builder::new()
        .name("nr-playtime".into())
        .spawn(move || {
            let mut sys = System::new();
            let mut games: Vec<Watched> = Vec::new();
            let mut scanned: Option<Instant> = None;
            // game id → session row being extended.
            let mut sessions: HashMap<String, i64> = HashMap::new();
            loop {
                if scanned.is_none_or(|t| t.elapsed() > RESCAN) {
                    games = watched(&app);
                    scanned = Some(Instant::now());
                }
                sys.refresh_processes_specifics(
                    ProcessesToUpdate::All,
                    true,
                    ProcessRefreshKind::nothing().with_exe(UpdateKind::OnlyIfNotSet).with_cmd(UpdateKind::OnlyIfNotSet),
                );
                let procs: Vec<Proc> = sys
                    .processes()
                    .values()
                    .map(|p| Proc {
                        exe: p.exe().map(|e| e.to_string_lossy().to_lowercase()),
                        cmd: p.cmd().iter().map(|a| a.to_string_lossy().to_lowercase()).collect::<Vec<_>>().join(" "),
                    })
                    .collect();
                let now_running = playtime::running(&games, &procs);
                let started: Vec<String> = now_running.iter().filter(|id| !sessions.contains_key(*id)).cloned().collect();
                sessions.retain(|id, _| now_running.contains(id));
                if let Some(state) = app.try_state::<AppState>() {
                    if let Ok(conn) = state.db.conn() {
                        let now = now_ms();
                        for row in sessions.values() {
                            let _ = playtime::touch_session(&conn, *row, now);
                        }
                        for id in &started {
                            let name = games.iter().find(|g| &g.id == id).map(|g| g.name.clone()).unwrap_or_default();
                            match playtime::start_session(&conn, id, &name, now) {
                                Ok(row) => {
                                    sessions.insert(id.clone(), row);
                                }
                                Err(err) => log::error!("playtime: {err}"),
                            }
                        }
                    }
                }
                let mut ids: Vec<String> = now_running.into_iter().collect::<HashSet<_>>().into_iter().collect();
                ids.sort();
                let changed = RUNNING.lock().map(|mut r| {
                    let changed = *r != ids;
                    *r = ids.clone();
                    changed
                });
                if changed.unwrap_or(false) {
                    let _ = app.emit("games://running", &ids);
                }
                std::thread::sleep(TICK);
            }
        })
        .expect("spawn playtime tracker");
}
