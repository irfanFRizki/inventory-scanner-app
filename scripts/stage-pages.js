/**
 * scripts/stage-pages.js
 *
 * Menyalin folder www/ ke direktori staging dan menyuntikkan WEB_SHEETS_API_KEY
 * dari environment variable ke salinan staging saja (source repo tidak diubah).
 */
const fs = require('fs');
const path = require('path');

const PLACEHOLDER = "'__WEB_SHEETS_API_KEY__'";
const apiKey = (process.env.WEB_SHEETS_API_KEY || '').trim();
const stagingArg = process.argv[2] || process.env.PAGES_STAGING_DIR;

if (!stagingArg) {
  console.error('Usage: node scripts/stage-pages.js <staging-dir>');
  process.exit(1);
}

if (!apiKey || apiKey === '__WEB_' + 'SHEETS_API_KEY__') {
  console.error('::error::WEB_SHEETS_API_KEY tidak tersedia atau masih placeholder. Set secret WEB_SHEETS_API_KEY di GitHub Actions.');
  process.exit(1);
}

const rootDir = path.resolve(__dirname, '..');
const srcDir = path.join(rootDir, 'www');
const stagingDir = path.resolve(stagingArg);

if (stagingDir === srcDir || stagingDir.startsWith(srcDir + path.sep)) {
  console.error('Staging directory tidak boleh di dalam www/.');
  process.exit(1);
}

fs.rmSync(stagingDir, { recursive: true, force: true });
fs.cpSync(srcDir, stagingDir, { recursive: true });

const stagedAppJsPath = path.join(stagingDir, 'app.js');
const appJs = fs.readFileSync(stagedAppJsPath, 'utf8');

if (appJs.indexOf(PLACEHOLDER) === -1) {
  console.error('Placeholder WEB_SHEETS_API_KEY tidak ditemukan di salinan staging app.js.');
  process.exit(1);
}

// Gunakan function replacer + JSON.stringify agar karakter khusus ($, ', \, newline)
// tidak pernah ditafsirkan sebagai pola penggantian atau menyuntik kode JS.
const injected = appJs.replace(PLACEHOLDER, () => JSON.stringify(apiKey));
fs.writeFileSync(stagedAppJsPath, injected, 'utf8');

const check = fs.readFileSync(stagedAppJsPath, 'utf8');
if (check.indexOf(PLACEHOLDER) !== -1) {
  console.error('Placeholder masih tersisa setelah injeksi.');
  process.exit(1);
}

console.log('Staged www/ ke ' + stagingDir + ' dengan WEB_SHEETS_API_KEY tersuntik (source repo tetap bersih).');
