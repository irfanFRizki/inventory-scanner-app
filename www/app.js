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
    history: 'scan_history'
  };

  var state = {
    invUrl: DEFAULT_INV_URL,
    openMode: 'inapp',
    confirmOpen: false,
    vibrate: true,
    qrOnly: true,
    autoRefresh: true,
    history: [],
    invLoadedOnce: false
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

    $('fInvUrl').value = state.invUrl;
    $('fOpenMode').value = state.openMode;
    $('fConfirmOpen').checked = !!state.confirmOpen;
    $('fVibrate').checked = !!state.vibrate;
    $('fQrOnly').checked = !!state.qrOnly;
    $('fAutoRefresh').checked = !!state.autoRefresh;
    $('invUrlLabel').textContent = state.invUrl;
    refreshHistoryUi();
  }

  // ================= Tab navigation =================
  function switchView(name) {
    document.querySelectorAll('.view').forEach(function (v) { v.classList.remove('active'); });
    document.querySelectorAll('.navbtn').forEach(function (b) { b.classList.remove('active'); });
    $('view-' + name).classList.add('active');
    document.querySelector('.navbtn[data-view="' + name + '"]').classList.add('active');

    if (name === 'inv') {
      if (!state.invUrl) {
        $('invEmpty').classList.add('show');
      } else if (!state.invLoadedOnce || state.autoRefresh) {
        loadInventory();
      }
    }
  }

  document.querySelectorAll('.navbtn').forEach(function (btn) {
    btn.addEventListener('click', function () { switchView(btn.dataset.view); });
  });

  // ================= Inventory iframe =================
  function loadInventory() {
    if (!state.invUrl) {
      $('invEmpty').classList.add('show');
      return;
    }
    $('invEmpty').classList.remove('show');
    $('invLoading').classList.add('show');
    var frame = $('invFrame');
    frame.onload = function () {
      $('invLoading').classList.remove('show');
      state.invLoadedOnce = true;
    };
    frame.onerror = function () {
      $('invLoading').classList.remove('show');
      toast('Gagal memuat inventory. Cek URL / koneksi.');
    };
    // cache-buster ringan supaya "reload" benar-benar minta ulang
    var sep = state.invUrl.indexOf('?') > -1 ? '&' : '?';
    frame.src = state.invUrl + sep + '_r=' + Date.now();
  }

  $('btnInvReload').addEventListener('click', loadInventory);
  $('btnGotoSettingsFromInv').addEventListener('click', function () { openSettings(); });

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
    await setPref(KEYS.invUrl, v);
    $('invUrlLabel').textContent = v || '-';
    state.invLoadedOnce = false;
    toast('URL Inventory disimpan.');
  });

  $('btnResetInvUrl').addEventListener('click', async function () {
    $('fInvUrl').value = DEFAULT_INV_URL;
    state.invUrl = DEFAULT_INV_URL;
    await setPref(KEYS.invUrl, DEFAULT_INV_URL);
    $('invUrlLabel').textContent = DEFAULT_INV_URL;
    state.invLoadedOnce = false;
    toast('URL Inventory dikembalikan ke default.');
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
