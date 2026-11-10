//! Explorer right-click integration.
//!
//! v1.3 wrote to HKEY_CLASSES_ROOT, which needs admin rights on modern Windows and failed
//! silently for normal users. This writes under HKEY_CURRENT_USER\Software\Classes, which
//! needs no elevation, and covers folders, drive roots and folder backgrounds.

pub const KEY_NAME: &str = "SW.EmptyFolderNuker";
pub const MENU_TEXT: &str = "&Find empty folders";

/// Class roots that get a verb: folder, drive, and the blank area inside a folder.
pub const TARGETS: [(&str, &str); 3] = [
    ("Directory", "%1"),
    ("Drive", "%1"),
    ("Directory\\Background", "%V"),
];

/// The command line stored for a verb. A drive root such as `C:\` ends in a backslash that
/// would escape the closing quote; the CLI parser repairs the resulting `C:"` argument.
pub fn command_line(exe: &str, arg: &str) -> String {
    format!("\"{exe}\" --scan \"{arg}\"")
}

/// Where the right-click entry's exe lives. Registering a stable copy (instead of wherever the
/// user happened to download the exe) means the download can be moved or deleted safely.
pub const INSTALL_FILE: &str = "EmptyFolderNuker.exe";

#[derive(Clone, Debug, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellStatus {
    pub supported: bool,
    pub enabled: bool,
}

/// Pulls the exe path out of `"C:\path\app.exe" --scan "%1"`.
pub fn parse_target(command: &str) -> Option<String> {
    let rest = command.trim().strip_prefix('"')?;
    Some(rest[..rest.find('"')?].to_string())
}

/// `a` is a strictly newer dotted version than `b` (missing or unparsable `b` counts as older).
pub fn version_gt(a: &str, b: &str) -> bool {
    let parse = |s: &str| -> Option<Vec<u64>> { s.split('.').map(|p| p.parse().ok()).collect() };
    match (parse(a), parse(b)) {
        (Some(a), Some(b)) => a > b,
        (Some(_), None) => true,
        _ => false,
    }
}

#[cfg(any(windows, test))]
pub(crate) fn newer_build(version: &str, build: &str, installed_version: &str, installed_build: &str) -> bool {
    version_gt(version, installed_version)
        || (version == installed_version
            && build.parse::<u128>().unwrap_or(0) > installed_build.parse::<u128>().unwrap_or(0))
}

#[cfg(windows)]
mod imp {
    use super::*;
    use std::fs::{self, File, OpenOptions};
    use std::path::Path;
    use std::path::PathBuf;
    use winreg::enums::*;
    use winreg::RegKey;

    fn classes() -> std::io::Result<RegKey> {
        RegKey::predef(HKEY_CURRENT_USER).open_subkey_with_flags("Software\\Classes", KEY_ALL_ACCESS)
    }

    fn saved_path() -> Option<PathBuf> {
        let base = std::env::var_os("LOCALAPPDATA")?;
        Some(PathBuf::from(base).join("EmptyFolderNuker").join(INSTALL_FILE))
    }

    fn registered_commands() -> [Option<String>; 3] {
        let classes = RegKey::predef(HKEY_CURRENT_USER).open_subkey("Software\\Classes");
        TARGETS.map(|(root, _)| {
            let cmd = classes.as_ref().ok()?.open_subkey(format!("{root}\\shell\\{KEY_NAME}\\command")).ok()?;
            cmd.get_value("").ok()
        })
    }

    fn same(a: &str, b: &str) -> bool {
        a.eq_ignore_ascii_case(b)
    }

    // Windows releases the exclusive handle when the process exits, including on a crash.
    fn lock(dir: &Path) -> Result<File, String> {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        let file = OpenOptions::new().write(true).create(true).truncate(false)
            .open(dir.join("shell.lock"))
            .map_err(|e| format!("Could not open Explorer integration lock: {e}"))?;
        file.lock().map_err(|e| format!("Could not lock Explorer integration: {e}"))?;
        Ok(file)
    }

    fn installed_build(target: &Path) -> (String, String) {
        let version = fs::read_to_string(target.with_file_name("version.txt")).unwrap_or_default().trim().to_owned();
        let stamp = fs::read_to_string(target.with_file_name("build.txt")).unwrap_or_default();
        let build = stamp.lines().nth(1).filter(|_| stamp.lines().next() == Some(&version)).unwrap_or("");
        (version, build.to_owned())
    }

    pub fn enable(current: &str, build: &str) -> Result<(), String> {
        let dest = saved_path().ok_or("LOCALAPPDATA is not set")?;
        let _lock = lock(dest.parent().unwrap())?;
        refresh_copy(current, build, &dest)?;
        register(&dest)
    }

