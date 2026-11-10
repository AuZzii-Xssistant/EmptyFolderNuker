use crate::settings;
use efn_core::{scan, shell, DeleteMode, DeletePolicy, DeleteResult, ScanOptions, ScanReport};
use serde::Serialize;
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, State, Window};
use tauri_plugin_dialog::DialogExt;

#[derive(Default)]
pub struct ScanState {
    cancel: Arc<AtomicBool>,
    working: Arc<AtomicBool>,
    /// What the last scan allows a delete to touch. The webview cannot widen it.
    policy: std::sync::Mutex<Option<Arc<DeletePolicy>>>,
}

impl ScanState {
    pub fn busy(&self) -> bool {
        self.working.load(Ordering::Relaxed)
    }
}

/// Clears the busy flag however the work ends, including a panic.
struct Busy(Arc<AtomicBool>);
impl Drop for Busy {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Relaxed);
    }
}

#[derive(Serialize, Clone)]
struct DeleteProgress {
    path: String,
    done: u64,
    total: u64,
}

#[derive(Serialize, Clone)]
struct Progress {
    path: String,
    count: u64,
}

pub fn native_message(text: &str) {
    rfd::MessageDialog::new().set_title("Empty Folder Nuker").set_description(text).show();
}

#[cfg_attr(windows, allow(dead_code))]
fn quiet(cmd: &mut Command) -> &mut Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    cmd
}

/// The one deliberate round trip the UI makes on boot to prove the bridge works.
#[tauri::command]
pub fn ping() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[tauri::command]
pub fn launch_folders(state: State<'_, crate::Launch>) -> Vec<String> {
    state.0.clone()
}

#[tauri::command]
pub async fn start_scan(
    app: AppHandle,
    state: State<'_, ScanState>,
    opts: ScanOptions,
) -> Result<ScanReport, String> {
    for r in &opts.roots {
        if !std::path::Path::new(r).is_dir() {
            return Err(format!("Folder \"{r}\" does not exist"));
        }
    }
    if state.working.swap(true, Ordering::SeqCst) {
        return Err("Another operation is already running".into());
    }
    let guard = Busy(state.working.clone());
    state.cancel.store(false, Ordering::SeqCst);
    let cancel = state.cancel.clone();
    *state.policy.lock().map_err(|e| e.to_string())? = None; // old results can no longer be deleted
    let scan_opts = opts.clone();
    let _guard = guard; // held until the policy is published, so no second scan can interleave
    let report = tauri::async_runtime::spawn_blocking(move || {
        let mut last = Instant::now() - Duration::from_secs(1);
        scan(&opts, &cancel, &mut |p, n| {
            if last.elapsed() >= Duration::from_millis(60) {
                last = Instant::now();
                let _ = app.emit("scan-progress", Progress { path: p.to_string_lossy().into(), count: n });
            }
        })
    })
    .await
    .map_err(|e| e.to_string())?;
    if !report.cancelled {
        *state.policy.lock().map_err(|e| e.to_string())? = Some(Arc::new(DeletePolicy::from_scan(&report, &scan_opts)));
    }
    Ok(report)
}

#[tauri::command]
pub fn cancel_scan(state: State<'_, ScanState>) {
    state.cancel.store(true, Ordering::SeqCst);
}

