use crate::protect;
use crate::scan::{has_link_ancestor, is_link, JunkStamp, NameRules, ScanOptions, ScanReport};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DeleteMode {
    /// Send to the Recycle Bin / Trash (v1.3 behaviour).
    Recycle,
    /// Remove permanently.
    Permanent,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum DeleteOutcome {
    Deleted,
    /// Already gone, usually because a parent was removed first.
    AlreadyGone,
    /// Refused because it now holds something.
    NotEmpty,
    /// Refused because it is in a protected location.
    Protected,
    Failed(String),
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteResult {
    pub path: String,
    pub outcome: DeleteOutcome,
}

fn key(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

struct Contents<'a> {
    junk: NameRules,
    scan: Option<&'a DeletePolicy>,
}

impl Contents<'_> {
    fn allows_dir(&self, path: &Path) -> bool {
        self.scan.is_none_or(|scan| scan.allowed.contains(&key(path)))
    }

    fn allows_file(&self, entry: &fs::DirEntry) -> bool {
        let Some(scan) = self.scan else { return self.junk.matches(&entry.file_name().to_string_lossy()) };
        if scan.junk_files.is_empty() {
            return false;
        }
        let path = entry.path();
        scan.junk_files.get(&path).is_some_and(|expected| JunkStamp::read(&path).as_ref() == Some(expected))
    }
}

/// Delete the given folders after checking their current contents. Use `DeletePolicy` to also
/// reject files absent from the scan. Shallowest first: when a parent is removed, every listed
/// folder inside it is already gone, so it is reported as deleted without another file system call
/// (one Recycle Bin entry instead of thousands, and no repeated re-reading of the same tree).
/// Setting `cancel` stops after the current folder. Junk patterns that are too broad are ignored.
pub fn delete_folders(
    paths: &[String],
    mode: DeleteMode,
    junk: &[String],
    protect: bool,
    follow_links: bool,
    cancel: &AtomicBool,
    on_item: &mut dyn FnMut(&DeleteResult),
) -> Vec<DeleteResult> {
    delete_checked(paths, mode, junk, protect, follow_links, None, cancel, on_item)
}

fn delete_checked(
    paths: &[String],
    mode: DeleteMode,
    junk: &[String],
    protect: bool,
    follow_links: bool,
    scan: Option<&DeletePolicy>,
    cancel: &AtomicBool,
    on_item: &mut dyn FnMut(&DeleteResult),
) -> Vec<DeleteResult> {
    let contents = Contents { junk: NameRules::compile(junk, true), scan };
    let mut order: Vec<&String> = paths.iter().collect();
    order.sort_by_key(|p| Path::new(p.as_str()).components().count());
    let mut removed: HashSet<String> = HashSet::new();
    let mut out = Vec::with_capacity(order.len());
    for p in order {
        if cancel.load(Ordering::Relaxed) {
            break; // stopped by the user: everything not yet reached is left untouched
        }
        let path = Path::new(p.as_str());
        let outcome = if path.ancestors().skip(1).any(|a| removed.contains(&key(a))) {
            DeleteOutcome::Deleted // went with its parent
        } else if protect && protect::is_protected_resolved(path) {
            DeleteOutcome::Protected
        } else if has_link_ancestor(path) {
            if follow_links {
                DeleteOutcome::Failed("Folder is on a junction or symbolic link".into())
            } else {
                DeleteOutcome::NotEmpty
            }
        } else {
            let meta = fs::symlink_metadata(path);
            match meta {
                Err(e) if e.kind() == io::ErrorKind::NotFound => DeleteOutcome::AlreadyGone,
                Err(e) => DeleteOutcome::Failed(friendly(&e)),
                Ok(m) if !m.is_dir() || is_link(&m) => DeleteOutcome::NotEmpty,
                Ok(_) if !only_empty_dirs(path, &contents) => DeleteOutcome::NotEmpty,
                Ok(_) => {
                    let o = remove(path, mode, &contents);
                    if o == DeleteOutcome::Deleted {
                        removed.insert(key(path));
                    }
                    o
                }
            }
        };
        let r = DeleteResult { path: p.clone(), outcome };
        on_item(&r);
        out.push(r);
    }
    out
}

fn remove(path: &Path, mode: DeleteMode, contents: &Contents<'_>) -> DeleteOutcome {
    match mode {
        DeleteMode::Recycle => match trash::delete(path) {
            Ok(()) => DeleteOutcome::Deleted,
            Err(e) => DeleteOutcome::Failed(friendly_trash(&e.to_string())),
        },
        DeleteMode::Permanent => match remove_tree_checked(path, contents) {
            Ok(()) => DeleteOutcome::Deleted,
            Err(e) if e.kind() == io::ErrorKind::DirectoryNotEmpty => DeleteOutcome::NotEmpty,
            Err(e) => DeleteOutcome::Failed(friendly(&e)),
        },
    }
}

/// The shell's own wording ("Some operations were aborted") says nothing; explain the usual causes.
pub(crate) fn friendly_trash(msg: &str) -> String {
    if msg.contains("Some operations were aborted") {
        "Windows refused to move it to the Recycle Bin (no permission, or this drive has no Recycle Bin). Try Permanently, or run as administrator".into()
    } else {
        msg.replace("Error during a `trash` operation: ", "")
    }
}

/// A short reason a person can act on, instead of "Access is denied. (os error 5)".
fn friendly(e: &io::Error) -> String {
    match e.raw_os_error() {
        Some(5) => "Access denied (read-only, in use, or no permission)".into(),
        Some(32) => "In use by another program".into(),
        Some(3) | Some(2) => "Path not found".into(),
        _ if e.kind() == io::ErrorKind::PermissionDenied => "Access denied (read-only, in use, or no permission)".into(),
        _ => e.to_string(),
    }
}

/// `remove_dir`, but a folder carrying the read-only attribute is made writable first. Windows refuses
/// to remove such folders ("Access is denied") although Explorer and the Recycle Bin manage it.
fn remove_dir_force(dir: &Path) -> io::Result<()> {
    match fs::remove_dir(dir) {
        Err(e) if e.kind() == io::ErrorKind::PermissionDenied => {
            let mut perm = fs::metadata(dir)?.permissions();
            if !perm.readonly() {
                return Err(e);
            }
            #[allow(clippy::permissions_set_readonly_false)]
            perm.set_readonly(false);
            fs::set_permissions(dir, perm)?;
            fs::remove_dir(dir)
        }
        other => other,
    }
}

/// Bottom-up removal. Only allowed junk files are unlinked. `remove_dir` refuses any directory
/// that still contains an entry, including files created during the removal.
#[cfg(test)]
pub(crate) fn remove_tree(dir: &Path, junk: &[String], _follow_links: bool) -> io::Result<()> {
    remove_tree_checked(dir, &Contents { junk: NameRules::compile(junk, true), scan: None })
}

fn remove_tree_checked(dir: &Path, contents: &Contents<'_>) -> io::Result<()> {
    let changed = || io::Error::new(io::ErrorKind::DirectoryNotEmpty, "folder contents changed");
    if is_link(&fs::symlink_metadata(dir)?) {
        return Err(changed());
    }
    for e in fs::read_dir(dir)? {
        let e = e?;
        let meta = e.metadata()?;
        let p = e.path();
        if is_link(&meta) {
            return Err(changed());
        } else if meta.is_dir() && contents.allows_dir(&p) {
            remove_tree_checked(&p, contents)?;
        } else if meta.is_file() && contents.allows_file(&e) {
            remove_file_force(&p)?;
        } else {
            return Err(io::Error::new(io::ErrorKind::DirectoryNotEmpty, "folder is not empty"));
        }
    }
    remove_dir_force(dir)
}

fn remove_file_force(p: &Path) -> io::Result<()> {
    match fs::remove_file(p) {
        Err(e) if e.kind() == io::ErrorKind::PermissionDenied => {
            let mut perm = fs::metadata(p)?.permissions();
            if !perm.readonly() {
                return Err(e);
            }
            #[allow(clippy::permissions_set_readonly_false)]
            perm.set_readonly(false);
            fs::set_permissions(p, perm)?;
            fs::remove_file(p)
        }
        other => other,
    }
}

/// Check the live tree immediately before removal. Unreadable entries count as content.
fn only_empty_dirs(dir: &Path, contents: &Contents<'_>) -> bool {
    let Ok(rd) = fs::read_dir(dir) else { return false };
    for e in rd {
        let Ok(e) = e else { return false };
        let Ok(meta) = e.metadata() else { return false };
        if is_link(&meta) {
            return false;
        }
        if meta.is_dir() {
            let p = e.path();
            if !contents.allows_dir(&p) || !only_empty_dirs(&p, contents) {
                return false;
            }
        } else if !(meta.is_file() && contents.allows_file(&e)) {
            return false;
        }
    }
    true
}

/// What the backend allows a delete to do: only folders reported by the last scan, judged by the
/// options that scan used. The UI cannot widen this (no other paths, no broader junk list, no
/// switching protection off), whatever it sends.
#[derive(Clone, Debug, Default)]
pub struct DeletePolicy {
    allowed: HashSet<String>,
    junk_files: HashMap<PathBuf, JunkStamp>,
    protect: bool,
    follow_links: bool,
}

impl DeletePolicy {
    pub fn from_scan(report: &ScanReport, opts: &ScanOptions) -> Self {
        Self {
            allowed: report.folders.iter().map(|f| f.path.clone()).collect(),
            junk_files: if opts.ignore_junk { report.junk_files.clone() } else { HashMap::new() },
            protect: opts.skip_protected,
            follow_links: !opts.skip_reparse,
        }
    }

    pub fn run(
        &self,
        paths: &[String],
        mode: DeleteMode,
        cancel: &AtomicBool,
        on_item: &mut dyn FnMut(&DeleteResult),
    ) -> Vec<DeleteResult> {
        let (ok, unknown): (Vec<String>, Vec<String>) = paths.iter().cloned().partition(|p| self.allowed.contains(p));
        let mut out = Vec::with_capacity(paths.len());
        for p in unknown {
            let r = DeleteResult { path: p, outcome: DeleteOutcome::Failed("not part of the last scan; scan again".into()) };
            on_item(&r);
            out.push(r);
        }
        out.extend(delete_checked(&ok, mode, &[], self.protect, self.follow_links, Some(self), cancel, on_item));
        out
    }
}
