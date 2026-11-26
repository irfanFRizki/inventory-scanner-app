/**
 * scripts/test-secrets-isolation.js
 *
 * Memverifikasi bahwa:
 * - ci/release.keystore tidak ada di working tree dan ter-ignore di .gitignore
 * - workflow build APK memakai GitHub Secrets dan tidak memakai WEB_SHEETS_API_KEY
 * - workflow Pages menyuntikkan WEB_SHEETS_API_KEY ke salinan staging saja
 * - source APK (www/ dan aset Capacitor) hanya berisi placeholder
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const rootDir = path.resolve(__dirname, '..');
const PLACEHOLDER = "'__WEB_SHEETS_API_KEY__'";
const API_KEY_PATTERN = /AIza[0-9A-Za-z_-]{20,}/;

function checkApkAssets(dirPath) {
  const appJsPath = path.join(dirPath, 'app.js');
  assert(fs.existsSync(appJsPath), 'app.js tidak ditemukan di ' + dirPath);
  const content = fs.readFileSync(appJsPath, 'utf8');
  assert(content.includes(PLACEHOLDER), 'Placeholder WEB_SHEETS_API_KEY hilang dari ' + appJsPath);
  assert(!API_KEY_PATTERN.test(content), 'Terdeteksi API key Google tertanam di ' + appJsPath);
}

const apkDirFlagIdx = process.argv.indexOf('--apk-dir');
if (apkDirFlagIdx !== -1) {
  const targetDir = process.argv[apkDirFlagIdx + 1];
  assert(targetDir, 'Argumen --apk-dir membutuhkan path direktori.');
  checkApkAssets(path.resolve(targetDir));
  console.log('OK: APK source web assets bersih (hanya placeholder): ' + targetDir);
  process.exit(0);
}

// 1. Cek www/app.js di repo
checkApkAssets(path.join(rootDir, 'www'));

// 2. Cek ci/release.keystore tidak ada & ter-ignore
assert(!fs.existsSync(path.join(rootDir, 'ci', 'release.keystore')), 'ci/release.keystore masih ada di working tree');
const gitignore = fs.readFileSync(path.join(rootDir, '.gitignore'), 'utf8');
assert(!gitignore.includes('!ci/release.keystore'), '.gitignore masih memaksa include ci/release.keystore');
assert(/^\s*ci\/release\.keystore\s*$/m.test(gitignore), '.gitignore harus meng-ignore ci/release.keystore');

// 3. Cek build-release.yml
const buildYml = fs.readFileSync(path.join(rootDir, '.github', 'workflows', 'build-release.yml'), 'utf8');
assert(!buildYml.includes('KS_PASS'), 'build-release.yml masih memuat KS_PASS');
assert(!buildYml.includes('scannergudang'), 'build-release.yml masih memuat password hardcoded');
assert(!buildYml.includes('keytool -genkeypair'), 'build-release.yml masih meng-generate keystore');
assert(!/secrets\.WEB_SHEETS_API_KEY/.test(buildYml) && !/^\s*WEB_SHEETS_API_KEY\s*:/m.test(buildYml), 'build-release.yml tidak boleh menerima WEB_SHEETS_API_KEY');
for (const secretName of ['RELEASE_KEYSTORE_BASE64', 'RELEASE_KEYSTORE_PASSWORD', 'RELEASE_KEY_ALIAS', 'RELEASE_KEY_PASSWORD']) {
  assert(buildYml.includes(secretName), 'build-release.yml belum memakai secret ' + secretName);
}

// 4. Cek pages.yml
const pagesYml = fs.readFileSync(path.join(rootDir, '.github', 'workflows', 'pages.yml'), 'utf8');
assert(pagesYml.includes('WEB_SHEETS_API_KEY: ${{ secrets.WEB_SHEETS_API_KEY }}'), 'pages.yml harus mengirim WEB_SHEETS_API_KEY lewat env');
assert(pagesYml.includes('scripts/stage-pages.js'), 'pages.yml harus memanggil scripts/stage-pages.js');
assert(!/^\s*path:\s*www\s*$/m.test(pagesYml), 'pages.yml tidak boleh mengunggah folder www mentah');

// 5. Cek syntax JS semua script dan aset web
for (const rel of ['www/app.js', 'www/lokasi3d.js', 'scripts/patch-android-manifest.js', 'scripts/stage-pages.js']) {
  const res = spawnSync(process.execPath, ['--check', path.join(rootDir, rel)], { encoding: 'utf8' });
  assert.strictEqual(res.status, 0, 'Syntax check gagal untuk ' + rel + ': ' + res.stderr);
}

// 6. Uji fungsional scripts/stage-pages.js (staging vs APK isolation)
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'inv-scanner-test-'));
try {
  const stagingDir = path.join(tmpRoot, 'pages-staging');
  const apkSimDir = path.join(tmpRoot, 'apk-assets-sim');
  const stageScript = path.join(rootDir, 'scripts', 'stage-pages.js');

  // Harus gagal jika secret kosong
  const emptyRun = spawnSync(process.execPath, [stageScript, stagingDir], {
    env: Object.assign({}, process.env, { WEB_SHEETS_API_KEY: '' }),
    encoding: 'utf8'
  });
  assert.notStrictEqual(emptyRun.status, 0, 'stage-pages.js harus gagal saat WEB_SHEETS_API_KEY kosong');

  // Uji injeksi dengan karakter khusus ($, ', ", \) untuk memastikan tidak ada command/JS injection
  const dummyKey = 'dummy-test-key-$&-\'-"-\\-12345';
  const okRun = spawnSync(process.execPath, [stageScript, stagingDir], {
    env: Object.assign({}, process.env, { WEB_SHEETS_API_KEY: dummyKey }),
    encoding: 'utf8'
  });
  assert.strictEqual(okRun.status, 0, 'stage-pages.js gagal: ' + okRun.stderr);
  assert(!okRun.stdout.includes(dummyKey), 'stage-pages.js tidak boleh mencetak secret ke stdout');
  assert(!okRun.stderr.includes(dummyKey), 'stage-pages.js tidak boleh mencetak secret ke stderr');

  const stagedAppJsPath = path.join(stagingDir, 'app.js');
  const stagedContent = fs.readFileSync(stagedAppJsPath, 'utf8');
  assert(!stagedContent.includes(PLACEHOLDER), 'Placeholder masih ada di salinan staging');

  const syntaxStaged = spawnSync(process.execPath, ['--check', stagedAppJsPath], { encoding: 'utf8' });
  assert.strictEqual(syntaxStaged.status, 0, 'Salinan staging app.js tidak valid secara sintaks: ' + syntaxStaged.stderr);

  const match = stagedContent.match(/var\s+WEB_SHEETS_API_KEY\s*=\s*("(?:\\.|[^"\\])*")\s*;/);
  assert(match, 'Baris WEB_SHEETS_API_KEY di salinan staging tidak ditemukan');
  assert.strictEqual(JSON.parse(match[1]), dummyKey, 'Nilai WEB_SHEETS_API_KEY di staging tidak cocok persis');

  // Source repo harus tetap tidak tersentuh
  const repoAppJs = fs.readFileSync(path.join(rootDir, 'www', 'app.js'), 'utf8');
  assert(repoAppJs.includes(PLACEHOLDER), 'www/app.js di repo termodifikasi');
  assert(!repoAppJs.includes('dummy-test-key-'), 'Key bocor ke www/app.js di repo');

  // Simulasi build APK: hanya menyalin www/ tanpa stage-pages.js
  fs.cpSync(path.join(rootDir, 'www'), apkSimDir, { recursive: true });
  checkApkAssets(apkSimDir);
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

console.log('ALL CHECKS PASSED: secret isolation, staging injection, dan APK placeholder verified.');
