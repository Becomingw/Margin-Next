use crate::error::AppError;
use crate::http;
use serde_json::Value;
use std::time::Duration;

pub async fn translate_google(
    host: &str,
    text: &str,
    source: &str,
    target: &str,
    timeout: Duration,
) -> Result<String, AppError> {
    let client = http::client(timeout)?;
    let sl = if source == "auto" { "auto" } else { source };
    let tl = target;
    let url = format!("{}/translate_a/single", host.trim_end_matches('/'));
    let resp = client
        .get(&url)
        .query(&[
            ("client", "gtx"),
            ("sl", sl),
            ("tl", tl),
            ("dt", "t"),
            ("q", text),
        ])
        .header("User-Agent", http::BROWSER_USER_AGENT)
        .send()
        .await
        .map_err(|e| AppError::message(format!("Google translate request failed: {e}")))?;
    let (status, body) = super::read_body(resp).await?;
    if !status.is_success() {
        return Err(super::http_err(status, &body, "Google Translate"));
    }
    parse_google_gtx_body(&body)
}

fn parse_google_gtx_body(body: &str) -> Result<String, AppError> {
    let v: Value = serde_json::from_str(body)
        .map_err(|e| AppError::message(format!("Google translate parse: {e}")))?;
    let mut out = String::new();
    let Some(segments) = v.get(0).and_then(|x| x.as_array()) else {
        return Err(AppError::message("Unexpected Google translation response"));
    };
    for seg in segments {
        if let Some(piece) = seg.get(0).and_then(|x| x.as_str()) {
            out.push_str(piece);
        }
    }
    if out.is_empty() {
        return Err(AppError::message("Empty Google translation result"));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_google_segments() {
        let body = r#"[[["你好","Hello",null,null,10]],null,"en"]"#;
        let t = parse_google_gtx_body(body).unwrap();
        assert_eq!(t, "你好");
    }
}
