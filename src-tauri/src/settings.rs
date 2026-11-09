use std::fs;
use std::path::PathBuf;

/// Settings are stored as one JSON blob the UI owns; the backend only persists it.
fn path() -> PathBuf {
    let base = std::env::var_os("APPDATA")
        .or_else(|| std::env::var_os("XDG_CONFIG_HOME"))
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")))
        .unwrap_or_else(std::env::temp_dir);
    base.join("EmptyFolderNuker").join("settings.json")
}

/// A corrupt or non-object file is moved aside to `settings.json.bad` (so it is not silently
/// overwritten) and the app starts from the defaults.
pub fn load() -> String {
    let p = path();
    let Ok(text) = fs::read_to_string(&p) else { return "{}".into() };
    match serde_json::from_str::<serde_json::Value>(&text) {
        Ok(v) if v.is_object() => text,
        _ => {
            let _ = fs::rename(&p, p.with_extension("json.bad"));
            "{}".into()
        }
    }
}

/// Written to a temporary file and renamed into place, so a crash can never leave half a file.
pub fn store(json: &str) -> Result<(), String> {
    let p = path();
    if let Some(dir) = p.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let tmp = p.with_extension("json.tmp");
    fs::write(&tmp, json).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &p).map_err(|e| e.to_string())
}
