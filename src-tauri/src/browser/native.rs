//! WebView2-specific hardening and events that Tauri does not expose.
//! Everything here runs on the UI thread through `Webview::with_webview`.

use base64::Engine as _;
use tauri::{AppHandle, Emitter, Manager};
use webview2_com::Microsoft::Web::WebView2::Win32::*;
use webview2_com::{
    take_pwstr, AcceleratorKeyPressedEventHandler, ClearBrowsingDataCompletedHandler, ContainsFullScreenElementChangedEventHandler, FaviconChangedEventHandler,
    GetFaviconCompletedHandler, HistoryChangedEventHandler, IsDocumentPlayingAudioChangedEventHandler, IsMutedChangedEventHandler,
    LaunchingExternalUriSchemeEventHandler, WebResourceRequestedEventHandler,
};
use windows::core::{Interface, BOOL, HSTRING, PWSTR};
use windows::Win32::System::Com::IStream;
use windows::Win32::UI::Input::KeyboardAndMouse::{GetKeyState, VK_CONTROL, VK_F5, VK_MENU, VK_SHIFT, VK_TAB};

use super::{emit_tab, notice, Browser};

/// adblock request type for a WebView2 resource context.
fn request_kind(ctx: COREWEBVIEW2_WEB_RESOURCE_CONTEXT, is_top_document: bool) -> &'static str {
    match ctx {
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_DOCUMENT if is_top_document => "document",
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_DOCUMENT => "sub_frame",
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_STYLESHEET => "stylesheet",
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_IMAGE => "image",
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_MEDIA => "media",
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_FONT => "font",
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_SCRIPT => "script",
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_XML_HTTP_REQUEST | COREWEBVIEW2_WEB_RESOURCE_CONTEXT_FETCH => "xmlhttprequest",
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_WEBSOCKET => "websocket",
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_PING => "ping",
        _ => "other",
    }
}

fn pwstr(f: impl FnOnce(*mut PWSTR) -> windows::core::Result<()>) -> String {
    let mut out = PWSTR::null();
    if f(&mut out).is_ok() {
        take_pwstr(out)
    } else {
        String::new()
    }
}

/// Hardens a freshly created browser webview and wires its events.
pub fn harden(webview: &tauri::Webview, app: AppHandle, label: String) {
    let _ = webview.with_webview(move |pw| unsafe {
        if let Err(err) = setup(&pw.controller(), &pw.environment(), &app, &label) {
            log::error!("browser hardening failed for {label}: {err}");
        }
    });
}