#[tauri::command]
pub async fn delete_paths(
    app: AppHandle,
    state: State<'_, ScanState>,
    paths: Vec<String>,
    mode: DeleteMode,
) -> Result<Vec<DeleteResult>, String> {
    if state.working.swap(true, Ordering::SeqCst) {
        return Err("Another operation is already running".into());
    }
    let guard = Busy(state.working.clone());
    let policy = state.policy.lock().map_err(|e| e.to_string())?.clone().ok_or("Nothing to delete: scan first")?;
    state.cancel.store(false, Ordering::SeqCst);
    let cancel = state.cancel.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = guard;
        let total = paths.len() as u64;
        let mut done = 0u64;
        let mut last = Instant::now() - Duration::from_secs(1);
        policy.run(&paths, mode, &cancel, &mut |r| {
            done += 1;
            // Throttle, but always deliver the final item so the bar reaches 100%.
            if last.elapsed() >= Duration::from_millis(40) || done == total {
                last = Instant::now();
                let _ = app.emit("delete-progress", DeleteProgress { path: r.path.clone(), done, total });
            }
        })
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn pick_folders(app: AppHandle, title: String, multiple: bool) -> Option<Vec<String>> {
    let b = app.dialog().file().set_title(title);
    let picked = if multiple { b.blocking_pick_folders() } else { b.blocking_pick_folder().map(|p| vec![p]) }?;
    Some(picked.into_iter().filter_map(|p| p.into_path().ok()).map(|p| p.to_string_lossy().into_owned()).collect())
}

/// Native save dialog + write. Returns the path written, or None if cancelled.
#[tauri::command]
pub async fn save_paths(app: AppHandle, lines: Vec<String>) -> Result<Option<String>, String> {
    let Some(target) = app
        .dialog()
        .file()
        .set_title("Save checked paths")
        .set_file_name("empty_folder_paths.txt")
        .add_filter("Text Files", &["txt"])
        .blocking_save_file()
    else {
        return Ok(None);
    };
    let path: PathBuf = target.into_path().map_err(|e| e.to_string())?;
    std::fs::write(&path, lines.join("\r\n")).map_err(|e| format!("Cannot open file for writing: {e}"))?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

#[tauri::command]
pub fn reveal(path: String, open_inside: bool) -> Result<(), String> {
    // The webview can call this with any string: only ever hand a real folder or file to the shell,
    // and never something that could be read as a command-line switch.
    if path.starts_with('-') || (cfg!(windows) && path.starts_with('/')) {
        return Err("Not a file or folder path".into());
    }
    let p = PathBuf::from(&path);
    if open_inside && !p.is_dir() {
        return Err("That folder no longer exists".into());
    }
    if !open_inside && !p.exists() {
        return Err("That item no longer exists".into());
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let mut c = Command::new("explorer.exe");
        if open_inside { c.arg(&p) } else { c.raw_arg(format!("/select,\"{}\"", p.display())) };
        c.spawn().map(|_| ()).map_err(|e| e.to_string())
    }
    #[cfg(not(windows))]
    {
        let target = if open_inside { p } else { p.parent().map(|x| x.to_path_buf()).unwrap_or(p) };
        quiet(&mut Command::new("xdg-open")).arg(target).spawn().map(|_| ()).map_err(|e| e.to_string())
    }
}

fn exe() -> String {
    std::env::current_exe().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default()
}

#[tauri::command]
pub fn shell_status() -> shell::ShellStatus {
    shell::status()
}

#[tauri::command]
pub async fn shell_enable() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(|| shell::enable(&exe(), crate::BUILD_ID))
        .await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn shell_disable() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(shell::disable).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn load_settings() -> String {
    settings::load()
}

#[tauri::command]
pub fn store_settings(json: String) -> Result<(), String> {
    serde_json::from_str::<serde_json::Value>(&json).map_err(|e| e.to_string())?;
    settings::store(&json)
}

#[tauri::command]
pub fn window_minimize(window: Window) -> Result<(), String> {
    window.minimize().map_err(|e| e.to_string())
}

/// Goes through the window's close request so busy-work confirmation applies, and so the
/// Alt+F4 and button paths behave identically (both end in `app.exit`).
#[tauri::command]
pub fn window_close(window: Window) -> Result<(), String> {
    window.close().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn confirm_exit(app: AppHandle) {
    app.exit(0);
}

/// Where the window is anchored: it grows and shrinks around its centre.
#[derive(Default)]
pub struct WindowAnchor(pub std::sync::Mutex<efn_core::layout::Anchor>);

fn rect_of(window: &Window) -> Option<efn_core::layout::Rect> {
    let (p, s) = (window.outer_position().ok()?, window.outer_size().ok()?);
    Some(efn_core::layout::Rect { x: p.x, y: p.y, w: s.width as i32, h: s.height as i32 })
}

fn work_rect(window: &Window) -> Option<efn_core::layout::Rect> {
    let a = *window.current_monitor().ok().flatten()?.work_area();
    Some(efn_core::layout::Rect { x: a.position.x, y: a.position.y, w: a.size.width as i32, h: a.size.height as i32 })
}

/// Resize the window to what the current screen needs. It grows and shrinks around its centre and
/// is kept inside the monitor's *work area* (the screen minus the taskbar). A maximized window is
/// left alone.
#[tauri::command]
pub fn fit_window(window: Window, anchor: State<'_, WindowAnchor>, width: f64, height: f64, show: Option<bool>) -> Result<(), String> {
    if window.is_maximized().unwrap_or(false) || window.is_fullscreen().unwrap_or(false) {
        return Ok(());
    }
    // A minimized window would take the size but keep showing the old one once restored; refuse, and the UI
    // asks again when the window comes back.
    if window.is_minimized().unwrap_or(false) {
        return Err("window is minimized".into());
    }
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    let work = work_rect(&window);
    let (mut w, mut h) = (width, height);
    if let Some(a) = &work {
        // Never ask for more than the usable screen.
        w = w.min(a.w as f64 / scale);
        h = h.min(a.h as f64 / scale);
    }
    let old = rect_of(&window);
    // The window is not user-resizable, so unlock it just long enough to apply our own size.
    let locked = !window.is_resizable().unwrap_or(true);
    if locked {
        let _ = window.set_resizable(true);
    }
    let sized = window.set_size(tauri::LogicalSize::new(w, h)).map_err(|e| e.to_string());
    if locked {
        let _ = window.set_resizable(false);
    }
    sized?;
    if let (Some(old), Some(area)) = (old, work) {
        let (pw, ph) = ((w * scale).round() as i32, (h * scale).round() as i32);
        let (nx, ny) = anchor.0.lock().map_err(|e| e.to_string())?.place(old, pw, ph, area);
        let _ = window.set_position(tauri::PhysicalPosition::new(nx, ny));
    }
    if show == Some(true) && !window.is_visible().map_err(|e| e.to_string())? {
        window.show().map_err(|e| e.to_string())?;
        let _ = window.set_focus();
    }
    Ok(())
}

#[tauri::command]
pub fn open_bug_report() -> Result<(), String> {
    const URL: &str = "https://github.com/AuZzii-Xssistant/EmptyFolderNuker/issues/";
    #[cfg(windows)]
    {
        use std::ffi::c_void;
        use std::ptr::{null, null_mut};

        #[link(name = "shell32")]
        extern "system" {
            fn ShellExecuteW(
                window: *mut c_void, verb: *const u16, target: *const u16,
                parameters: *const u16, directory: *const u16, show: i32,
            ) -> *mut c_void;
        }

        let url: Vec<u16> = URL.encode_utf16().chain(std::iter::once(0)).collect();
        // SAFETY: url is NUL-terminated and remains alive for the call. Other pointers are optional.
        // The HTTPS handler is the default browser. Explorer's file opener can ignore the URL.
        let result = unsafe { ShellExecuteW(null_mut(), null(), url.as_ptr(), null(), null(), 1) };
        if result as usize <= 32 {
            return Err(format!("Could not open GitHub in your default browser (Windows error {}).", result as usize));
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let opener = if cfg!(target_os = "macos") { "open" } else { "xdg-open" };
        Command::new(opener).arg(URL).spawn().map(|_| ()).map_err(|e| e.to_string())
    }
}
