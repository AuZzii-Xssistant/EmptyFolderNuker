use std::fs;
use std::io::{ErrorKind, Write};
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

/// Back up corrupt settings without moving the live path another instance may have replaced.
pub fn load() -> Result<serde_json::Value, String> {
    let p = path();
    let dir = p.parent().expect("settings path has a parent");
    if !dir.try_exists().map_err(|e| e.to_string())? {
        return Ok(serde_json::json!({}));
    }
    let _lock = lock(dir)?;
    let bytes = match fs::read(&p) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(serde_json::json!({})),
        Err(e) => return Err(e.to_string()),
    };
    match serde_json::from_slice::<serde_json::Value>(&bytes) {
        Ok(v) if v.is_object() => Ok(v),
        _ => {
            write_atomic(&p.with_extension("json.bad"), &bytes)?;
            Ok(serde_json::json!({}))
        }
    }
}

/// Written to a temporary file and renamed into place, so a crash can never leave half a file.
pub fn store(json: &str, allow_multiple: Option<bool>) -> Result<(), String> {
    store_at(&path(), json, allow_multiple)
}

fn store_at(path: &std::path::Path, json: &str, allow_multiple: Option<bool>) -> Result<(), String> {
    let mut value: serde_json::Value = serde_json::from_str(json).map_err(|e| e.to_string())?;
    let object = value.as_object_mut().ok_or("Settings must be a JSON object")?;
    let dir = path.parent().expect("settings path has a parent");
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let _lock = lock(dir)?;
    // Only an explicit change in Settings may update the launch policy. A different window
    // can still have an older copy of the other settings in memory.
    const KEY: &str = "allowMultipleInstances";
    let preference = match allow_multiple {
        Some(value) => Some(value),
        None => match fs::read(path) {
            Ok(bytes) => serde_json::from_slice::<serde_json::Value>(&bytes).ok()
                .and_then(|previous| previous.get(KEY).and_then(serde_json::Value::as_bool)),
            Err(e) if e.kind() == ErrorKind::NotFound => None,
            Err(e) => return Err(e.to_string()),
        },
    };
    object.remove(KEY);
    if let Some(preference) = preference {
        object.insert(KEY.into(), preference.into());
    }
    write_atomic(path, &serde_json::to_vec(&value).map_err(|e| e.to_string())?)
}

fn lock(dir: &std::path::Path) -> Result<fs::File, String> {
    let file = fs::OpenOptions::new().write(true).create(true).truncate(false)
        .open(dir.join("settings.lock")).map_err(|e| e.to_string())?;
    file.lock().map_err(|e| e.to_string())?;
    Ok(file)
}

fn write_atomic(path: &std::path::Path, bytes: &[u8]) -> Result<(), String> {
    let dir = path.parent().expect("settings path has a parent");
    let mut tmp = tempfile::NamedTempFile::new_in(dir).map_err(|e| e.to_string())?;
    tmp.write_all(bytes).map_err(|e| e.to_string())?;
    tmp.persist(path).map_err(|e| e.error.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn concurrent_saves_replace_whole_documents() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        let first = serde_json::json!({ "base": "a".repeat(64 * 1024) }).to_string();
        let second = serde_json::json!({ "base": "b".repeat(64 * 1024) }).to_string();
        for _ in 0..10 {
            let barrier = std::sync::Barrier::new(2);
            std::thread::scope(|scope| {
                let writer = scope.spawn(|| {
                    barrier.wait();
                    store_at(&path, &first, None).unwrap();
                });
                barrier.wait();
                store_at(&path, &second, None).unwrap();
                writer.join().unwrap();
            });
            let stored = fs::read_to_string(&path).unwrap();
            assert!(stored == first || stored == second);
        }
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 2);
    }

    #[test]
    fn stale_window_settings_cannot_change_the_instance_preference() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        store_at(&path, "{}", Some(true)).unwrap();
        store_at(&path, r#"{"allowMultipleInstances":false,"theme":"light"}"#, None).unwrap();
        let saved: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(saved, serde_json::json!({ "allowMultipleInstances": true, "theme": "light" }));
    }
}
