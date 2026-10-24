//! Windows titlebar overlay with real DWM caption buttons. Keep WS_CAPTION,
//! system menus, Snap Layouts and native close events; never draw web buttons.
use std::sync::atomic::{AtomicBool, AtomicIsize, AtomicU32, Ordering};
use tauri::WebviewWindow;
use windows::Win32::{
    Foundation::{COLORREF, HINSTANCE, HWND, LPARAM, LRESULT, POINT, RECT, WPARAM},
    Graphics::{
        Dwm::{
            DwmDefWindowProc, DwmExtendFrameIntoClientArea, DwmSetWindowAttribute,
            DWMNCRP_DISABLED, DWMWA_CAPTION_COLOR, DWMWA_NCRENDERING_POLICY, DWMWA_TEXT_COLOR,
            DWMWA_USE_IMMERSIVE_DARK_MODE,
        },
        Gdi::{
            CombineRgn, CreatePen, CreateRectRgn, CreateSolidBrush, DeleteObject, FillRect, LineTo,
            MoveToEx, ScreenToClient, SelectObject, SetWindowRgn, HDC, PS_SOLID, RGN_DIFF,
        },
    },
    System::LibraryLoader::GetModuleHandleW,
    UI::{
        Controls::MARGINS,
        HiDpi::{GetDpiForWindow, GetSystemMetricsForDpi},
        Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass},
        WindowsAndMessaging::*,
    },
};

const FRAME_ID: usize = 0x4D415247;
const WEBVIEW_ID: usize = FRAME_ID + 1;
static BACKGROUND: AtomicU32 = AtomicU32::new(0x00F4F8FA);
static FOREGROUND: AtomicU32 = AtomicU32::new(0x0022262B);
static COMPAT_CAPTION: AtomicBool = AtomicBool::new(false);
static HOVER: AtomicU32 = AtomicU32::new(0);
static TASKBAR_ICON: AtomicIsize = AtomicIsize::new(0);
static CAPTION_WINDOW: AtomicIsize = AtomicIsize::new(0);

unsafe fn layout_caption(hwnd: HWND) {
    let caption = CAPTION_WINDOW.load(Ordering::Relaxed);
    if caption == 0 {
        return;
    }
    let mut rect = RECT::default();
    unsafe {
        let _ = GetClientRect(hwnd, &mut rect);
        let _ = SetWindowPos(
            HWND(caption as *mut _),
            Some(HWND_TOP),
            rect.right - px(hwnd, 138),
            0,
            px(hwnd, 138),
            px(hwnd, 48),
            SWP_NOACTIVATE | SWP_NOCOPYBITS,
        );
        let _ = windows::Win32::Graphics::Gdi::InvalidateRect(
            Some(HWND(caption as *mut _)),
            None,
            false,
        );
    }
}

unsafe extern "system" fn caption_proc(hwnd: HWND, msg: u32, w: WPARAM, l: LPARAM) -> LRESULT {
    if msg == WM_NCHITTEST {
        return LRESULT(HTTRANSPARENT as isize);
    }
    if msg == WM_PAINT {
        unsafe {
            let mut paint = windows::Win32::Graphics::Gdi::PAINTSTRUCT::default();
            let dc = windows::Win32::Graphics::Gdi::BeginPaint(hwnd, &mut paint);
            let mut rect = RECT::default();
            let _ = GetClientRect(hwnd, &mut rect);
            let brush = CreateSolidBrush(COLORREF(BACKGROUND.load(Ordering::Relaxed)));
            FillRect(dc, &rect, brush);
            let _ = DeleteObject(brush.into());
            if let Ok(parent) = GetParent(hwnd) {
                paint_compat_caption(parent, dc, rect);
            }
            let _ = windows::Win32::Graphics::Gdi::EndPaint(hwnd, &paint);
        }
        return LRESULT(0);
    }
    unsafe { DefWindowProcW(hwnd, msg, w, l) }
}

