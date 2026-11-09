// Renders src-tauri/icons/icon.svg to PNGs with Chromium and prints them as base64 JSON for
// tools/make-ico.py. Run: node tools/make-icon.mjs  (see root CLAUDE.md for the Playwright path)
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const svg = fs.readFileSync(path.join(root, 'src-tauri/icons/icon.svg'), 'utf8');
const browser = await chromium.launch();
const out = {};
for (const size of [16, 20, 24, 32, 40, 48, 64, 128, 256]) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(`<body style="margin:0;background:transparent">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body>`);
  out[size] = (await page.screenshot({ omitBackground: true })).toString('base64');
  await page.close();
}
await browser.close();
fs.writeFileSync(process.argv[2] || '/tmp/icons.json', JSON.stringify(out));
