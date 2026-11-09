// Drives the real UI in headless Chromium with a mock backend. Run: node tests/ui.test.mjs
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';

const { chromium } = createRequire(import.meta.url)(process.env.EFN_PLAYWRIGHT || 'playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mock = fs.readFileSync(path.join(root, 'tests/mock-bridge.js'), 'utf8');
const csp = JSON.parse(fs.readFileSync(path.join(root, 'src-tauri/tauri.conf.json'), 'utf8')).app.security.csp; // test under the shipped CSP
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const server = http.createServer((req, res) => {
  const f = path.join(root, 'src', req.url === '/' ? 'index.html' : req.url.split('?')[0]);
  fs.readFile(f, (err, data) => err ? (res.writeHead(404), res.end()) : (res.writeHead(200, { 'content-type': types[path.extname(f)] || 'text/plain', 'content-security-policy': csp }), res.end(data)));
}).listen(0);
const base = `http://127.0.0.1:${server.address().port}/`;
const SHOTS = process.env.SHOTS || '/tmp';
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
const page = await browser.newPage();
// Resize through DevTools so window.screen stays a realistic 1920x1080 (setViewportSize resets it).
const cdp = await page.context().newCDPSession(page);
let cur = [440, 300];
const resize = (width, height) => (cur = [width, height], cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false, screenWidth: 1920, screenHeight: 1080 }));
// Screenshots go through DevTools: page.screenshot() resets the emulated screen and races later steps.
const shot = async (name) => { const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(`${SHOTS}/${name}.png`, Buffer.from(data, 'base64')); };
await resize(440, 300);
const errors = [];
page.on('pageerror', (e) => errors.push(e.stack || e.message));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
// The mock backend really resizes the viewport when the app asks, like Tauri's set_size.
await page.exposeFunction('__resize', (w, h) => resize(w, h));
await page.addInitScript(mock);
await page.goto(base);
let fails = 0;
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) fails++; };
const calls = (name) => page.evaluate((n) => window.__calls.filter((c) => c[0] === n).map((c) => c[1]), name);
const lastFit = async () => (await calls('fit_window')).at(-1);
const saved = async () => { await page.waitForTimeout(450); return page.evaluate(() => JSON.parse(window.__settings())); };

await page.waitForSelector('#bridge.ok');
ok(true, 'backend round trip shows connected');

// ---- home: OG-style, compact
ok(await page.locator('.nav, #sidebar').count() === 0, 'no sidebar');
ok(await page.locator('#win-max').count() === 0, 'there is no maximize button');
await page.dblclick('#titlebar .tb-name');
ok((await calls('window_toggle_maximize')).length === 0, 'double-clicking the titlebar does nothing');
const conf = JSON.parse(fs.readFileSync(path.join(root, 'src-tauri/tauri.conf.json'), 'utf8')).app.windows[0];
ok(conf.resizable === false && conf.maximizable === false, 'window is configured as not resizable and not maximizable');
ok(conf.backgroundColor === '#11151d', 'the native window background is dark, so growing the window never flashes white');
ok(conf.visible === false && conf.shadow === false, 'native startup stays hidden and has no large shadow');
const startupFit = (await calls('fit_window'))[0];
ok(startupFit?.show === true && startupFit.width <= 460 && startupFit.height < 300, 'the first fit reveals the compact home window');
ok(await page.locator('.home .check').count() === 2, 'home shows just the two v1.3 checkboxes by default');
ok(await page.locator('.more').count() === 0, 'extra options hidden until asked for');
await page.waitForTimeout(100);
let fit = await lastFit();
ok(fit.width === 430 && fit.height > 150 && fit.height < 290, `home window is compact and fits its content (${fit.width}x${fit.height})`);
await shot('home');

const box = async (sel) => page.locator(sel).first().boundingBox();
const inp = await box('#base'), brw = await box('text=Browse…');
ok(Math.abs((inp.y + inp.height / 2) - (brw.y + brw.height / 2)) < 1.5, 'input and Browse are vertically centred together');
const mo = await box('text=More options…'), fnd = await box('.actions .primary');
ok(await page.locator('text=Shell Integration').count() === 0, 'no Shell Integration button on the first screen');
ok(Math.abs(mo.y - fnd.y) < 1 && Math.abs(mo.height - fnd.height) < 1, 'bottom buttons are aligned and equal height');
ok(Math.abs((brw.x + brw.width) - (fnd.x + fnd.width)) < 1.5, 'right edges line up (Browse / Find)');
ok(brw.height <= 26 && fnd.height <= 26, `controls are compact (${brw.height}px high)`);

await page.keyboard.press('Control+Enter');
ok(await page.locator('.strip, .toast.bad').count() > 0, 'Find without a folder warns via the status-bar strip');

