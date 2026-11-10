import { call, listen, hasBridge, copyText, readText, onFileDrop } from './bridge.js';
import { h, checkbox, dropdown, radios, menu, closeMenu, toast, confirmBox } from './ui.js';

const DEFAULTS = {
  base: '', recurse: true, nestedEmpty: true, ignoreJunk: false, junkNames: 'Thumbs.db, desktop.ini, .DS_Store',
  skipNames: '', includeRoot: false, skipHidden: false, skipSystem: true, skipProtected: true, skipReparse: true, compact: true, showModified: true, resultsSize: 'default',
  mode: 'recycle', exitAfter: false, autoCheck: true, confirmDelete: true, theme: 'dark', v: 5,
};
const S = { cfg: structuredClone(DEFAULTS), view: 'home', report: null, base: '', checked: new Set(), filter: '', sortKey: 'path', sortDir: 1, cursor: 0, scanning: false, deleting: false, shown: [], sel: new Set(), anchor: 0, editJunk: false, lastReq: null, version: '', mode: null, shell: null, undo: null, del: { done: 0, total: 0, path: '' }, prev: null, outcome: null, refits: 0, listScroll: 0 };
const JUNK_DEFAULT = DEFAULTS.junkNames;
const curMode = () => S.mode ?? S.cfg.mode;
// Choices made on the results screen apply to that deletion only; Settings holds the defaults.
const resetOverrides = () => { S.mode = null; };
let ROW = 26;
const readRow = () => { ROW = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--row'), 10) || 26; };
const $ = (s, r = document) => r.querySelector(s);
const main = () => $('#main');
const names = (t) => t.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
const plural = (n, w) => `${n.toLocaleString()} ${w}${n === 1 ? '' : 's'}`;
const fail = (e) => toast(String(e), 'bad');

/* ---------- settings ---------- */
let saveTimer;
function save() { clearTimeout(saveTimer); saveTimer = setTimeout(() => call('store_settings', { json: JSON.stringify(S.cfg) }).catch(() => {}), 120); }
async function flushSave() { clearTimeout(saveTimer); await call('store_settings', { json: JSON.stringify(S.cfg) }).catch(() => {}); }
function set(k, v) { S.cfg[k] = v; save(); }
const applyTheme = () => {
  document.documentElement.dataset.theme = S.cfg.theme;
  document.documentElement.dataset.density = S.cfg.compact ? 'compact' : 'comfortable';
  readRow();
};
// A click on a button that starts something (a dialog, a scan, a save) is ignored while the previous
// click is still being handled, so double and triple clicks cannot stack windows or run things twice.
const running = new Set();
async function once(key, fn) {
  if (running.has(key)) return;
  running.add(key);
  try { return await fn(); } finally { running.delete(key); }
}
const status = (t) => { $('#status-text').textContent = t; };


/* ---------- small builders ---------- */
function check(label, value, onChange, cls = '', tip = '') {
  const box = checkbox(value, (v) => onChange(v), label);
  const row = h('div', { class: 'check ' + cls }, box, h('span', { text: label }));
  row.querySelector('span').addEventListener('click', () => box.click());
  if (tip) row.title = tip;
  return row;
}
const frow = (title, desc, ctl, wide) => h('div', { class: 'frow' + (wide ? ' wide' : '') }, h('div', null, h('div', { class: 't', text: title }), desc && h('div', { class: 'd', text: desc })), h('div', { class: 'ctl' }, ctl));
function textInput(value, onChange, placeholder) {
  const i = h('input', { class: 'input mono selectable', type: 'text', placeholder: placeholder || '', autocomplete: 'off', spellcheck: 'false' });
  i.value = value; i.addEventListener('input', () => onChange(i.value)); return i;
}

/* ---------- navigation ---------- */
// Every screen has its own size. Home/empty/busy screens fit their height to the content and
// remember a width you drag them to. Results and the Settings/About pages have a fixed
// default size (results: a share of the screen) and remember the size you drag them to.
const DEF = {
  compact: { home: 430, page: [500, 440], options: [480, 500] },
  comfortable: { home: 620, page: [620, 540], options: [620, 580] },
};
// Results size is a share of the usable screen (the window cannot be dragged, so this is the control).
const RESULT_SHARE = { small: [0.45, 0.5], default: [0.55, 0.6], large: [0.7, 0.75] };
const density = () => (S.cfg.compact ? 'compact' : 'comfortable');
const kind = () => (S.scanning || S.deleting ? 'busy' : S.view === 'results' || S.view === 'details' ? 'results' : S.view === 'home' ? 'home' : S.view === 'options' ? 'options' : 'page');
const bounds = () => ({ maxW: Math.max(380, screen.availWidth - 24), maxH: Math.max(240, screen.availHeight - 24) });
function defaultSize(k) {
  const d = density(), { maxW, maxH } = bounds();
  if (k === 'page') return DEF[d].page;
  if (k === 'options') return DEF[d].options;
  const [bw, bh] = RESULT_SHARE[S.cfg.resultsSize] || RESULT_SHARE.default;
  const [sw, sh] = d === 'compact' ? [bw, bh] : [bw + 0.07, bh + 0.07];
  return [Math.min(maxW, Math.max(680, Math.round(screen.availWidth * sw))), Math.min(maxH, Math.max(440, Math.round(screen.availHeight * sh)))];
}
// Natural height of the current screen at a given window width. Measuring at the target width
// matters: text wraps differently at 430px than at 440px.
function contentHeight(width) {
  const el = main().firstElementChild;
  if (!el) return 0;
  el.classList.add('measure');
  const prev = el.style.width;
  el.style.width = width + 'px';
  const hgt = el.scrollHeight;
  el.style.width = prev;
  el.classList.remove('measure');
  return hgt;
}
const frame = () => 2 * (parseFloat(getComputedStyle(document.body).paddingLeft) + $('#app').clientLeft);
const chrome = () => $('#titlebar').offsetHeight + $('#statusbar').offsetHeight + frame();
const sizeMatches = ([w, hgt]) => Math.abs(innerWidth - w) <= 4 && Math.abs(innerHeight - hgt) <= 4;
let finishReveal;
function revealWhenSized(size) {
  const el = main();
  if (!el.classList.contains('resizing')) return;
  if (!size || sizeMatches(size)) { el.classList.remove('resizing'); return; }
  const onResize = () => { if (sizeMatches(size)) finish(); };
  const finish = () => {
    clearTimeout(timeout);
    removeEventListener('resize', onResize);
    finishReveal = null;
    el.classList.remove('resizing');
  };
  const timeout = setTimeout(finish, 220);
  finishReveal = finish;
  addEventListener('resize', onResize);
}
// Ask the OS for a size, but only if it differs from the size we last asked for. (Comparing with the
// live window size is wrong: right after a resize request the OS has not applied it yet.)
function requestSize(w, hgt, show) {
  const last = S.lastReq;
  if (last && last[0] === w && last[1] === hgt) return false;
  const size = S.lastReq = [w, hgt];
  call('fit_window', { width: w, height: hgt, show }).catch(() => {
    if (S.lastReq === size) { S.lastReq = null; setTimeout(verifySize, 1000); }
  });
  return true;
}
// The OS can ignore a resize (window minimized or snapped during a long scan, an error in the call).
// Check that the window really got the size we asked for and ask again, a few times at most.
function verifySize() {
  if (busy() || modalGrown || S.refits >= 3) return;
  const r = S.lastReq; // null: the last request failed or was refused
  if (r && sizeMatches(r)) return;
  S.refits++; S.lastReq = null; scheduleFit();
}
addEventListener('focus', () => { S.refits = 0; setTimeout(verifySize, 400); }); // e.g. restored after being minimized
function fit(again = true, show = false) {
  const d = density(), k = kind(), { maxW, maxH } = bounds();
  // Scan and delete progress screens never resize the window: results stay results-sized, and the
  // home screen stays home-sized. Shrinking and regrowing for a one-second progress view is what
  // made the window end up the wrong size.
  if (k === 'busy') { revealWhenSized(null); return; }
  let w, hgt;
  if (k === 'results' || k === 'page' || k === 'options') [w, hgt] = defaultSize(k);
  else {
    w = Math.min(DEF[d].home + frame(), maxW);
    hgt = contentHeight(w - frame()) + chrome() + 14;
  }
  w = Math.round(Math.min(w, maxW)); hgt = Math.round(Math.min(hgt, maxH));
  if (show) main().classList.remove('resizing');
  const asked = requestSize(w, hgt, show);
  if (!show && !finishReveal) revealWhenSized(asked ? S.lastReq : null);
  if (asked) setTimeout(verifySize, 600);
  // Second pass once the OS has applied the size: if the content measured differently, refit.
  if (again && k === 'home') setTimeout(() => {
    if (kind() !== k) return;
    const want = Math.round(Math.min(contentHeight(w - frame()) + chrome() + 14, maxH));
    if (Math.abs(want - hgt) > 6) { S.lastReq = null; fit(false); }
  }, 280);
}
let fitTimer;
const scheduleFit = () => { clearTimeout(fitTimer); fitTimer = setTimeout(() => requestAnimationFrame(() => fit()), 0); };
// A dialog taller than the window would be cut off: grow the window while it is open.
let modalGrown = false;
function adjustForModal() {
  const m = $('.modal');
  if (!m) { if (modalGrown) { modalGrown = false; scheduleFit(); } return; }
  const need = Math.ceil(m.getBoundingClientRect().height) + frame() + 36;
  if (need > innerHeight && need <= bounds().maxH) {
    modalGrown = true;
    const w = S.lastReq ? S.lastReq[0] : innerWidth;
    S.lastReq = [w, need];
    call('fit_window', { width: w, height: need }).catch(() => { S.lastReq = null; });
  }
}
let modalT;
new MutationObserver(() => { clearTimeout(modalT); modalT = setTimeout(adjustForModal, 30); }).observe($('#layer'), { childList: true, subtree: true });

function go(view) { closeMenu(); if (view === 'home') S.outcome = null; S.view = view; render(); }
let lastKey = '';
let showScanProgress = false;
const busy = () => S.scanning || S.deleting;
function render() {
  const m = main();
  m.inert = false;
  $('#open-menu').disabled = busy(); // menu, settings and pages make no sense while a scan or delete runs
  const key = kind() + S.view;
  if (key !== lastKey) {
    finishReveal?.();
    S.refits = 0;
    m.classList.add('resizing');
    lastKey = key;
  }
  m.replaceChildren();
  const v = S.deleting ? viewDeleting : showScanProgress && S.scanning ? viewScanning : { home: viewHome, options: viewOptions, results: viewResults, details: viewDetails, settings: viewSettings, about: viewAbout }[S.view];
  v(m);
  scheduleFit();
}
function pageHead(title, extra) {
  return h('div', { class: 'pagehead' }, h('button', { class: 'btn', type: 'button', text: '‹ Back', onClick: () => go(S.report && S.view !== 'home' && S.prev === 'results' ? 'results' : 'home') }), h('h1', { text: title }), extra);
}
function openPage(name) { if (busy()) return; const l = $('#list'); if (l) S.listScroll = l.scrollTop; S.prev = S.view; go(name); }

/* ---------- home ---------- */
function revealFolder(path, openInside) {
  return once('reveal', async () => { await call('reveal', { path, openInside }).catch(fail); await new Promise((r) => setTimeout(r, 700)); });
}
async function browse() { return once('browse', browseNow); }
async function browseNow() {
  const picked = await call('pick_folders', { title: 'Select base directory where the search will start from', multiple: false }).catch(fail);
  if (picked && picked[0]) { set('base', picked[0]); if (S.view === 'home' && !S.scanning) render(); }
}

function viewHome(m) {
  const c = S.cfg;
  const input = h('input', { class: 'input mono selectable', id: 'base', type: 'text', placeholder: 'Type, paste or browse for a folder', autocomplete: 'off', spellcheck: 'false' });
  input.value = c.base;
  input.addEventListener('input', () => set('base', input.value));
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.stopPropagation(); doScan(); } });

  m.append(h('div', { class: 'home' },
    h('label', { class: 'cap', for: 'base', text: 'Base folder:' }),
    h('div', { class: 'pathrow' }, h('div', { class: 'inputgroup' }, input), h('button', { class: 'btn', type: 'button', text: 'Browse…', onClick: browse })),
    h('div', { class: 'opts' },
      check('Check subfolders', c.recurse, (v) => { set('recurse', v); render(); }),
      check('Consider folders with only empty subfolders as empty', c.nestedEmpty, (v) => set('nestedEmpty', v), 'sub' + (c.recurse ? '' : ' off'))),
    h('div', { class: 'spacer-fill' }),
    h('div', { class: 'actions' },
      h('button', { class: 'btn', type: 'button', text: 'More options…', onClick: () => openPage('options') }),
      h('span', { class: 'fill' }),
      h('button', { class: 'btn primary', type: 'button', text: 'Find', onClick: doScan }))));
  input.focus();
}

