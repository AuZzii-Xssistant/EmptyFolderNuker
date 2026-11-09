//! Locations the scanner leaves alone unless the user turns the protection off.
//! Empty folders under these are usually expected by Windows or by installed apps, so removing
//! them is never worth the risk.

use std::path::Path;

/// Folders directly under a drive root (matched case-insensitively).
const WINDOWS_ROOT_DIRS: &[&str] = &[
    "windows", "program files", "program files (x86)", "programdata", "system volume information",
    "$recycle.bin", "recovery", "boot", "$windows.~bt", "$windows.~ws", "$winreagent", "config.msi",
    "documents and settings", "perflogs", "msocache",
];
/// Top-level system folders on Unix-like systems.
const UNIX_ROOT_DIRS: &[&str] = &[
    "bin", "boot", "dev", "etc", "lib", "lib32", "lib64", "proc", "sbin", "sys", "usr", "system", "library", "applications",
];

/// Fast check on the path as spelled (no file system access). Used for every directory entry while
/// scanning, where the parent has already been resolved.
pub fn is_protected(path: &Path) -> bool {
    is_protected_str(&path.to_string_lossy())
}

/// The path as spelled *and*, when it exists, its canonical form (which resolves 8.3 short names such as
/// `PROGRA~1`, `..`, case, trailing dots and junctions). Use for roots, followed links and delete time.
pub fn is_protected_resolved(path: &Path) -> bool {
    is_protected(path) || std::fs::canonicalize(path).map(|c| is_protected(&c)).unwrap_or(false)
}

/// Lower-cased components of `path` with separators unified, `.`/`..` resolved lexically and the
/// trailing dots and spaces that Windows ignores removed.
fn components(path: &str) -> (bool, Vec<String>) {
    let p = path.replace('\\', "/").to_lowercase();
    let rooted = p.starts_with('/');
    let mut out: Vec<String> = Vec::new();
    for c in p.split('/') {
        match c {
            "" | "." => continue,
            ".." => {
                out.pop();
                continue;
            }
            _ => {}
        }
        let t = c.trim_end_matches(['.', ' ']);
        if !t.is_empty() {
            out.push(t.to_string());
        }
    }
    (rooted, out)
}

/// String form so it can be tested for Windows-style paths on any platform.
pub fn is_protected_str(path: &str) -> bool {
    let (rooted, mut parts) = components(path);
    // Device / verbatim prefixes: \\?\C:\..., \\.\C:\...
    if parts.first().map(|s| s == "?").unwrap_or(false) {
        parts.remove(0);
    }
    if parts.first().map(|s| s == "unc").unwrap_or(false) && parts.len() >= 3 {
        parts.drain(0..1); // \\?\UNC\server\share -> server\share
    }
    // Administrative share of this very machine: \\localhost\C$\Windows is C:\Windows.
    if parts.len() >= 2 && matches!(parts[0].as_str(), "localhost" | "127.0.0.1" | "::1") {
        let b = parts[1].as_bytes();
        if b.len() == 2 && b[0].is_ascii_alphabetic() && b[1] == b'$' {
            parts[1] = format!("{}:", parts[1].trim_end_matches('$'));
            parts.remove(0);
        }
    }
    let Some(first) = parts.first() else { return false };
    let b = first.as_bytes();
    if b.len() == 2 && b[0].is_ascii_alphabetic() && b[1] == b':' {
        if parts.get(1).map(|s| WINDOWS_ROOT_DIRS.contains(&s.as_str())).unwrap_or(false) {
            return true;
        }
        // Per-user app data that apps expect to be intact.
        return parts.windows(3).any(|w| w[0] == "appdata" && w[1] == "local" && w[2] == "packages");
    }
    // `\\dev\share` is a network server, not /dev: Unix roots only apply to `/`-style paths.
    let unc = path.starts_with("\\\\") || (cfg!(windows) && path.starts_with("//"));
    rooted && !unc && UNIX_ROOT_DIRS.contains(&first.as_str())
}
