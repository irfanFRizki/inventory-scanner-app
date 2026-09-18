# Scanner Gudang (Capacitor Android)

Aplikasi Android 2 tab:

- **Tab "Scan Code"** — scan QR (Google Code Scanner via ML Kit, tanpa perlu
  izin kamera manual). Kalau isi QR berupa link, langsung dibuka otomatis
  (in-app browser / browser eksternal, sesuai Pengaturan).
- **Tab "Inventory"** — UI native: daftar stok berjalan per card (foto,
  pencarian, detail, riwayat transaksi), form catat **Masuk/Keluar** dengan
  hitung otomatis jumlah pcs dari total timbangan.

**Tidak memakai Google Apps Script sama sekali.** Aplikasi bicara langsung ke
Google Sheets lewat **Google Sheets API v4**, diotorisasi lewat **Sign-in
Google (OAuth 2.0, PKCE)** yang dilakukan di dalam aplikasi. Data dibaca/ditulis
langsung dari/ke sheet `Kalibrasi_Card` dan `Stock_Mutasi` di spreadsheet yang
kamu tentukan lewat **Spreadsheet ID**.

---

## 0. Setup Google Cloud Console (wajib, sekali saja)

1. Buka https://console.cloud.google.com/ → buat project baru (atau pakai yang
   sudah ada).
2. **APIs & Services → Library** → cari **Google Sheets API** → **Enable**.
3. **APIs & Services → OAuth consent screen**:
   - User type: **External** (kalau bukan Google Workspace) atau **Internal**
   - Isi nama app, email, dst. Scope tidak perlu ditambah manual (dipilih
     otomatis dari yang diminta aplikasi: `.../auth/spreadsheets` dan
     `.../auth/userinfo.email`)
   - Kalau app masih status **Testing**, tambahkan akun Google yang akan
     dipakai (termasuk akunmu sendiri) di bagian **Test users**
4. **APIs & Services → Credentials → Create Credentials → OAuth client ID**:
   - Application type: **Android**
   - Package name: `com.irfan.invscanner` (samakan dengan `capacitor.config.json`
     kalau kamu ubah `appId`)
   - SHA-1 certificate fingerprint: ambil dari keystore signing kamu:
     ```bash
     keytool -list -v -keystore ci/release.keystore -alias scanner-gudang -storepass scannergudang
     ```
     (keystore ini yang di-generate otomatis oleh GitHub Actions — lihat
     bagian 3. Kalau belum ada, build sekali dulu lewat `workflow_dispatch`
     manual di tab Actions supaya `ci/release.keystore` ter-generate & ter-commit,
     baru ambil SHA-1-nya)
   - Simpan — kamu akan mendapat **Client ID** berbentuk
     `xxxxxxxxxx-yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy.apps.googleusercontent.com`

5. Buka `www/app.js`, isi baris ini dengan Client ID yang kamu dapat:
   ```js
   var GOOGLE_OAUTH_CLIENT_ID = 'xxxxxxxxxx-yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy.apps.googleusercontent.com';
   ```
   Commit & push perubahan ini. **Wajib format satu baris string literal seperti
   itu** — `scripts/patch-android-manifest.js` membaca baris ini saat build CI
   untuk mendaftarkan redirect URI OAuth ke `AndroidManifest.xml` secara otomatis.

> Kenapa Client ID harus di source code (bukan diisi di Pengaturan app)?
> Karena redirect OAuth-nya lewat custom URI scheme
> (`com.googleusercontent.apps.<client-id>:/oauth2redirect`) yang harus
> didaftarkan ke Android **saat build**, bukan saat aplikasi jalan.
> Spreadsheet ID tidak punya keterbatasan ini — itu tetap bisa diubah
> kapan saja lewat Pengaturan di aplikasi.

Terakhir, share Google Sheet-nya (menu Share di kanan atas Google Sheets) ke
akun Google yang akan dipakai sign-in di aplikasi, dengan akses **Editor**.

---

## 1. Siapkan sheet di spreadsheet

Aplikasi memakai 2 sheet (tab) di spreadsheet, dengan kolom persis seperti ini
(baris pertama = header):

