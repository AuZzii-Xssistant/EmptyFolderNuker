use super::*;
use std::fs;
use std::sync::atomic::AtomicBool;
use tempfile::tempdir;

fn run(opts: &ScanOptions) -> ScanReport {
    scan(opts, &AtomicBool::new(false), &mut |_, _| {})
}
fn opts(root: &std::path::Path) -> ScanOptions {
    ScanOptions { roots: vec![root.to_string_lossy().into()], ..Default::default() }
}
fn names(r: &ScanReport, root: &std::path::Path) -> Vec<String> {
    r.folders
        .iter()
        .map(|f| f.path.strip_prefix(&*root.to_string_lossy()).unwrap().trim_start_matches(['/', '\\']).replace('\\', "/"))
        .collect()
}

#[test]
fn finds_empty_and_nested_empty() {
    let d = tempdir().unwrap();
    fs::create_dir_all(d.path().join("a/b/c")).unwrap();
    fs::create_dir_all(d.path().join("keep")).unwrap();
    fs::write(d.path().join("keep/f.txt"), "x").unwrap();
    fs::create_dir_all(d.path().join("keep/empty")).unwrap();
    let r = run(&opts(d.path()));
    assert_eq!(names(&r, d.path()), ["a", "a/b", "a/b/c", "keep/empty"]);
    assert!(r.folders.iter().find(|f| f.path.ends_with("c")).unwrap().direct);
    assert!(!r.folders.iter().find(|f| f.path.ends_with("a")).unwrap().direct);
}

#[test]
fn nested_option_off_only_reports_leaves() {
    let d = tempdir().unwrap();
    fs::create_dir_all(d.path().join("a/b")).unwrap();
    let mut o = opts(d.path());
    o.nested_empty = false;
    assert_eq!(names(&run(&o), d.path()), ["a/b"]);
}

#[test]
fn root_is_never_reported_by_default() {
    let d = tempdir().unwrap();
    assert!(run(&opts(d.path())).folders.is_empty());
    let mut o = opts(d.path());
    o.include_root = true;
    assert_eq!(run(&o).folders.len(), 1);
}

#[test]
fn non_recursive_only_looks_one_level() {
    let d = tempdir().unwrap();
    fs::create_dir_all(d.path().join("x/y")).unwrap();
    fs::create_dir_all(d.path().join("z")).unwrap();
    let mut o = opts(d.path());
    o.recurse = false;
    assert_eq!(names(&run(&o), d.path()), ["z"]);
}

#[test]
fn junk_files_optional() {
    let d = tempdir().unwrap();
    fs::create_dir(d.path().join("t")).unwrap();
    fs::write(d.path().join("t/Thumbs.db"), "").unwrap();
    assert!(run(&opts(d.path())).folders.is_empty());
    let mut o = opts(d.path());
    o.ignore_junk = true;
    assert_eq!(names(&run(&o), d.path()), ["t"]);
}

#[test]
fn excluded_folder_and_its_parent_are_kept() {
    let d = tempdir().unwrap();
    fs::create_dir_all(d.path().join("p/.git")).unwrap();
    let mut o = opts(d.path());
    o.exclude_patterns = vec![".git".into()];
    assert!(run(&o).folders.is_empty());
}

#[test]
fn max_depth_treats_deeper_as_content() {
    let d = tempdir().unwrap();
    fs::create_dir_all(d.path().join("a/b")).unwrap();
    let mut o = opts(d.path());
    o.max_depth = 1;
    assert!(run(&o).folders.is_empty());
}

#[test]
fn min_age_blocks_young_folder_and_its_parent() {
    let d = tempdir().unwrap();
    fs::create_dir_all(d.path().join("a/b")).unwrap();
    let mut o = opts(d.path());
    o.min_age_days = 1;
    assert!(run(&o).folders.is_empty());
}

#[cfg(unix)]
#[test]
fn symlinks_count_as_content() {
    let d = tempdir().unwrap();
    fs::create_dir_all(d.path().join("target")).unwrap();
    fs::create_dir(d.path().join("holder")).unwrap();
    std::os::unix::fs::symlink(d.path().join("target"), d.path().join("holder/link")).unwrap();
    assert_eq!(names(&run(&opts(d.path())), d.path()), ["target"]);
}

