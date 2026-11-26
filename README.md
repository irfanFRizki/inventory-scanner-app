# Scanner Gudang (Capacitor Android)

Aplikasi Android (Scan, Inventory, Stok, Mutasi, Kalibrasi, Lokasi):

- **Tab "Scan Code"** — scan QR (Google Code Scanner via ML Kit, tanpa perlu
  izin kamera manual). Kalau isi QR berupa link, langsung dibuka otomatis
  (in-app browser / browser eksternal, sesuai Pengaturan).
- **Tab "Inventory"** — UI native: daftar stok berjalan per card (foto,
  pencarian, detail, riwayat transaksi), form catat **Masuk/Keluar** dengan
  hitung otomatis jumlah pcs dari total timbangan.

- **Tab "Lokasi"** — peta gudang **3D**: tiap rak digambar sebagai rak bersusun,
  tiap card sebagai kotak di susun/level-nya, diwarnai status stok (hijau aman,
  kuning hampir habis, merah habis). Geser = putar, 2 jari = zoom/geser, ketuk
  card = info lokasi + tombol Detail/Ubah Lokasi. Pencarian (nama card atau kode
  lokasi) menyorot card yang cocok dan membuat rak transparan. Tombol **+**
  untuk mengisi/mengubah lokasi card langsung dari aplikasi.

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
   - SHA-1 certificate fingerprint: ambil dari keystore signing milikmu sendiri
     (jangan pernah commit keystore ke repo):
     ```bash
     keytool -list -v -keystore path/ke/release.keystore -alias scanner-gudang
     ```
     (jika baru bermigrasi ke keystore baru, daftarkan SHA-1 keystore baru tersebut
     ke OAuth client ID Android di Google Cloud Console)
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

**Lokasi_Card** (dibuat otomatis oleh aplikasi saat lokasi pertama disimpan,
atau isi manual):
```
Nama Card | Lokasi | Keterangan
```
Kolom `Lokasi` memakai kode `ZONA-RAK-LEVEL[-SISI][-T][-SLOT]`:

| Kode | Artinya |
|---|---|
| `A-03-2` | zona A, rak 3, susun ke-2 dari bawah (sisi depan) |
| `B-01-2-D` / `B-01-2-B` | susun yang sama, sisi **D**epan / **B**elakang |
| `B-01-2-D-T` | **T**umpukan di atas barang sisi depan |
| `B-01-2-D-3` | slot ke-3 dari kiri (opsional; tanpa nomor, card mengisi dari kiri) |

Tiap sisi muat 8 kotak per baris; jumlah item boleh berapa saja (slot sisanya
kosong). Kode juga dikenali dalam bentuk `A3-2`, `a 3 2`, `RAK A-3-2`. Card
tanpa kode lokasi tidak muncul di 3D; jumlahnya ditampilkan di atas peta.

**Geser di peta:** ketuk card → **Geser** → seret kotak yang menyala ke slot
kosong → lepas. Kode lokasi baru terisi otomatis; ketuk **Simpan Lokasi**
untuk menyimpannya ke sheet. Tujuan hanya slot kosong di rak yang sudah ada
(rak baru dibuat lewat tombol **+**).

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

## 3. Build APK & Setup GitHub Secrets

Workflow `.github/workflows/build-release.yml` mengurus build Android menggunakan keystore yang disimpan di **GitHub Secrets** (tidak di-commit ke repo):

- Folder `android/` dibuat otomatis tiap run (`npx cap add android`)
- `scripts/patch-android-manifest.js` menyisipkan intent-filter redirect OAuth
  ke `AndroidManifest.xml` berdasarkan `GOOGLE_OAUTH_CLIENT_ID` di `www/app.js`
- Keystore signing didekode sementara dari Secret ke path ter-ignore (`ci/release.keystore`)
  selama build lalu dihapus kembali; build akan gagal jika salah satu secret belum diset.
- Build APK tidak pernah menerima `WEB_SHEETS_API_KEY` (di dalam APK nilai di `www/app.js`
  tetap berupa placeholder `__WEB_SHEETS_API_KEY__`).

Buat keystore lokal (sekali saja, simpan cadangannya di tempat aman di luar repo):

```bash
keytool -genkeypair -v \
  -keystore release.keystore \
  -alias scanner-gudang \
  -keyalg RSA -keysize 2048 -validity 10000
base64 -w 0 release.keystore
```

Lalu buka **Settings → Secrets and variables → Actions → New repository secret**
dan tambahkan secret berikut:

