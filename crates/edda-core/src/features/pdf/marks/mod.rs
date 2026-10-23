//! PDF mark storage helpers.

pub mod activity;
pub mod doctor;
#[cfg(not(any(target_os = "ios", target_os = "android")))]
pub mod service;
