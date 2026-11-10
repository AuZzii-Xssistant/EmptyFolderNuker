## Empty Folder Nuker v1.0.0 – Initial Release

First public release of Empty Folder Nuker, a portable Windows utility that finds and removes empty folders. It scans a folder you choose, shows what it found, and lets you decide what to remove.

### Highlights

- **Flexible scanning:** browse, paste a path, or drag a folder onto the window. Optionally include subfolders and folders that contain only empty subfolders.
- **Review before deleting:** filter results, uncheck anything you want to keep, or use **Rescan** to run the same search again. See any locations the scan skipped.
- **Safe by default:** deletes go to the Recycle Bin unless you choose Permanently. The app rechecks folders before removal and keeps folders where it finds new, changed, or in-use files.
- **Skip rules and junk-file handling:** choose which folders to skip and whether known junk files count as content.
- **Link-safe:** you can opt in to scanning through links. Deletion leaves linked locations alone.
- **Explorer integration:** enable the right-click menu for **Find empty folders** on folders, drive roots, and blank areas. On Windows 11, look under **Show more options**.
- **Auto-update of the saved copy:** close the running app and open a newer download to refresh the copy in `%LOCALAPPDATA%\EmptyFolderNuker`.
- **One window by default:** Explorer scan requests reuse the open window. Enable **Allow multiple instances** in Settings to open separate windows.
- **CLI flags:** `--scan <folder>`, `--enable-context-menu`, `--disable-context-menu`, `--help`, `--version`.

### Download

Download **EmptyFolderNuker.exe** below and run the portable executable.

SHA-256: `@SHA256@`

### Requirements

- Windows 10 or 11 (64-bit)
- Microsoft Edge WebView2 Runtime

### Note

The executable is unsigned, so Windows SmartScreen may warn on first run.

### Feedback

Found a bug or have an idea? Please [open an issue](https://github.com/AuZzii-Xssistant/EmptyFolderNuker/issues/).
