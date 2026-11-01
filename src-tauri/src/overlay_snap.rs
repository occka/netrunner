//! Snapping of overlay windows to the screen's work area and to each other.
//!
//! The overlay window is subclassed so the rectangle is adjusted inside
//! Windows' own move/size loop (`WM_MOVING` / `WM_SIZING`): the window sticks
//! while it is dragged instead of jumping after the mouse is released.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

/// `overlay.snap` setting; read by the window procedure on every move.
static ENABLED: AtomicBool = AtomicBool::new(true);
/// Raw handles of subclassed overlay windows, so overlays can snap to each other.
static WINDOWS: Mutex<Vec<isize>> = Mutex::new(Vec::new());

pub const SETTING_KEY: &str = "overlay.snap";
/// Snap distance in physical pixels.
const DISTANCE: i32 = 16;

pub fn set_enabled(on: bool) {
    ENABLED.store(on, Ordering::Relaxed);
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rect {
    pub l: i32,
    pub t: i32,
    pub r: i32,
    pub b: i32,
}

/// The target line nearest to `value` within `DISTANCE`.
fn nearest(value: i32, targets: impl IntoIterator<Item = i32>) -> Option<i32> {
    targets
        .into_iter()
        .filter(|t| (t - value).abs() <= DISTANCE)
        .min_by_key(|t| (t - value).abs())
}

/// Lines an edge may snap to: the work-area edge, and for every overlay that
/// is level with this one (overlaps on the other axis) both of its edges, so
/// windows can sit side by side or line up.
fn x_targets(r: Rect, work: Rect, others: &[Rect], left: bool) -> Vec<i32> {
    let mut out = vec![if left { work.l } else { work.r }];
    for o in others.iter().filter(|o| r.t < o.b + DISTANCE && r.b > o.t - DISTANCE) {
        out.extend([o.l, o.r]);
    }
    out
}

fn y_targets(r: Rect, work: Rect, others: &[Rect], top: bool) -> Vec<i32> {
    let mut out = vec![if top { work.t } else { work.b }];
    for o in others.iter().filter(|o| r.l < o.r + DISTANCE && r.r > o.l - DISTANCE) {
        out.extend([o.t, o.b]);
    }
    out
}

/// Moves `r` (keeping its size) so its closest edge on each axis meets a target.
pub fn snap_move(r: Rect, work: Rect, others: &[Rect]) -> Rect {
    let dx = [
        nearest(r.l, x_targets(r, work, others, true)).map(|t| t - r.l),
        nearest(r.r, x_targets(r, work, others, false)).map(|t| t - r.r),
    ]
    .into_iter()
    .flatten()
    .min_by_key(|d| d.abs())
    .unwrap_or(0);
    let dy = [
        nearest(r.t, y_targets(r, work, others, true)).map(|t| t - r.t),
        nearest(r.b, y_targets(r, work, others, false)).map(|t| t - r.b),
    ]
    .into_iter()
    .flatten()
    .min_by_key(|d| d.abs())
    .unwrap_or(0);
    Rect { l: r.l + dx, t: r.t + dy, r: r.r + dx, b: r.b + dy }
}

/// Snaps only the edges being dragged while resizing.
pub fn snap_size(mut r: Rect, work: Rect, others: &[Rect], edges: Edges) -> Rect {
    if edges.left {
        r.l = nearest(r.l, x_targets(r, work, others, true)).unwrap_or(r.l);
    }
    if edges.right {
        r.r = nearest(r.r, x_targets(r, work, others, false)).unwrap_or(r.r);
    }
    if edges.top {
        r.t = nearest(r.t, y_targets(r, work, others, true)).unwrap_or(r.t);
    }
    if edges.bottom {
        r.b = nearest(r.b, y_targets(r, work, others, false)).unwrap_or(r.b);
    }
    r
}

#[derive(Debug, Clone, Copy, Default)]
pub struct Edges {
    pub left: bool,
    pub right: bool,
    pub top: bool,
    pub bottom: bool,
}

#[cfg(windows)]
mod native {
    use super::*;
    use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, RECT, WPARAM};
    use windows_sys::Win32::Graphics::Gdi::{GetMonitorInfoW, MonitorFromRect, MONITORINFO, MONITOR_DEFAULTTONEAREST};
    use windows_sys::Win32::UI::Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetWindowRect, IsWindowVisible, WM_MOVING, WM_NCDESTROY, WM_SIZING, WMSZ_BOTTOM, WMSZ_BOTTOMLEFT, WMSZ_BOTTOMRIGHT,
        WMSZ_LEFT, WMSZ_RIGHT, WMSZ_TOP, WMSZ_TOPLEFT, WMSZ_TOPRIGHT,
    };

    const SUBCLASS_ID: usize = 0x4e52_534e; // "NRSN"

    fn to_rect(r: &RECT) -> Rect {
        Rect { l: r.left, t: r.top, r: r.right, b: r.bottom }
    }

    fn work_area(r: &RECT) -> Option<Rect> {
        // SAFETY: plain Win32 queries with valid pointers to stack values.
        unsafe {
            let monitor = MonitorFromRect(r, MONITOR_DEFAULTTONEAREST);
            let mut info: MONITORINFO = std::mem::zeroed();
            info.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
            (GetMonitorInfoW(monitor, &mut info) != 0).then(|| to_rect(&info.rcWork))
        }
    }

    fn other_overlays(me: HWND) -> Vec<Rect> {
        let handles = WINDOWS.lock().map(|w| w.clone()).unwrap_or_default();
        handles
            .into_iter()
            .filter(|h| *h != me as isize)
            .filter_map(|h| {
                let hwnd = h as HWND;
                // SAFETY: a stale handle only makes these calls fail.
                unsafe {
                    let mut r: RECT = std::mem::zeroed();
                    (IsWindowVisible(hwnd) != 0 && GetWindowRect(hwnd, &mut r) != 0).then(|| to_rect(&r))
                }
            })
            .collect()
    }

    unsafe extern "system" fn proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM, _id: usize, _data: usize) -> LRESULT {
        match msg {
            WM_MOVING | WM_SIZING if ENABLED.load(Ordering::Relaxed) && lparam != 0 => {
                let rect = &mut *(lparam as *mut RECT);
                if let Some(work) = work_area(rect) {
                    let others = other_overlays(hwnd);
                    let snapped = if msg == WM_MOVING {
                        snap_move(to_rect(rect), work, &others)
                    } else {
                        let e = wparam as u32;
                        let edges = Edges {
                            left: matches!(e, WMSZ_LEFT | WMSZ_TOPLEFT | WMSZ_BOTTOMLEFT),
                            right: matches!(e, WMSZ_RIGHT | WMSZ_TOPRIGHT | WMSZ_BOTTOMRIGHT),
                            top: matches!(e, WMSZ_TOP | WMSZ_TOPLEFT | WMSZ_TOPRIGHT),
                            bottom: matches!(e, WMSZ_BOTTOM | WMSZ_BOTTOMLEFT | WMSZ_BOTTOMRIGHT),
                        };
                        snap_size(to_rect(rect), work, &others, edges)
                    };
                    *rect = RECT { left: snapped.l, top: snapped.t, right: snapped.r, bottom: snapped.b };
                }
                // The default handler would reset the adjusted rectangle.
                1
            }
            WM_NCDESTROY => {
                if let Ok(mut w) = WINDOWS.lock() {
                    w.retain(|h| *h != hwnd as isize);
                }
                RemoveWindowSubclass(hwnd, Some(proc), SUBCLASS_ID);
                DefSubclassProc(hwnd, msg, wparam, lparam)
            }
            _ => DefSubclassProc(hwnd, msg, wparam, lparam),
        }
    }

    /// Must run on the thread that owns the window (Tauri's main thread).
    pub fn attach(hwnd: isize) {
        // SAFETY: `hwnd` is a live top-level window created by this process on this thread.
        let ok = unsafe { SetWindowSubclass(hwnd as HWND, Some(proc), SUBCLASS_ID, 0) } != 0;
        if ok {
            if let Ok(mut w) = WINDOWS.lock() {
                if !w.contains(&hwnd) {
                    w.push(hwnd);
                }
            }
        } else {
            log::warn!("overlay snapping unavailable for this window");
        }
    }
}