unsafe fn setup(
    controller: &ICoreWebView2Controller,
    env: &ICoreWebView2Environment,
    app: &AppHandle,
    label: &str,
) -> windows::core::Result<()> {
    let core = controller.CoreWebView2()?;
    let browser = app.state::<Browser>();

    // Keys pressed inside a page never reach NETRUNNER's UI; forward the
    // browser shortcuts (Ctrl+T/W/L/K/R/Tab, F5) so they work everywhere.
    {
        let (app, label) = (app.clone(), label.to_string());
        let mut token = 0i64;
        controller.add_AcceleratorKeyPressed(
            &AcceleratorKeyPressedEventHandler::create(Box::new(move |_, args| {
                let Some(args) = args else { return Ok(()) };
                let mut kind = COREWEBVIEW2_KEY_EVENT_KIND_KEY_UP;
                args.KeyEventKind(&mut kind)?;
                if kind != COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN {
                    return Ok(());
                }
                let mut vk = 0u32;
                args.VirtualKey(&mut vk)?;
                let down = |k: u16| GetKeyState(k as i32) < 0;
                let (ctrl, shift, alt) = (down(VK_CONTROL.0), down(VK_SHIFT.0), down(VK_MENU.0));
                if alt {
                    return Ok(());
                }
                let key = match (ctrl, vk) {
                    (true, v) if v == u32::from(b'T') => if shift { "new-private" } else { "new" },
                    (true, v) if v == u32::from(b'W') => "close",
                    (true, v) if v == u32::from(b'L') => "address",
                    (true, v) if v == u32::from(b'K') => "palette",
                    (true, v) if v == u32::from(VK_TAB.0) => if shift { "prev" } else { "next" },
                    (true, v) if v == u32::from(b'R') => "reload",
                    (false, v) if v == u32::from(VK_F5.0) => "reload",
                    _ => return Ok(()),
                };
                args.SetHandled(true)?;
                let _ = app.emit("browser://shortcut", (label.clone(), key));
                Ok(())
            })),
            &mut token,
        )?;
    }
    let prefs = browser.prefs();

    // Settings: no host objects or web messages (no bridge into NETRUNNER), no
    // saved passwords or form data unless the user opted in, SmartScreen on,
    // and the status bar so link targets are visible before clicking.
    let settings = core.Settings()?;
    settings.SetAreHostObjectsAllowed(false)?;
    settings.SetIsWebMessageEnabled(false)?;
    settings.SetIsStatusBarEnabled(true)?;
    if let Ok(s4) = settings.cast::<ICoreWebView2Settings4>() {
        s4.SetIsPasswordAutosaveEnabled(prefs.autofill)?;
        s4.SetIsGeneralAutofillEnabled(prefs.autofill)?;
    }
    if let Ok(s8) = settings.cast::<ICoreWebView2Settings8>() {
        s8.SetIsReputationCheckingRequired(true)?;
    }

    // Tracking prevention is a profile setting shared by all tabs.
    if let Ok(core13) = core.cast::<ICoreWebView2_13>() {
        if let Ok(profile) = core13.Profile().and_then(|p| p.cast::<ICoreWebView2Profile3>()) {
            let level = match prefs.tracking.as_str() {
                "basic" => COREWEBVIEW2_TRACKING_PREVENTION_LEVEL_BASIC,
                "balanced" => COREWEBVIEW2_TRACKING_PREVENTION_LEVEL_BALANCED,
                _ => COREWEBVIEW2_TRACKING_PREVENTION_LEVEL_STRICT,
            };
            profile.SetPreferredTrackingPreventionLevel(level)?;
        }
    }

    // Every request passes the content blocker. Workers and service workers
    // are included where the runtime supports it.
    let all = HSTRING::from("*");
    match core.cast::<ICoreWebView2_22>() {
        Ok(c22) => c22.AddWebResourceRequestedFilterWithRequestSourceKinds(
            &all,
            COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL,
            COREWEBVIEW2_WEB_RESOURCE_REQUEST_SOURCE_KINDS_ALL,
        )?,
        Err(_) => core.AddWebResourceRequestedFilter(&all, COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL)?,
    }
    let mut token = 0i64;
    {
        let (app, label, env) = (app.clone(), label.to_string(), env.clone());
        core.add_WebResourceRequested(
            &WebResourceRequestedEventHandler::create(Box::new(move |sender, args| {
                let (Some(sender), Some(args)) = (sender, args) else { return Ok(()) };
                let request = args.Request()?;
                let uri = pwstr(|p| request.Uri(p));
                if !(uri.starts_with("https://") || uri.starts_with("http://")) {
                    return Ok(());
                }
                let browser = app.state::<Browser>();
                let prefs = browser.prefs();
                let source = pwstr(|p| sender.Source(p));
                let mut ctx = COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL;
                args.ResourceContext(&mut ctx)?;
                let top = ctx == COREWEBVIEW2_WEB_RESOURCE_CONTEXT_DOCUMENT && (source.is_empty() || source == uri);
                // The page itself is never blocked: the user asked for it.
                if prefs.adblock && !top && !browser.is_exception(&source) {
                    if let Some(v) = browser.blocker.check(&uri, &source, request_kind(ctx, top)) {
                        if v.block {
                            let response = env.CreateWebResourceResponse(None, 403, &HSTRING::from("Blocked by NETRUNNER"), &HSTRING::new())?;
                            args.SetResponse(&response)?;
                            browser.count_blocked(&label);
                            return Ok(());
                        }
                    }
                }
                if prefs.gpc {
                    let headers = request.Headers()?;
                    let _ = headers.SetHeader(&HSTRING::from("Sec-GPC"), &HSTRING::from("1"));
                    let _ = headers.SetHeader(&HSTRING::from("DNT"), &HSTRING::from("1"));
                }
                Ok(())
            })),
            &mut token,
        )?;
    }

    {
        let (app, label) = (app.clone(), label.to_string());
        core.add_HistoryChanged(
            &HistoryChangedEventHandler::create(Box::new(move |sender, _| {
                let Some(sender) = sender else { return Ok(()) };
                let (mut back, mut forward) = (BOOL(0), BOOL(0));
                let _ = sender.CanGoBack(&mut back);
                let _ = sender.CanGoForward(&mut forward);
                let browser = app.state::<Browser>();
                emit_tab(&app, browser.update(&label, |t| {
                    t.can_back = back.as_bool();
                    t.can_forward = forward.as_bool();
                }));
                Ok(())
            })),
            &mut token,
        )?;
    }

    {
        let (app, label) = (app.clone(), label.to_string());
        core.add_ContainsFullScreenElementChanged(
            &ContainsFullScreenElementChangedEventHandler::create(Box::new(move |sender, _| {
                let Some(sender) = sender else { return Ok(()) };
                let mut full = BOOL(0);
                let _ = sender.ContainsFullScreenElement(&mut full);
                let browser = app.state::<Browser>();
                emit_tab(&app, browser.update(&label, |t| t.fullscreen = full.as_bool()));
                Ok(())
            })),
            &mut token,
        )?;
    }

    if let Ok(core8) = core.cast::<ICoreWebView2_8>() {
        let audio = {
            let (app, label) = (app.clone(), label.to_string());
            move |sender: Option<ICoreWebView2>, _| {
                let Some(c8) = sender.and_then(|s| s.cast::<ICoreWebView2_8>().ok()) else { return Ok(()) };
                let (mut playing, mut muted) = (BOOL(0), BOOL(0));
                let _ = c8.IsDocumentPlayingAudio(&mut playing);
                let _ = c8.IsMuted(&mut muted);
                let browser = app.state::<Browser>();
                emit_tab(&app, browser.update(&label, |t| {
                    t.audible = playing.as_bool();
                    t.muted = muted.as_bool();
                }));
                Ok(())
            }
        };
        core8.add_IsDocumentPlayingAudioChanged(&IsDocumentPlayingAudioChangedEventHandler::create(Box::new(audio.clone())), &mut token)?;
        core8.add_IsMutedChanged(&IsMutedChangedEventHandler::create(Box::new(audio)), &mut token)?;
    }

    if let Ok(core15) = core.cast::<ICoreWebView2_15>() {
        let (app, label) = (app.clone(), label.to_string());
        core15.add_FaviconChanged(
            &FaviconChangedEventHandler::create(Box::new(move |sender, _| {
                let Some(c15) = sender.and_then(|s| s.cast::<ICoreWebView2_15>().ok()) else { return Ok(()) };
                let (app, label) = (app.clone(), label.clone());
                c15.GetFavicon(
                    COREWEBVIEW2_FAVICON_IMAGE_FORMAT_PNG,
                    &GetFaviconCompletedHandler::create(Box::new(move |_, stream| {
                        // The UI's CSP only allows data: images, so the icon travels inline.
                        let icon = stream.and_then(|s| read_stream(&s, 64 * 1024)).filter(|b| !b.is_empty());
                        let url = icon.map(|b| format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(b)));
                        let browser = app.state::<Browser>();
                        emit_tab(&app, browser.update(&label, |t| t.favicon = url));
                        Ok(())
                    })),
                )
            })),
            &mut token,
        )?;
    }

    if let Ok(core18) = core.cast::<ICoreWebView2_18>() {
        let (app, label) = (app.clone(), label.to_string());
        core18.add_LaunchingExternalUriScheme(
            &LaunchingExternalUriSchemeEventHandler::create(Box::new(move |_, args| {
                let Some(args) = args else { return Ok(()) };
                // Pages cannot start other apps (steam:, ms-settings:, …) from here.
                args.SetCancel(true)?;
                let uri = pwstr(|p| args.Uri(p));
                let scheme = uri.split(':').next().unwrap_or("").to_string();
                notice(&app, &label, "external-app", &scheme, &uri);
                Ok(())
            })),
            &mut token,
        )?;
    }
    Ok(())
}