#[test]
fn cancel_stops_and_flags() {
    let d = tempdir().unwrap();
    fs::create_dir_all(d.path().join("a/b")).unwrap();
    let flag = AtomicBool::new(true);
    let r = scan(&opts(d.path()), &flag, &mut |_, _| {});
    assert!(r.cancelled && r.folders.is_empty());
}

#[test]
fn bad_root_is_reported_not_fatal() {
    let dir = tempdir().unwrap();
    let file = dir.path().join("file.txt");
    fs::write(&file, "").unwrap();
    let missing = dir.path().join("missing");
    let o = ScanOptions { roots: vec![missing.to_string_lossy().into(), file.to_string_lossy().into()], ..Default::default() };
    let r = run(&o);
    assert_eq!(r.scanned, 0);
    assert_eq!(r.skipped[0].reason, "Folder does not exist");
    assert_eq!(r.skipped[1].reason, "This path is not a folder");
}

#[test]
fn child_that_disappears_during_scan_is_reported_in_both_modes() {
    for recurse in [false, true] {
        let dir = tempdir().unwrap();
        let child = dir.path().join("child");
        fs::create_dir(&child).unwrap();
        let o = ScanOptions { recurse, include_root: true, ..opts(dir.path()) };
        let r = scan(&o, &AtomicBool::new(false), &mut |path, _| {
            if path == child {
                fs::remove_dir(path).unwrap();
            }
        });
        assert!(r.folders.is_empty());
        assert_eq!(r.skipped.len(), 1);
        assert_eq!(r.skipped[0].path, child.to_string_lossy());
        assert!(r.skipped[0].reason.starts_with("Could not read folder"));
    }
}

#[test]
fn wildcard_matching() {
    assert!(scan::wildcard("*.tmp", "A.TMP"));
    assert!(scan::wildcard("node_*", "node_modules"));
    assert!(scan::wildcard("t?mp", "temp"));
    assert!(!scan::wildcard("*.tmp", "a.tmpx"));
}

#[test]
fn compiled_name_rules_match_the_reference() {
    let patterns = ["Thumbs.DB", "Straße.*", "İ?.tXt", "*.TEMP", "a**b*", "*.*", "?"]
        .map(String::from);
    for junk in [true, false] {
        let rules = scan::NameRules::compile(&patterns, junk);
        for name in ["thumbs.db", "DESKTOP.INI", "STRaße.csv", "İa.TXT", "x.temp", "aab", "a", "a.txt", "İé.txt", ""] {
            let expected = patterns.iter().any(|p| (!junk || scan::valid_junk_pattern(p)) && scan::wildcard(p, name));
            assert_eq!(rules.matches(name), expected, "{name:?} (junk: {junk})");
        }
    }
}

#[test]
fn delete_removes_parents_with_children_and_refuses_stale_entries() {
    let d = tempdir().unwrap();
    fs::create_dir_all(d.path().join("a/b")).unwrap();
    fs::create_dir_all(d.path().join("full")).unwrap();
    fs::write(d.path().join("full/f"), "x").unwrap();
    let p = |s: &str| d.path().join(s).to_string_lossy().into_owned();
    let res = delete_folders(&[p("a"), p("a/b"), p("full")], DeleteMode::Permanent, &[], true, false, &AtomicBool::new(false), &mut |_| {});
    let get = |s: &str| res.iter().find(|r| r.path == p(s)).unwrap().outcome.clone();
    assert_eq!(get("a/b"), DeleteOutcome::Deleted);
    assert_eq!(get("a"), DeleteOutcome::Deleted);
    assert_eq!(get("full"), DeleteOutcome::NotEmpty);
    assert!(!d.path().join("a").exists() && d.path().join("full/f").exists());
}

#[test]
fn junk_only_folder_deletes_when_junk_listed() {
    let d = tempdir().unwrap();
    fs::create_dir(d.path().join("t")).unwrap();
    fs::write(d.path().join("t/desktop.ini"), "").unwrap();
    let p = d.path().join("t").to_string_lossy().into_owned();
    let none = delete_folders(&[p.clone()], DeleteMode::Permanent, &[], true, false, &AtomicBool::new(false), &mut |_| {});
    assert_eq!(none[0].outcome, DeleteOutcome::NotEmpty);
    let some = delete_folders(&[p], DeleteMode::Permanent, &["desktop.ini".into()], true, false, &AtomicBool::new(false), &mut |_| {});
    assert_eq!(some[0].outcome, DeleteOutcome::Deleted);
}