unsafe fn ensure_compat_caption(hwnd: HWND) {
    if CAPTION_WINDOW.load(Ordering::Relaxed) == 0 {
        // An opaque native child is necessary over WebView2's compositor on
        // Windows 10. It is paint-only; HTTRANSPARENT routes input to the real
        // system caption underneath, retaining its commands and accessibility.
        let module = unsafe { GetModuleHandleW(None) }.unwrap_or_default();
        let class = WNDCLASSW {
            style: CS_HREDRAW | CS_VREDRAW | CS_OWNDC,
            lpfnWndProc: Some(caption_proc),
            hInstance: HINSTANCE(module.0),
            lpszClassName: windows::core::w!("MarginCaptionSurface"),
            ..Default::default()
        };
        unsafe {
            RegisterClassW(&class);
        }
        if let Ok(caption) = unsafe {
            CreateWindowExW(
                WS_EX_NOACTIVATE,
                windows::core::w!("MarginCaptionSurface"),
                None,
                WS_CHILD | WS_VISIBLE | WS_CLIPSIBLINGS,
                0,
                0,
                0,
                0,
                Some(hwnd),
                None,
                Some(HINSTANCE(module.0)),
                None,
            )
        } {
            CAPTION_WINDOW.store(caption.0 as isize, Ordering::Relaxed);
        }
    }
    unsafe {
        layout_caption(hwnd);
    }
}

// Windows 10 does not implement DWMWA_CAPTION_COLOR. Paint its system caption
// glyphs in the Host (never in React) while retaining native hit tests/actions.
unsafe fn paint_compat_caption(hwnd: HWND, dc: HDC, rect: RECT) {
    let bg = BACKGROUND.load(Ordering::Relaxed);
    let fg = FOREGROUND.load(Ordering::Relaxed);
    let blend = |a: u32, b: u32| {
        (0..3).fold(0, |out, channel| {
            let shift = channel * 8;
            let value = (((a >> shift) & 255) * 9 + ((b >> shift) & 255)) / 10;
            out | (value << shift)
        })
    };
    let pen = unsafe { CreatePen(PS_SOLID, px(hwnd, 1).max(1), COLORREF(fg)) };
    let old = unsafe { SelectObject(dc, pen.into()) };
    for (index, hit) in [HTMINBUTTON, HTMAXBUTTON, HTCLOSE].into_iter().enumerate() {
        let left = rect.right - px(hwnd, 138 - index as i32 * 46);
        let bounds = RECT {
            left,
            top: 0,
            right: left + px(hwnd, 46),
            bottom: px(hwnd, 32),
        };
        if HOVER.load(Ordering::Relaxed) == hit {
            unsafe {
                let brush = CreateSolidBrush(COLORREF(blend(bg, fg)));
                FillRect(dc, &bounds, brush);
                let _ = DeleteObject(brush.into());
            }
        }
        let x = left + px(hwnd, 18);
        let y = px(hwnd, 11);
        let side = px(hwnd, 10);
        unsafe {
            match hit {
                HTMINBUTTON => {
                    let _ = MoveToEx(dc, x, y + side / 2, None);
                    let _ = LineTo(dc, x + side, y + side / 2);
                }
                HTMAXBUTTON => {
                    // A hollow native rectangle; don't fill over the header.
                    let _ = MoveToEx(dc, x, y, None);
                    let _ = LineTo(dc, x + side, y);
                    let _ = LineTo(dc, x + side, y + side);
                    let _ = LineTo(dc, x, y + side);
                    let _ = LineTo(dc, x, y);
                    if IsZoomed(hwnd).as_bool() {
                        let _ = MoveToEx(dc, x + px(hwnd, 2), y - px(hwnd, 2), None);
                        let _ = LineTo(dc, x + side + px(hwnd, 2), y - px(hwnd, 2));
                        let _ = LineTo(dc, x + side + px(hwnd, 2), y + side - px(hwnd, 2));
                    }
                }
                _ => {
                    let _ = MoveToEx(dc, x, y, None);
                    let _ = LineTo(dc, x + side, y + side);
                    let _ = MoveToEx(dc, x + side, y, None);
                    let _ = LineTo(dc, x, y + side);
                }
            }
        }
    }
    unsafe {
        SelectObject(dc, old);
        let _ = DeleteObject(pen.into());
    }
}

