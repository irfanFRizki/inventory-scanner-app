(function () {
  'use strict';

  var Plugins = window.Capacitor.Plugins;
  var Preferences = Plugins.Preferences;
  var Browser = Plugins.Browser;
  var Haptics = Plugins.Haptics;
  var App = Plugins.App;
  var BarcodeScanner = Plugins.BarcodeScanner;

  // ================= Konfigurasi build-time =================
  var APP_VERSION = '1.0.0'; // disuntik CI dari git tag saat build release
  var GITHUB_REPO = 'irfanFRizki/inventory-scanner-app'; // untuk fitur "Cek Update"

  // WAJIB diisi manual setelah membuat OAuth Client ID (tipe "Android") di
  // Google Cloud Console — lihat README bagian "Setup Google Cloud Console".
  // Formatnya: "xxxxxxxxxx-yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy.apps.googleusercontent.com"
  // CATATAN: nilai ini dibaca juga oleh scripts/patch-android-manifest.js
  // saat build CI untuk mendaftarkan redirect URI — jadi HARUS tetap dalam
  // format 'GOOGLE_OAUTH_CLIENT_ID = ...'; (string literal, satu baris).
  var GOOGLE_OAUTH_CLIENT_ID = '250943179443-0onrfglhn814v2fck81qmqf4cd76es80.apps.googleusercontent.com';

  var SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
  var USERINFO_SCOPE = 'https://www.googleapis.com/auth/userinfo.email';
  var TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
  var AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
  var USERINFO_ENDPOINT = 'https://www.googleapis.com/oauth2/v3/userinfo';
  var SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';

  function redirectScheme() {
    return 'com.googleusercontent.apps.' + GOOGLE_OAUTH_CLIENT_ID.replace('.apps.googleusercontent.com', '');
  }
  function redirectUri() {
    return redirectScheme() + ':/oauth2redirect';
  }

  var KEYS = {
    spreadsheetId: 'spreadsheet_id',
    openMode: 'open_mode',
    confirmOpen: 'confirm_open',
    vibrate: 'vibrate',
    qrOnly: 'qr_only',
    autoRefresh: 'auto_refresh_inv',
    history: 'scan_history',
    stockCache: 'stock_cache',
    oauthAccessToken: 'oauth_access_token',
    oauthExpiresAt: 'oauth_expires_at',
    oauthRefreshToken: 'oauth_refresh_token',
    oauthEmail: 'oauth_email',
    oauthPendingVerifier: 'oauth_pending_verifier'
  };

  var state = {
    spreadsheetId: '',
    openMode: 'inapp',
    confirmOpen: false,
    vibrate: true,
    qrOnly: true,
    autoRefresh: true,
    history: [],
    invLoadedOnce: false,
    stock: [],
    stockFilter: '',
    currentBrand: null,
    currentCard: null,
    trxJenis: 'masuk',
    trxMode: 'timbang',
    oauth: { accessToken: '', expiresAt: 0, refreshToken: '', email: '' }
  };

  // ================= Helpers umum =================
  function $(id) { return document.getElementById(id); }

  function toast(msg) {
    var t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { t.classList.remove('show'); }, 2400);
  }

  function isHttpUrl(str) { return /^https?:\/\//i.test(String(str || '').trim()); }

  function fmtTime(ts) {
    var d = new Date(ts);
    function p(n) { return n < 10 ? '0' + n : n; }
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ' ' + p(d.getDate()) + '/' + p(d.getMonth() + 1);
  }

  function fmtTanggal(val) {
    if (!val) return '';
    var d = new Date(val);
    if (isNaN(d.getTime())) return String(val);
    var bulan = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
    function p(n) { return n < 10 ? '0' + n : n; }
    return p(d.getDate()) + ' ' + bulan[d.getMonth()] + ' ' + d.getFullYear() + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  async function getPref(key, fallback) {
    try {
      var r = await Preferences.get({ key: key });
      if (r && r.value !== null && r.value !== undefined && r.value !== '') {
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

  async function clearPref(key) {
    try { await Preferences.remove({ key: key }); } catch (e) { /* ignore */ }
  }

  // ================= PKCE (OAuth tanpa client secret) =================
  function base64UrlEncode(buffer) {
    var bytes = new Uint8Array(buffer);
    var str = '';
    for (var i = 0; i < bytes.byteLength; i++) str += String.fromCharCode(bytes[i]);
    return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function randomVerifier() {
    var arr = new Uint8Array(64);
    (window.crypto || window.msCrypto).getRandomValues(arr);
    return base64UrlEncode(arr.buffer).slice(0, 64);
  }

  async function pkceChallenge(verifier) {
    var enc = new TextEncoder().encode(verifier);
    var digest = await window.crypto.subtle.digest('SHA-256', enc);
    return base64UrlEncode(digest);
  }

  // ================= OAuth: sign-in / sign-out / refresh =================
  async function loadOauthState() {
    state.oauth.accessToken = await getPref(KEYS.oauthAccessToken, '');
    state.oauth.expiresAt = await getPref(KEYS.oauthExpiresAt, 0);
    state.oauth.refreshToken = await getPref(KEYS.oauthRefreshToken, '');
    state.oauth.email = await getPref(KEYS.oauthEmail, '');
  }

  function isSignedIn() { return !!state.oauth.refreshToken; }

  async function beginSignIn() {
    if (!GOOGLE_OAUTH_CLIENT_ID) {
      toast('GOOGLE_OAUTH_CLIENT_ID belum diisi (lihat README bagian setup Google Cloud Console).');
      return;
    }
    var verifier = randomVerifier();
    var challenge = await pkceChallenge(verifier);
    await setPref(KEYS.oauthPendingVerifier, verifier);

    var params = {
      client_id: GOOGLE_OAUTH_CLIENT_ID,
      redirect_uri: redirectUri(),
      response_type: 'code',
      scope: SHEETS_SCOPE + ' ' + USERINFO_SCOPE,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      access_type: 'offline',
      prompt: 'consent'
    };
    var qs = Object.keys(params).map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]); }).join('&');
    await Browser.open({ url: AUTH_ENDPOINT + '?' + qs });
  }

  async function handleOauthRedirect(url) {
    var codeMatch = url.match(/[?&]code=([^&]+)/);
    var errMatch = url.match(/[?&]error=([^&]+)/);
    try { await Browser.close(); } catch (e) { /* ignore, mungkin sudah tertutup */ }

    if (errMatch) {
      toast('Sign-in dibatalkan/gagal: ' + decodeURIComponent(errMatch[1]));
      return;
    }
    if (!codeMatch) return;
    var code = decodeURIComponent(codeMatch[1]);
    var verifier = await getPref(KEYS.oauthPendingVerifier, '');
    if (!verifier) { toast('Sesi sign-in kadaluarsa, coba lagi.'); return; }

    try {
      var body = {
        code: code,
        client_id: GOOGLE_OAUTH_CLIENT_ID,
        redirect_uri: redirectUri(),
        grant_type: 'authorization_code',
        code_verifier: verifier
      };
      var tok = await tokenRequest(body);
      await applyTokenResponse(tok);
      await clearPref(KEYS.oauthPendingVerifier);
      await fetchUserEmail();
      toast('Berhasil masuk dengan Google.');
      renderSignInStatus();
    } catch (e) {
      toast('Gagal menukar kode sign-in: ' + e.message);
    }
  }

  async function tokenRequest(fields) {
    var body = Object.keys(fields).map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(fields[k]); }).join('&');
    var res = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body
    });
    var json = await res.json().catch(function () { return {}; });
    if (!res.ok) throw new Error(json.error_description || json.error || ('HTTP ' + res.status));
    return json;
  }

  async function applyTokenResponse(tok) {
    state.oauth.accessToken = tok.access_token || '';
    state.oauth.expiresAt = Date.now() + ((Number(tok.expires_in) || 3000) - 60) * 1000;
    if (tok.refresh_token) state.oauth.refreshToken = tok.refresh_token;
    await setPref(KEYS.oauthAccessToken, state.oauth.accessToken);
    await setPref(KEYS.oauthExpiresAt, state.oauth.expiresAt);
    if (tok.refresh_token) await setPref(KEYS.oauthRefreshToken, state.oauth.refreshToken);
  }

  async function fetchUserEmail() {
    try {
      var res = await fetch(USERINFO_ENDPOINT, { headers: { Authorization: 'Bearer ' + state.oauth.accessToken } });
      var j = await res.json();
      if (j && j.email) {
        state.oauth.email = j.email;
        await setPref(KEYS.oauthEmail, j.email);
      }
    } catch (e) { /* opsional, tidak fatal */ }
  }

  async function getValidAccessToken() {
    if (!state.oauth.refreshToken) throw new Error('Belum sign-in dengan Google. Buka Pengaturan.');
    if (state.oauth.accessToken && Date.now() < state.oauth.expiresAt) return state.oauth.accessToken;
    var tok = await tokenRequest({
      grant_type: 'refresh_token',
      refresh_token: state.oauth.refreshToken,
      client_id: GOOGLE_OAUTH_CLIENT_ID
    });
    await applyTokenResponse(tok);
    return state.oauth.accessToken;
  }

  async function signOut() {
    var token = state.oauth.accessToken;
    state.oauth = { accessToken: '', expiresAt: 0, refreshToken: '', email: '' };
    await clearPref(KEYS.oauthAccessToken);
    await clearPref(KEYS.oauthExpiresAt);
    await clearPref(KEYS.oauthRefreshToken);
    await clearPref(KEYS.oauthEmail);
    if (token) {
      fetch('https://oauth2.googleapis.com/revoke?token=' + encodeURIComponent(token)).catch(function () {});
    }
    renderSignInStatus();
    toast('Keluar dari akun Google.');
  }

  function renderSignInStatus() {
    var el = $('oauthStatus');
    var btnIn = $('btnGoogleSignIn');
    var btnOut = $('btnGoogleSignOut');
    if (isSignedIn()) {
      el.textContent = state.oauth.email ? ('Masuk sebagai ' + state.oauth.email) : 'Sudah masuk dengan Google';
      el.style.color = 'var(--green)';
      btnIn.style.display = 'none';
      btnOut.style.display = 'inline-block';
    } else {
      el.textContent = 'Belum masuk dengan akun Google';
      el.style.color = 'var(--muted)';
      btnIn.style.display = 'inline-block';
      btnOut.style.display = 'none';
    }
  }

  App.addListener('appUrlOpen', function (data) {
    var url = data && data.url ? data.url : '';
    if (url.indexOf(redirectScheme()) === 0) handleOauthRedirect(url);
  });

  // ================= Google Sheets API =================
  async function sheetsFetch(pathAndQuery, options) {
    if (!state.spreadsheetId) throw new Error('Spreadsheet ID belum diatur.');
    var token = await getValidAccessToken();
    var res = await fetch(SHEETS_API + '/' + state.spreadsheetId + pathAndQuery, Object.assign({}, options, {
      headers: Object.assign({ Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, (options && options.headers) || {})
    }));
    if (!res.ok) {
      var errJson = await res.json().catch(function () { return null; });
      var msg = (errJson && errJson.error && errJson.error.message) || ('HTTP ' + res.status);
      var e = new Error(msg);
      e.status = res.status;
      throw e;
    }
    return res.json();
  }

  async function readRawRows(sheetName) {
    try {
      // valueRenderOption=UNFORMATTED_VALUE: paksa angka balik sebagai number
      // JS asli, bukan string terformat sesuai locale sheet (mis. "3,2005"
      // ala Indonesia) yang bikin Number()/parseFloat() gagal jadi NaN.
      // dateTimeRenderOption=FORMATTED_STRING: kolom tanggal tetap dapat
      // string yang bisa diparse Date(), bukan serial number Sheets.
      var data = await sheetsFetch('/values/' + encodeURIComponent(sheetName) +
        '?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING');
      return (data.values || []).slice(1); // baris pertama = header
    } catch (e) {
      if (/Unable to parse range|not found|Requested entity was not found/i.test(e.message)) return [];
      throw e;
    }
  }

  async function ensureSheetExists(title, headerRow) {
    var meta = await sheetsFetch('?fields=sheets.properties.title');
    var exists = (meta.sheets || []).some(function (s) { return s.properties && s.properties.title === title; });
    if (exists) return;
    await sheetsFetch(':batchUpdate', {
      method: 'POST',
      body: JSON.stringify({ requests: [{ addSheet: { properties: { title: title } } }] })
    });
    var lastCol = String.fromCharCode(65 + headerRow.length - 1);
    await sheetsFetch('/values/' + encodeURIComponent(title + '!A1:' + lastCol + '1') + '?valueInputOption=RAW', {
      method: 'PUT',
      body: JSON.stringify({ values: [headerRow] })
    });
  }

  // ---- Domain: stok inventory (mengikuti skema Kalibrasi_Card / Stock_Mutasi) ----
  async function getStockList() {
    var cal = await readRawRows('Kalibrasi_Card');
    var stock = await readRawRows('Stock_Mutasi');

    var names = {}, foto = {}, stokMap = {}, lastTgl = {};
    cal.forEach(function (r) {
      if (!r[0]) return;
      names[r[0]] = true;
      foto[r[0]] = r[6] || '';
    });
    stock.forEach(function (r) {
      var nm = r[0];
      if (!nm) return;
      names[nm] = true;
      var jenis = String(r[1] || '').trim().toLowerCase();
      var jp = Number(r[2]) || 0;
      stokMap[nm] = (stokMap[nm] || 0) + (jenis === 'masuk' ? jp : (jenis === 'keluar' ? -jp : 0));
      var tgl = r[4];
      if (tgl && (!lastTgl[nm] || new Date(tgl) > new Date(lastTgl[nm]))) lastTgl[nm] = tgl;
    });

    var result = Object.keys(names).map(function (nm) {
      return {
        nama: nm,
        stok: stokMap[nm] || 0,
        fotoUrl: foto[nm] || '',
        tanggalTerakhir: lastTgl[nm] ? fmtTanggal(lastTgl[nm]) : ''
      };
    });
    result.sort(function (a, b) { return a.nama.localeCompare(b.nama); });
    return result;
  }

  async function getStockHistory(nama) {
    var rows = await readRawRows('Stock_Mutasi');
    var target = String(nama).trim().toLowerCase();
    var res = rows.filter(function (r) { return String(r[0]).trim().toLowerCase() === target; })
      .map(function (r) {
        return {
          jenis: r[1], jumlahPcs: Number(r[2]) || 0, totalTimbangan: Number(r[3]) || 0,
          tanggal: r[4] ? fmtTanggal(r[4]) : '', keterangan: r[5] || '',
          qtyPerIketKecil: (r[6] !== undefined && r[6] !== '') ? Number(r[6]) : null
        };
      });
    res.reverse();
    return res;
  }

  async function hitungPcsDariTimbangan(nama, timbanganBaru) {
    var cal = await readRawRows('Kalibrasi_Card');
    var target = String(nama).trim().toLowerCase();
    var row = cal.filter(function (r) { return String(r[0]).trim().toLowerCase() === target; })[0];
    var beratPerPcs = row ? (Number(row[4]) || 0) : 0;

    if (!beratPerPcs) {
      // Ringkasan di Kalibrasi_Card kosong/rusak (atau card belum sempat
      // ter-upsert ke sana) — hitung ulang langsung dari data mentah di
      // Kalibrasi_Parts (Nama Card, Part Ke, Jumlah Pcs, Total Timbangan,
      // Tanggal), lebih tahan karena tidak bergantung ke ringkasan cache.
      var fallback = await getCalibrationPartsFor(nama);
      var totalPcs = 0, totalTimbangan = 0;
      fallback.parts.forEach(function (p) {
        totalPcs += Number(p.jumlahPcs) || 0;
        totalTimbangan += Number(p.totalTimbangan) || 0;
      });
      if (totalPcs > 0 && totalTimbangan > 0) beratPerPcs = totalTimbangan / totalPcs;
    }

    if (!beratPerPcs) {
      throw new Error(row
        ? 'Data kalibrasi card ini kosong/rusak di Kalibrasi_Card maupun Kalibrasi_Parts.'
        : 'Card "' + nama + '" belum dikalibrasi (tidak ada di Kalibrasi_Card maupun Kalibrasi_Parts).');
    }

    var estimasi = timbanganBaru / beratPerPcs;
    return {
      nama: (row && row[0]) || nama, beratPerPcs: beratPerPcs, jumlahPcsEstimasi: estimasi,
      jumlahPcsDibulatkan: Math.ceil(estimasi / 5) * 5
    };
  }

  async function saveStockTransaction(nama, jenis, jumlahPcs, timbangan, qtyIket) {
    await ensureSheetExists('Stock_Mutasi', ['Nama Card', 'Jenis', 'Jumlah Pcs', 'Total Timbangan', 'Tanggal', 'Keterangan', 'Qty per Iket Kecil']);
    var nowIso = new Date().toISOString();
    await sheetsFetch('/values/' + encodeURIComponent('Stock_Mutasi') + ':append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS', {
      method: 'POST',
      body: JSON.stringify({ values: [[nama, jenis === 'masuk' ? 'Masuk' : 'Keluar', jumlahPcs, timbangan || 0, nowIso, '', qtyIket || '']] })
    });
    var hist = await getStockHistory(nama);
    var stokSaatIni = hist.reduce(function (acc, h) {
      var j = String(h.jenis || '').toLowerCase();
      return acc + (j === 'masuk' ? h.jumlahPcs : (j === 'keluar' ? -h.jumlahPcs : 0));
    }, 0);
    return { nama: nama, jenis: jenis, jumlahPcs: jumlahPcs, stokSaatIni: stokSaatIni };
  }

  async function pingSpreadsheet() {
    var meta = await sheetsFetch('?fields=properties.title');
    return { waktu: fmtTanggal(new Date()), judul: (meta.properties && meta.properties.title) || '-' };
  }

  // ================= Load / Save settings =================
  async function loadSettings() {
    state.spreadsheetId = await getPref(KEYS.spreadsheetId, '');
    state.openMode = await getPref(KEYS.openMode, 'inapp');
    state.confirmOpen = await getPref(KEYS.confirmOpen, false);
    state.vibrate = await getPref(KEYS.vibrate, true);
    state.qrOnly = await getPref(KEYS.qrOnly, true);
    state.autoRefresh = await getPref(KEYS.autoRefresh, true);
    state.history = await getPref(KEYS.history, []);
    state.stock = await getPref(KEYS.stockCache, []);
    await loadOauthState();

    $('fSpreadsheetId').value = state.spreadsheetId;
    $('fOpenMode').value = state.openMode;
    $('fConfirmOpen').checked = !!state.confirmOpen;
    $('fVibrate').checked = !!state.vibrate;
    $('fQrOnly').checked = !!state.qrOnly;
    $('fAutoRefresh').checked = !!state.autoRefresh;
    renderSignInStatus();
    refreshHistoryUi();
  }

  // ================= Tab navigation =================
  function switchView(name) {
    document.querySelectorAll('.view').forEach(function (v) { v.classList.remove('active'); });
    document.querySelectorAll('.navbtn').forEach(function (b) { b.classList.remove('active'); });
    $('view-' + name).classList.add('active');
    document.querySelector('.navbtn[data-view="' + name + '"]').classList.add('active');

    if (name === 'inv') {
      if (state.currentBrand !== null) {
        showInvScreen('grid');
        if (!state.invLoadedOnce || state.autoRefresh) loadInventory(state.stock.length > 0);
        else renderGrid();
      } else {
        showInvScreen('brand');
      }
    }
  }

  document.querySelectorAll('.navbtn').forEach(function (btn) {
    btn.addEventListener('click', function () { switchView(btn.dataset.view); });
  });

  // ================= Inventory: Pilih Brand -> Grid Katalog =================
  function showInvScreen(which) {
    $('invScreenBrand').classList.toggle('active', which === 'brand');
    $('invScreenGrid').classList.toggle('active', which === 'grid');
  }

  document.querySelectorAll('.brand-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      state.currentBrand = btn.dataset.brand || '';
      $('invBrandLabel').textContent = state.currentBrand ? state.currentBrand : 'Semua Brand';
      state.stockFilter = '';
      $('invSearch').value = '';
      showInvScreen('grid');
      if (!state.invLoadedOnce || state.autoRefresh) loadInventory(state.stock.length > 0);
      else renderGrid();
    });
  });

  $('btnGantiBrand').addEventListener('click', function () {
    state.currentBrand = null;
    showInvScreen('brand');
  });

  function showInvState(which) {
    ['invLoading', 'invEmpty'].forEach(function (id) { $(id).classList.remove('show'); });
    if (which) $(which).classList.add('show');
  }

  async function loadInventory(silent) {
    if (!isSignedIn()) {
      $('invEmptyText').textContent = 'Belum masuk dengan akun Google. Buka Pengaturan untuk sign-in.';
      showInvState('invEmpty');
      return;
    }
    if (!state.spreadsheetId) {
      $('invEmptyText').textContent = 'Spreadsheet ID belum diatur. Buka Pengaturan untuk mengisinya.';
      showInvState('invEmpty');
      return;
    }
    if (!silent && !state.stock.length) showInvState('invLoading');
    $('invMeta').textContent = 'Menyegarkan data...';

    try {
      var list = await getStockList();
      state.stock = list;
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
    renderGrid();
  }

  // Daftar yang lagi ditampilkan (sudah difilter brand + pencarian) — dipakai
  // juga untuk navigasi Sebelumnya/Berikutnya di panel detail.
  function currentFilteredList() {
    var brand = (state.currentBrand || '').toUpperCase();
    var q = state.stockFilter.trim().toLowerCase();
    return state.stock.filter(function (r) {
      var nm = String(r.nama || '');
      var matchBrand = !brand || nm.toUpperCase().indexOf(brand) > -1;
      var matchQ = !q || nm.toLowerCase().indexOf(q) > -1;
      return matchBrand && matchQ;
    });
  }

  function renderGrid() {
    var rows = currentFilteredList();

    if (!rows.length) {
      $('invGrid').innerHTML = '';
      $('invEmptyText').textContent = state.stockFilter.trim()
        ? 'Tidak ada card yang cocok dengan pencarian.'
        : 'Belum ada item' + (state.currentBrand ? ' brand ' + state.currentBrand : '') + ' di katalog.';
      showInvState('invEmpty');
      return;
    }
    showInvState(null);

    $('invGrid').innerHTML = rows.map(function (r) {
      var stok = Number(r.stok) || 0;
      var cls = stok > 0 ? '' : (stok < 0 ? 'neg' : 'zero');
      var photo = r.fotoUrl
        ? '<img src="' + escapeHtml(r.fotoUrl) + '" loading="lazy" ' +
          'onerror="this.parentNode.innerHTML=\'<div class=&quot;ci-placeholder&quot;>&#128196;</div>\'">'
        : '<div class="ci-placeholder">&#128196;</div>';
      return '<div class="catalog-item" data-nama="' + escapeHtml(r.nama) + '">' +
        '<div class="ci-photo-wrap">' + photo + '</div>' +
        '<div class="ci-label">' + escapeHtml(r.nama) + '</div>' +
        '<div class="ci-stock ' + cls + '">stok: ' + stok.toLocaleString('id-ID') + ' pcs</div>' +
        '</div>';
    }).join('');

    $('invGrid').querySelectorAll('.catalog-item').forEach(function (el) {
      el.addEventListener('click', function () { openDetail(el.dataset.nama); });
    });
  }

  $('btnInvReload').addEventListener('click', function () { loadInventory(); });
  $('btnGotoSettingsFromInv').addEventListener('click', function () { openSettings(); });

  var searchDebounce;
  $('invSearch').addEventListener('input', function () {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(function () { state.stockFilter = $('invSearch').value; renderGrid(); }, 200);
  });

  // ---- Foto diperbesar (lightbox) ----
  function driveHiRes(url) {
    var m = String(url || '').match(/id=([^&]+)/);
    return m ? 'https://drive.google.com/thumbnail?id=' + m[1] + '&sz=w1600' : url;
  }
  function openLightbox(url) {
    $('lightboxImg').src = url;
    $('photoLightbox').classList.add('show');
  }
  function closeLightbox() {
    $('photoLightbox').classList.remove('show');
    $('lightboxImg').src = '';
  }
  $('btnCloseLightbox').addEventListener('click', closeLightbox);
  $('photoLightbox').addEventListener('click', function (e) { if (e.target === $('photoLightbox')) closeLightbox(); });

  // ---- Detail card ----
  async function openDetail(nama) {
    var row = state.stock.filter(function (r) { return r.nama === nama; })[0];
    state.currentCard = row || { nama: nama, stok: 0 };

    $('dtName').textContent = nama;
    $('dtUpdated').textContent = (row && row.tanggalTerakhir) ? 'Transaksi terakhir: ' + row.tanggalTerakhir : 'Belum ada transaksi';
    setStokReadout(state.currentCard.stok);
    renderDetailPhoto(state.currentCard.fotoUrl);
    $('dtHistory').innerHTML = '<div class="muted-note">Memuat riwayat...</div>';
    $('detailSheet').classList.add('show');

    try {
      renderHistory(await getStockHistory(nama));
    } catch (e) {
      $('dtHistory').innerHTML = '<div class="muted-note">Gagal memuat riwayat: ' + escapeHtml(e.message) + '</div>';
    }
  }

  function renderDetailPhoto(fotoUrl) {
    var wrap = $('dtPhotoWrap');
    var img = $('dtPhoto');
    if (!fotoUrl) { wrap.style.display = 'none'; img.src = ''; return; }
    img.src = fotoUrl;
    wrap.style.display = 'block';
    img.onerror = function () { wrap.style.display = 'none'; };
    wrap.onclick = function () { openLightbox(driveHiRes(fotoUrl)); };
  }

  $('btnDtPrev').addEventListener('click', function () { switchDetailItem(-1); });
  $('btnDtNext').addEventListener('click', function () { switchDetailItem(1); });

  function switchDetailItem(dir) {
    var list = currentFilteredList();
    if (!state.currentCard || !list.length) return;
    var idx = list.findIndex(function (x) { return x.nama === state.currentCard.nama; });
    if (idx === -1) return;
    var newIdx = (idx + dir + list.length) % list.length;
    openDetail(list[newIdx].nama);
  }

  function setStokReadout(stok) {
    stok = Number(stok) || 0;
    var el = $('dtStok');
    el.textContent = stok.toLocaleString('id-ID');
    el.className = 'rvalue mono' + (stok > 0 ? '' : (stok < 0 ? ' neg' : ' zero'));
  }

  function renderHistory(hist) {
    if (!hist.length) { $('dtHistory').innerHTML = '<div class="muted-note">Belum ada transaksi untuk card ini.</div>'; return; }
    $('dtHistory').innerHTML = hist.map(function (h) {
      var jenis = String(h.jenis || '').toLowerCase();
      var cls = jenis === 'masuk' ? 'masuk' : 'keluar';
      return '<div class="hist-item"><span class="hist-jenis ' + cls + '">' + escapeHtml(h.jenis) + '</span>' +
        '<div class="hist-mid"><div class="hist-pcs">' + (Number(h.jumlahPcs) || 0).toLocaleString('id-ID') + ' pcs</div>' +
        '<div class="hist-tgl">' + escapeHtml(h.tanggal || '') + (h.totalTimbangan ? ' \u00b7 ' + h.totalTimbangan + ' kg' : '') + '</div></div></div>';
    }).join('');
  }

  $('btnCloseDetail').addEventListener('click', function () { $('detailSheet').classList.remove('show'); });
  $('detailSheet').addEventListener('click', function (e) { if (e.target === $('detailSheet')) $('detailSheet').classList.remove('show'); });

  // ---- Form transaksi ----
  function openTrx(jenis) {
    state.trxJenis = jenis;
    $('trxTitle').textContent = jenis === 'masuk' ? 'Catat Barang Masuk' : 'Catat Barang Keluar';
    $('trxCardName').textContent = state.currentCard ? state.currentCard.nama : '';
    $('fTimbangan').value = ''; $('fPcsManual').value = ''; $('fPcsFinal').value = ''; $('calcResult').innerHTML = '';
    setTrxMode('timbang');
    $('trxSheet').classList.add('show');
  }

  function setTrxMode(mode) {
    state.trxMode = mode;
    document.querySelectorAll('.subtab[data-trxmode]').forEach(function (t) { t.classList.toggle('active', t.dataset.trxmode === mode); });
    $('trxModeTimbang').style.display = mode === 'timbang' ? 'block' : 'none';
    $('trxModeManual').style.display = mode === 'manual' ? 'block' : 'none';
  }

  document.querySelectorAll('.subtab[data-trxmode]').forEach(function (t) { t.addEventListener('click', function () { setTrxMode(t.dataset.trxmode); }); });
  $('fPcsManual').addEventListener('input', function () { $('fPcsFinal').value = $('fPcsManual').value; });
  $('btnTrxMasuk').addEventListener('click', function () { openTrx('masuk'); });
  $('btnTrxCancel').addEventListener('click', function () { $('trxSheet').classList.remove('show'); });
  $('btnCloseTrx').addEventListener('click', function () { $('trxSheet').classList.remove('show'); });

  $('btnHitungPcs').addEventListener('click', async function () {
    var g = parseFloat(String($('fTimbangan').value).replace(',', '.'));
    if (!g || g <= 0) { toast('Isi total timbangan dulu.'); return; }
    var btn = $('btnHitungPcs');
    btn.disabled = true; btn.textContent = 'Menghitung...';
    try {
      var r = await hitungPcsDariTimbangan(state.currentCard.nama, g);
      $('calcResult').innerHTML = 'Berat per pcs: <b>' + Number(r.beratPerPcs).toFixed(6) + '</b> kg<br>' +
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
      var r = await saveStockTransaction(state.currentCard.nama, state.trxJenis, pcs, timbangan);
      if (state.vibrate) { try { await Haptics.vibrate({ duration: 60 }); } catch (e) {} }
      toast('Tersimpan. Stok sekarang: ' + Number(r.stokSaatIni).toLocaleString('id-ID') + ' pcs');
      $('trxSheet').classList.remove('show');

      state.currentCard.stok = r.stokSaatIni;
      setStokReadout(r.stokSaatIni);
      state.stock.forEach(function (row) { if (row.nama === state.currentCard.nama) row.stok = r.stokSaatIni; });
      await setPref(KEYS.stockCache, state.stock);
      renderGrid();
      try { renderHistory(await getStockHistory(state.currentCard.nama)); } catch (e) {}
    } catch (e) {
      toast('Gagal menyimpan: ' + e.message);
    } finally {
      btn.disabled = false; btn.textContent = 'Simpan';
    }
  });

  // ================= History Scan =================
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

  async function pushHistory(code) {
    state.history.unshift({ code: code, time: Date.now() });
    state.history = state.history.slice(0, 50);
    await setPref(KEYS.history, state.history);
    refreshHistoryUi();
  }

  $('btnToggleHistory').addEventListener('click', function () { $('historyPanel').classList.toggle('show'); });
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
    } catch (e) { /* platform lain tidak butuh langkah ini */ }
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
      if (!barcodes.length) { toast('Tidak ada kode terdeteksi.'); return; }
      await onScanResult(barcodes[0].rawValue || '');
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
    if (state.vibrate) { try { await Haptics.vibrate({ duration: 80 }); } catch (e) {} }

    if (!isHttpUrl(raw)) { toast('Kode di-scan bukan link, tidak dibuka otomatis.'); return; }
    if (state.confirmOpen) showConfirmOpen(raw); else await openLink(raw);
  }

  async function openLink(url) {
    try {
      if (state.openMode === 'external') window.open(url, '_system');
      else await Browser.open({ url: url });
    } catch (e) { toast('Gagal membuka link.'); }
  }

  $('btnScan').addEventListener('click', startScan);

  var pendingUrl = null;
  function showConfirmOpen(url) { pendingUrl = url; $('confirmUrlText').textContent = url; $('confirmModal').classList.add('show'); }
  $('btnConfirmCancel').addEventListener('click', function () { $('confirmModal').classList.remove('show'); pendingUrl = null; });
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
  $('settingsModal').addEventListener('click', function (e) { if (e.target === $('settingsModal')) closeSettings(); });

  $('btnGoogleSignIn').addEventListener('click', beginSignIn);
  $('btnGoogleSignOut').addEventListener('click', signOut);

  $('btnSaveSpreadsheetId').addEventListener('click', async function () {
    var v = $('fSpreadsheetId').value.trim();
    state.spreadsheetId = v;
    await setPref(KEYS.spreadsheetId, v);
    state.invLoadedOnce = false;
    toast('Spreadsheet ID disimpan.');
  });

  $('btnTestApi').addEventListener('click', async function () {
    var btn = $('btnTestApi'); var msg = $('apiTestMsg');
    var savedId = state.spreadsheetId;
    state.spreadsheetId = $('fSpreadsheetId').value.trim();
    btn.disabled = true; msg.style.color = 'var(--muted)'; msg.textContent = 'Menghubungi Google Sheets...';
    try {
      if (!isSignedIn()) throw new Error('Belum sign-in Google.');
      var r = await pingSpreadsheet();
      msg.style.color = 'var(--green)';
      msg.textContent = 'Berhasil terhubung ke "' + r.judul + '".';
    } catch (e) {
      msg.style.color = 'var(--red)';
      msg.textContent = 'Gagal: ' + e.message;
      state.spreadsheetId = savedId;
    } finally {
      btn.disabled = false;
    }
  });

  $('fOpenMode').addEventListener('change', async function () { state.openMode = $('fOpenMode').value; await setPref(KEYS.openMode, state.openMode); });
  $('fConfirmOpen').addEventListener('change', async function () { state.confirmOpen = $('fConfirmOpen').checked; await setPref(KEYS.confirmOpen, state.confirmOpen); });
  $('fVibrate').addEventListener('change', async function () { state.vibrate = $('fVibrate').checked; await setPref(KEYS.vibrate, state.vibrate); });
  $('fQrOnly').addEventListener('change', async function () { state.qrOnly = $('fQrOnly').checked; await setPref(KEYS.qrOnly, state.qrOnly); });
  $('fAutoRefresh').addEventListener('change', async function () { state.autoRefresh = $('fAutoRefresh').checked; await setPref(KEYS.autoRefresh, state.autoRefresh); });

  // ================= Kalibrasi: baca/tulis ke Sheets =================
  async function rewriteSheetRows(sheetName, headerRow, dataRows) {
    // Sheets API tidak punya "hapus baris berdasarkan nilai" yang simpel lewat
    // HTTP, jadi seluruh sheet ditulis ulang: bersihkan dulu, lalu tulis
    // header + data terbaru dari A1. Aman untuk ukuran data card gudang.
    await sheetsFetch('/values/' + encodeURIComponent(sheetName) + ':clear', { method: 'POST' });
    var all = [headerRow].concat(dataRows);
    await sheetsFetch('/values/' + encodeURIComponent(sheetName) + '?valueInputOption=USER_ENTERED', {
      method: 'PUT',
      body: JSON.stringify({ values: all })
    });
  }

  async function getCalibrationPartsFor(nama) {
    var target = String(nama).trim().toLowerCase();
    var rows = await readRawRows('Kalibrasi_Parts');
    var parts = rows.filter(function (r) { return String(r[0]).trim().toLowerCase() === target; })
      .map(function (r) { return { jumlahPcs: Number(r[2]), totalTimbangan: Number(r[3]) }; });

    var qtyIket = null;
    var cardRows = await readRawRows('Kalibrasi_Card');
    var found = cardRows.filter(function (r) { return String(r[0]).trim().toLowerCase() === target; })[0];
    if (found && found[7] !== undefined && found[7] !== '' && found[7] !== null) qtyIket = Number(found[7]);
    return { parts: parts, qtyPerIketKecil: qtyIket };
  }

  async function saveCalibrationToSheets(nama, parts, qtyIket) {
    await ensureSheetExists('Kalibrasi_Parts', ['Nama Card', 'Part Ke', 'Jumlah Pcs', 'Total Timbangan', 'Tanggal']);
    await ensureSheetExists('Kalibrasi_Card', ['Nama Card', 'Jumlah Part', 'Total Pcs Gabungan', 'Total Timbangan Gabungan', 'Berat per Pcs', 'Tanggal Update', 'Foto URL', 'Qty per Iket Kecil']);

    var target = nama.trim().toLowerCase();
    var nowIso = new Date().toISOString();

    // --- Kalibrasi_Parts: ganti semua part lama milik nama ini dengan gabungan baru ---
    var oldParts = await readRawRows('Kalibrasi_Parts');
    var keepParts = oldParts.filter(function (r) { return String(r[0]).trim().toLowerCase() !== target; });
    var newPartRows = parts.map(function (p, idx) { return [nama, idx + 1, p.jumlahPcs, p.totalTimbangan, nowIso]; });
    await rewriteSheetRows('Kalibrasi_Parts', ['Nama Card', 'Part Ke', 'Jumlah Pcs', 'Total Timbangan', 'Tanggal'], keepParts.concat(newPartRows));

    // --- Kalibrasi_Card: upsert baris ringkasan ---
    var totalPcs = 0, totalTimbangan = 0;
    parts.forEach(function (p) { totalPcs += p.jumlahPcs; totalTimbangan += p.totalTimbangan; });
    var beratPerPcs = totalTimbangan / totalPcs;

    var cardRows = await readRawRows('Kalibrasi_Card');
    var existingIdx = -1, existingFoto = '';
    cardRows.forEach(function (r, i) {
      if (String(r[0]).trim().toLowerCase() === target) { existingIdx = i; existingFoto = r[6] || ''; }
    });
    var summaryRow = [nama, parts.length, totalPcs, totalTimbangan, beratPerPcs, nowIso, existingFoto,
      (qtyIket !== null && qtyIket !== undefined) ? qtyIket : ''];
    var updated = existingIdx > -1;
    if (updated) cardRows[existingIdx] = summaryRow; else cardRows.push(summaryRow);
    await rewriteSheetRows('Kalibrasi_Card', ['Nama Card', 'Jumlah Part', 'Total Pcs Gabungan', 'Total Timbangan Gabungan', 'Berat per Pcs', 'Tanggal Update', 'Foto URL', 'Qty per Iket Kecil'], cardRows);

    return { nama: nama, updated: updated, jumlahPart: parts.length, beratPerPcs: beratPerPcs };
  }

  // ================= Kalibrasi: UI (part rows, preview, simpan) =================
  var kPartCounter = 0;
  var kLastLoadedNama = '';

  function addPartRow(prefill) {
    kPartCounter++;
    var div = document.createElement('div');
    div.className = 'part-row';
    div.innerHTML =
      '<div class="field"><label>Part &mdash; jumlah pcs</label>' +
      '<input type="text" inputmode="decimal" class="kp-jumlah" placeholder="mis. 100"></div>' +
      '<div class="field"><label>Total timbangan (kg)</label>' +
      '<input type="text" inputmode="decimal" class="kp-total" placeholder="mis. 0.345"></div>' +
      '<button type="button" class="part-remove" title="Hapus part ini">&times;</button>';
    $('kParts').appendChild(div);
    var jInput = div.querySelector('.kp-jumlah');
    var tInput = div.querySelector('.kp-total');
    if (prefill) { jInput.value = prefill.jumlahPcs; tInput.value = prefill.totalTimbangan; }
    jInput.addEventListener('input', updateKalibrasiPreview);
    tInput.addEventListener('input', updateKalibrasiPreview);
    div.querySelector('.part-remove').addEventListener('click', function () {
      div.remove();
      renumberParts();
      updateKalibrasiPreview();
    });
    renumberParts();
    updateKalibrasiPreview();
  }

  function renumberParts() {
    $('kParts').querySelectorAll('.part-row').forEach(function (row, idx) {
      row.querySelector('label').textContent = 'Part ' + (idx + 1) + ' \u2014 jumlah pcs';
    });
  }

  function resetKalibrasiParts(prefillList) {
    $('kParts').innerHTML = '';
    kPartCounter = 0;
    if (prefillList && prefillList.length) prefillList.forEach(function (p) { addPartRow(p); });
    else addPartRow(null);
  }

  $('kAddPart').addEventListener('click', function () { addPartRow(null); });

  function readKalibrasiParts() {
    var parts = [];
    $('kParts').querySelectorAll('.part-row').forEach(function (row) {
      var j = parseFloat(String(row.querySelector('.kp-jumlah').value).replace(',', '.'));
      var t = parseFloat(String(row.querySelector('.kp-total').value).replace(',', '.'));
      if (j > 0 && t > 0) parts.push({ jumlahPcs: j, totalTimbangan: t });
    });
    return parts;
  }

  function updateKalibrasiPreview() {
    var parts = readKalibrasiParts();
    if (!parts.length) {
      $('kRvalue').textContent = '\u2014';
      $('kRdetail').textContent = 'kg / pcs';
      $('kReadout').classList.add('muted');
      return;
    }
    var totalPcs = 0, totalTimbangan = 0;
    parts.forEach(function (p) { totalPcs += p.jumlahPcs; totalTimbangan += p.totalTimbangan; });
    var berat = totalTimbangan / totalPcs;
    $('kRvalue').textContent = berat.toFixed(6);
    $('kRdetail').textContent = 'kg / pcs \u00b7 ' + parts.length + ' part \u00b7 ' + totalPcs + ' pcs total';
    $('kReadout').classList.remove('muted');
  }

  var kNameDebounce;
  $('kNama').addEventListener('input', function () {
    clearTimeout(kNameDebounce);
    var val = $('kNama').value.trim();
    kNameDebounce = setTimeout(async function () {
      if (!val) { $('kLoadNote').style.display = 'none'; return; }
      if (val.toLowerCase() === kLastLoadedNama.toLowerCase()) return;
      if (!isSignedIn() || !state.spreadsheetId) return;
      try {
        var data = await getCalibrationPartsFor(val);
        if (data.parts.length) {
          kLastLoadedNama = val;
          resetKalibrasiParts(data.parts);
          $('kQtyIket').value = (data.qtyPerIketKecil !== null && data.qtyPerIketKecil !== undefined) ? data.qtyPerIketKecil : '';
          $('kLoadNote').textContent = 'Card ini sudah punya ' + data.parts.length + ' part sebelumnya \u2014 dimuat otomatis, tinggal tambah part baru lalu Simpan.';
          $('kLoadNote').style.display = 'block';
        } else {
          kLastLoadedNama = '';
          $('kLoadNote').style.display = 'none';
        }
      } catch (e) { /* diam saja — bukan blocking utk pengisian form */ }
    }, 400);
  });

  $('kSave').addEventListener('click', async function () {
    var btn = $('kSave');
    var nama = $('kNama').value.trim();
    var parts = readKalibrasiParts();
    var qtyRaw = parseFloat(String($('kQtyIket').value).replace(',', '.'));
    var qtyIket = (qtyRaw > 0) ? qtyRaw : null;

    $('kMsg').textContent = ''; $('kMsg').className = 'kal-msg';
    if (!nama) { $('kMsg').textContent = 'Nama card wajib diisi.'; $('kMsg').className = 'kal-msg err'; return; }
    if (!parts.length) { $('kMsg').textContent = 'Isi minimal 1 part (jumlah pcs & total timbangan).'; $('kMsg').className = 'kal-msg err'; return; }
    if (!isSignedIn()) { $('kMsg').textContent = 'Belum sign-in Google. Buka Pengaturan.'; $('kMsg').className = 'kal-msg err'; return; }
    if (!state.spreadsheetId) { $('kMsg').textContent = 'Spreadsheet ID belum diatur. Buka Pengaturan.'; $('kMsg').className = 'kal-msg err'; return; }

    btn.disabled = true; btn.textContent = 'Menyimpan...';
    try {
      var res = await saveCalibrationToSheets(nama, parts, qtyIket);
      $('kMsg').className = 'kal-msg ok';
      $('kMsg').innerHTML = (res.updated ? 'Kalibrasi "' + escapeHtml(res.nama) + '" diperbarui \u2014 ' : 'Kalibrasi "' + escapeHtml(res.nama) + '" disimpan \u2014 ') +
        res.jumlahPart + ' part, berat per pcs gabungan: <b>' + res.beratPerPcs.toFixed(6) + ' kg</b>.';
      $('kNama').value = ''; $('kQtyIket').value = '';
      kLastLoadedNama = '';
      $('kLoadNote').style.display = 'none';
      resetKalibrasiParts(null);
      state.invLoadedOnce = false; // biar tab Inventory tarik ulang, card baru ikut muncul
    } catch (e) {
      $('kMsg').className = 'kal-msg err';
      $('kMsg').textContent = e.message;
    } finally {
      btn.disabled = false; btn.textContent = 'Simpan Kalibrasi';
    }
  });

  // ================= Update check =================
  $('btnCheckUpdate').addEventListener('click', async function () {
    var btn = $('btnCheckUpdate');
    btn.disabled = true; btn.textContent = '...';
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
      btn.disabled = false; btn.textContent = 'Cek';
    }
  });

  // ================= Init =================
  async function init() {
    $('verLabel').textContent = 'v' + APP_VERSION;
    try {
      var info = await App.getInfo();
      if (info && info.version) { APP_VERSION = info.version; $('verLabel').textContent = 'v' + APP_VERSION; }
    } catch (e) { /* web preview: getInfo tidak tersedia */ }

    await loadSettings();
    resetKalibrasiParts(null);
    switchView('scan');
  }

  init();
})();