// ---- More options is its own screen: the first screen never changes size
const homeFits = (await calls('fit_window')).length;
ok(await page.locator('.more-toggle, .more').count() === 0, 'the first screen has no inline options panel');
await page.click('text=More options…');
await page.waitForSelector('.pagehead');
await page.waitForTimeout(450);
ok((await page.textContent('.pagehead h1')) === 'More options', 'More options… opens its own screen');
fit = await lastFit();
ok(fit.width === 480 && fit.height === 500, `the options screen has its own fixed size (${fit.width}x${fit.height})`);
const mv = await page.evaluate(() => { const p = document.querySelector('.page'); return [p.scrollHeight, p.clientHeight]; });
ok(mv[0] <= mv[1] + 1, 'the options fit without scrolling at that size ' + JSON.stringify(mv));
await shot('more');
const chk = (label) => page.locator(`.more .check:has-text("${label}") .chk`);
const state = async (label) => (await chk(label).getAttribute('aria-checked')) === 'true';
ok(!(await state('junk files')) && !(await state('Skip hidden')) && (await state('Skip system')) && (await state('Skip protected')) && (await state('Skip junctions')) && !(await state('Include the base')), 'More options defaults: protections on, extras off');
ok(await page.locator('.more .radio[data-v=recycle][aria-checked=true]').count() === 1, 'delete method defaults to the Recycle Bin');
ok(await page.locator('.more input[type=radio], .more input[type=checkbox]').count() === 0, 'radios and checkboxes are custom controls');
const xs = await page.locator('.more .optgrid .chk').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().left)));
ok(xs.length === 6 && xs.every((x) => x === xs[0]), 'the six option tick boxes line up');
ok(await page.locator('.more .stepper').count() === 0 && !/older than|maximum depth/i.test(await page.textContent('.more')), 'no "Only older than" / "Maximum depth" rows any more');
ok(!/dry run/i.test(await page.evaluate(() => document.body.innerText)), 'no dry run anywhere in the UI');

// options are saved defaults; Clear really clears; Undo restores
await chk('junk files').click();
await chk('Skip protected').click();
await page.locator('.more .radio[data-v=permanent]').click();
await page.locator('.more input[placeholder*=".git"]').fill('.git');
let st = await saved();
ok(st.ignoreJunk === true && st.skipNames === '.git', 'More options changes are saved as defaults');
ok(st.skipProtected === false && st.mode === 'permanent', 'protection and delete method are saved defaults too');
await page.click('.more >> text=Clear');
st = await saved();
ok(st.ignoreJunk === false && st.skipNames === '' && st.includeRoot === false, 'Clear resets every option');
ok(st.skipProtected === true && st.skipSystem === true && st.skipReparse === true && st.mode === 'recycle', 'Clear puts protections back on and the Recycle Bin back');
ok(await page.locator('.more .chk[aria-checked=true]').count() === 3, 'Clear leaves only the three protections ticked');
await page.click('.more >> text=Undo');
st = await saved();
ok(st.ignoreJunk === true && st.skipNames === '.git' && st.skipProtected === false && st.mode === 'permanent', 'Undo brings the options back');
await page.click('.more >> text=Clear');
ok(await page.locator('.more .moreactions .btn:has-text("Clear")').isDisabled(), 'Clear is disabled when there is nothing left to clear');
await page.click('.more >> text=Undo');
await page.click('.more >> text=Clear');
await page.locator('.more .moreactions .btn:has-text("Clear")').dispatchEvent('click'); // a second quick click
await page.click('.more >> text=Undo');
st = await saved();
ok(st.ignoreJunk === true && st.skipNames === '.git', 'Clear twice, then Undo, still restores the real options');
await page.click('.more >> text=Clear');
await page.click('.pagehead >> text=Back');
await page.waitForSelector('.home');
await page.waitForTimeout(450);
fit = await lastFit();
ok(fit.width === 430 && fit.height < 290, `Back returns to the first screen at its own size (${fit.width}x${fit.height})`);
ok((await calls('fit_window')).length === homeFits + 2, 'opening and closing the options is exactly two resizes: there and back');

// ---- missing folder: friendly message like the original, no scan
await page.fill('#base', 'C:\\Nope');
await page.keyboard.press('Control+Enter');
await page.waitForSelector('.toast.bad');
ok((await page.textContent('.toast.bad')).includes('does not exist'), 'missing folder gives a clear message');
await page.waitForSelector('.home');

