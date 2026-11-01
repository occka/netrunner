//! Domain services. Each service works on a borrowed SQLite connection (or
//! read-only OS data) and is independent of Tauri so it can be unit-tested.

pub mod activity;
pub mod alarms;
pub mod appearance;
pub mod automation;
pub mod games;
pub mod integrations;
pub mod launcher;
pub mod notes;
pub mod overlays;
pub mod profiles;
pub mod quick_access;
pub mod settings;
pub mod sounds;
pub mod studio;
