//! Tauri command handlers. These are thin adapters: they lock the database,
//! call a service and record activity. Business rules live in `services`.
//!
//! All handlers are `async` so Tauri runs them off the main (UI) thread.

pub mod activity;
pub mod app;
pub mod browser;
pub mod dev;
pub mod files;
pub mod library;
pub mod neural;
pub mod overlay;
pub mod profiles;
pub mod quick_access;
pub mod settings;
pub mod system;