unsafe fn read_stream(stream: &IStream, limit: usize) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    let mut buf = [0u8; 8192];
    loop {
        let mut read = 0u32;
        let hr = stream.Read(buf.as_mut_ptr().cast(), buf.len() as u32, Some(&mut read));
        if hr.is_err() {
            return None;
        }
        if read == 0 {
            break;
        }
        out.extend_from_slice(&buf[..read as usize]);
        if out.len() > limit {
            return None;
        }
    }
    Some(out)
}

/// Puts the page above its host window's own webview. In transparent overlay
/// windows a new child webview can otherwise end up underneath it.
pub fn raise(webview: &tauri::Webview) {
    let _ = webview.with_webview(|pw| unsafe {
        use windows::Win32::UI::WindowsAndMessaging::{SetWindowPos, HWND_TOP, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE};
        let mut hwnd = windows::Win32::Foundation::HWND::default();
        if pw.controller().ParentWindow(&mut hwnd).is_ok() && !hwnd.is_invalid() {
            let _ = SetWindowPos(hwnd, Some(HWND_TOP), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
        }
    });
}

pub fn action(webview: &tauri::Webview, action: &str) {
    let action = action.to_string();
    let _ = webview.with_webview(move |pw| unsafe {
        let Ok(core) = pw.controller().CoreWebView2() else { return };
        let _ = match action.as_str() {
            "back" => core.GoBack(),
            "forward" => core.GoForward(),
            "stop" => core.Stop(),
            "mute" | "unmute" => core.cast::<ICoreWebView2_8>().and_then(|c| c.SetIsMuted(action == "mute")),
            _ => Ok(()),
        };
    });
}

/// Deletes cookies, cache, storage, history and downloads metadata of the
/// browser profile (NETRUNNER's own data is in a different profile).
pub fn clear_profile(webview: &tauri::Webview) {
    let app = webview.app_handle().clone();
    let _ = webview.with_webview(move |pw| unsafe {
        let profile = pw
            .controller()
            .CoreWebView2()
            .and_then(|c| c.cast::<ICoreWebView2_13>())
            .and_then(|c| c.Profile())
            .and_then(|p| p.cast::<ICoreWebView2Profile2>());
        match profile {
            Ok(p) => {
                let _ = p.ClearBrowsingDataAll(&ClearBrowsingDataCompletedHandler::create(Box::new(move |hr| {
                    let _ = app.emit("browser://cleared", hr.is_ok());
                    Ok(())
                })));
            }
            Err(err) => log::warn!("cannot clear browsing data: {err}"),
        }
    });
}
