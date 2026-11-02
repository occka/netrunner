//! Language Server Protocol bridge: DEVELOPER's Monaco editor talks to the
//! user's installed language servers through these modules.

pub mod bridge;
pub mod jsonrpc;
pub mod process;
pub mod registry;

#[cfg(test)]
mod tests;
