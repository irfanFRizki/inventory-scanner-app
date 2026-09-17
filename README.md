# Scanner Gudang (Capacitor Android)

Aplikasi Android 2 tab, mirip pola `xp-scanner`:

- **Tab "Scan Code"** — scan QR (pakai Google Code Scanner via ML Kit, tanpa perlu
  izin kamera manual). Kalau isi QR berupa link (contoh: QR dari `barcode.txt` /
  form "Catat Barang Keluar"), link itu **langsung dibuka otomatis** (in-app
  browser atau browser eksternal, sesuai Pengaturan).
- **Tab "Inventory"** — **UI native di dalam aplikasi** (bukan lagi iframe ke
  Web App GAS). Menampilkan daftar stok berjalan per card lengkap dengan foto,
  pencarian, detail stok, riwayat transaksi, serta form catat **Masuk/Keluar**
  (bisa hitung otomatis jumlah pcs dari total timbangan memakai data kalibrasi).
  Data diambil dari Google Sheets lewat endpoint JSONP di Apps Script, dan
  di-cache di HP sehingga daftar terakhir tetap bisa dilihat saat offline.

- **Pengaturan (ikon gear kanan atas)**:
  - Ubah URL Web App Inventory (tersimpan permanen di HP, bisa di-reset ke default)
  - Buka hasil scan di: in-app browser / browser eksternal
  - Konfirmasi sebelum membuka link (biar tidak asal-buka link tak dikenal)
  - Getar (haptic) saat scan berhasil
  - Mode "Hanya QR Code" (matikan kalau mau scan barcode 1D biasa juga)
  - Auto-refresh Inventory setiap pindah tab
  - Riwayat scan (50 terakhir) + tombol hapus
  - Cek Update (baca rilis terbaru dari GitHub Releases repo ini)

Semua source web app ada di `www/` (vanilla HTML/CSS/JS, tanpa framework/bundler
— sama seperti tool-tool HTML kamu yang lain), dengan Capacitor plugin yang sudah
disiapkan sebagai file UMD siap-pakai di `www/vendor/` (sudah diverifikasi dari
paket npm resminya, jadi tidak perlu proses build/bundle tambahan untuk JS-nya).

---

## 0. Pasang endpoint API di Apps Script (wajib, sekali saja)

Aplikasi tidak lagi membuka halaman GAS, tapi mengambil datanya langsung.
Agar itu bisa jalan, project Apps Script `Card dan Plastik WH MLN lt5` perlu
tambahan endpoint:

1. Buka project Apps Script-nya.
2. Buat file baru bernama **Api** (`Api.gs`), paste seluruh isi
   `gas/Api.gs` dari repo ini.
3. Di `Code.gs`, **hapus fungsi `doGet()` yang lama** (sudah digantikan oleh
   `doGet()` di `Api.gs`, yang tetap menyajikan halaman HTML seperti biasa
   kalau dibuka lewat browser).
4. **Deploy > Manage deployments > edit (ikon pensil) > Version: New version >
   Deploy.** Pastikan *Who has access* = **Anyone**.
5. Salin URL `/exec`-nya ke aplikasi: **Pengaturan > URL API Inventory**, lalu
   tekan **Tes Koneksi** untuk memastikan tersambung.

Opsional tapi disarankan: isi Script Property `API_TOKEN`
(*Project Settings > Script properties*) dengan kata sandi acak, lalu isi token
yang sama di **Pengaturan > Token API** di aplikasi. Tanpa ini, siapa pun yang
tahu URL `/exec` bisa memanggil API-nya.

Endpoint yang tersedia: `stockList`, `history`, `calibrations`, `summary`,
`hitung`, `trx`, `ping`.

---

## 1. Persiapan awal (sekali saja, opsional — untuk coba lokal)

GitHub Actions yang akan melakukan build sesungguhnya (lihat bagian 4), jadi
langkah ini hanya perlu kalau kamu mau coba jalankan/tes di Android Studio
sendiri:

```bash
npm install
npx cap add android
npx cap sync android
npx cap open android
```

Folder `android/` **tidak** perlu (dan sebaiknya tidak) di-commit — di
GitHub Actions folder ini dibuat ulang otomatis setiap build lewat
`npx cap add android`, supaya proyek native selalu fresh sesuai
`capacitor.config.json` & versi plugin terbaru di `package.json`.

---

## 2. Push ke GitHub

```bash
git init
git add .
git commit -m "Initial commit: Scanner Gudang app"
git branch -M main
git remote add origin https://github.com/irfanFRizki/inventory-scanner-app.git
git push -u origin main
```

GitHub sudah tidak menerima password akun untuk `git push` — gunakan
**Personal Access Token** (Settings → Developer settings → Personal access
tokens → scope `repo` + `workflow`) sebagai password saat diminta.

Kalau nama repo kamu berbeda dari `irfanFRizki/inventory-scanner-app`, update
konstanta `GITHUB_REPO` di `www/app.js` (dipakai fitur "Cek Update").

---

## 3. Build APK — tanpa setup keystore/secrets manual

Workflow `.github/workflows/build-release.yml` mengurus semuanya sendiri:

- Folder `android/` dibuat otomatis tiap run (`npx cap add android`)
- Keystore signing dibuat **otomatis sekali** di build pertama, lalu
  di-commit balik ke repo (folder `ci/`) supaya semua build berikutnya
  pakai tanda tangan yang sama — jadi update APK bisa menimpa versi lama
  tanpa perlu uninstall dulu
- Password keystore-nya statis (`scannergudang`, ada di dalam file
  workflow) — cukup aman untuk APK internal gudang yang dibagikan sendiri;
  kalau nanti repo ini dibuat publik, pindahkan ke GitHub Secrets

Build & rilis APK tinggal push tag:

```bash
git tag v1.0.0
git push origin v1.0.0
```
## 4. Rekomendasi pengembangan lanjutan (opsional)

- **Auto-update dalam-app** (download+install APK dari dalam aplikasi tanpa ke
  Play Store/browser) bisa ditambahkan menyusul pola `ApkInstallerPlugin.java`
  custom seperti di `xp-scanner` (`@capacitor/filesystem` + `FileProvider` +
  `REQUEST_INSTALL_PACKAGES`). Sengaja belum disertakan di versi awal ini biar
  lebih ringan diverifikasi; sekarang "Cek Update" hanya membuka halaman
  Release-nya di browser untuk diunduh manual.
- **Ikon & splash screen**: pakai `@capacitor/assets` (`npx capacitor-assets generate`)
  dengan logo kamu sendiri.
- **Deploy ke Play Store**: build `bundleRelease` (.aab) alih-alih `assembleRelease`
  kalau nanti mau upload ke Play Console.

---

## Struktur folder

```
inventory-scanner-app/
├─ package.json
├─ capacitor.config.json
├─ www/
│  ├─ index.html        # UI 2 tab + modal Settings
│  ├─ app.js            # logic scan, inventory native, API JSONP, preferences
│  └─ vendor/           # Capacitor core + plugin (UMD, tanpa bundler)
├─ gas/Api.gs           # endpoint JSONP untuk dipasang di Apps Script
├─ .github/workflows/build-release.yml
└─ android/              # TIDAK di-commit — dibuat otomatis oleh CI tiap build
```
