//! タイマー: when a timer, ポモドーロ or アラーム comes due, the person may be
//! drawing in another app (CSP) with Name Studio behind it or minimized. The
//! page rings and shows the notice; this says it outside the window too:
//! Windows' own notification, the taskbar button flashing until the window is
//! looked at, and (when asked) the window brought to the front.

use serde::Deserialize;
use tauri::{Manager, UserAttentionType, WebviewWindow};
use tauri_plugin_notification::NotificationExt;

/// What to say, and how (設定 › タイマー).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimerNotice {
    pub title: String,
    pub body: String,
    /// Windows' notification.
    pub toast: bool,
    /// The taskbar button flashes (only while the window is not the one in front).
    pub flash: bool,
    /// The window is shown, restored and brought to the front.
    pub front: bool,
}

/// Say that a timer came due outside the window. A part that fails (no
/// notifications on this computer) does not stop the others; the first
/// failure is given back to be logged.
#[tauri::command]
pub fn timer_notice(window: WebviewWindow, notice: TimerNotice) -> Result<(), String> {
    let mut failed: Option<String> = None;
    let mut fail = |what: &str, error: String| {
        failed.get_or_insert_with(|| format!("{what}: {error}"));
    };
    if notice.toast
        && let Err(error) = window
            .app_handle()
            .notification()
            .builder()
            .title(&notice.title)
            .body(&notice.body)
            .show()
    {
        fail("notification", error.to_string());
    }
    let focused = window.is_focused().unwrap_or(false);
    if notice.front {
        if window.is_minimized().unwrap_or(false)
            && let Err(error) = window.unminimize()
        {
            fail("unminimize", error.to_string());
        }
        if let Err(error) = window.show().and_then(|()| window.set_focus()) {
            fail("focus", error.to_string());
        }
    } else if notice.flash
        && !focused
        && let Err(error) = window.request_user_attention(Some(UserAttentionType::Critical))
    {
        fail("attention", error.to_string());
    }
    failed.map_or(Ok(()), Err)
}