unsafe fn caption_hit(hwnd: HWND, l: LPARAM) -> Option<u32> {
    let mut point = POINT {
        x: (l.0 as u16 as i16) as i32,
        y: ((l.0 >> 16) as u16 as i16) as i32,
    };
    let mut rect = RECT::default();
    unsafe {
        let _ = ScreenToClient(hwnd, &mut point);
        let _ = GetClientRect(hwnd, &mut rect);
    }
    if point.y < 0 || point.y >= px(hwnd, 32) || point.x < rect.right - px(hwnd, 138) {
        return None;
    }
    Some(if point.x >= rect.right - px(hwnd, 46) {
        HTCLOSE
    } else if point.x >= rect.right - px(hwnd, 92) {
        HTMAXBUTTON
    } else {
        HTMINBUTTON
    })
}

fn px(hwnd: HWND, logical: i32) -> i32 {
    unsafe { (logical * GetDpiForWindow(hwnd) as i32 + 48) / 96 }
}

unsafe fn clip_webview(hwnd: HWND) {
    let mut rect = RECT::default();
    if unsafe { GetClientRect(hwnd, &mut rect) }.is_err() {
        return;
    }
    // Leave the native caption controls exposed above the WebView. Windows
    // owns this area, including hover, accessibility and maximize Snap Layouts.
    let all = unsafe { CreateRectRgn(0, 0, rect.right, rect.bottom) };
    let cut = unsafe {
        CreateRectRgn(
            (rect.right - px(hwnd, 138)).max(0),
            0,
            rect.right,
            px(hwnd, 48),
        )
    };
    unsafe {
        CombineRgn(Some(all), Some(all), Some(cut), RGN_DIFF);
        let _ = DeleteObject(cut.into());
        if SetWindowRgn(hwnd, Some(all), true) == 0 {
            let _ = DeleteObject(all.into());
        }
    }
}

unsafe extern "system" fn webview_proc(
    hwnd: HWND,
    msg: u32,
    w: WPARAM,
    l: LPARAM,
    _id: usize,
    _data: usize,
) -> LRESULT {
    if msg == WM_NCDESTROY {
        unsafe {
            let _ = RemoveWindowSubclass(hwnd, Some(webview_proc), WEBVIEW_ID);
        }
    }
    let result = unsafe { DefSubclassProc(hwnd, msg, w, l) };
    if msg == WM_SIZE || msg == WM_DPICHANGED {
        unsafe {
            clip_webview(hwnd);
        }
    }
    result
}

unsafe extern "system" fn find_webview(hwnd: HWND, _data: LPARAM) -> windows::core::BOOL {
    let mut class = [0u16; 64];
    let len = unsafe { GetClassNameW(hwnd, &mut class) } as usize;
    if String::from_utf16_lossy(&class[..len]) == "WRY_WEBVIEW" {
        unsafe {
            let _ = SetWindowSubclass(hwnd, Some(webview_proc), WEBVIEW_ID, 0);
            clip_webview(hwnd);
        }
        return false.into();
    }
    true.into()
}