| Secret | Isi |
|---|---|
| `RELEASE_KEYSTORE_BASE64` | Output base64 satu baris dari `release.keystore` |
| `RELEASE_KEYSTORE_PASSWORD` | Password keystore (`-storepass`) |
| `RELEASE_KEY_ALIAS` | Alias key (mis. `scanner-gudang`) |
| `RELEASE_KEY_PASSWORD` | Password key (`-keypass`) |
| `WEB_SHEETS_API_KEY` | API key Google Sheets untuk versi web GitHub Pages (lihat bagian 6) |

Build & rilis APK tinggal push tag:

```bash
git tag v1.0.0
git push origin v1.0.0
```

Untuk build manual (tanpa tag), buka tab **Actions → Build & Release APK → Run workflow**.

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

## 6. Versi web (hanya baca, dipakai dari PC via GitHub Pages)

Folder `www/` yang sama juga bisa dibuka di browser. Di dalam APK perilakunya tidak berubah. Di browser, aplikasi otomatis masuk **mode hanya-baca**:

- Tab yang tampil: **Inventory** (tanpa `+ Masuk` dan tanpa Scan Masuk), **Stok**, **Mutasi**, **Lokasi** (tanpa tambah/ubah/geser lokasi).
- Tab Scan Code dan Kalibrasi, serta tombol Pengaturan, disembunyikan.
- Tidak ada login Google. Spreadsheet ID (`WEB_SPREADSHEET_ID`) ada di `www/app.js`, sedangkan API key (`WEB_SHEETS_API_KEY`) disimpan sebagai **GitHub Secret** (`WEB_SHEETS_API_KEY`) dan disuntikkan oleh `.github/workflows/pages.yml` **hanya** ke salinan staging saat deploy GitHub Pages (source `www/app.js` di repo tetap memakai placeholder `__WEB_SHEETS_API_KEY__`, sehingga build APK tidak pernah membawa API key).
- Semua penulisan ke Sheets diblokir di satu titik (`sheetsFetchReadOnly`), jadi web tidak bisa mengubah data walau ada yang mengutak-atik tampilan.

Setup sekali:

1. **Bagikan spreadsheet**: Share → Akses umum → **Siapa saja yang memiliki link: Pelihat (Viewer)**. Artinya siapa pun yang tahu ID dan link-nya bisa membaca data. Repo dan web ini bersifat publik, jadi anggap seluruh isi sheet dapat dibaca publik.
2. Google Cloud Console → **APIs & Services → Credentials → Create Credentials → API key**.
   > **Penting:** Karena aplikasi web dijalankan di browser sisi klien (GitHub Pages publik), nilai `WEB_SHEETS_API_KEY` yang disuntikkan ke bundle web **akan terlihat oleh siapa pun yang membuka situs**. Menyimpan key di GitHub Secret mencegah key tersebar di source repo/APK, tetapi **tidak** membuatnya rahasia di browser. Oleh karena itu key **WAJIB** dibatasi di Google Cloud Console:
   - *Application restrictions*: Websites → tambahkan `https://irfanfrizki.github.io/*` (dan `http://localhost:8080/*` bila perlu uji lokal)
   - *API restrictions*: Restrict key → **Google Sheets API** saja
3. Pastikan `WEB_SPREADSHEET_ID` di `www/app.js` sudah sesuai, lalu simpan API key tersebut sebagai GitHub Secret bernama `WEB_SHEETS_API_KEY` (**Settings → Secrets and variables → Actions**). Jangan isi nilai key asli ke `www/app.js` (biarkan `'__WEB_SHEETS_API_KEY__'`).
4. GitHub → **Settings → Pages → Source: GitHub Actions**. Setiap push yang mengubah `www/` ke `main` otomatis menyalin `www/` ke folder staging, menyuntikkan `WEB_SHEETS_API_KEY`, dan mempublikasikan salinan staging lewat `.github/workflows/pages.yml`.

Foto kartu dimuat langsung dari URL di kolom `Foto URL`, jadi file fotonya harus bisa dilihat publik (sama seperti di APK).

Uji lokal (opsional, pakai salinan staging agar repo tetap bersih):
```bash
WEB_SHEETS_API_KEY="API_KEY_KAMU" node scripts/stage-pages.js /tmp/pages-www
cd /tmp/pages-www && python3 -m http.server 8080
```
Lalu buka `http://localhost:8080`.

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