// A junk pattern needs at least 3 letters that are not * or ?; broader ones are ignored by the backend.
const junkWarning = (txt) => {
  const bad = names(txt).filter((p) => p.replace(/[*?]/g, '').length < 3);
  return bad.length ? `Ignored (too broad, they would match real files): ${bad.join(', ')}` : '';
};
function viewOptions(m) {
  const c = S.cfg;
  const edit = (k, v) => { S.undo = null; set(k, v); syncMore(); };
  const opt = (label, key, tip, cls = '') => check(label, c[key], (v) => edit(key, v), cls, tip);
  const junkRow = check('Treat folders containing only junk files as empty', c.ignoreJunk, (v) => { edit('ignoreJunk', v); render(); }, '', 'Folders that hold only Thumbs.db, desktop.ini and similar');
  junkRow.append(h('button', { class: 'link', type: 'button', style: 'margin-left:8px', text: S.editJunk ? 'Hide list' : 'Edit list', onClick: () => { S.editJunk = !S.editJunk; render(); } }));
  m.append(h('div', { class: 'page' }, pageHead('More options'), h('div', { class: 'box more' },
    h('div', { class: 'optgrid' },
      junkRow,
      opt('Skip hidden folders', 'skipHidden', 'Hidden folders are left alone, and so are the folders that contain them'),
      opt('Skip system folders', 'skipSystem', 'Folders marked as system folders are left alone'),
      opt('Skip protected locations (Windows, Program Files…)', 'skipProtected', 'Never scans or deletes inside Windows, Program Files, ProgramData, the Recycle Bin and similar'),
      opt('Skip junctions and symbolic links', 'skipReparse', 'Links are never entered. Turn off to scan through them (loops are detected)'),
      opt('Include the base folder itself', 'includeRoot', 'Report the base folder too if it ends up empty')),
    S.editJunk ? frow('Junk file names', 'comma separated, * and ? allowed', textInput(c.junkNames, (v) => { edit('junkNames', v); const w = $('#junk-warn'); if (w) w.textContent = junkWarning(v); }), true) : null,
    S.editJunk ? h('div', { class: 'clearnote', id: 'junk-warn', text: junkWarning(c.junkNames) }) : null,
    frow('Never enter folders named', 'comma separated, * and ? allowed', textInput(c.skipNames, (v) => edit('skipNames', v), '.git, node_modules'), true),
    h('div', { class: 'delrow' }, h('span', { class: 'lbl', text: 'When deleting' }),
      radios([{ value: 'recycle', label: 'Move to the Recycle Bin' }, { value: 'permanent', label: 'Delete permanently' }], c.mode, (v) => edit('mode', v))),
    h('div', { class: 'moreactions' }, h('span', { class: 'fill', id: 'more-note', text: S.undo ? 'Options cleared' : 'Saved automatically as your defaults' }),
      S.undo ? h('button', { class: 'btn', type: 'button', id: 'btn-undo', text: 'Undo', onClick: undoClear }) : null,
      h('button', { class: 'btn', type: 'button', id: 'btn-clear', text: 'Clear', disabled: isCleared(), title: 'Reset every option above', onClick: clearOptions })))));
}