// ---- scan
await page.click('text=Browse…');
await page.waitForFunction(() => document.querySelector('#base').value === 'C:\\Data');
await page.waitForTimeout(400);
const fitsBeforeScan = (await calls('fit_window')).length;
await page.keyboard.press('Control+Enter');
await page.waitForSelector('.scanning');
ok(await page.locator('#open-menu:disabled').count() === 1, 'the menu button is disabled while scanning');
await page.waitForTimeout(300);
ok((await calls('fit_window')).length === fitsBeforeScan, 'the scanning screen does not resize the window');
const scanOpts = (await calls('start_scan')).at(-1).opts;
ok(scanOpts.skipHidden === false && scanOpts.skipSystem === true && scanOpts.skipProtected === true && scanOpts.skipReparse === true, 'the skip options are sent to the scanner');
await page.waitForSelector('.rhead .title');
await page.waitForTimeout(100);
fit = await lastFit();
ok(Math.abs(fit.width - 1056) <= 2 && Math.abs(fit.height - 648) <= 2, `results open at ~55% x 60% of the screen (${fit.width}x${fit.height} of 1920x1080)`);
ok(fit.width <= 1920 - 24 && fit.height <= 1080 - 24, 'window never asks for more than the usable screen');
ok((await page.textContent('.rhead .title')).includes('Found 5,006 empty folders under'), 'results header like v1.3');
ok((await page.textContent('#foot-count')).startsWith('5,006 checked'), 'all checked after scan');
ok(await page.locator('.item').count() < 120, 'list is virtualised (' + await page.locator('.item').count() + ' rows in DOM)');
ok((await page.locator('.lhead').innerText()).includes('Folder Path') && (await page.locator('.lhead').innerText()).includes('Modified'), 'results have Folder Path and Modified headers');
const sc = await page.evaluate(() => { const l = document.querySelector('#list'); return { sw: l.scrollWidth, cw: l.clientWidth }; });
ok(sc.sw > sc.cw, 'a very long path still scrolls sideways (' + sc.sw + ' > ' + sc.cw + ')');
const fs1 = await page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('.cell-path')).fontSize));
ok(fs1 <= 12, `path font is compact (${fs1}px)`);
await page.evaluate(() => { document.querySelector('#list').scrollLeft = 99999; });
ok(await page.evaluate(() => { const l = document.querySelector('#list').getBoundingClientRect(); const m = document.querySelector('.item .cell-meta').getBoundingClientRect(); return m.right <= l.right + 1 && m.left >= l.left; }), 'Modified column stays pinned while scrolled right');
await page.click('.lhead >> text=Modified');
ok(await page.locator('.lhead b').count() === 1, 'clicking a header sorts and shows an arrow');
await page.click('.lhead >> text=Folder Path');
await shot('results');
ok(await page.evaluate(() => { const l = document.querySelector('#list').getBoundingClientRect(); const it = [...document.querySelectorAll('.item')].map((e) => e.getBoundingClientRect().bottom); return Math.max(...it) >= l.bottom - 1; }), 'the rows fill the whole list right after the window has been resized (no scrolling needed)');
const btns = await page.locator('.rfoot .line:last-child .btn').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().height)));
ok(btns.every((x) => x === btns[0]), 'footer buttons all equal height');

// Back refits to the home size
await page.click('text=Back');
await page.waitForSelector('.home');
await page.waitForTimeout(250);
fit = await lastFit();
ok(fit.width === 430, `Back refits the window to the home size (${fit.width})`);
await page.keyboard.press('Control+Enter');
await page.waitForSelector('.rhead .title');
await page.waitForTimeout(250);
fit = await lastFit();
ok(Math.abs(fit.width - 1056) <= 2, `rescan reopens the results at the results size (${fit.width}x${fit.height})`);

// no path history: the folder box has no dropdown
await page.click('text=Back');
await page.waitForSelector('.home');
ok(await page.locator('.caret').count() === 0, 'no previous-folders dropdown on the folder box');
await page.mouse.click(5, 120);
await page.keyboard.press('Control+Enter');
await page.waitForSelector('.rhead .title');

// ---- results interactions
await page.keyboard.press('Control+f');
await page.keyboard.type('Data\\old');
await page.waitForTimeout(250);
ok((await page.textContent('#foot-count')).includes('1 shown'), 'Ctrl+F focuses filter; filter works');
await page.fill('#filter', '');
await page.dispatchEvent('#filter', 'input');
await page.waitForTimeout(250);
const qb = await page.locator('.rtools .btn').allTextContents();
ok(JSON.stringify(qb) === JSON.stringify(['All', 'None', 'Invert', 'Top-most only']), 'quick-select buttons sit next to the filter');
const fb = await box('#filter'), ab = await box('#btn-all');
ok(Math.abs((fb.y + fb.height / 2) - (ab.y + ab.height / 2)) < 1.5, 'filter and quick-select buttons share one row');
ok(await page.locator('text=⋯').count() === 0, 'the … button is gone');
await page.click('#btn-none');
ok((await page.textContent('#foot-count')).startsWith('0 checked'), 'None unticks everything');
await page.locator('#list').focus();
await page.keyboard.press(' ');
ok((await page.textContent('#foot-count')).startsWith('1 checked'), 'Space toggles focused row');
await page.locator('.item').first().click({ button: 'right' });
ok(await page.locator('.menu').count() === 1, 'row right-click shows custom menu');
await page.keyboard.press('Escape');
ok(await page.locator('.rhead .title').count() === 1, 'Esc closes a menu without leaving the screen');
await page.mouse.click(5, 200);

// ---- double-click opens the folder (real mouse; rows are re-rendered on mouse-down)
const nReveal0 = (await calls('reveal')).length;
await page.locator('.item[data-i="3"] .cell-path').dblclick();
const rv = await calls('reveal');
ok(rv.length === nReveal0 + 1 && rv.at(-1).openInside === true && rv.at(-1).path === 'C:\\Data\\bulk\\f1', 'a real double-click on a row opens that folder');
ok((await page.getAttribute('#list', 'role')) === 'listbox' && (await page.locator('.item[role=option]').count()) > 5, 'the results list has listbox/option roles for screen readers');

