/**
 * Api.gs — endpoint JSONP untuk aplikasi Android "Scanner Gudang".
 *
 * CARA PASANG:
 * 1. Buat file baru di project Apps Script ini, beri nama "Api" (Api.gs),
 *    lalu paste seluruh isi file ini.
 * 2. HAPUS / rename fungsi doGet() yang lama di Code.gs, karena doGet()
 *    di bawah ini menggantikannya (tetap melayani halaman HTML seperti
 *    biasa kalau dibuka lewat browser tanpa parameter ?api=).
 * 3. Deploy ulang: Deploy > Manage deployments > edit (pensil) >
 *    Version: New version > Deploy.
 *    Pastikan "Who has access" = Anyone (supaya aplikasi bisa akses
 *    tanpa login Google).
 * 4. Salin URL /exec-nya ke Pengaturan > URL API Inventory di aplikasi.
 *
 * CATATAN AKSES:
 * Karena web app harus di-set "Anyone", siapa pun yang tahu URL-nya bisa
 * memanggil API ini. Untuk jaga-jaga, isi Script Property "API_TOKEN"
 * (Project Settings > Script properties) dengan sebuah kata sandi acak,
 * lalu isi token yang sama di Pengaturan aplikasi. Kalau API_TOKEN
 * dikosongkan, pengecekan token dilewati.
 *
 * Semua respons memakai JSONP (dibungkus nama fungsi callback) supaya
 * bisa dipanggil dari WebView aplikasi tanpa kena batasan CORS milik
 * Google Apps Script.
 */

function doGet(e) {
  var p = (e && e.parameter) || {};

  // Tanpa parameter ?api= → tetap sajikan halaman web seperti semula.
  if (!p.api) {
    return HtmlService.createHtmlOutputFromFile('index')
      .setTitle('Card dan Plastik WH MLN lt5')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1, maximum-scale=1')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  }

  var payload;
  try {
    checkApiToken_(p);
    payload = { ok: true, data: routeApi_(p) };
  } catch (err) {
    payload = { ok: false, error: err && err.message ? err.message : String(err) };
  }
  return jsonpOut_(p.callback, payload);
}

function checkApiToken_(p) {
  var expected = PropertiesService.getScriptProperties().getProperty('API_TOKEN');
  if (!expected) return; // token tidak diaktifkan
  if (String(p.token || '') !== String(expected)) {
    throw new Error('Token API salah. Cek Pengaturan di aplikasi.');
  }
}

function routeApi_(p) {
  switch (String(p.api)) {

    // Daftar stok semua card: nama, stok, fotoUrl, tanggalTerakhir.
    case 'stockList':
      return getStockList();

    // Daftar card terkalibrasi (termasuk beratPerPcs & qtyPerIketKecil),
    // dipakai aplikasi untuk fitur hitung pcs dari timbangan.
    case 'calibrations':
      return getCalibrations();

    // Riwayat transaksi satu card.
    case 'history':
      return getStockHistory(p.nama);

    // Ringkasan masuk/keluar/sisa semua card.
    case 'summary':
      return exportStockSummary();

    // Estimasi jumlah pcs dari total timbangan.
    case 'hitung':
      return hitungPcs(p.nama, Number(p.timbangan));

    // Catat transaksi masuk/keluar.
    case 'trx':
      return saveStockTransaction(
        p.nama,
        p.jenis,
        Number(p.jumlahPcs),
        Number(p.timbangan || 0),
        p.qtyIket
      );

    // Dipakai aplikasi untuk mengetes koneksi & token dari layar Pengaturan.
    case 'ping':
      return { ok: true, waktu: Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'dd MMM yyyy HH:mm:ss') };

    default:
      throw new Error('Perintah api "' + p.api + '" tidak dikenal.');
  }
}

function jsonpOut_(callback, payload) {
  var json = JSON.stringify(payload);
  if (callback) {
    // Nama callback dibatasi karakter aman supaya tidak bisa disisipi script.
    var safe = String(callback).replace(/[^a-zA-Z0-9_$]/g, '');
    return ContentService
      .createTextOutput(safe + '(' + json + ');')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService
    .createTextOutput(json)
    .setMimeType(ContentService.MimeType.JSON);
}