unsafe extern "system" fn frame_proc(
    hwnd: HWND,
    msg: u32,
    w: WPARAM,
    l: LPARAM,
    _id: usize,
    _data: usize,
) -> LRESULT {
    if msg == WM_NCCALCSIZE && w.0 != 0 {
        let params = l.0 as *mut NCCALCSIZE_PARAMS;
        let top = unsafe { (*params).rgrc[0].top };
        let _ = unsafe { DefSubclassProc(hwnd, msg, w, l) };
        let inset = if unsafe { IsZoomed(hwnd) }.as_bool() {
            unsafe {
                GetSystemMetricsForDpi(SM_CYFRAME, GetDpiForWindow(hwnd))
                    + GetSystemMetricsForDpi(SM_CXPADDEDBORDER, GetDpiForWindow(hwnd))
            }
        } else {
            0
        };
        unsafe {
            (*params).rgrc[0].top = top + inset;
        }
        return LRESULT(0);
    }
    if msg == WM_NCDESTROY {
        unsafe {
            let _ = RemoveWindowSubclass(hwnd, Some(frame_proc), FRAME_ID);
        }
        let result = unsafe { DefSubclassProc(hwnd, msg, w, l) };
        let icon = TASKBAR_ICON.swap(0, Ordering::Relaxed);
        CAPTION_WINDOW.store(0, Ordering::Relaxed);
        if icon != 0 {
            unsafe {
                let _ = DestroyIcon(HICON(icon as *mut _));
            }
        }
        return result;
    }
    if COMPAT_CAPTION.load(Ordering::Relaxed) {
        if msg == WM_NCHITTEST {
            if let Some(hit) = unsafe { caption_hit(hwnd, l) } {
                return LRESULT(hit as isize);
            }
        }
        if msg == WM_NCMOUSEMOVE || msg == WM_NCMOUSELEAVE {
            HOVER.store(
                if msg == WM_NCMOUSELEAVE {
                    0
                } else {
                    w.0 as u32
                },
                Ordering::Relaxed,
            );
            unsafe {
                let _ = windows::Win32::Graphics::Gdi::InvalidateRect(Some(hwnd), None, false);
                let caption = CAPTION_WINDOW.load(Ordering::Relaxed);
                if caption != 0 {
                    let _ = windows::Win32::Graphics::Gdi::InvalidateRect(
                        Some(HWND(caption as *mut _)),
                        None,
                        false,
                    );
                }
            }
        }
        if msg == WM_NCPAINT {
            return LRESULT(0);
        }
        if msg == WM_NCACTIVATE {
            return LRESULT(1);
        }
    }
    // DWM also needs activation/non-client painting messages, not only hit
    // tests; otherwise an inactive window can retain unreadable caption glyphs.
    if !COMPAT_CAPTION.load(Ordering::Relaxed) {
        let mut result = LRESULT(0);
        if unsafe { DwmDefWindowProc(hwnd, msg, w, l, &mut result) }.as_bool() {
            return result;
        }
    }
    if msg == WM_PAINT {
        let mut paint = windows::Win32::Graphics::Gdi::PAINTSTRUCT::default();
        unsafe {
            let dc = windows::Win32::Graphics::Gdi::BeginPaint(hwnd, &mut paint);
            let mut rect = RECT::default();
            let _ = GetClientRect(hwnd, &mut rect);
            let brush = CreateSolidBrush(COLORREF(BACKGROUND.load(Ordering::Relaxed)));
            FillRect(dc, &rect, brush);
            let _ = DeleteObject(brush.into());
            let _ = windows::Win32::Graphics::Gdi::EndPaint(hwnd, &paint);
        }
        return LRESULT(0);
    }
    let result = unsafe { DefSubclassProc(hwnd, msg, w, l) };
    if msg == WM_SIZE {
        unsafe {
            layout_caption(hwnd);
        }
    }
    if matches!(msg, WM_DPICHANGED | WM_DWMCOMPOSITIONCHANGED) {
        unsafe {
            let _ = DwmExtendFrameIntoClientArea(
                hwnd,
                &MARGINS {
                    cyTopHeight: if COMPAT_CAPTION.load(Ordering::Relaxed) {
                        0
                    } else {
                        px(hwnd, 48)
                    },
                    ..Default::default()
                },
            );
        }
    }
    result
}

