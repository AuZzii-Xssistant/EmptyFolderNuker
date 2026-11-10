#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod settings;

use efn_core::cli;
use std::{
    sync::{atomic::{AtomicBool, Ordering}, Mutex, Once},
    time::Instant,
};
use tauri::{Emitter, Manager};

pub struct Launch(pub Vec<String>);
#[derive(Default)]
pub struct ForwardedFolders(Mutex<Vec<String>>);
const BUILD_ID: &str = env!("EFN_BUILD_ID");

struct Startup {
    exe: String,
    started: Instant,
    timing: bool,
    refresh: Once,
    refresh_failed: AtomicBool,
    settings: Result<serde_json::Value, String>,
}

impl Startup {
    fn mark(&self, stage: &str) {
        if self.timing {
            eprintln!("EFN startup: {stage} at {} ms", self.started.elapsed().as_millis());
        }
    }

    fn window_shown(&self, app: tauri::AppHandle) {
        self.refresh.call_once(|| {
            self.mark("window shown");
            std::thread::spawn(move || {
                let startup = app.state::<Startup>();
                let _ = startup.refresh_copy();
                startup.mark("saved copy check finished");
            });
        });
    }

    fn refresh_copy(&self) -> Result<(), String> {
        let result = efn_core::shell::refresh(&self.exe, BUILD_ID);
        self.refresh_failed.store(result.is_err(), Ordering::Relaxed);
        result
    }
}

fn main() {
    let started = Instant::now();
    let args = cli::parse(std::env::args().skip(1));
    let exe = std::env::current_exe().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();

    if !args.unknown.is_empty() {
        commands::native_message(&format!("Unknown option: {}\n\n{}", args.unknown.join(" "), cli::USAGE));
        std::process::exit(2);
    }
    // Headless switches from the old WinTools build: no window at all.
    if args.help || args.version || args.install_shell || args.uninstall_shell {
        std::process::exit(run_headless(&args, &exe));
    }

    let settings = settings::load();
    let timing = std::env::var_os("EFN_STARTUP_TIMING").is_some();
    if timing {
        eprintln!("EFN startup: settings loaded at {} ms", started.elapsed().as_millis());
    }
    let allow_multiple = settings.as_ref().ok()
        .and_then(|value| value.get("allowMultipleInstances"))
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    let mut builder = tauri::Builder::default();
    if !allow_multiple {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            if let Some(folder) = cli::parse(args.into_iter().skip(1)).folders.into_iter().next() {
                let path = std::path::Path::new(&folder);
                let folder = if path.is_absolute() {
                    folder
                } else {
                    std::path::Path::new(&cwd).join(path).to_string_lossy().into_owned()
                };
                app.state::<ForwardedFolders>().0.lock().unwrap().push(folder);
                let _ = app.emit("folders-forwarded", ());
            }
            if let Some(window) = app.get_webview_window("main") {
                if window.is_minimized().unwrap_or(false) {
                    let _ = window.unminimize();
                }
                let _ = window.set_focus();
            }
        }));
    }
    builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(Launch(args.folders))
        .manage(ForwardedFolders::default())
        .manage(Startup {
            exe, started, timing,
            refresh: Once::new(), refresh_failed: AtomicBool::new(false), settings,
        })
        .manage(commands::ScanState::default())
        .manage(commands::WindowAnchor::default())
        .setup(|app| {
            // A broken or unusually slow webview must not leave an invisible process.
            if let Some(window) = app.get_webview_window("main") {
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(4));
                    if matches!(window.is_visible(), Ok(false)) && window.show().is_ok() {
                        window.state::<Startup>().window_shown(window.app_handle().clone());
                    }
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::bootstrap,
            commands::take_forwarded_folders,
            commands::start_scan,
            commands::cancel_scan,
            commands::delete_paths,
            commands::pick_folders,
            commands::save_paths,
            commands::reveal,
            commands::shell_status,
            commands::shell_enable,
            commands::shell_disable,
            commands::shell_retry_refresh,
            commands::store_settings,
            commands::fit_window,
            commands::open_bug_report,
            commands::window_minimize,
            commands::window_close,
            commands::confirm_exit,
        ])
        .on_window_event(|window, event| {
            // Closing always goes through the UI's own confirmation when work is pending,
            // otherwise the process must really exit (Alt+F4 included).
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let app = window.app_handle();
                // The UI saves pending settings (and asks first when work is running), then calls
                // confirm_exit. If the page does not answer, an idle app still exits after 2 s.
                api.prevent_close();
                let _ = app.emit("close-requested", ());
                if !app.state::<commands::ScanState>().busy() {
                    let app = app.clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(std::time::Duration::from_secs(2));
                        app.exit(0);
                    });
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Empty Folder Nuker");
}

/// Console-less processes cannot print, so the result is reported via a message box on
/// Windows and stdout elsewhere. Exit codes follow the old tool: 0 ok, 4 usage, 5 version.
fn run_headless(args: &cli::Cli, exe: &str) -> i32 {
    use efn_core::shell;
    let say = |m: &str| commands::native_message(m);
    if args.help {
        say(cli::USAGE);
        return 4;
    }
    if args.version {
        say(&format!("Empty Folder Nuker {}", env!("CARGO_PKG_VERSION")));
        return 5;
    }
    let r = if args.uninstall_shell { shell::disable() } else { shell::enable(exe, BUILD_ID) };
    match r {
        Ok(()) => {
            say(if args.uninstall_shell { "Explorer context menu disabled." } else { "Explorer context menu enabled." });
            0
        }
        Err(e) => {
            say(&format!("Failed: {e}"));
            1
        }
    }
}
