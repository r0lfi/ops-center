//! opstui library: the binary in main.rs is a thin terminal wrapper, so the
//! state machine, API client and renderer can be tested without a terminal.

pub mod api;
pub mod app;
pub mod claude;
pub mod config;
pub mod figure;
pub mod floor;
pub mod mask;
pub mod model;
pub mod sync;
pub mod ui;
