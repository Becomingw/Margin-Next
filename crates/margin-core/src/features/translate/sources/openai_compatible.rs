use crate::error::AppError;
use crate::http;
use serde::Serialize;
use serde_json::Value;
use std::time::Duration;

#[derive(Serialize)]
struct OpenAiMessage<'a> {
    role: &'a str,
    content: &'a str,
}

#[derive(Serialize)]
struct OpenAiRequest<'a> {
    model: &'a str,
    messages: [OpenAiMessage<'a>; 2],
    temperature: f32,
}

/// Instruction block for the OpenAI-compatible path. Mirrors the Agent prompt in
/// `src/lib/translate/prompt.ts`; keep both in sync.
const OPENAI_TRANSLATE_SYSTEM: &str = "You are a professional academic translator. You render research-paper prose into fluent, idiomatic target-language text and output only the translation.";

/// Literal word-for-word output at 0.0 reads badly for paper prose; a small
/// amount of sampling lets the model restructure sentences.
const OPENAI_TRANSLATE_TEMPERATURE: f32 = 0.2;

fn openai_translate_prompt(text: &str, source: &str, target: &str) -> String {
    // Numbered batch payload ([[1]] …, [[2]] …): ask the model to keep the
    // markers and paragraph count so the caller can split the result back.
    let numbered_hint = if text.contains("[[1]]") {
        "\n- The text contains several paragraphs, each prefixed with a [[n]] marker. Translate every paragraph and keep the same [[n]] markers, in the same order, with the same number of paragraphs. Do not merge paragraphs."
    } else {
        ""
    };
    let from = if source == "auto" {
        "the source language"
    } else {
        source
    };
    format!(
        "Translate the text below from {from} to {target}.\n\nRules:\n\
         - The source is prose from a research paper, often extracted from a PDF text layer. Translate the meaning, not the word order: re-order clauses and split long sentences when that reads better.\n\
         - Keep mathematics, symbols, variable names, units, inline code, URLs, citation markers and figure/table/equation numbers exactly as they appear, including any ⟦n⟧ placeholders.\n\
         - Use the established target-language term for each concept and stay consistent.\n\
         - Do not add, drop, summarize or explain anything. No translator notes, no markdown fences.\n\
         - Output only the translation.{numbered_hint}\n\nText:\n{text}"
    )
}

pub async fn translate_openai_compatible(
    text: &str,
    source: &str,
    target: &str,
    timeout: Duration,
    api_key: Option<&str>,
    base_url: Option<&str>,
    model: Option<&str>,
) -> Result<String, AppError> {
    let key = super::required_api_key("OpenAI-compatible", api_key)?;
    let model = model
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            AppError::message("OpenAI-compatible requires model (Settings → Translate)")
        })?;
    let url = super::optional_endpoint(base_url, "https://api.openai.com/v1", "/chat/completions");
    let prompt = openai_translate_prompt(text, source, target);
    let client = http::client(timeout)?;
    let resp = client
        .post(&url)
        .header("Authorization", format!("Bearer {key}"))
        .header("Content-Type", "application/json")
        .json(&OpenAiRequest {
            model,
            messages: [
                OpenAiMessage {
                    role: "system",
                    content: OPENAI_TRANSLATE_SYSTEM,
                },
                OpenAiMessage {
                    role: "user",
                    content: &prompt,
                },
            ],
            temperature: OPENAI_TRANSLATE_TEMPERATURE,
        })
        .send()
        .await
        .map_err(|e| AppError::message(format!("OpenAI-compatible request failed: {e}")))?;
    let (status, body) = super::read_body(resp).await?;
    if !status.is_success() {
        return Err(super::http_err(status, &body, "OpenAI-compatible"));
    }
    let v: Value = serde_json::from_str(&body)
        .map_err(|e| AppError::message(format!("OpenAI-compatible parse: {e}")))?;
    let choice = v
        .get("choices")
        .and_then(|x| x.get(0))
        .ok_or_else(|| AppError::message("Unexpected OpenAI-compatible response"))?;
    if let Some(reason) = choice.get("finish_reason").and_then(|x| x.as_str()) {
        if matches!(reason, "length" | "max_tokens" | "content_filter") {
            return Err(AppError::message(format!(
                "OpenAI-compatible translation incomplete (finish_reason={reason}); retry with a smaller chunk"
            )));
        }
    }
    choice
        .get("message")
        .and_then(|x| x.get("content"))
        .and_then(|x| x.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| AppError::message("Unexpected OpenAI-compatible response"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn openai_prompt_carries_academic_rules_and_marker_hint() {
        let single = openai_translate_prompt("Hello world", "auto", "zh-CN");
        assert!(single.contains("the source language"));
        assert!(single.contains("zh-CN"));
        assert!(single.contains("Translate the meaning, not the word order"));
        assert!(single.contains("Output only the translation."));
        assert!(!single.contains("[[n]] marker"));

        let batch = openai_translate_prompt("[[1]] a\n\n[[2]] b", "en", "zh-CN");
        assert!(batch.contains("from en to zh-CN"));
        assert!(batch.contains("[[n]] marker"));
    }
}