pub fn install(window: &WebviewWindow) -> Result<(), Box<dyn std::error::Error>> {
    let hwnd = HWND(window.hwnd()?.0);
    unsafe {
        // Tauri's set_icon updates ICON_SMALL only. Set ICON_BIG as well so
        // the taskbar and Alt-Tab use the new artwork instead of a cached EXE.
        // Own a copy: a later small-icon replacement must not invalidate it.
        let icon = SendMessageW(hwnd, WM_GETICON, Some(WPARAM(ICON_SMALL as usize)), None);
        if icon.0 != 0 {
            let taskbar = CopyIcon(HICON(icon.0 as *mut _))?;
            TASKBAR_ICON.store(taskbar.0 as isize, Ordering::Relaxed);
            SendMessageW(
                hwnd,
                WM_SETICON,
                Some(WPARAM(ICON_BIG as usize)),
                Some(LPARAM(taskbar.0 as isize)),
            );
        }
        SetWindowSubclass(hwnd, Some(frame_proc), FRAME_ID, 0).ok()?;
        DwmExtendFrameIntoClientArea(
            hwnd,
            &MARGINS {
                cyTopHeight: px(hwnd, 48),
                ..Default::default()
            },
        )?;
        let _ = EnumChildWindows(Some(hwnd), Some(find_webview), LPARAM(0));
        SetWindowPos(
            hwnd,
            None,
            0,
            0,
            0,
            0,
            SWP_FRAMECHANGED | SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE,
        )?;
        // Detect the Windows 10 path before the first web frame is painted.
        let unpack = |c: u32| [c as u8, (c >> 8) as u8, (c >> 16) as u8];
        theme(
            hwnd,
            unpack(BACKGROUND.load(Ordering::Relaxed)),
            unpack(FOREGROUND.load(Ordering::Relaxed)),
            false,
        );
    }
    Ok(())
}

pub fn theme(hwnd: HWND, background: [u8; 3], foreground: [u8; 3], dark: bool) {
    let rgb = |c: [u8; 3]| u32::from(c[0]) | (u32::from(c[1]) << 8) | (u32::from(c[2]) << 16);
    let bg = rgb(background);
    let fg = rgb(foreground);
    let dark = i32::from(dark);
    BACKGROUND.store(bg, Ordering::Relaxed);
    FOREGROUND.store(fg, Ordering::Relaxed);
    unsafe {
        if DwmSetWindowAttribute(hwnd, DWMWA_CAPTION_COLOR, (&bg as *const u32).cast(), 4).is_err()
        {
            COMPAT_CAPTION.store(true, Ordering::Relaxed);
            let policy = DWMNCRP_DISABLED;
            let _ = DwmSetWindowAttribute(
                hwnd,
                DWMWA_NCRENDERING_POLICY,
                (&policy as *const _ as *const u32).cast(),
                4,
            );
            // GDI captions must be opaque. Leaving the old glass extension
            // active zeroes the glyph alpha and produces white-on-white icons.
            let _ = DwmExtendFrameIntoClientArea(hwnd, &MARGINS::default());
            ensure_compat_caption(hwnd);
        }
        let _ = DwmSetWindowAttribute(hwnd, DWMWA_TEXT_COLOR, (&fg as *const u32).cast(), 4);
        let _ = DwmSetWindowAttribute(
            hwnd,
            DWMWA_USE_IMMERSIVE_DARK_MODE,
            (&dark as *const i32).cast(),
            4,
        );
        let _ = windows::Win32::Graphics::Gdi::InvalidateRect(Some(hwnd), None, true);
        let caption = CAPTION_WINDOW.load(Ordering::Relaxed);
        if caption != 0 {
            let _ = windows::Win32::Graphics::Gdi::InvalidateRect(
                Some(HWND(caption as *mut _)),
                None,
                true,
            );
        }
    }
}