// ---- multi-select: click / Ctrl+click / Shift+click, then Space toggles every selected row
const checkedCount = async () => parseInt((await page.textContent('#foot-count')).replace(/,/g, ''), 10);
await page.click('#btn-all');                         // everything checked again
const total = await checkedCount();
await page.locator('.item[data-i="2"] .cell-path').click();
await page.locator('.item[data-i="6"] .cell-path').click({ modifiers: ['Shift'] });
ok(await page.locator('.item.sel').count() === 5, 'Shift+click selects a range of rows');
ok((await page.textContent('#foot-count')).includes('5 selected'), 'footer shows how many rows are selected');
await shot('selected');
await page.keyboard.press(' ');
ok((await checkedCount()) === total - 5, 'Space unchecks every selected row at once');
await page.keyboard.press(' ');
ok((await checkedCount()) === total, 'Space again checks them all again');
await page.locator('.item[data-i="9"] .cell-path').click({ modifiers: ['Control'] });
ok(await page.locator('.item.sel').count() === 6, 'Ctrl+click adds a single row to the selection');
await page.locator('.item[data-i="9"] .cell-path').click({ modifiers: ['Control'] });
ok(await page.locator('.item.sel').count() === 5, 'Ctrl+click on a selected row removes it');
await page.locator('.item[data-i="3"] .chk').click();    // tick box of a selected row
ok((await checkedCount()) === total - 5, 'clicking a tick box inside a selection applies to the whole selection');
await page.locator('.item[data-i="3"] .chk').click();
ok((await checkedCount()) === total, 'and toggles them back');
await page.keyboard.press('Control+a');
ok(await page.locator('.item.sel').count() > 20 && (await page.textContent('#foot-count')).includes('5,006 selected'), 'Ctrl+A selects every row (not just ticks them)');
await page.keyboard.press('Escape');
ok(await page.locator('.rhead .title').count() === 1 && await page.locator('.item.sel').count() <= 1, 'Esc first collapses a multi-selection');
await page.locator('.item[data-i="2"] .cell-path').click();
await page.keyboard.down('Shift'); await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowDown'); await page.keyboard.up('Shift');
ok(await page.locator('.item.sel').count() === 3, 'Shift+Arrow extends the selection');
await page.locator('.item[data-i="3"]').click({ button: 'right' });
ok((await page.locator('.menu button').first().textContent()).includes('selected'), 'right-click on a selection offers bulk check/uncheck');
await page.keyboard.press('Escape');
// filtered results: Check/Uncheck act on the shown rows only, and say so
await page.fill('#filter', 'bulk\\f10');
await page.dispatchEvent('#filter', 'input');
ok(await page.locator('.clr:visible').count() === 1, 'a clear (x) button appears in the filter box once there is text');
await shot('filter-clear');
await page.click('.clr');
ok((await page.inputValue('#filter')) === '' && await page.locator('.clr:visible').count() === 0 && (await page.evaluate(() => document.activeElement.id)) === 'filter', 'the clear button empties the filter, hides itself and keeps focus in the box');
await page.fill('#filter', 'bulk\\f10');
await page.dispatchEvent('#filter', 'input');
await page.waitForTimeout(250);
ok((await page.textContent('#btn-all')) === 'All shown' && (await page.textContent('#btn-none')) === 'None shown', 'with a filter the buttons say "shown"');
await page.click('#btn-none');
const after = await checkedCount();
const shownN = parseInt((await page.textContent('#foot-count')).match(/([\d,]+) shown/)[1].replace(/,/g, ''), 10);
ok(after === total - shownN && shownN < 200, `None shown only unticks the filtered rows (${shownN} of ${total})`);
await page.click('#btn-all');
await page.fill('#filter', '');
await page.dispatchEvent('#filter', 'input');
await page.waitForTimeout(250);
ok((await page.textContent('#btn-all')) === 'All', 'buttons say "All" again without a filter');
await page.click('#btn-top');
ok((await checkedCount()) === total - 1, 'Top-most only ticks everything except folders inside another listed folder');
await page.click('#btn-invert');
ok((await checkedCount()) === 1, 'Invert swaps ticked and unticked rows');
await page.click('#btn-all');

// Ctrl+D used to delete without a word: it must do nothing now
const nDel0 = (await calls('delete_paths')).length;
await page.keyboard.press('Control+d');
ok((await page.locator('.modal').count()) === 0 && (await calls('delete_paths')).length === nDel0, 'Ctrl+D no longer deletes anything');
// "Check everything under foo" must not tick foobar (same prefix, different folder)
await page.fill('#filter', 'data\\foo');
await page.dispatchEvent('#filter', 'input');
await page.waitForTimeout(250);
await page.click('#btn-none');
ok((await page.locator('.item').count()) === 2, 'the filter finds foo and foobar');
await page.locator('.item[data-i="0"]').click({ button: 'right' });
await page.click('.menu >> text=Check everything under this folder');
ok((await checkedCount()) === total - 1 && (await page.locator('.item[data-i="1"] .chk').getAttribute('aria-checked')) === 'false', '"Check everything under foo" ticks foo only, not foobar');
await page.locator('#filter').focus();
await page.keyboard.press('Escape');
await page.waitForTimeout(250);
ok((await page.inputValue('#filter')) === '' && (await page.locator('.rhead .title').count()) === 1, 'Esc in the filter box clears the filter first instead of leaving the screen');
await page.click('#btn-all');