    fn refresh_copy(current: &str, build: &str, dest: &Path) -> Result<(), String> {
        let (version, stamp) = installed_build(dest);
        if dest.is_file() && !newer_build(env!("CARGO_PKG_VERSION"), build, &version, &stamp) {
            return Ok(());
        }
        let dest_s = dest.to_string_lossy().into_owned();
        if !same(current, &dest_s) {
            let dir = dest.parent().unwrap();
            // Copy to a temporary name first and check it, so a failed or partial copy is never
            // registered. A running exe cannot be overwritten but can be renamed out of the way.
            let tmp = dir.join("EmptyFolderNuker.exe.new");
            let old = dir.join("EmptyFolderNuker.exe.old");
            let want = std::fs::metadata(current).map(|m| m.len()).map_err(|e| e.to_string())?;
            std::fs::copy(current, &tmp).map_err(|e| format!("Could not copy the app to {dest_s}: {e}"))?;
            if std::fs::metadata(&tmp).map(|m| m.len()).unwrap_or(0) != want {
                let _ = std::fs::remove_file(&tmp);
                return Err("The copy of the app is incomplete".into());
            }
            // A previous interrupted update may have left the only good copy at .old.
            let had_old = if dest.exists() {
                let _ = fs::remove_file(&old);
                fs::rename(dest, &old).map_err(|e| format!("Could not move the saved copy aside: {e}"))?;
                true
            } else {
                old.exists()
            };
            if let Err(e) = fs::rename(&tmp, dest) {
                if had_old {
                    let _ = fs::rename(&old, dest);
                }
                let _ = std::fs::remove_file(&tmp);
                return Err(format!("Could not replace the saved copy of the app: {e}"));
            }
            let _ = fs::remove_file(&old);
        }
        let version = env!("CARGO_PKG_VERSION");
        let version_path = dest.with_file_name("version.txt");
        let pending_version = version_path.with_extension("new");
        fs::write(&pending_version, version).map_err(|e| e.to_string())?;
        fs::rename(&pending_version, &version_path).map_err(|e| e.to_string())?;
        let stamp = dest.with_file_name("build.txt");
        let pending = stamp.with_extension("new");
        fs::write(&pending, format!("{version}\n{build}\n")).map_err(|e| e.to_string())?;
        fs::rename(&pending, &stamp).map_err(|e| e.to_string())?;
        Ok(())
    }

    fn register(dest: &Path) -> Result<(), String> {
        let dest_s = dest.to_string_lossy();
        let classes = classes().map_err(|e| e.to_string())?;
        for (root, arg) in TARGETS {
            let (verb, _) = classes.create_subkey(format!("{root}\\shell\\{KEY_NAME}")).map_err(|e| e.to_string())?;
            verb.set_value("", &MENU_TEXT).map_err(|e| e.to_string())?;
            verb.set_value("Icon", &format!("\"{dest_s}\",0")).map_err(|e| e.to_string())?;
            let (cmd, _) = verb.create_subkey("command").map_err(|e| e.to_string())?;
            cmd.set_value("", &command_line(&dest_s, arg)).map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    pub fn disable() -> Result<(), String> {
        let dest = saved_path().ok_or("LOCALAPPDATA is not set")?;
        let _lock = lock(dest.parent().unwrap())?;
        let classes = classes().map_err(|e| e.to_string())?;
        for (root, _) in TARGETS {
            match classes.delete_subkey_all(format!("{root}\\shell\\{KEY_NAME}")) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(e.to_string()),
            }
        }
        Ok(())
    }

    pub fn status() -> ShellStatus {
        ShellStatus {
            supported: true,
            enabled: registered_commands().iter().any(Option::is_some),
        }
    }

    /// Keep the saved copy current independently of the Explorer setting.
    pub fn refresh(current: &str, build: &str) -> Result<(), String> {
        let dest = saved_path().ok_or("LOCALAPPDATA is not set")?;
        let _lock = lock(dest.parent().unwrap())?;
        refresh_copy(current, build, &dest)?;
        let commands = registered_commands();
        if commands.iter().any(Option::is_some)
            && !commands.iter().zip(TARGETS).all(|(command, (_, arg))| {
                command.as_deref() == Some(command_line(&dest.to_string_lossy(), arg).as_str())
            })
        {
            register(&dest)?;
        }
        Ok(())
    }

    #[test]
    fn saved_copy_is_created_and_updated_without_registry_entries() {
        let dir = tempfile::tempdir().unwrap();
        let _lock = lock(dir.path()).unwrap();
        let source = dir.path().join("portable.exe");
        let dest = dir.path().join(INSTALL_FILE);
        let source_path = source.to_str().unwrap();
        fs::write(&source, b"first").unwrap();
        refresh_copy(source_path, "10", &dest).unwrap();
        assert_eq!(fs::read(&dest).unwrap(), b"first");
        fs::write(&source, b"second").unwrap();
        refresh_copy(source_path, "11", &dest).unwrap();
        assert_eq!(fs::read(&dest).unwrap(), b"second");
        fs::write(&source, b"older").unwrap();
        refresh_copy(source_path, "10", &dest).unwrap();
        assert_eq!(fs::read(&dest).unwrap(), b"second");
    }
}

#[cfg(not(windows))]
mod imp {
    use super::*;
    const NA: &str = "Explorer integration is only available on Windows";
    pub fn enable(_: &str, _: &str) -> Result<(), String> { Err(NA.into()) }
    pub fn disable() -> Result<(), String> { Err(NA.into()) }
    pub fn status() -> ShellStatus { ShellStatus::default() }
    pub fn refresh(_: &str, _: &str) -> Result<(), String> { Ok(()) }
}

pub use imp::{disable, enable, refresh, status};