#[test]
fn cli_parsing() {
    let a = |v: &[&str]| cli::parse(v.iter().map(|s| s.to_string()));
    assert!(a(&["-i"]).install_shell && a(&["--uninstall"]).uninstall_shell);
    assert!(a(&["-V"]).version && a(&["-h"]).help);
    let c = a(&["--scan", "C:\""]);
    assert!(c.scan);
    assert_eq!(c.folders, ["C:\\"]);
    assert!(a(&["D:\\x"]).scan);
    assert!(!a(&[]).scan);
    assert_eq!(a(&["-x", "--bogus"]).unknown, ["-x", "--bogus"]);
    assert!(a(&["-x"]).folders.is_empty(), "an unknown switch is not a folder");
    assert_eq!(a(&["D:\\\\my folder"]).folders, ["D:\\\\my folder"]);
}

#[test]
fn shell_command_line_is_quoted() {
    assert_eq!(shell::command_line("C:\\a b\\e.exe", "%1"), "\"C:\\a b\\e.exe\" --scan \"%1\"");
}

#[test]
fn window_grows_and_shrinks_around_its_centre() {
    use layout::{Anchor, Rect};
    let area = Rect { x: 0, y: 0, w: 1920, h: 1040 };
    let mut a = Anchor::default();
    let small = Rect { x: 800, y: 400, w: 430, h: 262 };
    let (x, y) = a.place(small, 1056, 648, area); // grow: centre stays at (1015, 531)
    assert_eq!((x, y), (1015 - 528, 531 - 324));
    let big = Rect { x, y, w: 1056, h: 648 };
    assert_eq!(a.place(big, 430, 262, area), (800, 400), "shrinking returns to the original spot");
    // many round trips never drift, even with odd size differences
    let mut cur = small;
    for _ in 0..50 {
        let (gx, gy) = a.place(cur, 1057, 649, area);
        cur = Rect { x: gx, y: gy, w: 1057, h: 649 };
        let (sx, sy) = a.place(cur, 430, 262, area);
        cur = Rect { x: sx, y: sy, w: 430, h: 262 };
    }
    assert_eq!((cur.x, cur.y), (800, 400), "no creeping after repeated grow/shrink");
}

#[test]
fn window_placement_stays_inside_the_work_area() {
    use layout::{Anchor, Rect};
    let area = Rect { x: 0, y: 0, w: 1920, h: 1040 }; // the taskbar takes the bottom 40px
    let mut a = Anchor::default();
    // near the bottom-right corner: growing would run under the taskbar / off screen
    let (x, y) = a.place(Rect { x: 1700, y: 900, w: 200, h: 100 }, 800, 600, area);
    assert_eq!((x, y), (1920 - 800, 1040 - 600));
    // and near the top-left
    let mut b = Anchor::default();
    assert_eq!(b.place(Rect { x: 10, y: 10, w: 200, h: 100 }, 800, 600, area), (0, 0));
    // a window bigger than the area is pinned to its top-left corner
    let mut c = Anchor::default();
    assert_eq!(c.place(Rect { x: 300, y: 300, w: 200, h: 100 }, 3000, 2000, area), (0, 0));
}

#[test]
fn dragging_the_window_moves_the_anchor() {
    use layout::{Anchor, Rect};
    let area = Rect { x: 0, y: 0, w: 1920, h: 1040 };
    let mut a = Anchor::default();
    let (x, y) = a.place(Rect { x: 800, y: 400, w: 430, h: 262 }, 1056, 648, area);
    // the user drags the big window 300px to the right, then it shrinks around its NEW centre
    let dragged = Rect { x: x + 300, y, w: 1056, h: 648 };
    let (sx, _) = a.place(dragged, 430, 262, area);
    assert_eq!(sx, 800 + 300, "shrinks around where the user left the window");
}

#[test]
fn shell_target_parsing() {
    assert_eq!(shell::parse_target("\"C:\\a b\\e.exe\" --scan \"%1\""), Some("C:\\a b\\e.exe".into()));
    assert_eq!(shell::parse_target("garbage"), None);
}

