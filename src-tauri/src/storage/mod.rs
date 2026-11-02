//! Local SQLite storage: connection handling and schema migrations.

mod db;
mod migrations;
mod repair;

pub use db::Database;
