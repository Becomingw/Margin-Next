//! In-memory handoff frame for DOM overlays above native WebView2 content.
//! Never writes page pixels to disk or exports them through external MCP.

#[cfg(windows)]
pub async fn capture(view: &tauri::Webview) -> Result<String, String> {
    use std::sync::{Arc, Mutex};
    use webview2_com::{
        CapturePreviewCompletedHandler,
        Microsoft::Web::WebView2::Win32::COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG,
    };
    use windows::Win32::System::Com::StructuredStorage::CreateStreamOnHGlobal;

    let (sender, receiver) = tokio::sync::oneshot::channel();
    let sender = Arc::new(Mutex::new(Some(sender)));
    view.with_webview(move |native| {
        let callback_sender = Arc::clone(&sender);
        // COM objects stay on the webview's UI thread, including stream reads.
        let started = (|| -> Result<(), String> {
            let stream = unsafe { CreateStreamOnHGlobal(Default::default(), true) }
                .map_err(|e| e.to_string())?;
            let callback_stream = stream.clone();
            let callback = CapturePreviewCompletedHandler::create(Box::new(move |status| {
                let result = status
                    .map_err(|e| e.to_string())
                    .and_then(|_| read_png(&callback_stream));
                if let Some(sender) = callback_sender.lock().unwrap().take() {
                    let _ = sender.send(result);
                }
                Ok(())
            }));
            unsafe {
                native.controller().CoreWebView2().and_then(|view| {
                    view.CapturePreview(
                        COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG,
                        &stream,
                        &callback,
                    )
                })
            }
            .map_err(|e| e.to_string())
        })();
        if let Err(error) = started {
            if let Some(sender) = sender.lock().unwrap().take() {
                let _ = sender.send(Err(error));
            }
        }
    })
    .map_err(|e| e.to_string())?;
    tokio::time::timeout(std::time::Duration::from_secs(3), receiver)
        .await
        .map_err(|_| "browse snapshot timed out".to_string())?
        .map_err(|_| "browse snapshot cancelled".to_string())?
}

#[cfg(windows)]
fn read_png(stream: &windows::Win32::System::Com::IStream) -> Result<String, String> {
    use base64::Engine;
    use windows::Win32::System::Com::{STATFLAG_NONAME, STATSTG, STREAM_SEEK_SET};
    let mut stat = STATSTG::default();
    unsafe { stream.Stat(&mut stat, STATFLAG_NONAME) }.map_err(|e| e.to_string())?;
    if stat.cbSize == 0 || stat.cbSize > 16 * 1024 * 1024 {
        return Err("browse snapshot size out of bounds".into());
    }
    let mut bytes = vec![0u8; stat.cbSize as usize];
    let mut read = 0;
    unsafe {
        stream
            .Seek(0, STREAM_SEEK_SET, None)
            .map_err(|e| e.to_string())?;
        stream
            .Read(
                bytes.as_mut_ptr().cast(),
                bytes.len() as u32,
                Some(&mut read),
            )
            .ok()
            .map_err(|e| e.to_string())?;
    }
    if read as usize != bytes.len() || !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Err("invalid browse snapshot".into());
    }
    Ok(format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    ))
}

#[cfg(not(windows))]
pub async fn capture(_view: &tauri::Webview) -> Result<String, String> {
    Err("native browse snapshots are not supported on this platform".into())
}
