// Test-only stand-in for window.__TAURI__ so the UI can be driven in plain Chromium.
// Never shipped: it lives outside src/ and is injected by tests/ui.test.mjs.
(() => {
  const calls = [];
  const listeners = {};
  const folders = [
    { path: 'C:\\Data\\a', direct: false, depth: 1, modified: 1500000000 },
    { path: 'C:\\Data\\a\\b', direct: true, depth: 2, modified: 1500000000 },
    { path: 'C:\\Data\\old', direct: true, depth: 1, modified: 1600000000 },
  ];
  folders.push({ path: 'C:\\Example\\Archive\\SampleProject\\Snapshots\\ArchivedWorkingCopy-2025-07-03\\Library\\Records\\ExampleStore\\data\\very\\deep\\folder\\structure\\that\\keeps\\going', direct: true, depth: 14, modified: 1751583264 });
  folders.push({ path: 'C:\\Data\\foo', direct: true, depth: 1, modified: 1700000000 }, { path: 'C:\\Data\\foobar', direct: true, depth: 1, modified: 1700000000 });
  for (let i = 0; i < 5000; i++) folders.push({ path: `C:\\Data\\bulk\\f${i}`, direct: true, depth: 2, modified: 1700000000 });
  let settings = window.__seed || '{}';
  let shellEnabled = false;
  const emit = (n, p) => (listeners[n] || []).forEach((f) => f({ payload: p }));
  window.__calls = calls;
  window.__settings = () => settings;
  window.__emit = emit;
  window.__TAURI__ = {
    core: { invoke: async (cmd, args) => {
      calls.push([cmd, args]);
      switch (cmd) {
        case 'ping': return '1.0.0';
        case 'fit_window': if (window.__failFits > 0) { window.__failFits--; throw 'window is minimized'; } if (window.__dropFits > 0) { window.__dropFits--; return null; } if (window.__resize) window.__resize(args.width, args.height); return null;
        case 'launch_folders': return [];
        case 'load_settings': return settings;
        case 'store_settings': settings = args.json; return;
        case 'shell_status': return { supported: true, enabled: shellEnabled };
        case 'shell_enable': shellEnabled = true; return null;
        case 'shell_disable': shellEnabled = false; return null;
        case 'start_scan':
          if (args.opts.roots[0] === 'C:\\Nope') throw 'Folder "C:\\Nope" does not exist';
          if (args.opts.roots[0] === 'C:\\Empty') return { folders: [], scanned: 12, skipped: [], cancelled: false };
          await new Promise((r) => setTimeout(r, 1200)); return { folders, scanned: 9000, skipped: [], cancelled: false };
        case 'delete_paths': {
          const total = args.paths.length;
          for (let i = 1; i <= 3; i++) { emit('delete-progress', { path: args.paths[0], done: Math.ceil((total * i) / 3), total }); await new Promise((r) => setTimeout(r, 150)); }
          return args.paths.map((p, i) => ({ path: p, outcome: i < (window.__failDelete || 0) ? { failed: 'Access denied (read-only, in use, or no permission)' } : 'deleted' }));
        }
        case 'pick_folders': await new Promise((r) => setTimeout(r, 250)); return ['C:\\Data'];
        default: return null;
      }
    } },
    event: { listen: async (n, f) => { (listeners[n] ||= []).push(f); return () => {}; } },
    webview: { getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }) },
    clipboardManager: { writeText: async () => {}, readText: async () => 'pasted' },
  };
})();