const OPT_KEYS = ['ignoreJunk', 'junkNames', 'skipNames', 'includeRoot', 'skipHidden', 'skipSystem', 'skipProtected', 'skipReparse', 'mode'];
const CLEARED = { ignoreJunk: false, junkNames: JUNK_DEFAULT, skipNames: '', includeRoot: false, skipHidden: false, skipSystem: true, skipProtected: true, skipReparse: true, mode: 'recycle' };
const isCleared = () => OPT_KEYS.every((k) => S.cfg[k] === CLEARED[k]);
// Edits do not re-render this page (that would steal focus from the text boxes), so bring Clear/Undo up to date.
function syncMore() {
  const c = $('#btn-clear'); if (c) c.disabled = isCleared();
  $('#btn-undo')?.remove();
  const n = $('#more-note'); if (n) n.textContent = S.undo ? 'Options cleared' : 'Saved automatically as your defaults';
}
function clearOptions() {
  if (isCleared()) return; // nothing to clear; never overwrite the undo snapshot with an empty one
  S.undo = Object.fromEntries(OPT_KEYS.map((k) => [k, S.cfg[k]]));
  Object.assign(S.cfg, CLEARED);
  save(); render();
}
function undoClear() { Object.assign(S.cfg, S.undo); S.undo = null; save(); render(); }

function viewScanning(m) {
  m.append(h('div', { class: 'scanning' },
    h('div', { text: 'Scanning folder…' }), h('div', { class: 'path', id: 'scan-path', text: S.base }),
    h('div', { class: 'progress' }, h('i')), h('div', { class: 'count', id: 'scan-count', text: '' }),
    h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'button', text: 'Cancel', onClick: () => call('cancel_scan') }))));
}
function viewDeleting(m) {
  const d = S.del;
  m.append(h('div', { class: 'scanning' },
    h('div', { id: 'del-title', text: curMode() === 'recycle' ? 'Moving folders to the Recycle Bin…' : 'Deleting folders…' }),
    h('div', { class: 'path', id: 'del-path', text: d.path }),
    h('div', { class: 'progress det' }, h('i', { id: 'del-bar', style: `width:${d.total ? (d.done / d.total) * 100 : 0}%` })),
    h('div', { class: 'count', id: 'del-count', text: `${d.done.toLocaleString()} of ${d.total.toLocaleString()}` }),
    h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'button', text: 'Stop', onClick: () => call('cancel_scan') }))));
}

function scanOptions(base) {
  const c = S.cfg;
  return { roots: [base], recurse: c.recurse, nestedEmpty: c.nestedEmpty, ignoreJunk: c.ignoreJunk, junkPatterns: names(c.junkNames),
    excludePatterns: names(c.skipNames), minAgeDays: 0, maxDepth: 0, includeRoot: c.includeRoot,
    skipHidden: c.skipHidden, skipSystem: c.skipSystem, skipProtected: c.skipProtected, skipReparse: c.skipReparse };
}
async function doScan() {
  if (S.scanning || S.deleting) return;
  const base = S.cfg.base.trim().replace(/^"|"$/g, '');
  if (!base) { toast('Enter a base folder first', 'bad'); $('#base')?.focus(); return; }
  S.report = null; S.outcome = null; S.listScroll = 0; // results and notes of an earlier scan must not outlive this one
  S.scanning = true; S.base = base; S.view = 'home';
  main().inert = true;
  $('#open-menu').disabled = true;
  status('Scanning…');
  const showProgress = setTimeout(() => { showScanProgress = true; render(); }, 150);
  const t0 = performance.now();
  try {
    const r = await call('start_scan', { opts: scanOptions(base) });
    S.scanning = false;
    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    status(`Found ${plural(r.folders.length, 'empty folder')} · ${plural(r.scanned, 'folder')} read in ${secs}s`);
    if (r.cancelled) { render(); return; }
    S.report = indexReport(r); S.filter = ''; S.cursor = 0; S.sel = new Set(); S.anchor = 0; resetOverrides();
    S.checked = new Set(S.cfg.autoCheck ? r.folders.map((f) => f.path) : []);
    if (r.skipped.length) toast(`${plural(r.skipped.length, 'folder')} could not be read and were left alone`);
    go('results');
  } catch (e) { S.scanning = false; status('Scan failed'); fail(e); render(); }
  finally { clearTimeout(showProgress); showScanProgress = false; }
}

/* ---------- results ---------- */
// Lower-cased path cached once per folder: sorting and filtering 200k rows must not re-lowercase.
function indexReport(r) { for (const f of r.folders) f.lp = f.path.toLowerCase(); return r; }
let sortedResults;
function derive() {
  const folders = S.report.folders;
  if (sortedResults?.folders !== folders || sortedResults.key !== S.sortKey || sortedResults.dir !== S.sortDir) {
    const value = S.sortKey === 'path' ? (f) => f.lp : (f) => f.modified ?? 0;
    const rows = folders.slice().sort((a, b) => (value(a) < value(b) ? -1 : value(a) > value(b) ? 1 : 0) * S.sortDir);
    sortedResults = { folders, key: S.sortKey, dir: S.sortDir, rows };
  }
  const q = S.filter.toLowerCase();
  return q ? sortedResults.rows.filter((f) => f.lp.includes(q)) : sortedResults.rows;
}

