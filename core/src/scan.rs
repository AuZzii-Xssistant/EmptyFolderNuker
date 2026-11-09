use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, SystemTime};

#[derive(Clone, Debug, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ScanOptions {
    /// One or more base folders to search.
    pub roots: Vec<String>,
    /// Descend into subfolders (v1.3 "Check subfolders").
    pub recurse: bool,
    /// A folder holding only empty subfolders counts as empty (v1.3).
    pub nested_empty: bool,
    /// Treat folders holding only junk files (Thumbs.db, desktop.ini, ...) as empty.
    pub ignore_junk: bool,
    /// Extra file names (case-insensitive, `*` wildcard) counted as junk.
    pub junk_patterns: Vec<String>,
    /// Folder names (case-insensitive, `*` wildcard) never reported or entered.
    pub exclude_patterns: Vec<String>,
    /// Only report folders last modified at least this many days ago (0 = off).
    pub min_age_days: u32,
    /// Maximum depth below each root (0 = unlimited).
    pub max_depth: u32,
    /// Skip hidden folders (and treat their parent as non-empty).
    pub skip_hidden: bool,
    /// Skip folders marked as system folders.
    pub skip_system: bool,
    /// Skip OS-protected locations (Windows, Program Files, ...), see `protect`.
    pub skip_protected: bool,
    /// Do not enter symlinks, junctions or cloud placeholders. When false they are followed
    /// (loops and duplicates are detected).
    pub skip_reparse: bool,
    /// Allow the root itself to be reported when it turns out to be empty.
    pub include_root: bool,
}

impl Default for ScanOptions {
    fn default() -> Self {
        Self {
            roots: vec![],
            recurse: true,
            nested_empty: true,
            ignore_junk: false,
            junk_patterns: vec!["thumbs.db".into(), "desktop.ini".into(), ".ds_store".into()],
            exclude_patterns: vec![],
            min_age_days: 0,
            max_depth: 0,
            skip_hidden: false,
            skip_system: true,
            skip_protected: true,
            skip_reparse: true,
            include_root: false,
        }
    }
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EmptyFolder {
    pub path: String,
    /// Directly empty (true) or only emptied by removing empty children (false).
    pub direct: bool,
    pub depth: u32,
    /// Seconds since the Unix epoch, if known.
    pub modified: Option<u64>,
}

#[derive(Clone, Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ScanReport {
    pub folders: Vec<EmptyFolder>,
    pub scanned: u64,
    pub skipped: Vec<String>,
    pub cancelled: bool,
}

/// A junk pattern must contain at least three literal characters. Patterns such as `*`, `*.*` or `?`
/// would turn every file into "junk" and let real documents be deleted, so they are ignored.
pub fn valid_junk_pattern(p: &str) -> bool {
    p.chars().filter(|c| !matches!(c, '*' | '?')).count() >= 3
}

/// Wildcard match on a single name; `*` matches any run, case-insensitive.
pub fn wildcard(pattern: &str, name: &str) -> bool {
    let p: Vec<char> = pattern.to_lowercase().chars().collect();
    let n: Vec<char> = name.to_lowercase().chars().collect();
    let (mut pi, mut ni, mut star, mut mark) = (0, 0, None, 0);
    while ni < n.len() {
        if pi < p.len() && p[pi] == '*' {
            star = Some(pi);
            mark = ni;
            pi += 1;
        } else if pi < p.len() && (p[pi] == '?' || p[pi] == n[ni]) {
            pi += 1;
            ni += 1;
        } else if let Some(s) = star {
            pi = s + 1;
            mark += 1;
            ni = mark;
        } else {
            return false;
        }
    }
    while pi < p.len() && p[pi] == '*' {
        pi += 1;
    }
    pi == p.len()
}

struct Ctx<'a> {
    opts: &'a ScanOptions,
    cancel: &'a AtomicBool,
    on_progress: &'a mut dyn FnMut(&Path, u64),
    report: ScanReport,
    cutoff: Option<SystemTime>,
    /// Canonical paths of followed links already entered (loop and duplicate guard).
    visited: HashSet<PathBuf>,
}

