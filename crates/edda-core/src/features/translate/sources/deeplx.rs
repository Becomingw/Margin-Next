use crate::error::AppError;
use crate::http;
use serde_json::Value;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub async fn translate_deeplx(
    text: &str,
    source: &str,
    target: &str,
    timeout: Duration,
) -> Result<String, AppError> {
    let client = http::client(timeout)?;
    let id = deeplx_request_id();
    let i_count = text.matches('i').count() as u128 + text.matches('I').count() as u128 + 1;
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let timestamp = now_ms - (now_ms % i_count) + i_count;
    let mut body = serde_json::json!({
        "jsonrpc": "2.0",
        "method": "LMT_handle_texts",
        "id": id,
        "params": {
            "texts": [
                {
                    "text": text,
                    "requestAlternatives": 3,
                }
            ],
            "splitting": "newlines",
            "lang": {
                "source_lang_user_selected": deeplx_lang(source, true),
                "target_lang": deeplx_lang(target, false),
            },
            "timestamp": timestamp,
            "commonJobParams": {
                "wasSpoken": false,
                "transcribe_as": "",
            },
        },
    })
    .to_string();
    if (id + 5).is_multiple_of(29) || (id + 3).is_multiple_of(13) {
        body = body.replace("\"method\":\"", "\"method\" : \"");
    } else {
        body = body.replace("\"method\":\"", "\"method\": \"");
    }

    let resp = client
        .post("https://www2.deepl.com/jsonrpc?client=chrome-extension,1.28.0&method=LMT_handle_jobs")
        .header("Accept", "*/*")
        .header("Authorization", "None")
        .header("Cache-Control", "no-cache")
        .header("Content-Type", "application/json")
        .header("DNT", "1")
        .header("Origin", "chrome-extension://cofdbpoegempjloogbagkncekinflcnj")
        .header("Pragma", "no-cache")
        .header("Referer", "https://www.deepl.com/")
        .header("Sec-Fetch-Dest", "empty")
        .header("Sec-Fetch-Mode", "cors")
        .header("Sec-Fetch-Site", "none")
        .header("Sec-GPC", "1")
        .header("User-Agent", "DeepLBrowserExtension/1.28.0 Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36")
        .body(body)
        .send()
        .await
        .map_err(|e| AppError::message(format!("DeepLX request failed: {e}")))?;
    let (status, body) = super::read_body(resp).await?;
    if !status.is_success() {
        return Err(super::http_err(status, &body, "DeepLX"));
    }
    let v: Value =
        serde_json::from_str(&body).map_err(|e| AppError::message(format!("DeepLX parse: {e}")))?;
    if let Some(error) = v.get("error") {
        return Err(AppError::message(format!("DeepLX service error: {error}")));
    }
    v.get("result")
        .and_then(|x| x.get("texts"))
        .and_then(|x| x.get(0))
        .and_then(|x| x.get("text"))
        .and_then(|x| x.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| AppError::message("Unexpected DeepLX translation response"))
}

fn deeplx_request_id() -> u64 {
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    8_300_000_001 + (now_ms % 99_999) * 1_000
}

fn deeplx_lang(code: &str, allow_auto: bool) -> String {
    if allow_auto && code == "auto" {
        return "AUTO".to_string();
    }
    let lower = code.to_ascii_lowercase();
    match lower.as_str() {
        "zh" | "zh-cn" | "zh-hans" | "zh-hk" | "zh-mo" | "zh-sg" | "zh-tw" => "ZH".to_string(),
        "pt-br" => "PT-BR".to_string(),
        "pt-pt" => "PT-PT".to_string(),
        _ => super::lang_base(code).to_ascii_uppercase(),
    }
}