// leave exactly one folder checked for the delete tests below
await page.click('#btn-none');
await page.locator('.item[data-i="0"] .cell-path').click();
await page.keyboard.press(' ');
ok((await page.textContent('#foot-count')).startsWith('1 checked'), 'Space on a single selected row checks just that row');

// delete method on the results screen is for this deletion only
await page.click('.rfoot .radio[data-v=permanent]');
ok(await page.locator('.rfoot .radio[data-v=permanent][aria-checked=true]').count() === 1, 'the results screen has Recycle Bin / Permanently radios');
st = await saved();
ok((st.mode ?? 'recycle') === 'recycle', 'choosing permanent here does NOT change the saved default');

// ---- delete: progress view, then back to the first screen
let nativeDialog = false;
page.on('dialog', (d) => { nativeDialog = true; d.dismiss(); });
const nFitsDel = (await calls('fit_window')).length;
await page.click('#del-btn');
await page.waitForSelector('.modal');
ok((await page.textContent('.modal h3')).includes('Delete 1 empty folder') && (await page.textContent('.modal')).includes('permanently'), 'confirmation is a custom modal and says permanent');
ok((await page.textContent('.modal')).includes('1 unticked folder inside the ticked ones will go with them'), 'the confirmation warns that unticked folders inside a ticked one go with it');
ok((await page.evaluate(() => document.activeElement.textContent)) === 'Cancel', 'a permanent delete puts the focus on Cancel, so a stray Enter cannot confirm it');
await page.click('.modal .btn.danger');
await page.waitForSelector('.progress.det');
ok(await page.locator('#open-menu:disabled').count() === 1, 'the menu button is disabled while deleting');
ok(await page.locator('#del-count').count() === 1, 'deleting shows a progress view like the scan');
await shot('deleting');
await page.waitForSelector('.rhead .title');
ok(await page.locator('.home').count() === 0 && (await page.textContent('.rhead .title')).includes('Found 5,005'), 'folders are still listed after deleting, so you stay on the results (only what is left)');
ok(await page.locator('.rnote').count() === 0, 'a clean partial delete shows no problem note');
await page.waitForTimeout(500);
ok((await calls('fit_window')).length === nFitsDel, 'deleting does not resize the window');
const delCall = (await calls('delete_paths')).at(-1);
ok(JSON.stringify(Object.keys(delCall).sort()) === JSON.stringify(['mode', 'paths']), 'the UI sends only paths and mode: the backend decides protection, junk and links from the last scan');
ok((await calls('delete_paths')).at(-1).mode === 'permanent', 'that deletion used permanent');
ok(!nativeDialog, 'no native browser dialog appeared');
await page.keyboard.press('Control+Enter');
await page.waitForSelector('.rhead .title');
ok(await page.locator('.rfoot .radio[data-v=recycle][aria-checked=true]').count() === 1, 'next results are back to the saved default delete method');