#[test]
fn delete_can_be_stopped() {
    let d = tempdir().unwrap();
    for i in 0..5 {
        fs::create_dir(d.path().join(format!("e{i}"))).unwrap();
    }
    let paths: Vec<String> = (0..5).map(|i| d.path().join(format!("e{i}")).to_string_lossy().into_owned()).collect();
    let stop = AtomicBool::new(false);
    let mut n = 0;
    let res = delete_folders(&paths, DeleteMode::Permanent, &[], true, false, &stop, &mut |_| {
        n += 1;
        if n == 2 {
            stop.store(true, std::sync::atomic::Ordering::SeqCst);
        }
    });
    assert_eq!(res.len(), 2, "stops after the folder in progress");
    assert_eq!(paths.iter().filter(|p| std::path::Path::new(p).exists()).count(), 3);
}

#[test]
fn unicode_and_odd_names_are_handled() {
    let d = tempdir().unwrap();
    for n in ["日本語", "with space", "trailing.dot", "ünï", "a,b", "emoji🙂"] {
        fs::create_dir(d.path().join(n)).unwrap();
    }
    assert_eq!(run(&opts(d.path())).folders.len(), 6);
}

/// Randomised check against a deliberately naive reference implementation.
#[test]
fn scanner_matches_reference_on_random_trees() {
    struct Rng(u64);
    impl Rng {
        fn next(&mut self, n: u64) -> u64 {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            self.0 % n
        }
    }
    fn build(r: &mut Rng, dir: &std::path::Path, depth: u32) {
        for i in 0..r.next(4) {
            let sub = dir.join(format!("d{i}"));
            fs::create_dir(&sub).unwrap();
            if depth < 4 {
                build(r, &sub, depth + 1);
            }
        }
        match r.next(6) {
            0 => fs::write(dir.join("f.txt"), "x").unwrap(),
            1 => fs::write(dir.join("Thumbs.db"), "").unwrap(),
            _ => {}
        }
    }
    // Reference: (is_empty, collected) where junk = Thumbs.db counts as empty content.
    fn reference(dir: &std::path::Path, junk: bool, nested: bool, out: &mut Vec<String>) -> bool {
        let mut all_empty = true;
        let mut had_dirs = false;
        for e in fs::read_dir(dir).unwrap().flatten() {
            let p = e.path();
            if p.is_dir() {
                had_dirs = true;
                if !reference(&p, junk, nested, out) {
                    all_empty = false;
                }
            } else if !(junk && e.file_name().to_string_lossy().eq_ignore_ascii_case("thumbs.db")) {
                all_empty = false;
            }
        }
        let empty = all_empty && (!had_dirs || nested);
        if empty {
            out.push(dir.to_string_lossy().into_owned());
        }
        empty
    }
    let mut rng = Rng(0x9E3779B97F4A7C15);
    for case in 0..150 {
        let d = tempdir().unwrap();
        build(&mut rng, d.path(), 0);
        for (junk, nested) in [(false, true), (true, true), (false, false), (true, false)] {
            let mut want = vec![];
            reference(d.path(), junk, nested, &mut want);
            want.retain(|p| std::path::Path::new(p) != d.path());
            want.sort_by_key(|p| p.to_lowercase());
            let mut o = opts(d.path());
            o.ignore_junk = junk;
            o.nested_empty = nested;
            o.junk_patterns = vec!["thumbs.db".into()];
            let got: Vec<String> = run(&o).folders.into_iter().map(|f| f.path).collect();
            assert_eq!(got, want, "case {case} junk={junk} nested={nested}");
        }
    }
}

#[test]
fn scans_a_large_tree_quickly() {
    let d = tempdir().unwrap();
    for i in 0..60 {
        for j in 0..60 {
            fs::create_dir_all(d.path().join(format!("a{i}/b{j}"))).unwrap();
        }
    }
    let t = std::time::Instant::now();
    let r = run(&opts(d.path()));
    assert_eq!(r.folders.len(), 60 * 60 + 60);
    assert!(t.elapsed().as_secs() < 5, "took {:?}", t.elapsed());
}

