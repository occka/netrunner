use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard};

use crate::error::{AppError, AppResult};
use crate::storage::Database;
use crate::system::monitor::SystemMonitor;

/// Shared state managed by Tauri.
pub struct AppState {
    pub db: Database,
    pub data_dir: PathBuf,
    /// Created on first use so startup does not pay for hardware enumeration.
    monitor: Mutex<Option<SystemMonitor>>,
}

impl AppState {
    pub fn new(db: Database, data_dir: PathBuf) -> Self {
        Self { db, data_dir, monitor: Mutex::new(None) }
    }

    pub fn with_monitor<T>(&self, f: impl FnOnce(&mut SystemMonitor) -> T) -> AppResult<T> {
        let mut guard: MutexGuard<'_, Option<SystemMonitor>> =
            self.monitor.lock().map_err(|_| AppError::Internal("monitor lock poisoned".into()))?;
        let monitor = guard.get_or_insert_with(SystemMonitor::new);
        Ok(f(monitor))
    }
}
