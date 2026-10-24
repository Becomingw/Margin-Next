//! Specta-only shape for runtime-shaped JSON (`serde_json::Value`).
//!
//! specta's built-in `serde_json::Value` definition is an inline recursive
//! enum which the TypeScript exporter cannot expand (stack overflow), so the
//! IPC contract represents raw JSON with the named recursive [`Json`] union:
//!
//! - contract fields keep `serde_json::Value` and override only their specta
//!   representation via `#[specta(type = Option<crate::json::Json>)]`;
//! - commands returning provider pass-through JSON return [`JsonValue`], a
//!   serde-transparent wrapper (byte-identical wire format to
//!   `serde_json::Value`) exported to TypeScript as [`Json`].
//!
//! Serde shapes never change: both mechanisms are specta-side only.

use serde::{Deserialize, Serialize};
use specta::{datatype::DataType, Type, Types};
use std::collections::HashMap;

/// TypeScript-side representation of arbitrary JSON values.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(untagged)]
pub enum Json {
    /// JSON `null`.
    Null,
    /// JSON boolean.
    Bool(bool),
    /// JSON number.
    Number(f64),
    /// JSON string.
    String(String),
    /// JSON array.
    Array(Vec<Json>),
    /// JSON object.
    Object(HashMap<String, Json>),
}

/// Runtime-shaped JSON payload crossing the IPC contract (provider
/// pass-through, `null` acks, ...). Serializes exactly like the inner
/// `serde_json::Value`; exported to TypeScript as [`Json`].
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(transparent)]
pub struct JsonValue(pub serde_json::Value);

impl JsonValue {
    /// The `null` payload (used by ack-style commands).
    pub fn null() -> Self {
        Self(serde_json::Value::Null)
    }
}

impl Type for JsonValue {
    fn definition(types: &mut Types) -> DataType {
        <Json as Type>::definition(types)
    }
}
