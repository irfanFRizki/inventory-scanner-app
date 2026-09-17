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

## 1. Persiapan awal (sekali saja)

```bash
# 1. Install semua dependency
npm install

# 2. Buat proyek native Android (folder android/ akan dibuat oleh Capacitor CLI)
npx cap add android

# 3. Sinkronkan plugin ke proyek Android
npx cap sync android
```

Setelah `npx cap add android`, tambahkan baris ini di
`android/app/src/main/AndroidManifest.xml` (biasanya sudah otomatis ada lewat
manifest plugin, tapi cek untuk memastikan akses internet & jaringan lokal
untuk Web App GAS):

```xml
<uses-permission android:name="android.permission.INTERNET" />
```

> Kamera **tidak perlu** minta permission manual di manifest — Google Code
> Scanner (yang dipakai lewat `@capacitor-mlkit/barcode-scanning` method
> `scan()`) menangani izin kameranya sendiri lewat UI Google Play Services.

Commit folder `android/` yang baru dibuat itu ke git (lihat `.gitignore` —
hanya hasil build & keystore yang di-ignore, folder `android/` sendiri **harus**
ikut commit karena dipakai GitHub Actions).

Coba jalankan dulu di Android Studio (`npx cap open android`) untuk memastikan
semua jalan sebelum setup CI.

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

Kalau nama repo kamu berbeda dari `irfanFRizki/inventory-scanner-app`, update
konstanta `GITHUB_REPO` di `www/app.js` (dipakai fitur "Cek Update").

---

## 3. Setup keystore & GitHub Secrets (untuk build APK ter-signed otomatis)

Buat keystore sekali saja (simpan baik-baik, jangan sampai hilang — dibutuhkan
lagi setiap update APK):

```bash
keytool -genkey -v -keystore release.keystore -alias scanner-gudang \
  -keyalg RSA -keysize 2048 -validity 10000
```

Encode ke base64 untuk disimpan sebagai secret:

```bash
base64 -i release.keystore -o release.keystore.b64
cat release.keystore.b64
```

Di GitHub: **Settings → Secrets and variables → Actions → New repository secret**,
tambahkan 4 secret ini:

| Nama secret         | Isi                                      |
|----------------------|-------------------------------------------|
| `KEYSTORE_BASE64`    | isi file `release.keystore.b64`           |
| `KEYSTORE_PASSWORD`  | password keystore yang kamu buat          |
| `KEY_ALIAS`          | `scanner-gudang` (atau alias yang dipakai)|
| `KEY_PASSWORD`       | password key (biasanya sama dgn keystore) |

---

## 4. Build APK otomatis lewat GitHub Actions

Workflow `.github/workflows/build-release.yml` jalan otomatis setiap kamu push
git tag berawalan `v`, dan langsung meng-inject nomor versi tag itu ke
`APP_VERSION` di aplikasi + membuat GitHub Release dengan APK ter-signed sebagai
attachment.

```bash
git tag v1.0.0
git push origin v1.0.0
```

Setelah selesai (cek tab **Actions** di GitHub), APK bisa diunduh dari
**Releases** repo ini — tinggal instal ke HP (perlu izin "Instal dari sumber
tidak dikenal" untuk browser/file manager yang dipakai download, sekali saja).

Untuk build manual tanpa tag, buka tab **Actions → Build & Release APK → Run workflow**.

---

## 5. Rekomendasi pengembangan lanjutan (opsional)

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
└─ android/              # dibuat oleh `npx cap add android` (langkah 1)
```
