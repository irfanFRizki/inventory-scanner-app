(function () {
  'use strict';

  var Plugins = window.Capacitor.Plugins;
  var Preferences = Plugins.Preferences;
  var Browser = Plugins.Browser;
  var Haptics = Plugins.Haptics;
  var App = Plugins.App;
  var BarcodeScanner = Plugins.BarcodeScanner;

  // ==== Konfigurasi default ====
  var DEFAULT_INV_URL = 'https://script.google.com/macros/s/AKfycbxMdNbDeTn3voaSImOvABiQ6wm4UX4YOF_lkCtgHv4E1yqdsExDQytAhtGXeT9mvP7Fnw/exec';
  var APP_VERSION = '1.0.0'; // diisi otomatis oleh CI dari git tag saat build release
  var GITHUB_REPO = 'irfanFRizki/inventory-scanner-app'; // ganti sesuai nama repo asli setelah dipush

  var KEYS = {
    invUrl: 'inv_url',
    openMode: 'open_mode',
    confirmOpen: 'confirm_open',
    vibrate: 'vibrate',
    qrOnly: 'qr_only',
    autoRefresh: 'auto_refresh_inv',
    history: 'scan_history',
    apiToken: 'api_token',
    stockCache: 'stock_cache'
  };

  var state = {
    invUrl: DEFAULT_INV_URL,
    openMode: 'inapp',
    confirmOpen: false,
    vibrate: true,
    qrOnly: true,
    autoRefresh: true,
    history: [],
    apiToken: '',
    invLoadedOnce: false,
    stock: [],
    stockFilter: '',
    currentCard: null,
    trxJenis: 'masuk',
    trxMode: 'timbang'
  };

  // ================= Helpers =================
  function $(id) { return document.getElementById(id); }

  function toast(msg) {
    var t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { t.classList.remove('show'); }, 2200);
  }

  function isHttpUrl(str) {
    return /^https?:\/\//i.test(String(str || '').trim());
  }

  function fmtTime(ts) {
    var d = new Date(ts);
    function p(n) { return n < 10 ? '0' + n : n; }
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ' ' + p(d.getDate()) + '/' + p(d.getMonth() + 1);
  }

  async function getPref(key, fallback) {
    try {
      var r = await Preferences.get({ key: key });
      if (r && r.value !== null && r.value !== undefined) {
        try { return JSON.parse(r.value); } catch (e) { return r.value; }
      }
    } catch (e) { /* ignore */ }
    return fallback;
  }

  async function setPref(key, value) {
    try {
      await Preferences.set({ key: key, value: typeof value === 'string' ? value : JSON.stringify(value) });
    } catch (e) { /* ignore */ }
  }

  // ================= Load / Save settings =================
  async function loadSettings() {
    state.invUrl = await getPref(KEYS.invUrl, DEFAULT_INV_URL);
    state.openMode = await getPref(KEYS.openMode, 'inapp');
    state.confirmOpen = await getPref(KEYS.confirmOpen, false);
    state.vibrate = await getPref(KEYS.vibrate, true);
    state.qrOnly = await getPref(KEYS.qrOnly, true);
    state.autoRefresh = await getPref(KEYS.autoRefresh, true);
    state.history = await getPref(KEYS.history, []);
    state.apiToken = await getPref(KEYS.apiToken, '');
    state.stock = await getPref(KEYS.stockCache, []);

    $('fInvUrl').value = state.invUrl;
    $('fOpenMode').value = state.openMode;
    $('fConfirmOpen').checked = !!state.confirmOpen;
    $('fVibrate').checked = !!state.vibrate;
    $('fQrOnly').checked = !!state.qrOnly;
    $('fAutoRefresh').checked = !!state.autoRefresh;
    $('fApiToken').value = state.apiToken;
    refreshHistoryUi();
  }

  // ================= Tab navigation =================
  function switchView(name) {
    document.querySelectorAll('.view').forEach(function (v) { v.classList.remove('active'); });
    document.querySelectorAll('.navbtn').forEach(function (b) { b.classList.remove('active'); });
    $('view-' + name).classList.add('active');
    document.querySelector('.navbtn[data-view="' + name + '"]').classList.add('active');

    if (name === 'inv') {
      if (!state.invLoadedOnce || state.autoRefresh) {
        loadInventory(state.stock.length > 0);
      } else {
        renderInventory();
      }
    }
  }

  document.querySelectorAll('.navbtn').forEach(function (btn) {
    btn.addEventListener('click', function () { switchView(btn.dataset.view); });
  });

  // ================= API JSONP ke Google Apps Script =================
  // GAS tidak mengirim header CORS, jadi request dilakukan lewat <script>
  // tag (JSONP) — pola yang sama seperti dipakai di xp-scanner.
  function apiCall(params, timeoutMs) {
    return new Promise(function (resolve, reject) {
      if (!state.invUrl) {
        reject(new Error('URL API Inventory belum diatur.'));
        return;
      }
      var cbName = 'gascb_' + Date.now() + '_' + Math.floor(Math.random() * 1e6);
      var script = document.createElement('script');
      var done = false;

      var timer = setTimeout(function () {
        if (done) return;
        cleanup();
        reject(new Error('Timeout — server tidak membalas.'));
      }, timeoutMs || 25000);

      function cleanup() {
        done = true;
        clearTimeout(timer);
        try { delete window[cbName]; } catch (e) { window[cbName] = undefined; }
        if (script.parentNode) script.parentNode.removeChild(script);
      }

      window[cbName] = function (payload) {
        if (done) return;
        cleanup();
        if (payload && payload.ok === false) reject(new Error(payload.error || 'Terjadi kesalahan di server.'));
        else resolve(payload ? payload.data : null);
      };

      script.onerror = function () {
        if (done) return;
        cleanup();
        reject(new Error('Gagal terhubung. Cek koneksi & URL API.'));
      };

      var all = Object.assign({}, params, { callback: cbName });
      if (state.apiToken) all.token = state.apiToken;
      var qs = Object.keys(all).map(function (k) {
        return encodeURIComponent(k) + '=' + encodeURIComponent(all[k]);
      }).join('&');

      script.src = state.invUrl + (state.invUrl.indexOf('?') > -1 ? '&' : '?') + qs;
      document.body.appendChild(script);
    });
  }

  // ================= Inventory (native) =================
  function showInvState(which) {
    ['invLoading', 'invEmpty'].forEach(function (id) { $(id).classList.remove('show'); });
    if (which) $(which).classList.add('show');
  }

  async function loadInventory(silent) {
    if (!state.invUrl) {
      $('invEmptyText').textContent = 'URL API Inventory belum diatur. Buka Pengaturan untuk mengisinya.';
      showInvState('invEmpty');
      return;
    }
    if (!silent && !state.stock.length) showInvState('invLoading');
    $('invMeta').textContent = 'Menyegarkan data...';

    try {
      var list = await apiCall({ api: 'stockList' });
      state.stock = Array.isArray(list) ? list : [];
      state.invLoadedOnce = true;
      await setPref(KEYS.stockCache, state.stock);
      $('invMeta').textContent = state.stock.length + ' card \u00b7 diperbarui ' + fmtTime(Date.now());
    } catch (e) {
      $('invMeta').textContent = 'Gagal memuat' + (state.stock.length ? ' \u00b7 menampilkan data tersimpan' : '');
      if (!state.stock.length) {
        $('invEmptyText').textContent = e.message;
        showInvState('invEmpty');
        return;
      }
      toast(e.message);
    }
    renderInventory();
  }

  function renderInventory() {
    var q = state.stockFilter.trim().toLowerCase();
    var rows = state.stock.filter(function (r) {
      return !q || String(r.nama).toLowerCase().indexOf(q) > -1;
    });

    if (!rows.length) {
      $('invList').innerHTML = '';
      $('invEmptyText').textContent = q
        ? 'Tidak ada card yang cocok dengan pencarian.'
        : 'Belum ada data stok di spreadsheet.';
      showInvState('invEmpty');
      return;
    }
    showInvState(null);

    $('invList').innerHTML = rows.map(function (r, i) {
      var stok = Number(r.stok) || 0;
      var cls = stok > 0 ? '' : (stok < 0 ? 'neg' : 'zero');
      var thumb = r.fotoUrl
        ? '<img class="inv-thumb" src="' + escapeHtml(r.fotoUrl) + '" loading="lazy" ' +
          'onerror="this.outerHTML=\'<div class=&quot;inv-thumb-ph&quot;>&#128196;</div>\'">'
        : '<div class="inv-thumb-ph">&#128196;</div>';
      return '<div class="inv-item" data-nama="' + escapeHtml(r.nama) + '">' +
        thumb +
        '<div class="inv-info">' +
          '<div class="inv-name">' + escapeHtml(r.nama) + '</div>' +
          '<div class="inv-date">' + (r.tanggalTerakhir ? escapeHtml(r.tanggalTerakhir) : 'Belum ada transaksi') + '</div>' +
        '</div>' +
        '<div class="inv-stok"><div class="num ' + cls + '">' + stok.toLocaleString('id-ID') + '</div>' +
        '<div class="unit">pcs</div></div>' +
        '</div>';
    }).join('');

    $('invList').querySelectorAll('.inv-item').forEach(function (el) {
      el.addEventListener('click', function () { openDetail(el.dataset.nama); });
    });
  }

  $('btnInvReload').addEventListener('click', function () { loadInventory(); });
  $('btnGotoSettingsFromInv').addEventListener('click', function () { openSettings(); });

  var searchDebounce;
  $('invSearch').addEventListener('input', function () {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(function () {
      state.stockFilter = $('invSearch').value;
      renderInventory();
    }, 200);
  });

  // ---- Detail card ----
  async function openDetail(nama) {
    var row = state.stock.filter(function (r) { return r.nama === nama; })[0];
    state.currentCard = row || { nama: nama, stok: 0 };

    $('dtName').textContent = nama;
    $('dtUpdated').textContent = (row && row.tanggalTerakhir) ? 'Transaksi terakhir: ' + row.tanggalTerakhir : 'Belum ada transaksi';
    setStokReadout(state.currentCard.stok);
    $('dtHistory').innerHTML = '<div class="muted-note">Memuat riwayat...</div>';
    $('detailSheet').classList.add('show');

    try {
      var hist = await apiCall({ api: 'history', nama: nama });
      renderHistory(hist || []);
    } catch (e) {
      $('dtHistory').innerHTML = '<div class="muted-note">Gagal memuat riwayat: ' + escapeHtml(e.message) + '</div>';
    }
  }

  function setStokReadout(stok) {
    stok = Number(stok) || 0;
    var el = $('dtStok');
    el.textContent = stok.toLocaleString('id-ID');
    el.className = 'rvalue mono' + (stok > 0 ? '' : (stok < 0 ? ' neg' : ' zero'));
  }

  function renderHistory(hist) {
    if (!hist.length) {
      $('dtHistory').innerHTML = '<div class="muted-note">Belum ada transaksi untuk card ini.</div>';
      return;
    }
    $('dtHistory').innerHTML = hist.map(function (h) {
      var jenis = String(h.jenis || '').toLowerCase();
      var cls = jenis === 'masuk' ? 'masuk' : 'keluar';
      return '<div class="hist-item">' +
        '<span class="hist-jenis ' + cls + '">' + escapeHtml(h.jenis) + '</span>' +
        '<div class="hist-mid">' +
          '<div class="hist-pcs">' + (Number(h.jumlahPcs) || 0).toLocaleString('id-ID') + ' pcs</div>' +
          '<div class="hist-tgl">' + escapeHtml(h.tanggal || '') +
          (h.totalTimbangan ? ' \u00b7 ' + h.totalTimbangan + ' g' : '') + '</div>' +
        '</div></div>';
    }).join('');
  }

  $('btnCloseDetail').addEventListener('click', function () { $('detailSheet').classList.remove('show'); });
  $('detailSheet').addEventListener('click', function (e) {
    if (e.target === $('detailSheet')) $('detailSheet').classList.remove('show');
  });

  // ---- Form transaksi ----
  function openTrx(jenis) {
    state.trxJenis = jenis;
    $('trxTitle').textContent = jenis === 'masuk' ? 'Catat Barang Masuk' : 'Catat Barang Keluar';
    $('trxCardName').textContent = state.currentCard ? state.currentCard.nama : '';
    $('fTimbangan').value = '';
    $('fPcsManual').value = '';
    $('fPcsFinal').value = '';
    $('calcResult').innerHTML = '';
    setTrxMode('timbang');
    $('trxSheet').classList.add('show');
  }

  function setTrxMode(mode) {
    state.trxMode = mode;
    document.querySelectorAll('.subtab[data-trxmode]').forEach(function (t) {
      t.classList.toggle('active', t.dataset.trxmode === mode);
    });
    $('trxModeTimbang').style.display = mode === 'timbang' ? 'block' : 'none';
    $('trxModeManual').style.display = mode === 'manual' ? 'block' : 'none';
  }

  document.querySelectorAll('.subtab[data-trxmode]').forEach(function (t) {
    t.addEventListener('click', function () { setTrxMode(t.dataset.trxmode); });
  });

  $('fPcsManual').addEventListener('input', function () {
    $('fPcsFinal').value = $('fPcsManual').value;
  });

  $('btnTrxMasuk').addEventListener('click', function () { openTrx('masuk'); });
  $('btnTrxKeluar').addEventListener('click', function () { openTrx('keluar'); });
  $('btnTrxCancel').addEventListener('click', function () { $('trxSheet').classList.remove('show'); });
  $('btnCloseTrx').addEventListener('click', function () { $('trxSheet').classList.remove('show'); });

  $('btnHitungPcs').addEventListener('click', async function () {
    var g = parseFloat(String($('fTimbangan').value).replace(',', '.'));
    if (!g || g <= 0) { toast('Isi total timbangan dulu.'); return; }
    var btn = $('btnHitungPcs');
    btn.disabled = true; btn.textContent = 'Menghitung...';
    try {
      var r = await apiCall({ api: 'hitung', nama: state.currentCard.nama, timbangan: g });
      $('calcResult').innerHTML =
        'Berat per pcs: <b>' + Number(r.beratPerPcs).toFixed(4) + '</b> g<br>' +
        'Estimasi: <b>' + Number(r.jumlahPcsEstimasi).toFixed(1) + '</b> pcs<br>' +
        'Dibulatkan (kelipatan 5): <b>' + r.jumlahPcsDibulatkan + '</b> pcs';
      $('fPcsFinal').value = r.jumlahPcsDibulatkan;
    } catch (e) {
      $('calcResult').innerHTML = '<span style="color:var(--red);">' + escapeHtml(e.message) + '</span>';
    } finally {
      btn.disabled = false; btn.textContent = 'Hitung Perkiraan Pcs';
    }
  });

  $('btnTrxSave').addEventListener('click', async function () {
    var pcs = parseFloat(String($('fPcsFinal').value).replace(',', '.'));
    if (!pcs || pcs <= 0) { toast('Jumlah pcs harus lebih dari 0.'); return; }

    var btn = $('btnTrxSave');
    btn.disabled = true; btn.textContent = 'Menyimpan...';
    try {
      var timbangan = parseFloat(String($('fTimbangan').value).replace(',', '.')) || 0;
      var r = await apiCall({
        api: 'trx',
        nama: state.currentCard.nama,
        jenis: state.trxJenis,
        jumlahPcs: pcs,
        timbangan: timbangan
      });
      if (state.vibrate) { try { await Haptics.vibrate({ duration: 60 }); } catch (e) {} }
      toast('Tersimpan. Stok sekarang: ' + Number(r.stokSaatIni).toLocaleString('id-ID') + ' pcs');
      $('trxSheet').classList.remove('show');

      // perbarui angka di layar tanpa menunggu reload penuh
      state.currentCard.stok = r.stokSaatIni;
      setStokReadout(r.stokSaatIni);
      state.stock.forEach(function (row) {
        if (row.nama === state.currentCard.nama) row.stok = r.stokSaatIni;
      });
      await setPref(KEYS.stockCache, state.stock);
      renderInventory();

      try { renderHistory(await apiCall({ api: 'history', nama: state.currentCard.nama }) || []); } catch (e) {}
    } catch (e) {
      toast('Gagal menyimpan: ' + e.message);
    } finally {
      btn.disabled = false; btn.textContent = 'Simpan';
    }
  });

  // ================= History =================
  function refreshHistoryUi() {
    var panel = $('historyPanel');
    if (!state.history.length) {
      panel.innerHTML = '<div style="padding:14px; text-align:center; color:var(--muted); font-size:12px;">Belum ada riwayat scan.</div>';
    } else {
      panel.innerHTML = state.history.slice(0, 20).map(function (h) {
        return '<div class="hist-row"><span class="hist-code mono">' + escapeHtml(h.code) + '</span>' +
          '<span class="hist-time">' + fmtTime(h.time) + '</span></div>';
      }).join('');
    }
    $('histCountLabel').textContent = state.history.length + ' riwayat tersimpan';
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  async function pushHistory(code) {
    state.history.unshift({ code: code, time: Date.now() });
    state.history = state.history.slice(0, 50);
    await setPref(KEYS.history, state.history);
    refreshHistoryUi();
  }

  $('btnToggleHistory').addEventListener('click', function () {
    $('historyPanel').classList.toggle('show');
  });

  $('btnClearHistory').addEventListener('click', async function () {
    state.history = [];
    await setPref(KEYS.history, []);
    refreshHistoryUi();
    toast('Riwayat scan dihapus.');
  });

  // ================= Scan flow =================
  var scanning = false;

  async function ensureScannerReady() {
    try {
      var avail = await BarcodeScanner.isGoogleBarcodeScannerModuleAvailable();
      if (avail && avail.available === false) {
        toast('Menyiapkan modul scanner (sekali saja)...');
        await BarcodeScanner.installGoogleBarcodeScannerModule();
      }
    } catch (e) { /* platform lain (web/iOS) tidak butuh langkah ini */ }
  }

  async function startScan() {
    if (scanning) return;
    scanning = true;
    $('scanRing').classList.add('busy');
    $('btnScan').disabled = true;
    try {
      await ensureScannerReady();
      var options = {};
      if (state.qrOnly) options.formats = ['QrCode'];
      var result = await BarcodeScanner.scan(options);
      var barcodes = (result && result.barcodes) || [];
      if (!barcodes.length) {
        toast('Tidak ada kode terdeteksi.');
        return;
      }
      var raw = barcodes[0].rawValue || '';
      await onScanResult(raw);
    } catch (e) {
      var msg = (e && e.message) || String(e);
      if (!/cancel/i.test(msg)) toast('Scan dibatalkan/gagal: ' + msg);
    } finally {
      scanning = false;
      $('scanRing').classList.remove('busy');
      $('btnScan').disabled = false;
    }
  }

  async function onScanResult(raw) {
    $('lastScan').style.display = 'block';
    $('lastScan').innerHTML = 'Terakhir: <b class="mono">' + escapeHtml(raw) + '</b>';
    await pushHistory(raw);

    if (state.vibrate) {
      try { await Haptics.vibrate({ duration: 80 }); } catch (e) { /* ignore */ }
    }

    if (!isHttpUrl(raw)) {
      toast('Kode di-scan bukan link, tidak dibuka otomatis.');
      return;
    }

    if (state.confirmOpen) {
      showConfirmOpen(raw);
    } else {
      await openLink(raw);
    }
  }

  async function openLink(url) {
    try {
      if (state.openMode === 'external') {
        window.open(url, '_system');
      } else {
        await Browser.open({ url: url });
      }
    } catch (e) {
      toast('Gagal membuka link.');
    }
  }

  $('btnScan').addEventListener('click', startScan);

  // ================= Confirm-open dialog =================
  var pendingUrl = null;
  function showConfirmOpen(url) {
    pendingUrl = url;
    $('confirmUrlText').textContent = url;
    $('confirmModal').classList.add('show');
  }
  $('btnConfirmCancel').addEventListener('click', function () {
    $('confirmModal').classList.remove('show');
    pendingUrl = null;
  });
  $('btnConfirmOpen').addEventListener('click', async function () {
    $('confirmModal').classList.remove('show');
    if (pendingUrl) await openLink(pendingUrl);
    pendingUrl = null;
  });

  // ================= Settings modal =================
  function openSettings() { $('settingsModal').classList.add('show'); }
  function closeSettings() { $('settingsModal').classList.remove('show'); }

  $('btnSettings').addEventListener('click', openSettings);
  $('btnCloseSettings').addEventListener('click', closeSettings);
  $('settingsModal').addEventListener('click', function (e) {
    if (e.target === $('settingsModal')) closeSettings();
  });

  $('btnSaveInvUrl').addEventListener('click', async function () {
    var v = $('fInvUrl').value.trim();
    if (v && !isHttpUrl(v)) {
      toast('URL harus diawali http:// atau https://');
      return;
    }
    state.invUrl = v;
    state.apiToken = $('fApiToken').value.trim();
    await setPref(KEYS.invUrl, v);
    await setPref(KEYS.apiToken, state.apiToken);
    state.invLoadedOnce = false;
    toast('Pengaturan API disimpan.');
  });

  $('btnResetInvUrl').addEventListener('click', async function () {
    $('fInvUrl').value = DEFAULT_INV_URL;
    state.invUrl = DEFAULT_INV_URL;
    await setPref(KEYS.invUrl, DEFAULT_INV_URL);
    state.invLoadedOnce = false;
    toast('URL dikembalikan ke default.');
  });

  $('btnTestApi').addEventListener('click', async function () {
    var btn = $('btnTestApi');
    var msg = $('apiTestMsg');
    // pakai nilai yang sedang diketik, tanpa harus disimpan dulu
    var savedUrl = state.invUrl, savedToken = state.apiToken;
    state.invUrl = $('fInvUrl').value.trim();
    state.apiToken = $('fApiToken').value.trim();

    btn.disabled = true;
    msg.style.color = 'var(--muted)';
    msg.textContent = 'Menghubungi server...';
    try {
      var r = await apiCall({ api: 'ping' }, 15000);
      msg.style.color = 'var(--green)';
      msg.textContent = 'Berhasil terhubung. Waktu server: ' + (r && r.waktu ? r.waktu : '-');
    } catch (e) {
      msg.style.color = 'var(--red)';
      msg.textContent = 'Gagal: ' + e.message;
      state.invUrl = savedUrl; state.apiToken = savedToken;
    } finally {
      btn.disabled = false;
    }
  });

  $('fOpenMode').addEventListener('change', async function () {
    state.openMode = $('fOpenMode').value;
    await setPref(KEYS.openMode, state.openMode);
  });
  $('fConfirmOpen').addEventListener('change', async function () {
    state.confirmOpen = $('fConfirmOpen').checked;
    await setPref(KEYS.confirmOpen, state.confirmOpen);
  });
  $('fVibrate').addEventListener('change', async function () {
    state.vibrate = $('fVibrate').checked;
    await setPref(KEYS.vibrate, state.vibrate);
  });
  $('fQrOnly').addEventListener('change', async function () {
    state.qrOnly = $('fQrOnly').checked;
    await setPref(KEYS.qrOnly, state.qrOnly);
  });
  $('fAutoRefresh').addEventListener('change', async function () {
    state.autoRefresh = $('fAutoRefresh').checked;
    await setPref(KEYS.autoRefresh, state.autoRefresh);
  });

  // ================= Update check =================
  $('btnCheckUpdate').addEventListener('click', async function () {
    var btn = $('btnCheckUpdate');
    btn.disabled = true;
    btn.textContent = '...';
    try {
      var res = await fetch('https://api.github.com/repos/' + GITHUB_REPO + '/releases/latest');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var data = await res.json();
      var latest = (data.tag_name || '').replace(/^v/i, '');
      if (latest && latest !== APP_VERSION) {
        toast('Update tersedia: v' + latest + '. Membuka halaman rilis...');
        await Browser.open({ url: data.html_url || ('https://github.com/' + GITHUB_REPO + '/releases') });
      } else {
        toast('Sudah versi terbaru (v' + APP_VERSION + ').');
      }
    } catch (e) {
      toast('Gagal cek update. Cek koneksi internet.');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Cek';
    }
  });

  // ================= Init =================
  async function init() {
    $('verLabel').textContent = 'v' + APP_VERSION;
    try {
      var info = await App.getInfo();
      if (info && info.version) {
        APP_VERSION = info.version;
        $('verLabel').textContent = 'v' + APP_VERSION;
      }
    } catch (e) { /* web preview: getInfo tidak tersedia */ }

    await loadSettings();
    switchView('scan');
  }

  init();
})();