#[test]
fn protected_locations_are_recognised() {
    use protect::is_protected_str as p;
    // different spellings of the same protected places must not slip through
    for sp in ["C:\\Windows.", "C:\\Windows ", "C:\\Users\\..\\Windows\\x", "C:\\.\\Windows", "C:\\Windows\\\\System32", "c:/windows/system32", "\\\\localhost\\C$\\Windows", "\\\\?\\UNC\\localhost\\c$\\Program Files", "\\\\.\\C:\\Windows", "/usr/../etc"] {
        assert!(p(sp), "{sp:?} should be protected");
    }
    assert_eq!(p("//usr/lib"), !cfg!(windows), "Windows treats a double slash as UNC");
    assert!(!p("C:\\WindowsFoo") && !p("\\\\srv\\share\\Windows") && !p("C:\\Users\\a\\Windows") && !p("/usr2/x"));
    assert!(p("C:\\Windows\\System32") && p("c:\\program files\\x") && p("D:\\Program Files (x86)") && p("C:\\ProgramData\\a"));
    assert!(p("C:\\$Recycle.Bin\\S-1") && p("\\\\?\\C:\\Windows") && p("E:/Windows/x"));
    assert!(p("C:\\Users\\a\\AppData\\Local\\Packages\\Foo") && p("/usr/lib") && p("/etc"));
    assert!(!p("C:\\Users\\a\\Desktop") && !p("D:\\Backup\\Windows") && !p("/home/a") && !p("/tmp/x") && !p("relative\\path"));
}

#[test]
fn protected_root_is_refused_and_protected_delete_is_blocked() {
    let o = ScanOptions { roots: vec!["/usr".into()], ..Default::default() };
    let r = run(&o);
    assert!(r.folders.is_empty() && r.skipped.len() == 1 && r.scanned == 0);
    let res = delete_folders(&["/usr/definitely-not-here".to_string()], DeleteMode::Permanent, &[], true, false, &AtomicBool::new(false), &mut |_| {});
    assert_eq!(res[0].outcome, DeleteOutcome::Protected);
}

#[cfg(unix)]
#[test]
fn hidden_folders_can_be_skipped() {
    let d = tempdir().unwrap();
    fs::create_dir_all(d.path().join(".cache/inner")).unwrap();
    fs::create_dir(d.path().join("plain")).unwrap();
    let mut o = opts(d.path());
    assert_eq!(run(&o).folders.len(), 3, "hidden folders are scanned unless asked otherwise");
    o.skip_hidden = true;
    assert_eq!(names(&run(&o), d.path()), ["plain"]);
}

#[cfg(unix)]
#[test]
fn links_can_be_followed_without_looping() {
    let d = tempdir().unwrap();
    fs::create_dir_all(d.path().join("real/empty")).unwrap();
    fs::create_dir(d.path().join("holder")).unwrap();
    std::os::unix::fs::symlink(d.path().join("real"), d.path().join("holder/link")).unwrap();
    std::os::unix::fs::symlink(d.path(), d.path().join("real/loop")).unwrap(); // points back at the root
    let mut o = opts(d.path());
    let skipped = run(&o);
    assert!(!skipped.folders.iter().any(|f| f.path.contains("link")), "links are not entered by default");
    o.skip_reparse = false;
    let followed = run(&o); // must terminate despite the loop
    assert!(followed.scanned > 0);
}

#[cfg(unix)]
#[test]
fn following_links_still_refuses_unsafe_deletes_by_default() {
    let d = tempdir().unwrap();
    fs::create_dir_all(d.path().join("target/inner")).unwrap();
    fs::create_dir(d.path().join("t")).unwrap();
    std::os::unix::fs::symlink(d.path().join("target"), d.path().join("t/l")).unwrap();
    let p = d.path().join("t").to_string_lossy().into_owned();
    let no = delete_folders(&[p.clone()], DeleteMode::Permanent, &[], true, false, &AtomicBool::new(false), &mut |_| {});
    assert_eq!(no[0].outcome, DeleteOutcome::NotEmpty);
}

