//! Empty Folder Nuker core: scanning, deleting, shell integration, CLI parsing.
//! No UI or Tauri code lives here so it can be tested anywhere.

pub mod cli;
pub mod delete;
pub mod layout;
pub mod protect;
pub mod scan;
pub mod shell;

pub use delete::{delete_folders, DeleteMode, DeleteOutcome, DeletePolicy, DeleteResult};
pub use scan::{scan, EmptyFolder, ScanOptions, ScanReport};

#[cfg(test)]
mod tests;