const fmtDate = (sec) => { if (!sec) return ''; const d = new Date(sec * 1000), z = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`; };
let charW = 7.5;
function measureChar() {
  const c = document.createElement('canvas').getContext('2d');
  c.font = `${parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--pfs')) || 11.5}px "Cascadia Mono", Consolas, monospace`;
  charW = c.measureText('0').width || 7.5;
}

function viewEmpty(m) {
  m.append(h('div', { class: 'emptystate' },
    h('div', { class: 'big', text: 'No empty folders found' }),
    h('div', { class: 'muted', text: 'Everything under ' }, h('span', { class: 'mono selectable', text: S.base }), ' holds something.'),
    S.report.skipped && S.report.skipped.length ? h('div', { class: 'faint tip', text: `${plural(S.report.skipped.length, 'folder')} could not be scanned (protected or unreadable) and were left alone.` }) : null,
    S.cfg.ignoreJunk ? null : h('div', { class: 'faint tip' }, 'Tip: folders holding only Thumbs.db or desktop.ini count as empty if you turn that on in ', h('button', { class: 'link', type: 'button', text: 'More options', onClick: () => openPage('options') }), '.'),
    h('div', { class: 'actions' }, h('span', { class: 'fill' }), h('button', { class: 'btn', type: 'button', text: 'Rescan', onClick: doScan }), h('button', { class: 'btn primary', type: 'button', text: 'Back', onClick: () => go('home') }))));
}
function outcomeStrip() {
  const o = S.outcome;
  const strip = h('div', { class: 'rnote' }, h('span', { class: 'txt', text: o.summary }), h('span', { class: 'fill' }),
    o.issues.length ? h('button', { class: 'btn sm', type: 'button', text: 'Details', onClick: () => openPage('details') }) : null,
    h('button', { class: 'btn sm x', type: 'button', text: '✕', title: 'Dismiss', 'aria-label': 'Dismiss', onClick: () => { S.outcome = null; strip.remove(); } }));
  return strip;
}
function viewDetails(m) {
  const o = S.outcome;
  if (!o) { go(S.report ? 'results' : 'home'); return; }
  const v = o.view || (o.view = { key: 'path', dir: 1, q: '' }); // sort + filter live with the outcome, so Back/Details keeps them
  const text = (i) => `${i.what}: ${i.why}`;
  const shown = () => {
    const q = v.q.toLowerCase();
    const rows = q ? o.issues.filter((i) => i.path.toLowerCase().includes(q) || text(i).toLowerCase().includes(q)) : o.issues.slice();
    const val = v.key === 'path' ? (i) => i.path.toLowerCase() : (i) => text(i).toLowerCase();
    return rows.sort((a, b) => (val(a) < val(b) ? -1 : val(a) > val(b) ? 1 : 0) * v.dir);
  };
  const filter = h('input', { class: 'input selectable', id: 'dfilter', type: 'text', placeholder: 'Filter…', autocomplete: 'off', spellcheck: 'false' });
  filter.value = v.q;
  const clr = h('button', { class: 'clr', type: 'button', title: 'Clear filter', 'aria-label': 'Clear filter', hidden: !v.q, onClick: () => { filter.value = ''; filter.dispatchEvent(new Event('input')); filter.focus(); } });
  clr.innerHTML = '<svg viewBox="0 0 10 10"><path d="M1 1l8 8M9 1L1 9" stroke="currentColor" fill="none"/></svg>';
  const sum = h('div', { class: 'dsum' });
  const table = h('div', { class: 'dtable selectable' });
  const head = (key, label) => h('span', { class: 'dh ' + key, role: 'columnheader', tabindex: '0', onClick: () => { v.dir = v.key === key ? -v.dir : 1; v.key = key; fill(); } }, label, v.key === key ? h('b', { text: v.dir === 1 ? ' ▲' : ' ▼' }) : null);
  function fill() {
    const rows = shown();
    sum.textContent = o.summary + (v.q ? ` · ${rows.length.toLocaleString()} of ${o.issues.length.toLocaleString()} shown` : '');
    table.replaceChildren(h('div', { class: 'drow dhead' }, head('path', 'Folder Path'), head('why', 'What happened')),
      ...rows.map((i) => h('div', { class: 'drow' }, h('span', { class: 'dpath mono', text: i.path }), h('span', { class: 'dwhy', text: text(i) }))));
    if (!rows.length) table.append(h('div', { class: 'dnone faint', text: 'Nothing matches the filter' }));
    table.dataset.shown = rows.length;
  }
  filter.addEventListener('input', () => { v.q = filter.value; clr.hidden = !v.q; fill(); });
  const copy = h('button', { class: 'btn', type: 'button', text: 'Copy', title: 'Copy the rows shown', onClick: () => copyText(shown().map((i) => `${i.path}\t${text(i)}`).join('\r\n')).then(() => toast('Copied')) });
  m.append(h('div', { class: 'page details' },
    h('div', { class: 'pagehead' }, h('button', { class: 'btn', type: 'button', text: '‹ Back', onClick: () => go('results') }), h('h1', { text: 'Details' }),
      h('div', { class: 'inputgroup filtergroup dfg' }, filter, clr), copy),
    sum, table));
  fill();
}
function viewResults(m) {
  if (!S.report) { go('home'); return; }
  if (S.report.folders.length === 0) { viewEmpty(m); return; }
  S.shown = derive();
  measureChar();
  const filter = h('input', { class: 'input selectable', id: 'filter', type: 'text', placeholder: 'Filter by path…  (Ctrl+F)', autocomplete: 'off', spellcheck: 'false' });
  filter.value = S.filter;
  let filterTimer;
  const clr = h('button', { class: 'clr', type: 'button', title: 'Clear filter', 'aria-label': 'Clear filter', hidden: !S.filter, onClick: () => { filter.value = ''; filter.dispatchEvent(new Event('input')); filter.focus(); } });
  clr.innerHTML = '<svg viewBox="0 0 10 10"><path d="M1 1l8 8M9 1L1 9" stroke="currentColor" fill="none"/></svg>';
  filter.addEventListener('input', () => {
    S.filter = filter.value;
    clr.hidden = !S.filter;
    clearTimeout(filterTimer);
    filterTimer = setTimeout(() => { S.cursor = 0; S.sel = new Set(); S.anchor = 0; S.shown = derive(); fillList(); updateFoot(); }, S.report.folders.length > 20000 ? 150 : 0);
  });
  filter.addEventListener('keydown', (e) => { if (e.key === 'ArrowDown') { e.preventDefault(); $('#list').focus(); } });
  const list = h('div', { class: 'list', id: 'list', tabindex: '0', role: 'listbox', 'aria-multiselectable': 'true', 'aria-label': 'Empty folders' });
  list.addEventListener('scroll', drawRows);
  list.addEventListener('keydown', listKey);
  // Opening a folder: a row is re-rendered on mouse-down, so a per-row dblclick never fires. Work out
  // the row from the pointer position instead.
  list.addEventListener('dblclick', (e) => {
    if (e.target.closest && e.target.closest('.chk')) return;
    const i = Math.floor((e.clientY - list.getBoundingClientRect().top + list.scrollTop - ROW) / ROW); // minus the sticky header row
    const f = S.shown[i];
    if (f) revealFolder(f.path, true);
  });
  const quick = (id, text, tip, fn) => h('button', { class: 'btn sm', type: 'button', id, text, title: tip, onClick: fn });

  m.append(
    h('div', { class: 'rhead' },
      h('div', { class: 'title' }, `Found ${S.report.folders.length.toLocaleString()} empty folders under `, h('span', { class: 'mono selectable', title: S.base, text: S.base })),
      h('div', { class: 'rtools' }, h('div', { class: 'inputgroup filtergroup' }, filter, clr),
        quick('btn-all', 'All', 'Tick every row', () => checkMany(S.shown, true)),
        quick('btn-none', 'None', 'Untick every row', () => checkMany(S.shown, false)),
        quick('btn-invert', 'Invert', 'Swap ticked and unticked rows', invert))),
    ...(S.outcome ? [outcomeStrip()] : []), // m.append() would print a literal "null"
    list,
    h('div', { class: 'rfoot' },
      h('div', { class: 'line' }, check('Exit after successful deletion', S.cfg.exitAfter, (v) => set('exitAfter', v)), h('span', { class: 'fill' }),
        h('button', { class: 'btn', type: 'button', text: 'Save checked paths…', onClick: savePaths })),
      h('div', { class: 'line' },
        radios([{ value: 'recycle', label: 'Recycle Bin' }, { value: 'permanent', label: 'Permanently' }], curMode(), (v) => { S.mode = v; updateFoot(); }),
        h('span', { class: 'fill muted', id: 'foot-count' }),
        h('button', { class: 'btn', type: 'button', text: 'Back', onClick: () => go('home') }),
        h('button', { class: 'btn danger', type: 'button', id: 'del-btn', text: 'Delete', onClick: doDelete }))));
  fillList(); updateFoot(); list.focus();
  if (S.listScroll) { list.scrollTop = S.listScroll; S.listScroll = 0; } // coming back from Details / Settings: keep the place
  // The window is resized after this screen is built, so the list grows afterwards: draw the rows that
  // now fit, or the bottom stays empty until the first scroll.
  listWatch?.disconnect();
  let raf = 0;
  listWatch = new ResizeObserver(() => { cancelAnimationFrame(raf); raf = requestAnimationFrame(drawRows); });
  listWatch.observe(list);
}
let listWatch;
// Folders that are not inside another folder in the results. Deleting a parent removes its empty
// children too, so ticking only these avoids listing the same work twice.
function sortBy(k) { S.sortDir = S.sortKey === k ? -S.sortDir : 1; S.sortKey = k; S.shown = derive(); S.cursor = 0; S.sel = new Set(); S.anchor = 0; updateFoot(); fillList(); }

function headerEl() {
  const arrow = (k) => (S.sortKey === k ? h('b', { text: S.sortDir === 1 ? '▲' : '▼' }) : null);
  return h('div', { class: 'lhead' },
    h('div', { class: 'cell-chk' }),
    h('div', { class: 'cell-path' }, h('button', { class: 'hbtn', type: 'button', onClick: () => sortBy('path') }, 'Folder Path', arrow('path'))),
    h('div', { class: 'cell-meta' + (S.cfg.showModified ? '' : ' nomod') }, S.cfg.showModified ? h('button', { class: 'hbtn', type: 'button', onClick: () => sortBy('age') }, 'Modified', arrow('age')) : null));
}
function fillList() {
  const list = $('#list'); if (!list) return;
  list.replaceChildren();
  if (!S.shown.length) { list.append(h('div', { class: 'zero' }, h('b', { text: S.report.folders.length ? 'Nothing matches the filter' : 'No empty folders found' }), S.report.folders.length ? '' : 'Everything under that folder contains something.')); return; }
  const longest = S.shown.reduce((n, f) => Math.max(n, f.path.length), 0);
  const need = Math.ceil((longest + 8) * charW) + 40 + 16 + 120 + 24;
  const canvas = h('div', { class: 'canvas', style: `min-width:${need}px` }, headerEl(), h('div', { class: 'rows', style: `height:${S.shown.length * ROW}px` }));
  list.append(canvas);
  list.scrollTop = 0; list.scrollLeft = 0; drawRows();
}
function drawRows() {
  const list = $('#list'), sp = list && $('.rows', list); if (!sp) return;
  const first = Math.max(0, Math.floor(list.scrollTop / ROW) - 8), last = Math.min(S.shown.length, Math.ceil((list.scrollTop + list.clientHeight) / ROW) + 8);
  list.setAttribute('aria-activedescendant', 'row-' + S.cursor);
  const range = first + ':' + last;
  if (sp.dataset.range === range) return; // same rows as already drawn (selection/ticks are synced in place)
  sp.dataset.range = range;
  const frag = document.createDocumentFragment();
  for (let i = first; i < last; i++) frag.append(rowEl(i));
  sp.replaceChildren(frag);
}
// Selection, cursor and tick changes only touch the classes of the rows already on screen. Replacing
// the row under the pointer on mouse-down would swallow the click, so a double-click would never fire.
function syncRows() {
  const list = $('#list');
  if (!list) return;
  for (const row of list.querySelectorAll('.item')) {
    const i = Number(row.dataset.i), f = S.shown[i];
    if (!f) continue;
    const sel = S.sel.has(f.path), cur = i === S.cursor;
    row.classList.toggle('sel', sel);
    row.classList.toggle('cursor', cur);
    row.setAttribute('aria-selected', String(sel || (cur && S.sel.size === 0)));
    const box = row.querySelector('.chk'), on = String(S.checked.has(f.path));
    if (box && box.getAttribute('aria-checked') !== on) box.setAttribute('aria-checked', on);
  }
  list.setAttribute('aria-activedescendant', 'row-' + S.cursor);
}
// Selection (highlighted rows) is separate from checking (the tick boxes that decide what is deleted).
// Click selects, Ctrl+click toggles, Shift+click selects a range; Space ticks/unticks every selected row.
const selRows = () => (S.sel.size ? S.shown.filter((f) => S.sel.has(f.path)) : S.shown[S.cursor] ? [S.shown[S.cursor]] : []);
function selectRange(from, to, keep) {
  const [lo, hi] = from < to ? [from, to] : [to, from];
  const next = keep ? new Set(S.sel) : new Set();
  for (let j = lo; j <= hi; j++) next.add(S.shown[j].path);
  S.sel = next;
}
function clickRow(i, e) {
  const f = S.shown[i], additive = e.ctrlKey || e.metaKey;
  if (e.shiftKey) selectRange(S.anchor, i, additive);
  else if (additive) { S.sel.has(f.path) ? S.sel.delete(f.path) : S.sel.add(f.path); S.anchor = i; }
  else { S.sel = new Set([f.path]); S.anchor = i; }
  S.cursor = i; syncRows(); updateFoot();
  $('#list')?.focus({ preventScroll: true }); // the clicked row was just re-rendered, so keep keyboard focus on the list
}
function selectAll() { S.sel = new Set(S.shown.map((f) => f.path)); S.anchor = 0; syncRows(); updateFoot(); }
function toggleSelection() {
  const rows = selRows();
  if (rows.length) checkMany(rows, rows.some((f) => !S.checked.has(f.path)));
}
function rowEl(i) {
  const f = S.shown[i];
  const onCheck = (v) => {
    // A tick on a selected row applies to the whole selection, like Explorer.
    const rows = S.sel.has(f.path) && S.sel.size > 1 ? selRows() : [f];
    for (const r of rows) v ? S.checked.add(r.path) : S.checked.delete(r.path);
    S.cursor = i; syncRows(); updateFoot();
  };
  const row = h('div', { class: 'item' + (i === S.cursor ? ' cursor' : '') + (S.sel.has(f.path) ? ' sel' : ''), style: `top:${i * ROW}px`, dataset: { i }, id: 'row-' + i, role: 'option', 'aria-selected': String(S.sel.has(f.path) || i === S.cursor && S.sel.size === 0) },
    h('div', { class: 'cell-chk' }, checkbox(S.checked.has(f.path), onCheck, 'Check ' + f.path)),
    h('div', { class: 'cell-path', title: f.path }, f.path, f.direct ? null : h('span', { class: 'tag', title: 'Deleting this parent also removes its empty subfolders', text: 'nested' })),
    h('div', { class: 'cell-meta' + (S.cfg.showModified ? '' : ' nomod'), title: f.modified ? 'Last modified ' + new Date(f.modified * 1000).toLocaleString() : '' }, S.cfg.showModified ? fmtDate(f.modified) : null));
  row.addEventListener('mousedown', (e) => { if (e.button !== 0 || e.target.closest('.chk')) return; e.preventDefault(); clickRow(i, e); });
  row.addEventListener('contextmenu', (e) => {
    if (!S.sel.has(f.path)) { S.sel = new Set([f.path]); S.anchor = i; }
    S.cursor = i; syncRows(); updateFoot();
    const rows = selRows();
    if (rows.length > 1) {
      menu([
        { label: `Check ${rows.length} selected`, hint: 'Space', run: () => checkMany(rows, true) },
        { label: `Uncheck ${rows.length} selected`, run: () => checkMany(rows, false) }, '-',
        { label: 'Copy paths', run: () => copyText(rows.map((r) => r.path).join('\r\n')).then(() => toast(`${rows.length} paths copied`)) },
      ], e.clientX, e.clientY);
      return;
    }
    menu([
      { label: S.checked.has(f.path) ? 'Uncheck' : 'Check', hint: 'Space', run: () => toggleRow(f) }, '-',
      { label: 'Open folder', run: () => revealFolder(f.path, true) },
      { label: 'Show in Explorer', run: () => revealFolder(f.path, false) },
      { label: 'Copy path', run: () => copyText(f.path).then(() => toast('Path copied')) },
    ], e.clientX, e.clientY);
  });
  return row;
}
function toggleRow(f) { S.checked.has(f.path) ? S.checked.delete(f.path) : S.checked.add(f.path); syncRows(); updateFoot(); }
function checkMany(rows, on) { for (const f of rows) on ? S.checked.add(f.path) : S.checked.delete(f.path); syncRows(); updateFoot(); }
function invert() { for (const f of S.shown) S.checked.has(f.path) ? S.checked.delete(f.path) : S.checked.add(f.path); syncRows(); updateFoot(); }
const checkedPaths = () => (S.report ? S.report.folders.map((f) => f.path).filter((p) => S.checked.has(p)) : []);
function updateFoot() {
  const n = S.checked.size, fc = $('#foot-count'), db = $('#del-btn'); // S.checked only ever holds listed paths
  for (const [id, t] of [['btn-all', 'All'], ['btn-none', 'None']]) {
    const b = $('#' + id);
    if (b) { b.textContent = S.filter ? t + ' shown' : t; b.title = S.filter ? 'Only the rows that match the filter' : (t === 'All' ? 'Tick every row' : 'Untick every row'); }
  }
  if (fc) fc.textContent = `${n.toLocaleString()} checked` + (S.filter ? ` · ${S.shown.length.toLocaleString()} shown` : '') + (S.sel.size > 1 ? ` · ${S.sel.size.toLocaleString()} selected` : '');
  if (db) { db.disabled = n === 0 || S.deleting; db.title = curMode() === 'permanent' ? 'Deletes permanently' : ''; }
}
function listKey(e) {
  const n = S.shown.length; if (!n) return;
  const list = e.currentTarget, page = Math.max(1, Math.floor(list.clientHeight / ROW) - 1);
  if (e.key === ' ') { e.preventDefault(); toggleSelection(); return; }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') { e.preventDefault(); const rows = selRows(); copyText(rows.map((r) => r.path).join('\r\n')).then(() => toast(`${plural(rows.length, 'path')} copied`)); return; }
  const mv = { ArrowDown: 1, ArrowUp: -1, PageDown: page, PageUp: -page }[e.key];
  let to = S.cursor;
  if (mv !== undefined) to = Math.max(0, Math.min(n - 1, S.cursor + mv));
  else if (e.key === 'Home') to = 0; else if (e.key === 'End') to = n - 1; else return;
  e.preventDefault();
  if (e.shiftKey) selectRange(S.anchor, to, false); else { S.sel = new Set([S.shown[to].path]); S.anchor = to; }
  S.cursor = to;
  const top = S.cursor * ROW;
  if (top < list.scrollTop) list.scrollTop = top; else if (top + 2 * ROW > list.scrollTop + list.clientHeight) list.scrollTop = top + 2 * ROW - list.clientHeight;
  syncRows(); updateFoot();
}
async function savePaths() { return once('save', savePathsNow); }
async function savePathsNow() {
  const paths = checkedPaths();
  if (!paths.length) { toast('Nothing is checked', 'bad'); return; }
  try { const where = await call('save_paths', { lines: paths }); if (where) { toast('Saved ' + plural(paths.length, 'path'), 'ok'); } } catch (e) { fail(e); }
}
const pathKey = (path) => path.replaceAll('\\', '/').replace(/\/+$/, '');
function hasAncestor(path, parents) {
  if (!parents.size) return false;
  for (let cut = path.lastIndexOf('/'); cut > 0; cut = path.lastIndexOf('/', cut - 1)) {
    if (parents.has(path.slice(0, cut))) return true;
  }
  return false;
}
async function doDelete() { return once('delete', doDeleteNow); }
async function doDeleteNow() {
  const paths = checkedPaths(), c = S.cfg, mode = curMode();
  if (!paths.length || S.deleting || S.scanning) return;
  const checked = new Set(paths.map(pathKey));
  const inside = S.report.folders.reduce((count, f) =>
    count + Number(!S.checked.has(f.path) && hasAncestor(pathKey(f.path), checked)), 0);
  if (c.confirmDelete || inside) {
    const how = mode === 'recycle' ? 'They go to the Recycle Bin where Windows allows it.' : 'They are removed permanently and cannot be restored.';
    const nestedNote = inside ? ` ${plural(inside, 'unticked folder')} inside the ticked ones will go with them. Uncheck the parent to keep those subfolders.` : '';
    if (!(await confirmBox(`Delete ${plural(paths.length, 'empty folder')}?`, how + nestedNote + ' Folders containing regular files are kept. Files matching enabled junk rules may go with their folder.', mode === 'recycle' ? 'Delete' : 'Delete permanently', true, mode === 'permanent'))) { $('#list')?.focus(); return; }
  }
  S.deleting = true; S.del = { done: 0, total: paths.length, path: '' };
  go('results');
  try {
    const res = await call('delete_paths', { paths, mode });
    const outcomeKind = (o) => (typeof o === 'string' ? o : Object.keys(o)[0]);
    const by = (k) => res.filter((r) => outcomeKind(r.outcome) === k);
    const deleted = by('deleted'), gone = by('alreadyGone'), kept = by('notEmpty'), failed = by('failed'), prot = by('protected');
    const deletedParents = new Set(deleted.map((r) => pathKey(r.path)));
    const reported = new Set(res.map((r) => r.path));
    const untouched = paths.filter((p) => !reported.has(p) && !hasAncestor(pathKey(p), deletedParents)).length;
    const stopped = untouched > 0;
    const removed = new Set([...deleted, ...gone].map((r) => r.path));
    let inherited = 0;
    S.report.folders = S.report.folders.filter((f) => {
      if (!removed.has(f.path)) {
        if (!hasAncestor(pathKey(f.path), deletedParents)) return true;
        inherited++;
      }
      S.checked.delete(f.path);
      return false;
    });
    S.sel = new Set(); S.cursor = 0; S.anchor = 0; // the listed rows changed
    const parts = [`${mode === 'recycle' ? 'Moved to Recycle Bin:' : 'Deleted'} ${plural(deleted.length + inherited, 'folder')}`];
    if (kept.length) parts.push(`${kept.length} no longer empty (kept)`);
    if (prot.length) parts.push(`${prot.length} in protected locations (kept)`);
    if (failed.length) parts.push(`${failed.length} couldn't be deleted`);
    if (stopped) parts.push(`stopped with ${untouched} untouched`);
    const msg = parts.join(' · ');
    const issues = [
      ...failed.map((r) => ({ path: r.path, what: 'Could not delete', why: Object.values(r.outcome)[0] })),
      ...kept.map((r) => ({ path: r.path, what: 'Kept', why: 'No longer empty (something appeared in it since the scan)' })),
      ...prot.map((r) => ({ path: r.path, what: 'Kept', why: 'Protected location' }))];
    S.deleting = false; resetOverrides(); status(msg);
    if (c.exitAfter && !issues.length && !stopped) { await flushSave(); call('confirm_exit'); return; }
    if (!S.report.folders.length) { // nothing left to show: back to the first screen, ready for the next search
      S.report = null; go('home'); toast(msg, 'ok'); return;
    }
    // Folders are still listed (failed, kept, unticked or untouched): stay on the results with only
    // what is left. Problems get a short note with Details; a clean partial delete just a toast.
    S.outcome = issues.length || stopped ? { summary: msg, issues } : null;
    go('results');
    if (!S.outcome) toast(msg, 'ok');
  } catch (e) { S.deleting = false; resetOverrides(); fail(e); go('results'); }
}

/* ---------- Explorer integration ---------- */
let shellRefresh;
function refreshShell() {
  return shellRefresh ??= call('shell_status')
    .then((status) => { S.shell = status; }, () => { S.shell = null; })
    .finally(() => { shellRefresh = null; });
}
function shellItems() {
  const enabled = S.shell?.enabled;
  return [{ label: enabled ? 'Disable context menu' : 'Enable context menu', run: () => toggleShell(enabled) }];
}
function toggleShell(enabled) {
  return once('shell', async () => {
    if (S.shell && !S.shell.supported) { toast('The context menu is only available on Windows', 'bad'); return; }
    try {
      await call(enabled ? 'shell_disable' : 'shell_enable');
      toast(enabled ? 'Context menu disabled' : 'Context menu enabled', 'ok');
    } catch (e) { fail(e); }
    await refreshShell();
  });
}

/* ---------- pages ---------- */
function viewSettings(m) {
  const c = S.cfg;
  m.append(h('div', { class: 'page' }, pageHead('Settings'), h('div', { class: 'box' },
    frow('Theme', null, dropdown([{ value: 'dark', label: 'Dark' }, { value: 'light', label: 'Light' }], c.theme, (v) => { set('theme', v); applyTheme(); })),
    frow('Ask before deleting', 'Always asks when deleting a parent would also remove unchecked subfolders', h('div', { style: 'display:contents' }, check('', c.confirmDelete, (v) => set('confirmDelete', v)))),
    frow('Check everything after a scan', 'Turn off to pick folders one by one', h('div', { style: 'display:contents' }, check('', c.autoCheck, (v) => set('autoCheck', v)))),
    frow('Results window size', 'The window cannot be dragged, so choose how big the results screen is', dropdown([{ value: 'small', label: 'Small' }, { value: 'default', label: 'Default' }, { value: 'large', label: 'Large' }], c.resultsSize, (v) => set('resultsSize', v))),
    frow('Compact mode', 'Smaller window and tighter spacing', h('div', { style: 'display:contents' }, check('', c.compact, (v) => { set('compact', v); applyTheme(); render(); }))),
    frow('Show modified date column', 'In the results list', h('div', { style: 'display:contents' }, check('', c.showModified, (v) => set('showModified', v)))),
    frow('Reset all settings', 'Back to the defaults', h('button', { class: 'btn', type: 'button', text: 'Reset…', onClick: async () => { if (await confirmBox('Reset all settings?', 'Your options go back to the defaults.', 'Reset')) { S.cfg = structuredClone(DEFAULTS); save(); applyTheme(); render(); toast('Settings reset'); } } })),
  )));
}
function viewAbout(m) {
  const keys = [['Ctrl+Enter', 'Find'], ['Ctrl+O', 'Browse for a folder'], ['Ctrl+F', 'Filter results'], ['Ctrl+A', 'Select all rows'], ['Click / Ctrl+click / Shift+click', 'Select rows'], ['Space', 'Check or uncheck the selected rows'], ['Ctrl+C', 'Copy the selected paths'], ['Delete', 'Delete checked'], ['Ctrl+S', 'Save checked paths'], ['Esc', 'Back']];
  m.append(h('div', { class: 'page' }, pageHead('About'),
    h('div', { class: 'box' }, h('dl', { class: 'kv' }, h('dt', { text: 'Version' }), h('dd', { text: S.version || '—' }), )),
    h('h2', { text: 'Quick start' }),
    h('ol', { class: 'box quick-start' },
      h('li', { text: 'Browse for a base folder or drop one onto the window, then choose Find.' }),
      h('li', { text: 'Review the checked results. Use the filter to narrow the list.' }),
      h('li', { text: 'Send checked folders to the Recycle Bin or choose permanent deletion. Deleting a nested parent also removes its empty subfolders, including unchecked ones.' })),
    h('h2', { text: 'Explorer and help' }),
    h('div', { class: 'box' }, h('p', { text: 'Enable the context menu to scan from Explorer. Use the bug icon in the title bar to open GitHub Issues.' })),
    h('h2', { text: 'Keyboard' }),
    h('div', { class: 'box' }, h('dl', { class: 'kv' }, ...keys.flatMap(([k, v]) => [h('dt', null, h('kbd', { text: k })), h('dd', { text: v })])))));
}

/* ---------- menus / keyboard ---------- */
function mainMenu(anchor) {
  const r = anchor.getBoundingClientRect();
  menu([
    { label: 'More options', run: () => openPage('options') }, { label: 'Settings', run: () => openPage('settings') }, ...shellItems(),
    '-', { label: 'About', run: () => openPage('about') },
  ], r.right - 190, r.bottom + 2, 190);
}
const typing = (t) => t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement;
addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase(), ctrl = e.ctrlKey || e.metaKey, block = () => { e.preventDefault(); e.stopPropagation(); };
  if (e.key === 'F12' || e.key === 'F5' || e.key === 'F3' || (ctrl && e.shiftKey && ['i', 'j', 'c', 'r'].includes(k)) || (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight'))) return block();
  if (ctrl && ['+', '-', '=', '0', '_'].includes(e.key)) return block();
  if (!ctrl) {
    if (document.querySelector('.scrim')) return;
    if (e.key === 'Escape') { if (closeMenu()) return; if (e.target && e.target.id === 'filter' && S.filter) { S.filter = ''; e.target.value = ''; e.target.dispatchEvent(new Event('input')); return; } if (S.view === 'results' && S.sel.size > 1) { S.sel = new Set(); syncRows(); updateFoot(); return; } if (S.scanning || S.deleting) { call('cancel_scan'); return; } if (S.view !== 'home' && !S.scanning) go(S.view !== 'results' && S.prev === 'results' ? 'results' : 'home'); return; }
    if (typing(e.target)) return;
    if (e.key === 'Delete' && S.view === 'results') return doDelete();
    return;
  }
  if (document.querySelector('.scrim') && !['c', 'v', 'x', 'a', 'z', 'y'].includes(k)) return block(); // no app shortcuts under an open dialog
  switch (k) {
    case 'enter': block(); return doScan();
    case 'o': block(); return browse();
    case 'f': block(); if (S.view === 'results') $('#filter')?.focus(); return;
    case 's': block(); if (S.view === 'results') savePaths(); return;
    case 'a': if (S.view === 'results' && !typing(e.target)) { block(); selectAll(); } return;
    case 'p': case 'u': case 'r': case 'g': case 'j': case 'n': case 't': case 'w': case 'h': case 'l': case 'e': case 'd': return block();
  }
}, true);
addEventListener('wheel', (e) => { if (e.ctrlKey) e.preventDefault(); }, { passive: false });
['gesturestart', 'gesturechange', 'gestureend'].forEach((t) => addEventListener(t, (e) => e.preventDefault()));
addEventListener('dragover', (e) => e.preventDefault());
addEventListener('drop', (e) => e.preventDefault());
addEventListener('contextmenu', (e) => {
  e.preventDefault();
  const t = e.target;
  if (typing(t)) {
    const sel = t.selectionStart !== t.selectionEnd, text = () => t.value.slice(t.selectionStart, t.selectionEnd);
    const put = (s) => { t.setRangeText(s, t.selectionStart, t.selectionEnd, 'end'); t.dispatchEvent(new Event('input', { bubbles: true })); };
    menu([{ label: 'Cut', disabled: !sel, run: () => { copyText(text()); put(''); } }, { label: 'Copy', disabled: !sel, run: () => copyText(text()) },
      { label: 'Paste', run: async () => { t.focus(); put((await readText()) || ''); } }, '-', { label: 'Select all', run: () => { t.focus(); t.select(); } }], e.clientX, e.clientY);
  } else if (t.closest('#titlebar')) {
    menu([{ label: 'Minimize', run: () => call('window_minimize') }, '-', { label: 'Close', hint: 'Alt+F4', run: () => call('window_close') }], e.clientX, e.clientY);
  }
}, true);
addEventListener('click', (e) => { const a = e.target.closest && e.target.closest('a'); if (a) e.preventDefault(); }, true);

/* ---------- boot ---------- */
async function boot() {
  const bridge = $('#bridge');
  if (!hasBridge) { bridge.className = 'bridge bad'; bridge.lastChild.textContent = 'No backend'; main().append(h('div', { class: 'zero' }, h('b', { text: 'Backend not connected' }), 'The native bridge is missing, so nothing can run.')); return; }
  try { S.version = await call('ping'); bridge.className = 'bridge ok'; bridge.lastChild.textContent = 'v' + S.version; }
  catch (e) { bridge.className = 'bridge bad'; bridge.lastChild.textContent = 'Backend error'; fail(e); }
  let migrated = false;
  try {
    const saved = JSON.parse(await call('load_settings'));
    if (!saved.base && Array.isArray(saved.roots) && saved.roots[0]) saved.base = saved.roots[0]; // from 2.0 alpha settings
    // v3: before this version, choosing "permanent"/"dry run" on the results screen silently changed
    // the saved defaults. Put them back to the safe values once, and say so.
    if ((saved.v || 0) < 3) {
      if (saved.mode === 'permanent' || saved.dryRun) { saved.mode = 'recycle'; saved.dryRun = false; migrated = true; }
      saved.v = 3;
    }
    if ((saved.v || 0) < 4) { delete saved.dryRun; delete saved.minAgeDays; delete saved.maxDepth; saved.v = 4; }
    if ((saved.v || 0) < 5) saved.v = 5; // v5 drops the folder history, activity log and swap-windows setting
    S.cfg = { ...structuredClone(DEFAULTS), ...saved };
    // A hand-edited or damaged file must not be able to break the app.
    // Only known keys of the right type survive (this also drops keys of removed features).
    for (const k of Object.keys(S.cfg)) if (!(k in DEFAULTS)) delete S.cfg[k]; else if (typeof S.cfg[k] !== typeof DEFAULTS[k]) S.cfg[k] = structuredClone(DEFAULTS[k]);
    if (!['recycle', 'permanent'].includes(S.cfg.mode)) S.cfg.mode = 'recycle';
    if (!['dark', 'light'].includes(S.cfg.theme)) S.cfg.theme = 'dark';
    if (!RESULT_SHARE[S.cfg.resultsSize]) S.cfg.resultsSize = 'default';
    if (typeof S.cfg.base !== 'string') S.cfg.base = '';
  } catch { /* first run */ }
  applyTheme();
  $('#win-min').onclick = () => call('window_minimize');
  $('#report-bug').onclick = () => once('report-bug', () => call('open_bug_report').catch(fail));
  $('#win-close').onclick = async () => { await flushSave(); call('window_close'); };
  $('#open-menu').onclick = async (e) => { if (busy()) return; const b = e.currentTarget; await refreshShell(); mainMenu(b); };
  listen('scan-progress', (p) => { const el = $('#scan-path'); if (el) el.textContent = p.path; const c = $('#scan-count'); if (c) c.textContent = `${p.count.toLocaleString()} folders read`; status(`Scanning… ${p.count.toLocaleString()} folders`); });
  listen('delete-progress', (p) => {
    S.del = { done: p.done, total: p.total, path: p.path };
    const bar = $('#del-bar'); if (bar) bar.style.width = `${(p.done / p.total) * 100}%`;
    const cnt = $('#del-count'); if (cnt) cnt.textContent = `${p.done.toLocaleString()} of ${p.total.toLocaleString()}`;
    const path = $('#del-path'); if (path) path.textContent = p.path;
    status(`Deleting… ${p.done.toLocaleString()} of ${p.total.toLocaleString()}`);
  });
  listen('close-requested', async () => { // Alt+F4 / the close button: save pending settings first, ask only when work is running
    if (busy() && !(await confirmBox('Operation in progress', 'A scan or deletion is still running. Quit anyway?', 'Quit', true))) return;
    await flushSave(); call('confirm_exit');
  });
  onFileDrop({ over: () => { $('#drop-overlay').hidden = false; }, leave: () => { $('#drop-overlay').hidden = true; },
    drop: (paths) => { $('#drop-overlay').hidden = true; if (paths[0] && !busy() && !$('#layer .scrim')) { set('base', paths[0]); doScan(); } } }).catch(() => {});
  refreshShell();
  go('home');
  clearTimeout(fitTimer);
  fit(false, true);
  if (migrated) { save(); toast('Delete method set back to the Recycle Bin (an older version could change it by accident)'); }
  const launch = await call('launch_folders').catch(() => []);
  if (launch.length) { set('base', launch[0]); doScan(); }
}
boot();