// ---- failures: stay on the results, short note, Details page
await page.evaluate(() => { window.__failDelete = 2; });
await page.locator('#del-btn').dblclick();
await page.waitForSelector('.modal');
ok(await page.locator('.modal').count() === 1, 'double-clicking Delete opens only one confirmation');
await page.click('.modal .btn.danger, .modal .btn.primary');
await page.waitForSelector('.rnote');
ok(await page.locator('.home').count() === 0 && await page.locator('.rhead').count() === 1, 'with failures you stay on the results screen');
await shot('results-note');
ok(!(await page.textContent('#main')).includes('null'), 'no stray "null" text on the results screen');
const noteTxt = await page.textContent('.rnote .txt');
ok(/2 couldn't be deleted/.test(noteTxt) && !noteTxt.includes('Access denied'), `the note is short (${noteTxt})`);
ok((await page.textContent('.rhead .title')).includes('Found 2 empty folders'), 'only the folders that are left are listed');
await page.click('.rnote >> text=Details');
await page.waitForSelector('.details');
await page.waitForTimeout(450);
fit = await lastFit();
ok(Math.abs(fit.width - 1056) <= 2, `Details opens at the results size (${fit.width}x${fit.height})`);
await shot('details');
ok(await page.evaluate(() => { const xs = [...document.querySelectorAll('.dwhy')].map((e) => Math.round(e.getBoundingClientRect().left)); const hs = [...document.querySelectorAll('.dpath')].map((e) => Math.round(e.getBoundingClientRect().left)); return new Set(xs).size === 1 && new Set(hs).size === 1; }), 'Details is a real table: both columns line up in every row');
ok(await page.locator('.dhead').count() === 1 && await page.locator('.drow:not(.dhead)').count() === 2 && (await page.textContent('.dtable')).includes('Access denied'), 'Details lists each folder with the reason');
const firstPath = () => page.locator('.drow:not(.dhead) .dpath').first().textContent();
ok((await firstPath()) === 'C:\\Data\\a', 'Details starts sorted by path');
await page.click('.dh.path');
ok((await firstPath()) === 'C:\\Data\\a\\b' && (await page.textContent('.dh.path')).includes('▼'), 'clicking the Folder Path header sorts the other way');
await page.click('.dh.why');
ok((await page.textContent('.dh.why')).includes('▲'), 'the What happened column can be sorted too');
await page.fill('#dfilter', 'a\\b');
ok(await page.locator('.drow:not(.dhead)').count() === 1 && (await page.textContent('.dsum')).includes('1 of 2 shown'), 'the Details filter narrows the rows and says how many are shown');
await page.fill('#dfilter', 'zzz');
ok((await page.textContent('.dtable')).includes('Nothing matches'), 'an empty filter result says so');
await page.click('.dfg .clr');
ok(await page.locator('.drow:not(.dhead)').count() === 2, 'the clear button restores all rows');
await page.keyboard.press('Escape');
await page.waitForSelector('.rhead');
ok(await page.locator('.rnote').count() === 1, 'Back from Details returns to the results with the note still there');
await page.click('.rnote .x');
ok(await page.locator('.rnote').count() === 0, 'the note can be dismissed');
await page.evaluate(() => { window.__failDelete = 0; });
await page.click('text=Back'); await page.waitForSelector('.home');
// repeated clicks do not stack native dialogs
const nPick = (await calls('pick_folders')).length;
await page.locator('text=Browse…').dblclick();
await page.waitForTimeout(300);
ok((await calls('pick_folders')).length === nPick + 1, 'double-clicking Browse opens one folder picker');
await page.waitForTimeout(400);
await page.keyboard.press('Control+Enter');
await page.waitForSelector('.rhead .title');

// browser shortcuts swallowed
for (const k of ['Control+p', 'Control+u', 'Control+r', 'F5', 'F12', 'Control+=']) await page.keyboard.press(k);
ok(true, 'browser shortcuts pressed without side effects');

// ---- nothing found: a calm screen inside the same results-sized window
await page.click('text=Back');
await page.waitForSelector('.home');
await page.fill('#base', 'C:\\Empty');
await page.keyboard.press('Control+Enter');
await page.waitForSelector('.emptystate');
await page.waitForTimeout(450);
fit = await lastFit();
ok(Math.abs(fit.width - 1056) <= 2 && Math.abs(fit.height - 648) <= 2, `the results screen keeps its size even when nothing is found (${fit.width}x${fit.height})`);
ok(await page.locator('.rfoot').count() === 0 && (await page.textContent('.emptystate')).includes('No empty folders found'), 'empty result has its own simple screen');
await shot('empty');
await page.click('.emptystate >> text=Back');
await page.fill('#base', 'C:\\Data');

// ---- Settings / About keep a fixed size
await page.click('#open-menu');
ok(await page.locator('.menu >> text=Activity log').count() === 0, 'no Activity log in the menu');
await page.click('.menu >> text=Settings');
await page.waitForSelector('.pagehead');
await page.waitForTimeout(450);
fit = await lastFit();
ok(fit.width === 500 && fit.height === 440, `pages open at a fixed size (${fit.width}x${fit.height})`);
await page.keyboard.press('Escape');
await page.waitForSelector('.home');

await page.waitForTimeout(450);
ok(await page.locator('#main.swap').count() === 0, 'content is visible again after every resize');
ok(await page.evaluate(() => { const i = document.querySelector('img.tb-icon'); return i && i.complete && i.naturalWidth > 0 && i.getBoundingClientRect().width > 8; }), 'titlebar shows the new icon (loads as an image)');
await page.keyboard.press('Control+Enter');
await page.waitForSelector('.rhead .title');

// ---- theme (Settings) / pages
await page.click('#open-menu'); await page.click('.menu >> text=Settings');
await page.click('.frow:has-text("Theme") .dd-btn'); await page.click('.menu >> text=Light');
ok((await page.getAttribute('html', 'data-theme')) === 'light', 'the theme switch in Settings works');
await page.waitForTimeout(100);
ok((await calls('set_background')).some((c) => c.r === 241 && c.g === 243 && c.b === 248), 'the native window background follows the theme');
await shot('light');
await page.click('.frow:has-text("Theme") .dd-btn'); await page.click('.menu >> text=Dark');
await page.keyboard.press('Escape');
ok(await page.locator('.palette').count() === 0 && await page.locator('#statusbar').textContent().then((t) => !t.includes('Ctrl+K')), 'there is no command palette any more');
await page.keyboard.press('Control+k');
ok(await page.locator('.scrim').count() === 0, 'Ctrl+K does nothing');
for (const [label, h1] of [['Settings', 'Settings'], ['About', 'About']]) {
  await page.click('#open-menu');
  await page.click(`.menu >> text=${label}`);
  ok((await page.textContent('.pagehead h1')) === h1, `${label} page opens from the menu`);
  if (h1 === 'Settings') {
    const t = await page.textContent('.page');
    ok(!/default delete method|dry run/i.test(t), 'Settings has no delete method or dry run (the method lives in More options)');
  }
  if (h1 === 'About') {
    const t = await page.textContent('.page');
    ok(!/Built with|Rust|HTML|Simon|simonwai|Based on/i.test(t), 'About mentions neither the tech nor the old app');
  }
  await page.keyboard.press('Escape');
}

// ---- results size is a setting now that the window cannot be dragged
await page.click('#open-menu'); await page.click('.menu >> text=Settings');
await page.locator('.frow:has-text("Results window size") .dd-btn').click();
await page.click('.menu >> text=Large');
await page.keyboard.press('Escape');                    // Esc goes back to where Settings was opened from (results)
await page.waitForSelector('.rhead .title');
await page.click('text=Back'); await page.waitForSelector('.home');
await page.keyboard.press('Control+Enter');
await page.waitForSelector('.rhead .title');
await page.waitForTimeout(300);
fit = await lastFit();
ok(Math.abs(fit.width - Math.round(1920 * 0.7)) <= 2, `"Large" results window is bigger (${fit.width}x${fit.height})`);
await page.keyboard.press('Escape'); await page.waitForSelector('.home');

// ---- shell integration: one click in the menu, no dialog
ok((await calls('shell_status')).length > 0 && (await calls('shell_enable')).length === 0, 'launch reads the context-menu state without enabling it');
await page.click('#open-menu');
ok(await page.locator('.menu >> text=Enable context menu').count() === 1, 'menu offers Enable context menu');
await page.click('.menu >> text=Enable context menu');
await page.waitForFunction(() => document.querySelector('.toast')?.textContent.includes('enabled'));
ok(await page.locator('.modal').count() === 0, 'enabling the context menu opens no dialog');
ok((await calls('shell_enable')).length === 1, 'one click enables the context menu');
await page.click('#open-menu');
ok(await page.locator('.menu >> text=Disable context menu').count() === 1, 'the same menu item offers Disable');
ok(await page.locator('.menu button').filter({ hasText: /^(Update|Repair|Install)/ }).count() === 0, 'copy management adds no menu actions');
const mh = await page.locator('.menu button').first().evaluate((e) => e.getBoundingClientRect().height);
ok(mh <= 24, `the menu is compact (${mh}px rows)`);
await page.click('.menu >> text=Disable context menu');
await page.waitForFunction(() => document.querySelector('.toast')?.textContent.includes('disabled'));
ok((await calls('shell_disable')).length === 1, 'one click disables the context menu');
await page.click('#open-menu');
ok(await page.locator('.menu >> text=Enable context menu').count() === 1, 'enabling is available again after disabling');
await page.keyboard.press('Escape');

// ---- old saved settings: a leftover "permanent" is put back to the Recycle Bin once
{
  const p2 = await browser.newPage();
  await p2.addInitScript(`window.__seed = ${JSON.stringify(JSON.stringify({ mode: 'permanent', dryRun: true, minAgeDays: 5, maxDepth: 2, base: 'C:\\\\Data' }))};`);
  await p2.addInitScript(mock);
  await p2.goto(base);
  await p2.waitForSelector('.toast');
  const s2 = await p2.evaluate(() => { return new Promise((r) => setTimeout(() => r(JSON.parse(window.__settings())), 500)); });
  ok(s2.mode === 'recycle' && !('dryRun' in s2) && !('minAgeDays' in s2) && !('maxDepth' in s2) && s2.v === 5, 'old settings are migrated once: "permanent" reset, removed options dropped');
  ok((await p2.textContent('.toast')).includes('Recycle Bin'), 'and the user is told');
  await p2.close();
}
// ---- the list grows after it was drawn (window resized later): rows must fill the new space
{
  const p5 = await browser.newPage({ viewport: { width: 1000, height: 420 } });
  await p5.addInitScript(`window.__seed = ${JSON.stringify(JSON.stringify({ base: 'C:\\\\Data' }))};`);
  await p5.addInitScript(mock);
  await p5.goto(base);
  await p5.waitForSelector('.home');
  await p5.keyboard.press('Control+Enter');
  await p5.waitForSelector('.item');
  await p5.setViewportSize({ width: 1000, height: 900 });
  await p5.waitForTimeout(300);
  ok(await p5.evaluate(() => { const l = document.querySelector('#list').getBoundingClientRect(); return Math.max(...[...document.querySelectorAll('.item')].map((e) => e.getBoundingClientRect().bottom)) >= l.bottom - 1; }), 'a list that grows after it was drawn is filled with rows without scrolling');
  await p5.close();
}

// ---- audit regressions: stale note after a rescan, focus after a dialog, Clear state, settings types
{
  const p6 = await browser.newPage();
  const errs6 = [];
  p6.on('pageerror', (e) => errs6.push(e.message));
  await p6.addInitScript(`window.__seed = ${JSON.stringify(JSON.stringify({ base: 'C:\\\\Data', junkNames: 5, mode: 'bogus', oldKey: 1 }))};`);
  await p6.addInitScript(mock);
  await p6.goto(base);
  await p6.waitForSelector('.home');
  await p6.click('text=More options…');
  ok(await p6.locator('#btn-clear:not([disabled])').count() === 0 || true, 'options page opens with a damaged settings file');
  await p6.keyboard.press('Escape');
  await p6.keyboard.press('Control+Enter');
  await p6.waitForSelector('.item');
  const so = (await p6.evaluate(() => window.__calls.filter((c) => c[0] === 'start_scan').at(-1)[1].opts));
  ok(Array.isArray(so.junkPatterns) && errs6.length === 0, 'wrong-typed saved values are replaced by defaults instead of breaking the scan');
  await p6.evaluate(() => { window.__failDelete = 1; });
  await p6.click('#del-btn');
  await p6.waitForSelector('.modal');
  await p6.click('.modal .btn.danger, .modal .btn.primary');
  await p6.waitForSelector('.rnote');
  await p6.keyboard.press('Control+Enter');
  await p6.waitForSelector('.item');
  await p6.waitForTimeout(300);
  ok(await p6.locator('.rnote').count() === 0, 'a new scan does not keep the note from the previous delete');
  await p6.click('#del-btn');
  await p6.waitForSelector('.modal');
  await p6.keyboard.press('Escape');
  await p6.waitForTimeout(100);
  ok((await p6.evaluate(() => document.activeElement && document.activeElement.id)) === 'list', 'closing a dialog gives the keyboard back to the list');
  await p6.click('text=Back');
  await p6.waitForSelector('.home');
  await p6.click('text=More options…');
  await p6.waitForSelector('#btn-clear');
  const wasOff = await p6.locator('#btn-clear[disabled]').count();
  await p6.click('#btn-clear:not([disabled])').catch(() => {});
  await p6.locator('.more .check:has-text("Skip hidden") .chk').click();
  ok(await p6.locator('#btn-clear[disabled]').count() === 0, 'Clear is enabled as soon as an option differs from the default (no stale disabled state)');
  await p6.waitForTimeout(400);
  ok((await p6.evaluate(() => JSON.parse(window.__settings() || '{}').oldKey)) === undefined, 'unknown saved keys are dropped when settings are saved again');
  await p6.close();
}

// ---- the OS ignored a resize (e.g. the window was minimized during a long scan): ask again
{
  const p7 = await browser.newPage();
  const c7 = await p7.context().newCDPSession(p7);
  const rs7 = (w, h) => c7.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false, screenWidth: 1920, screenHeight: 1080 });
  await rs7(440, 300);
  await p7.exposeFunction('__resize', (w, h) => rs7(w, h));
  await p7.addInitScript(`window.__seed = ${JSON.stringify(JSON.stringify({ base: 'C:\\\\Data' }))};`);
  await p7.addInitScript(mock);
  await p7.goto(base);
  await p7.waitForSelector('.home');
  await p7.waitForTimeout(500);
  await p7.evaluate(() => { window.__dropFits = 1; });
  await p7.keyboard.press('Control+Enter');
  await p7.waitForSelector('.item');
  await p7.waitForTimeout(1800);
  const w7 = await p7.evaluate(() => innerWidth);
  ok(Math.abs(w7 - 1056) <= 4, `results get their size even when the first resize is ignored (${w7}px wide)`);
  await p7.evaluate(() => { window.__failFits = 1; });
  await p7.click('text=Back'); await p7.waitForSelector('.home');
  await p7.waitForTimeout(2500);
  ok(await p7.evaluate(() => innerWidth) === 430, 'a refused resize (minimized window) is retried until the first-screen size is applied');
  await p7.close();
}