**Stock_Mutasi** (dibuat otomatis oleh aplikasi kalau belum ada):
```
Nama Card | Jenis | Jumlah Pcs | Total Timbangan | Tanggal | Keterangan | Qty per Iket Kecil
```

**Kalibrasi_Card** (buat manual, atau isi dari project GAS lama kamu kalau
sudah ada datanya — cukup salin/pindahkan sheet-nya ke spreadsheet baru):
```
Nama Card | Jumlah Part | Total Pcs Gabungan | Total Timbangan Gabungan | Berat per Pcs | Tanggal Update | Foto URL | Qty per Iket Kecil
```
Kolom **Berat per Pcs** (E) inilah yang dipakai fitur "Hitung dari Timbangan".
Aplikasi ini belum punya UI untuk mengisi kalibrasi baru (fitur kalibrasi
berat-per-pcs dari beberapa part timbangan) — kalau perlu, tinggal minta
ditambahkan tab "Kalibrasi" juga.

Ambil **Spreadsheet ID** dari URL sheet-nya:
```
https://docs.google.com/spreadsheets/d/SPREADSHEET_ID_DI_SINI/edit
```

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

GitHub tidak menerima password akun untuk `git push` — gunakan **Personal
Access Token** (Settings → Developer settings → Personal access tokens →
scope `repo` + `workflow`) sebagai password saat diminta.

---

## 3. Build APK — tanpa setup keystore/secrets manual

Workflow `.github/workflows/build-release.yml` mengurus semuanya:

- Folder `android/` dibuat otomatis tiap run (`npx cap add android`)
- `scripts/patch-android-manifest.js` menyisipkan intent-filter redirect OAuth
  ke `AndroidManifest.xml` berdasarkan `GOOGLE_OAUTH_CLIENT_ID` di `www/app.js`
- Keystore signing dibuat **otomatis sekali** di build pertama, lalu
  di-commit balik ke repo (folder `ci/`) supaya semua build berikutnya pakai
  tanda tangan yang sama — jadi update APK bisa menimpa versi lama tanpa
  perlu uninstall dulu

Build & rilis APK tinggal push tag:

```bash
git tag v1.0.0
git push origin v1.0.0
```

Untuk build manual (tanpa tag, mis. untuk ambil SHA-1 keystore pertama kali
di langkah 0), buka tab **Actions → Build & Release APK → Run workflow**.

---

## 4. Pemakaian di aplikasi

1. Install APK dari **Releases**.
2. Buka **Pengaturan** (ikon gear) → **Masuk dgn Google** → login & setujui
   izin akses Spreadsheet.
3. Isi **Spreadsheet ID**, tekan **Simpan**, lalu **Tes Koneksi**.
4. Buka tab **Inventory** — daftar stok akan termuat.

---

## 5. Rekomendasi pengembangan lanjutan (opsional)

- **Tab Kalibrasi** — mengisi berat-per-pcs dari beberapa part timbangan
  langsung dari aplikasi (saat ini kolom `Berat per Pcs` di `Kalibrasi_Card`
  masih perlu diisi manual/dari sumber lain).
- **Ikon & splash screen**: `npx capacitor-assets generate` dengan logo sendiri.
- **Auto-update dalam-app** (download+install APK dari dalam aplikasi):
  saat ini "Cek Update" hanya membuka halaman GitHub Release di browser.
- **Deploy ke Play Store**: build `bundleRelease` (.aab) alih-alih
  `assembleRelease`.

---

## Struktur folder

```
inventory-scanner-app/
├─ package.json
├─ capacitor.config.json
├─ www/
│  ├─ index.html            # UI 2 tab + modal Settings (sign-in Google, dst)
│  ├─ app.js                # OAuth PKCE, akses Sheets API langsung, logic scan
│  └─ vendor/                # Capacitor core + plugin (UMD, tanpa bundler)
├─ scripts/patch-android-manifest.js   # patch redirect URI OAuth ke manifest saat build
├─ .github/workflows/build-release.yml
└─ android/                  # TIDAK di-commit — dibuat otomatis oleh CI tiap build
```
