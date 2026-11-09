//! Command line. Accepts the old WinTools switches (-h -i -u -V), the v1.3 style bare
//! folder argument, and the long forms used by the Explorer verb.

#[derive(Debug, Default, PartialEq, Eq)]
pub struct Cli {
    pub help: bool,
    pub version: bool,
    pub install_shell: bool,
    pub uninstall_shell: bool,
    /// Start scanning immediately.
    pub scan: bool,
    pub folders: Vec<String>,
    /// Options starting with `-` that we do not know (a typo must not be treated as a folder name).
    pub unknown: Vec<String>,
}

pub const USAGE: &str = "Usage: EmptyFolderNuker [options] [folder ...]\n\
  -h, --help        show this message\n\
  -V, --version     show the version\n\
  -i, --enable-context-menu   enable the Explorer context menu\n\
  -u, --disable-context-menu  disable the Explorer context menu\n\
  -s, --scan        scan the given folders immediately\n\
A folder given with no options is scanned immediately.";

pub fn parse<I: IntoIterator<Item = String>>(args: I) -> Cli {
    let mut c = Cli::default();
    for a in args {
        match a.as_str() {
            "-h" | "--help" | "/?" => c.help = true,
            "-V" | "--version" => c.version = true,
            "-i" | "--install" | "--enable-context-menu" => c.install_shell = true,
            "-u" | "--uninstall" | "--disable-context-menu" => c.uninstall_shell = true,
            "-s" | "--scan" => c.scan = true,
            s if s.starts_with('-') && s.len() > 1 => c.unknown.push(a.clone()),
            _ => c.folders.push(normalise(&a)),
        }
    }
    if !c.folders.is_empty() {
        c.scan = true;
    }
    c
}

/// Explorer hands over `C:\` or, when a trailing backslash escaped the quote, `C:"`.
fn normalise(a: &str) -> String {
    let a = a.trim_matches('"');
    if a.len() == 2 && a.ends_with(':') {
        return format!("{a}\\");
    }
    a.to_string()
}