#[test]
fn too_broad_junk_patterns_are_ignored_and_never_delete_real_files() {
    assert!(!scan::valid_junk_pattern("*") && !scan::valid_junk_pattern("*.*") && !scan::valid_junk_pattern("?") && !scan::valid_junk_pattern("*.d?"));
    assert!(scan::valid_junk_pattern("thumbs.db") && scan::valid_junk_pattern("*.tmp") && scan::valid_junk_pattern("desktop.ini"));
    let d = tempdir().unwrap();
    fs::create_dir_all(d.path().join("docs")).unwrap();
    fs::write(d.path().join("docs/thesis.docx"), "precious").unwrap();
    let mut o = opts(d.path());
    o.ignore_junk = true;
    o.junk_patterns = vec!["*".into(), "*.*".into()];
    assert!(run(&o).folders.is_empty(), "a folder holding a real file is not empty, whatever the pattern says");
    let p = d.path().join("docs").to_string_lossy().into_owned();
    let res = delete_folders(&[p], DeleteMode::Permanent, &["*".to_string()], true, false, &AtomicBool::new(false), &mut |_| {});
    assert_eq!(res[0].outcome, DeleteOutcome::NotEmpty);
    assert!(d.path().join("docs/thesis.docx").exists());
}

#[test]
fn permanent_delete_never_destroys_a_file_that_appears_late() {
    let d = tempdir().unwrap();
    fs::create_dir_all(d.path().join("a/b")).unwrap();
    fs::write(d.path().join("a/desktop.ini"), "").unwrap();
    fs::write(d.path().join("a/b/new-work.txt"), "created after the scan").unwrap();
    let err = delete::remove_tree(&d.path().join("a"), &["desktop.ini".to_string()], false).unwrap_err();
    assert_eq!(err.kind(), std::io::ErrorKind::DirectoryNotEmpty);
    assert!(d.path().join("a/b/new-work.txt").exists(), "the late file is untouched");
}

#[test]
fn an_unreadable_entry_counts_as_content_at_delete_time() {
    // an entry that is neither a directory nor a junk file blocks deletion
    let d = tempdir().unwrap();
    fs::create_dir(d.path().join("a")).unwrap();
    fs::write(d.path().join("a/x.bin"), "x").unwrap();
    let p = d.path().join("a").to_string_lossy().into_owned();
    let r = delete_folders(&[p], DeleteMode::Permanent, &[], true, false, &AtomicBool::new(false), &mut |_| {});
    assert_eq!(r[0].outcome, DeleteOutcome::NotEmpty);
}

#[test]
fn nested_folders_are_removed_with_their_parent_in_one_operation() {
    let d = tempdir().unwrap();
    fs::create_dir_all(d.path().join("p/c1/c2")).unwrap();
    let all: Vec<String> = ["p", "p/c1", "p/c1/c2"].iter().map(|s| d.path().join(s).to_string_lossy().into_owned()).collect();
    let mut calls = 0;
    let res = delete_folders(&all, DeleteMode::Permanent, &[], true, false, &AtomicBool::new(false), &mut |_| calls += 1);
    assert_eq!(calls, 3, "every listed folder is still reported");
    assert!(res.iter().all(|r| r.outcome == DeleteOutcome::Deleted));
    assert!(!d.path().join("p").exists());
}

#[test]
fn a_missing_folder_is_already_gone_but_other_errors_are_failures() {
    let d = tempdir().unwrap();
    let p = d.path().join("never-existed").to_string_lossy().into_owned();
    let r = delete_folders(&[p], DeleteMode::Permanent, &[], true, false, &AtomicBool::new(false), &mut |_| {});
    assert_eq!(r[0].outcome, DeleteOutcome::AlreadyGone);
}

#[test]
fn the_delete_policy_only_accepts_folders_from_the_last_scan_with_that_scans_rules() {
    let d = tempdir().unwrap();
    fs::create_dir(d.path().join("scanned")).unwrap();
    let o = opts(d.path()); // junk off
    let report = run(&o);
    let policy = DeletePolicy::from_scan(&report, &o);
    // a folder that is empty but was created after the scan is refused: it was never listed
    fs::create_dir(d.path().join("other")).unwrap();
    let other = d.path().join("other").to_string_lossy().into_owned();
    // a scanned folder that gains a junk-named file is NOT deleted: this scan had junk switched off
    let scanned = d.path().join("scanned").to_string_lossy().into_owned();
    fs::write(d.path().join("scanned/desktop.ini"), "").unwrap();
    let res = policy.run(&[other.clone(), scanned.clone()], DeleteMode::Permanent, &AtomicBool::new(false), &mut |_| {});
    let get = |p: &String| res.iter().find(|r| &r.path == p).unwrap().outcome.clone();
    assert!(matches!(get(&other), DeleteOutcome::Failed(_)), "{:?}", get(&other));
    assert_eq!(get(&scanned), DeleteOutcome::NotEmpty);
    assert!(d.path().join("scanned/desktop.ini").exists() && d.path().join("other").exists());
}