/// Enables snapping for an overlay window.
pub fn attach(app: &tauri::AppHandle, win: &tauri::WebviewWindow) {
    #[cfg(windows)]
    if let Ok(hwnd) = win.hwnd() {
        let raw = hwnd.0 as isize;
        let _ = app.run_on_main_thread(move || native::attach(raw));
    }
    #[cfg(not(windows))]
    let _ = (app, win);
}

#[cfg(test)]
mod tests {
    use super::*;

    const WORK: Rect = Rect { l: 0, t: 0, r: 1920, b: 1040 };

    #[test]
    fn snaps_to_work_area_edges() {
        let r = Rect { l: 10, t: 500, r: 310, b: 700 };
        assert_eq!(snap_move(r, WORK, &[]), Rect { l: 0, t: 500, r: 300, b: 700 });
        let r = Rect { l: 1600, t: 830, r: 1910, b: 1032 };
        let s = snap_move(r, WORK, &[]);
        assert_eq!((s.r, s.b), (1920, 1040));
        // Far from every edge: unchanged.
        let r = Rect { l: 500, t: 500, r: 800, b: 700 };
        assert_eq!(snap_move(r, WORK, &[]), r);
    }

    #[test]
    fn snaps_beside_and_in_line_with_other_overlays() {
        let other = Rect { l: 400, t: 100, r: 700, b: 300 };
        // Just right of the other overlay, level with it: sits flush against it.
        let r = Rect { l: 710, t: 108, r: 900, b: 250 };
        let s = snap_move(r, WORK, &[other]);
        assert_eq!((s.l, s.t), (700, 100), "flush on x, tops aligned on y");
        // Far below the other overlay: x edges of it are not targets.
        let r = Rect { l: 710, t: 800, r: 900, b: 900 };
        assert_eq!(snap_move(r, WORK, &[other]).l, 710);
    }

    #[test]
    fn resizing_snaps_only_dragged_edges() {
        let r = Rect { l: 300, t: 300, r: 1910, b: 1035 };
        let s = snap_size(r, WORK, &[], Edges { right: true, bottom: true, ..Default::default() });
        assert_eq!(s, Rect { l: 300, t: 300, r: 1920, b: 1040 });
        let r = Rect { l: 8, t: 300, r: 600, b: 500 };
        let s = snap_size(r, WORK, &[], Edges { right: true, ..Default::default() });
        assert_eq!(s.l, 8, "left edge is not being dragged");
    }
}