/// Scan. `on_progress` receives the folder being read and the running count.
pub fn scan(
    opts: &ScanOptions,
    cancel: &AtomicBool,
    on_progress: &mut dyn FnMut(&Path, u64),
) -> ScanReport {
    let cutoff = (opts.min_age_days > 0)
        .then(|| SystemTime::now() - Duration::from_secs(opts.min_age_days as u64 * 86_400));
    let mut ctx = Ctx { opts, cancel, on_progress, report: ScanReport::default(), cutoff, visited: HashSet::new() };
    for root in &opts.roots {
        if cancel.load(Ordering::Relaxed) {
            break;
        }
        let root = PathBuf::from(root);
        if !root.is_dir() {
            ctx.report.skipped.push(format!("{} (not a folder)", root.display()));
            continue;
        }
        // Windows treats `/` and `\\` alike; keep one spelling so paths we report are consistent.
        #[cfg(windows)]
        let root = PathBuf::from(root.to_string_lossy().replace('/', "\\"));
        if opts.skip_reparse && has_link_ancestor(&root) {
            ctx.report.skipped.push(format!("{} (junction or symbolic link)", root.display()));
            continue;
        }
        if opts.skip_protected && crate::protect::is_protected_resolved(&root) {
            ctx.report.skipped.push(format!("{} (protected location: turn off \"Skip protected locations\" to scan it)", root.display()));
            continue;
        }
        visit(&mut ctx, &root, 0, true);
    }
    ctx.report.cancelled = cancel.load(Ordering::Relaxed);
    ctx.report.folders.sort_by_cached_key(|f| f.path.to_lowercase());
    ctx.report.folders.dedup_by(|a, b| a.path == b.path);
    ctx.report
}

/// Windows junctions, mount points and cloud placeholders are reparse points. `DirEntry::metadata`
/// reads the attributes straight from the directory listing (no extra syscall) and does not
/// follow the link, so this is both cheap and safe.
#[cfg(windows)]
pub(crate) fn is_link(meta: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    meta.file_attributes() & 0x400 != 0
}
#[cfg(not(windows))]
pub(crate) fn is_link(meta: &fs::Metadata) -> bool {
    meta.is_symlink()
}

pub(crate) fn has_link_ancestor(path: &Path) -> bool {
    path.ancestors().any(|part| fs::symlink_metadata(part).is_ok_and(|m| is_link(&m)))
}

#[cfg(windows)]
fn is_reparse(entry: &fs::DirEntry) -> bool {
    entry.metadata().is_ok_and(|m| is_link(&m))
}
#[cfg(not(windows))]
fn is_reparse(_: &fs::DirEntry) -> bool {
    false
}

/// (hidden, system) for a directory entry. On Windows these are file attributes read from the
/// directory listing (free); elsewhere "hidden" means a leading dot.
#[cfg(windows)]
fn dir_flags(e: &fs::DirEntry, _name: &str) -> (bool, bool) {
    use std::os::windows::fs::MetadataExt;
    e.metadata().map(|m| { let a = m.file_attributes(); (a & 0x2 != 0, a & 0x4 != 0) }).unwrap_or((false, false))
}
#[cfg(not(windows))]
fn dir_flags(_: &fs::DirEntry, name: &str) -> (bool, bool) {
    (name.starts_with('.'), false)
}

