use crate::error::AppError;
use crate::http;
use serde_json::Value;
use std::time::Duration;

pub async fn translate_huoshan_web(
    text: &str,
    source: &str,
    target: &str,
    timeout: Duration,
) -> Result<String, AppError> {
    let client = http::client(timeout)?;
    let from = if source == "auto" {
        "auto".to_string()
    } else {
        super::lang_base(source).to_string()
    };
    let to = super::lang_base(target).to_string();
    let body = serde_json::json!({
        "source_language": from,
        "target_language": to,
        "text": text,
    });
    let resp = client
        .post("https://translate.volcengine.com/crx/translate/v1")
        .header("Content-Type", "application/json")
        .header("User-Agent", http::BROWSER_USER_AGENT)
        .json(&body)
        .send()
        .await
        .map_err(|e| AppError::message(format!("Volcengine request failed: {e}")))?;
    let (status, body) = super::read_body(resp).await?;
    if !status.is_success() {
        return Err(super::http_err(status, &body, "Volcengine Web"));
    }
    let v: Value = serde_json::from_str(&body)
        .map_err(|e| AppError::message(format!("Volcengine parse: {e}")))?;
    v.get("translation")
        .and_then(|x| x.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| AppError::message("Unexpected Volcengine translation response"))
}