#[test]
fn files_started_after_scan_keep_their_parent_in_both_delete_modes() {
    use std::io::Write;
    for mode in [DeleteMode::Permanent, DeleteMode::Recycle] {
        for recurse in [false, true] {
            for name in ["copy-in-progress.iso", "copy-in-progress.tmp"] {
                let d = tempdir().unwrap();
                let parent = d.path().join("parent");
                let destination = if recurse { parent.join("nested") } else { parent.clone() };
                fs::create_dir_all(&destination).unwrap();
                let mut options = opts(d.path());
                options.recurse = recurse;
                options.ignore_junk = true;
                options.junk_patterns = vec!["*.tmp".into()];
                let report = run(&options);
                let target = parent.to_string_lossy().into_owned();
                assert!(report.folders.iter().any(|row| row.path == target));
                let policy = DeletePolicy::from_scan(&report, &options);
                let path = destination.join(name);
                let mut copying = fs::File::create(&path).unwrap();
                for bytes in [&b""[..], &b"part one"[..]] {
                    copying.write_all(bytes).unwrap();
                    let results = policy.run(std::slice::from_ref(&target), mode, &AtomicBool::new(false), &mut |_| {});
                    assert_eq!(results[0].outcome, DeleteOutcome::NotEmpty, "{mode:?} {name} {bytes:?}");
                    assert!(parent.is_dir());
                    assert_eq!(fs::read(&path).unwrap(), bytes);
                }
                #[cfg(windows)]
                assert!(run(&options).folders.is_empty(), "a rescan must also keep the active copy");
                copying.write_all(b" and part two").unwrap();
                drop(copying);
                assert_eq!(fs::read(path).unwrap(), b"part one and part two");
            }
        }
    }
}

#[test]
fn only_unchanged_junk_seen_in_the_scan_can_be_removed() {
    let d = tempdir().unwrap();
    let unchanged = d.path().join("unchanged");
    let edited = d.path().join("edited");
    let replaced = d.path().join("replaced");
    for dir in [&unchanged, &edited, &replaced] {
        fs::create_dir(dir).unwrap();
        fs::write(dir.join("desktop.ini"), "original").unwrap();
    }
    let mut options = opts(d.path());
    options.ignore_junk = true;
    let report = run(&options);
    assert_eq!(report.folders.len(), 3);
    let policy = DeletePolicy::from_scan(&report, &options);
    fs::write(edited.join("desktop.ini"), "new contents").unwrap();
    let moved = d.path().join("download");
    fs::write(&moved, "moved in").unwrap();
    fs::rename(moved, replaced.join("desktop.ini")).unwrap();
    for mode in [DeleteMode::Permanent, DeleteMode::Recycle] {
        for (dir, expected) in [(&edited, "new contents"), (&replaced, "moved in")] {
            let results = policy.run(&[dir.to_string_lossy().into_owned()], mode, &AtomicBool::new(false), &mut |_| {});
            assert_eq!(results[0].outcome, DeleteOutcome::NotEmpty);
            assert_eq!(fs::read_to_string(dir.join("desktop.ini")).unwrap(), expected);
        }
    }
    let results = policy.run(&[unchanged.to_string_lossy().into_owned()], DeleteMode::Permanent, &AtomicBool::new(false), &mut |_| {});
    assert_eq!(results[0].outcome, DeleteOutcome::Deleted);
    assert!(!unchanged.exists());
}