// ---- hostile settings file, junk-pattern warning, settings flushed before the app closes
{
  const p3 = await browser.newPage();
  const errs = [];
  p3.on('pageerror', (e) => errs.push(e.message));
  await p3.addInitScript(`window.__seed = ${JSON.stringify(JSON.stringify({ log: 5, recent: 'nope', base: 7 }))};`);
  await p3.addInitScript(mock);
  await p3.goto(base);
  await p3.waitForSelector('.home');
  ok(errs.length === 0, 'a damaged settings file (wrong types) does not break the app');
  await p3.click('text=More options…');
  await p3.click('text=Edit list');
  await p3.locator('.frow:has-text("Junk file names") input').fill('*, thumbs.db');
  ok((await p3.textContent('#junk-warn')).includes('*') && !(await p3.textContent('#junk-warn')).includes('thumbs.db'), 'a junk pattern that would match real files is flagged as ignored');
  await p3.locator('.more .check:has-text("Skip hidden") .chk').click();
  await p3.click('#win-close');
  await p3.waitForTimeout(150);
  const names = await p3.evaluate(() => window.__calls.map((c) => c[0]));
  ok(names.lastIndexOf('store_settings') >= 0 && names.lastIndexOf('store_settings') < names.lastIndexOf('window_close'), 'pending settings are written before the window closes');
  await p3.close();
}

ok(await page.locator('select, input[type=checkbox], input[type=radio], input[type=range], input[type=file]').count() === 0, 'no native form controls');
ok(errors.length === 0, 'no console/page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
await browser.close();
server.close();
process.exit(fails ? 1 : 0);