/// Returns Some(direct) when `dir` is empty (and therefore deletable), None otherwise.
/// Every empty folder found is pushed to the report.
fn visit(ctx: &mut Ctx, dir: &Path, depth: u32, is_root: bool) -> Option<bool> {
    if ctx.cancel.load(Ordering::Relaxed) {
        return None;
    }
    if !ctx.opts.skip_reparse {
        let canon = fs::canonicalize(dir).ok()?;
        if (ctx.opts.skip_protected && crate::protect::is_protected(&canon)) || !ctx.visited.insert(canon) {
            return None;
        }
    }
    tick(ctx, dir);

    let rd = match fs::read_dir(dir) {
        Ok(r) => r,
        Err(e) => {
            ctx.report.skipped.push(format!("{} ({e})", dir.display()));
            return None; // unreadable: never assume empty
        }
    };

    let mut has_content = false;
    let mut had_empty_children = false;
    for entry in rd {
        if ctx.cancel.load(Ordering::Relaxed) {
            return None;
        }
        let Ok(entry) = entry else {
            has_content = true; // an entry we could not read might be anything
            continue;
        };
        let Ok(ft) = entry.file_type() else {
            has_content = true;
            continue;
        };
        if has_content && !ft.is_dir() && !ft.is_symlink() {
            continue; // already not empty: another plain file changes nothing (and needs no junk matching)
        }
        let path = entry.path();
        let os_name = entry.file_name();
        let link = ft.is_symlink() || is_reparse(&entry);
        // Only a real symlink can point at a directory without saying so; this avoids a stat for
        // every cloud placeholder file.
        let is_dir = ft.is_dir() || (ft.is_symlink() && path.is_dir());

        if !is_dir {
            if ft.is_file() && !link && is_junk(ctx.opts, &os_name.to_string_lossy()) {
                continue;
            }
            has_content = true;
            continue;
        }
        let name = os_name.to_string_lossy().into_owned();
        // Anything we are told not to touch is left alone, and so is its parent: a folder holding
        // something we skipped is not empty.
        let (hidden, system) = dir_flags(&entry, &name);
        if (ctx.opts.skip_hidden && hidden)
            || (ctx.opts.skip_system && system)
            || (ctx.opts.skip_protected && crate::protect::is_protected(&path))
        {
            has_content = true;
            continue;
        }
        if link && ctx.opts.skip_reparse {
            has_content = true;
            continue;
        }
        let excluded = ctx.opts.exclude_patterns.iter().any(|p| wildcard(p, &name));
        let too_deep = ctx.opts.max_depth > 0 && depth + 1 > ctx.opts.max_depth;
        if excluded || too_deep {
            has_content = true; // not examined, so it must be assumed to hold something
            continue;
        }
        let child = if ctx.opts.recurse {
            visit(ctx, &path, depth + 1, false)
        } else if leaf_empty(ctx, &path) {
            push(ctx, &path, true, depth + 1).then_some(true)
        } else {
            None
        };
        match child {
            Some(_) => had_empty_children = true,
            None => has_content = true,
        }
    }
    if has_content || ctx.cancel.load(Ordering::Relaxed) {
        return None;
    }
    if had_empty_children && !ctx.opts.nested_empty {
        return None;
    }
    let direct = !had_empty_children;
    if is_root && !ctx.opts.include_root {
        return Some(direct);
    }
    push(ctx, dir, direct, depth).then_some(direct)
}

fn is_junk(opts: &ScanOptions, name: &str) -> bool {
    opts.ignore_junk && opts.junk_patterns.iter().any(|p| valid_junk_pattern(p) && wildcard(p, name))
}

fn tick(ctx: &mut Ctx, dir: &Path) {
    ctx.report.scanned += 1;
    let n = ctx.report.scanned;
    (ctx.on_progress)(dir, n);
}

/// Non-recursive mode: a direct child is empty only if it holds nothing but junk files.
fn leaf_empty(ctx: &mut Ctx, dir: &Path) -> bool {
    if !ctx.opts.skip_reparse {
        let Ok(canon) = fs::canonicalize(dir) else { return false };
        if (ctx.opts.skip_protected && crate::protect::is_protected(&canon)) || !ctx.visited.insert(canon) {
            return false;
        }
    }
    tick(ctx, dir);
    let Ok(rd) = fs::read_dir(dir) else { return false };
    for e in rd {
        if ctx.cancel.load(Ordering::Relaxed) {
            return false;
        }
        let Ok(e) = e else { return false };
        let is_file = e.file_type().is_ok_and(|t| t.is_file()) && !is_reparse(&e);
        if !(is_file && is_junk(ctx.opts, &e.file_name().to_string_lossy())) {
            return false;
        }
    }
    true
}

/// Records the folder unless it is too recent. Returns whether it was recorded.
fn push(ctx: &mut Ctx, dir: &Path, direct: bool, depth: u32) -> bool {
    let modified = fs::metadata(dir).and_then(|m| m.modified()).ok();
    if let (Some(cut), Some(m)) = (ctx.cutoff, modified) {
        if m > cut {
            return false;
        }
    }
    let secs = modified
        .and_then(|m| m.duration_since(SystemTime::UNIX_EPOCH).ok())
        .map(|d| d.as_secs());
    ctx.report.folders.push(EmptyFolder {
        path: dir.to_string_lossy().into_owned(),
        direct,
        depth,
        modified: secs,
    });
    true
}
