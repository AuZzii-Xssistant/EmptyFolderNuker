# Empty Folder Nuker

A portable Windows utility for finding and removing empty folders. It scans a folder you choose, shows what it found, and lets you decide which folders to remove.

## Download

Download [EmptyFolderNuker.exe](builds/EmptyFolderNuker.exe?raw=true) or open the [file on GitHub](builds/EmptyFolderNuker.exe). See [build information](builds/BUILDINFO.txt) for the version and SHA-256.

The app runs on Windows 10 and 11 with Microsoft Edge WebView2 Runtime. Run the portable executable directly.

## Find and remove empty folders

1. Browse for a base folder, paste its path, or drag a folder onto the window.
2. Choose whether to scan subfolders and count folders containing only empty subfolders.
3. Select **Find**, then review the checked results. Use the filter and **Top-most only** to narrow a large list.
4. Choose **Recycle Bin** or **Permanently**, then confirm. The Recycle Bin is the default.

**More options** controls which folders to skip, whether known junk files count as content, and your default deletion method. The app rechecks folders before removal. It keeps folders with newly discovered content or subfolders outside the last scan. You can opt in to scanning through links, but deletion leaves linked locations alone.

## Explorer right-click menu

Choose **Enable context menu** from the app menu. Explorer can then run **Find empty folders** on folders, drive roots, and blank areas inside folders. On Windows 11 it appears under **Show more options**.

On launch, the app keeps a copy in `%LOCALAPPDATA%\EmptyFolderNuker` whether or not the context menu is enabled. A newer download replaces the saved copy automatically, including newer builds with the same displayed version. The app compares versions first, then build timestamps within the same version. A failed refresh can retry on a later launch.

**Disable context menu** removes the Explorer entry and keeps the saved copy. The portable executable also accepts `--scan <folder>`, `--enable-context-menu`, `--disable-context-menu`, `--help`, and `--version`.

## Build and test

The scanning and deletion logic lives in `core/`. The Windows app uses Tauri 2 with an embedded HTML, CSS, and JavaScript interface.

On Windows, install the Rust MSVC toolchain, Microsoft C++ build tools, Windows SDK, Node.js, and Playwright with Chromium. Run the build script from PowerShell in this directory.

```powershell
.\build.ps1
```

If Playwright is installed outside the project, set `EFN_PLAYWRIGHT` to its module directory. Set `CHROMIUM` to use an existing Chromium or Edge executable. The script runs the Rust and browser suites, builds the portable executable, and writes it with its SHA-256 to `builds/`. On Linux, `bash build.sh` uses cargo-xwin to build the Windows executable.
