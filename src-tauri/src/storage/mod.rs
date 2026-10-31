//! Local SQLite storage: connection handling and schema migrations.

mod db;
mod migrations;

pub use db::Database;