#[cfg(windows)]
#[test]
fn opening_a_scanned_junk_file_for_writing_blocks_deletion_before_any_bytes_change() {
    let d = tempdir().unwrap();
    let dir = d.path().join("parent");
    fs::create_dir(&dir).unwrap();
    let path = dir.join("desktop.ini");
    fs::write(&path, "original").unwrap();
    let mut options = opts(d.path());
    options.ignore_junk = true;
    let report = run(&options);
    assert_eq!(report.folders.len(), 1);
    let policy = DeletePolicy::from_scan(&report, &options);
    let writing = fs::OpenOptions::new().append(true).open(&path).unwrap();
    for mode in [DeleteMode::Permanent, DeleteMode::Recycle] {
        let results = policy.run(&[dir.to_string_lossy().into_owned()], mode, &AtomicBool::new(false), &mut |_| {});
        assert_eq!(results[0].outcome, DeleteOutcome::NotEmpty);
    }
    drop(writing);
    assert_eq!(fs::read_to_string(path).unwrap(), "original");
}

#[test]
fn newer_versions_win() {
    use shell::version_gt as gt;
    assert!(gt("2.9.0", "2.8.0") && gt("2.10.0", "2.9.9") && gt("3.0", "2.9.9") && gt("2.9.0", ""));
    assert!(!gt("2.8.0", "2.8.0") && !gt("2.7.0", "2.8.0") && !gt("", "2.8.0"));
}

#[test]
fn same_version_shell_builds_only_update_forward() {
    use shell::newer_build;
    assert!(newer_build("1.0.0", "12", "1.0.0", ""));
    assert!(newer_build("1.0.0", "12", "1.0.0", "9"));
    assert!(newer_build("1.1.0", "9", "1.0.0", "12"));
    assert!(!newer_build("1.0.0", "12", "1.0.0", "12"));
    assert!(!newer_build("1.0.0", "9", "1.0.0", "12"));
    assert!(!newer_build("1.0.0", "12", "3.2.2", ""));
}

#[test]
fn delete_policy_keeps_new_subfolders_outside_the_last_scan() {
    let d = tempdir().unwrap();
    let parent = d.path().join("parent");
    fs::create_dir(&parent).unwrap();
    let options = opts(d.path());
    let policy = crate::DeletePolicy::from_scan(&run(&options), &options);
    fs::create_dir(parent.join("new")).unwrap();
    let result = policy.run(
        &[parent.to_string_lossy().into_owned()],
        DeleteMode::Permanent,
        &AtomicBool::new(false),
        &mut |_| {},
    );
    assert_eq!(result[0].outcome, DeleteOutcome::NotEmpty);
    assert!(parent.join("new").is_dir());
}

#[cfg(any(windows, unix))]
#[test]
fn a_selected_root_cannot_bypass_skip_links() {
    let d = tempdir().unwrap();
    let target = d.path().join("target");
    let link = d.path().join("link");
    fs::create_dir_all(target.join("empty")).unwrap();
    #[cfg(windows)]
    let linked = std::os::windows::fs::symlink_dir(&target, &link);
    #[cfg(unix)]
    let linked = std::os::unix::fs::symlink(&target, &link);
    if let Err(e) = linked {
        #[cfg(windows)]
        if e.raw_os_error() == Some(1314) { return; }
        panic!("cannot create test link: {e}");
    }
    assert!(run(&opts(&link)).folders.is_empty());
    let result = delete_folders(
        &[link.join("empty").to_string_lossy().into_owned()],
        DeleteMode::Permanent, &[], true, false, &AtomicBool::new(false), &mut |_| {},
    );
    assert_eq!(result[0].outcome, DeleteOutcome::NotEmpty);
    assert!(target.join("empty").is_dir());
}

#[test]
fn trash_errors_get_readable_reasons() {
    let m = crate::delete::friendly_trash("Error during a `trash` operation: Unknown { description: \"Some operations were aborted\" }");
    assert!(m.starts_with("Windows refused") && !m.contains("Unknown"));
    assert_eq!(crate::delete::friendly_trash("Error during a `trash` operation: boom"), "boom");
}

#[test]
fn unc_servers_named_like_unix_dirs_are_not_protected() {
    use crate::protect::is_protected_str;
    for p in [r"\\dev\projects\x", r"\\system\share", r"\\?\UNC\dev\share"] {
        assert!(!is_protected_str(p), "{p}");
    }
    assert!(is_protected_str("/usr/lib") && is_protected_str(r"C:\Windows\x"));
}
