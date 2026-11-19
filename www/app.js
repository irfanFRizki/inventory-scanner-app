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
  var LIMIT_STOCK = 1000; // batas alarm stock hampir habis (pcs) sesuai rekap_stock.py

  // WAJIB diisi manual setelah membuat OAuth Client ID (tipe "Android") di
  // Google Cloud Console — lihat README bagian "Setup Google Cloud Console".
  // Formatnya: "xxxxxxxxxx-yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy.apps.googleusercontent.com"
  // CATATAN: nilai ini dibaca juga oleh scripts/patch-android-manifest.js
  // saat build CI untuk mendaftarkan redirect URI — jadi HARUS tetap dalam
  // format 'GOOGLE_OAUTH_CLIENT_ID = ...'; (string literal, satu baris).
  var GOOGLE_OAUTH_CLIENT_ID = '250943179443-0onrfglhn814v2fck81qmqf4cd76es80.apps.googleusercontent.com';

  // ================= Versi web (browser PC) =================
  // Dipakai HANYA saat halaman dibuka di browser (mis. GitHub Pages). Di dalam
  // APK nilai ini diabaikan. Isi dengan OAuth Client ID bertipe "Web application"
  // dari Google Cloud Console; "Authorized JavaScript origins"-nya harus memuat
  // alamat situs (mis. https://irfanfrizki.github.io). Client ID bukan rahasia.
  // Nama variabel sengaja berbeda supaya tidak terbaca scripts/patch-android-manifest.js.
  var GOOGLE_OAUTH_WEB_CLIENT_ID = '250943179443-ebe5pr6ri17j0n07ajc4munkkn61pjkg.apps.googleusercontent.com';
  var IS_WEB = !(window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function' && window.Capacitor.isNativePlatform());

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

  // ================= State & Storage =================
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
    filterLowStockOnly: false,
    currentBrand: null,
    currentCard: null,
    trxJenis: 'masuk',
    trxMode: 'timbang',
    mutasi: [],
    mutasiFilter: '',
    mutasiTab: 'all',
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

  // Parse tanggal dari Sheets. Teks "dd/mm/yyyy [HH:mm[:ss]]" (format Indonesia)
  // dibaca sebagai hari/bulan/tahun; new Date() akan salah membacanya sebagai bulan/hari.
  function parseTanggal(val) {
    if (val instanceof Date) return val;
    var s = String(val == null ? '' : val).trim();
    var m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})(?:[ T,]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
    if (m) {
      return new Date(+m[3], +m[2] - 1, +m[1], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
    }
    return new Date(val);
  }

  function fmtTanggal(val) {
    if (!val) return '';
    var d = parseTanggal(val);
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

  // Android: sudah masuk selama ada refresh token. Web (Google Identity Services)
  // tidak punya refresh token, jadi sudah masuk = access token masih berlaku.
  function isSignedIn() {
    if (IS_WEB) return !!state.oauth.accessToken && Date.now() < state.oauth.expiresAt;
    return !!state.oauth.refreshToken;
  }

  // ----- Login versi web: Google Identity Services (popup, tanpa client secret) -----
  var gisLoading = null;
  function loadGis() {
    if (window.google && window.google.accounts && window.google.accounts.oauth2) return Promise.resolve();
    if (gisLoading) return gisLoading;
    gisLoading = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client';
      s.async = true;
      s.onload = function () { resolve(); };
      s.onerror = function () { gisLoading = null; reject(new Error('Gagal memuat Google Sign-In. Cek koneksi internet.')); };
      document.head.appendChild(s);
    });
    return gisLoading;
  }

  async function webSignIn() {
    if (!GOOGLE_OAUTH_WEB_CLIENT_ID) {
      toast('GOOGLE_OAUTH_WEB_CLIENT_ID belum diisi di www/app.js (Client ID tipe Web).');
      return;
    }
    try {
      await loadGis();
    } catch (e) { toast(e.message); return; }
    var client = window.google.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_OAUTH_WEB_CLIENT_ID,
      scope: SHEETS_SCOPE + ' ' + USERINFO_SCOPE,
      callback: async function (resp) {
        if (!resp || resp.error || !resp.access_token) {
          toast('Sign-in gagal: ' + ((resp && (resp.error_description || resp.error)) || 'tidak ada token'));
          return;
        }
        await applyTokenResponse(resp);
        await fetchUserEmail();
        toast('Berhasil masuk dengan Google.');
        renderSignInStatus();
      },
      error_callback: function (err) {
        var t = err && err.type;
        if (t === 'popup_closed') toast('Sign-in dibatalkan.');
        else if (t === 'popup_failed_to_open') toast('Popup login diblokir browser. Izinkan popup untuk situs ini.');
        else toast('Sign-in gagal' + (t ? ': ' + t : '.'));
      }
    });
    client.requestAccessToken({ prompt: '' });
  }

  async function beginSignIn() {
    if (IS_WEB) { await webSignIn(); return; }
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
      prompt: 'consent',
      // Force a new refresh token on re-authentication, including when the
      // account still has an old grant from a previous installation.
      include_granted_scopes: 'true'
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
    if (!res.ok) {
      var err = new Error(json.error_description || json.error || ('HTTP ' + res.status));
      err.oauthError = json.error || '';
      throw err;
    }
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
    if (IS_WEB) {
      if (state.oauth.accessToken && Date.now() < state.oauth.expiresAt) return state.oauth.accessToken;
      // Token Google Identity Services berlaku sekitar 1 jam dan tidak bisa
      // diperbarui diam-diam tanpa klik pengguna (popup diblokir browser).
      renderSignInStatus();
      throw new Error('Sesi Google habis. Buka Pengaturan → Masuk dgn Google.');
    }
    if (!state.oauth.refreshToken) throw new Error('Belum sign-in dengan Google. Buka Pengaturan.');
    if (state.oauth.accessToken && Date.now() < state.oauth.expiresAt) return state.oauth.accessToken;
    var tok;
    try {
      tok = await tokenRequest({
        grant_type: 'refresh_token',
        refresh_token: state.oauth.refreshToken,
        client_id: GOOGLE_OAUTH_CLIENT_ID
      });
    } catch (e) {
      // Google returns invalid_grant when a refresh token has expired or been
      // revoked. Do not keep presenting the app as signed in with unusable
      // credentials; clear only OAuth state and ask the user to sign in again.
      if (e.oauthError === 'invalid_grant') {
        state.oauth = { accessToken: '', expiresAt: 0, refreshToken: '', email: '' };
        await clearPref(KEYS.oauthAccessToken);
        await clearPref(KEYS.oauthExpiresAt);
        await clearPref(KEYS.oauthRefreshToken);
        await clearPref(KEYS.oauthEmail);
        renderSignInStatus();
        throw new Error('Sesi Google sudah kedaluwarsa atau dicabut. Masuk kembali lewat Pengaturan → Masuk dengan Google.');
      }
      throw e;
    }
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
      if (IS_WEB && window.google && window.google.accounts && window.google.accounts.oauth2) {
        try { window.google.accounts.oauth2.revoke(token, function () {}); } catch (e) { /* abaikan */ }
      } else {
        fetch('https://oauth2.googleapis.com/revoke?token=' + encodeURIComponent(token)).catch(function () {});
      }
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
  async function sheetsFetch(pathAndQuery, options, retried) {
    if (!state.spreadsheetId) throw new Error('Spreadsheet ID belum diatur.');
    var token = await getValidAccessToken();
    var res = await fetch(SHEETS_API + '/' + state.spreadsheetId + pathAndQuery, Object.assign({}, options, {
      headers: Object.assign({ Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, (options && options.headers) || {})
    }));
    if (res.status === 401 && !retried) {
      // Access token sudah ditolak server tapi cache expiresAt masih menganggap
      // valid (mis. jam perangkat bergeser). Paksa refresh lalu ulangi sekali.
      state.oauth.expiresAt = 0;
      return sheetsFetch(pathAndQuery, options, true);
    }
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

  // Brand otomatis = kata pertama di Nama Card (mis. "XP Card ATT" -> "XP").
  function brandFromName(nama) {
    var first = String(nama || '').trim().split(/\s+/)[0] || '';
    return first.toUpperCase();
  }
  function brandBadgeHtml(nama) {
    var b = brandFromName(nama);
    return b ? '<span class="brand-badge brand-' + escapeHtml(b.toLowerCase().replace(/[^a-z0-9]/g, '')) + '">' + escapeHtml(b) + '</span>' : '';
  }

  // Daftar brand dinamis dari data stok (kata pertama tiap Nama Card).
  // Kalau data belum ada, pakai brand bawaan supaya layar pilih brand tidak kosong.
  var DEFAULT_BRANDS = ['ML', 'XP', 'LYN'];
  function getBrandList() {
    var seen = {};
    (state.stock || []).forEach(function (r) {
      var b = brandFromName(r.nama);
      if (b) seen[b] = true;
    });
    var list = Object.keys(seen).sort(function (a, b) { return a.localeCompare(b); });
    return list.length ? list : DEFAULT_BRANDS.slice();
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
      if (tgl && (!lastTgl[nm] || parseTanggal(tgl) > parseTanggal(lastTgl[nm]))) lastTgl[nm] = tgl;
    });

    var result = Object.keys(names).map(function (nm) {
      return {
        nama: nm,
        brand: brandFromName(nm),
        stok: stokMap[nm] || 0,
        fotoUrl: foto[nm] || '',
        tanggalTerakhir: lastTgl[nm] ? fmtTanggal(lastTgl[nm]) : ''
      };
    });
    result.sort(function (a, b) { return a.nama.localeCompare(b.nama); });
    return result;
  }

  // ---- Ringkasan merek & alarm low stock (sesuai rekap_stock.py) ----
  function getBrandSummary() {
    var brands = getBrandList();
    var cardStock = {}, plasticStock = {}, brandCounts = {}, brandLowCount = {};
    brands.forEach(function (b) { cardStock[b] = 0; plasticStock[b] = 0; brandCounts[b] = 0; brandLowCount[b] = 0; });

    state.stock.forEach(function (r) {
      var name = String(r.nama || '').trim();
      var brand = brandFromName(name);
      if (brands.indexOf(brand) === -1) return;

      var stock = Number(r.stok) || 0;
      var isPlastic = /plastik/i.test(name);
      if (isPlastic) plasticStock[brand] += stock;
      else cardStock[brand] += stock;
      brandCounts[brand]++;
      if (isLowStock(stock)) brandLowCount[brand]++;
    });

    return {
      brands: brands,
      cardStock: cardStock,
      plasticStock: plasticStock,
      counts: brandCounts,
      lowCounts: brandLowCount
    };
  }

  function isLowStock(stok) {
    return stok > 0 && stok <= LIMIT_STOCK;
  }

  function isOutStock(stok) {
    return stok <= 0;
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

  // ---- Mutasi: riwayat pergerakan stok semua card (masuk/keluar) ----
  async function getMutasiList() {
    var rows = await readRawRows('Stock_Mutasi');
    var res = rows.map(function (r) {
      var nm = r[0] || '';
      var jenis = String(r[1] || '').trim();
      var jp = Number(r[2]) || 0;
      var tgl = r[4];
      return {
        nama: nm,
        jenis: jenis.toLowerCase(),
        jumlahPcs: jp,
        totalTimbangan: Number(r[3]) || 0,
        tanggal: tgl ? fmtTanggal(tgl) : '',
        keterangan: r[5] || '',
        rawTgl: tgl
      };
    }).filter(function (r) { return r.nama && r.tanggal; });
    // Urutkan paling baru di atas (rawTgl untuk sorting)
    res.sort(function (a, b) {
      var da = parseTanggal(a.rawTgl);
      var db = parseTanggal(b.rawTgl);
      return db - da;
    });
    return res;
  }

  function filterMutasi(list) {
    var q = state.mutasiFilter.trim().toLowerCase();
    var tab = state.mutasiTab;
    return list.filter(function (r) {
      var matchQ = !q || r.nama.toLowerCase().indexOf(q) > -1;
      var matchTab = tab === 'all' || r.jenis === tab;
      return matchQ && matchTab;
    });
  }

  function updateMutasiCounts(list) {
    var all = list.length;
    var masuk = list.filter(function (r) { return r.jenis === 'masuk'; }).length;
    var keluar = list.filter(function (r) { return r.jenis === 'keluar'; }).length;
    $('mutasiAllCount').textContent = all;
    $('mutasiMasukCount').textContent = masuk;
    $('mutasiKeluarCount').textContent = keluar;
  }

  function renderMutasi(list) {
    var filtered = filterMutasi(list);
    updateMutasiCounts(filtered);

    if (!filtered.length) {
      $('mutasiList').innerHTML = '';
      var emptyText = state.mutasiFilter
        ? 'Tidak ada mutasi yang cocok dengan pencarian \"' + escapeHtml(state.mutasiFilter) + '\".'
        : (state.mutasiTab === 'all'
          ? 'Belum ada riwayat mutasi stok.'
          : (state.mutasiTab === 'masuk'
            ? 'Belum ada barang masuk yang tercatat.'
            : 'Belum ada barang keluar yang tercatat.'));
      $('mutasiEmptyText').textContent = emptyText;
      $('mutasiEmpty').style.display = 'flex';
      $('mutasiLoading').style.display = 'none';
      return;
    }
    $('mutasiEmpty').style.display = 'none';
    $('mutasiLoading').style.display = 'none';

    $('mutasiList').innerHTML = filtered.map(function (r) {
      var isMasuk = r.jenis === 'masuk';
      var arrowHtml = isMasuk ? '&#8679;' : '&#8681;';
      var arrowClass = isMasuk ? 'masuk' : 'keluar';
      var qtyClass = isMasuk ? 'masuk' : 'keluar';
      var qtyPrefix = isMasuk ? '+' : '-';
      return '<div class="mutasi-item">' +
        '<div class="mutasi-arrow ' + arrowClass + '">' + arrowHtml + '</div>' +
        '<div class="mutasi-info">' +
          '<div class="mutasi-name">' + escapeHtml(r.nama) + '</div>' +
          '<div class="mutasi-meta">' +
            '<span class="mutasi-time">' + escapeHtml(r.tanggal) + '</span>' +
            (r.keterangan ? '<span class="mutasi-desc">· ' + escapeHtml(r.keterangan) + '</span>' : '') +
          '</div>' +
        '</div>' +
        '<div class="mutasi-qty ' + qtyClass + '">' + qtyPrefix + Number(r.jumlahPcs).toLocaleString('id-ID') + ' pcs</div>' +
      '</div>';
    }).join('');
  }

  async function loadMutasi() {
    if (!isSignedIn()) {
      $('mutasiEmptyText').textContent = 'Belum masuk dengan akun Google. Buka Pengaturan untuk sign-in.';
      $('mutasiEmpty').style.display = 'flex';
      $('mutasiLoading').style.display = 'none';
      return;
    }
    if (!state.spreadsheetId) {
      $('mutasiEmptyText').textContent = 'Spreadsheet ID belum diatur. Buka Pengaturan untuk mengisinya.';
      $('mutasiEmpty').style.display = 'flex';
      $('mutasiLoading').style.display = 'none';
      return;
    }
    $('mutasiLoading').style.display = 'flex';
    $('mutasiEmpty').style.display = 'none';
    try {
      state.mutasi = await getMutasiList();
      renderMutasi(state.mutasi);
    } catch (e) {
      $('mutasiEmptyText').textContent = 'Gagal memuat: ' + e.message;
      $('mutasiEmpty').style.display = 'flex';
      $('mutasiLoading').style.display = 'none';
      toast(e.message);
    }
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
    if (name !== 'lokasi') lokasiStop();
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
        renderBrandPicker();
        if (!state.invLoadedOnce) loadInventory(state.stock.length > 0);
      }
    } else if (name === 'stock') {
      // Always load stock data when opening Stock tab
      if (!state.invLoadedOnce || state.autoRefresh) loadInventory(state.stock.length > 0);
      else renderStockTab();
    } else if (name === 'mutasi') {
      if (!state.invLoadedOnce || state.autoRefresh) loadMutasi();
      else renderMutasi(state.mutasi);
    } else if (name === 'lokasi') {
      openLokasiView();
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

  // Tombol brand dibuat dari data (kata pertama Nama Card), bukan daftar tetap.
  function renderBrandPicker() {
    var box = $('brandButtons');
    if (!box) return;
    box.innerHTML = getBrandList().map(function (b) {
      return '<button class="btn brand-btn" data-brand="' + escapeHtml(b) + '">' + escapeHtml(b) + '</button>';
    }).join('');
  }

  document.querySelector('.brand-pick').addEventListener('click', function (e) {
    var btn = e.target.closest ? e.target.closest('.brand-btn') : null;
    if (!btn) return;
    state.currentBrand = btn.dataset.brand || '';
    $('invBrandLabel').textContent = state.currentBrand ? state.currentBrand : 'Semua Brand';
    state.stockFilter = '';
    $('invSearch').value = '';
    showInvScreen('grid');
    if (!state.invLoadedOnce || state.autoRefresh) loadInventory(state.stock.length > 0);
    else renderGrid();
  });

  $('btnGantiBrand').addEventListener('click', function () {
    state.currentBrand = null;
    showInvScreen('brand');
    renderBrandPicker();
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
    renderBrandPicker();
    if ($('view-stock').classList.contains('active')) renderStockTab();
    else renderGrid();
  }

  // Daftar yang lagi ditampilkan (sudah difilter brand + pencarian) — dipakai
  // juga untuk navigasi Sebelumnya/Berikutnya di panel detail.
  function currentFilteredList() {
    var brand = (state.currentBrand || '').toUpperCase();
    var q = state.stockFilter.trim().toLowerCase();
    return state.stock.filter(function (r) {
      var nm = String(r.nama || '');
      var stok = Number(r.stok) || 0;
      var matchBrand = !brand || brandFromName(nm) === brand;
      var matchQ = !q || nm.toLowerCase().indexOf(q) > -1;
      var matchLow = !state.filterLowStockOnly || (stok > 0 && stok <= LIMIT_STOCK);
      return matchBrand && matchQ && matchLow;
    });
  }

  function renderBrandSummaryUi() {
    var summary = getBrandSummary();
    var target = $('stockBrandSummary');
    if (!target) return;
    var brands = summary.brands;
    var cardTotal = 0, plasticTotal = 0, itemTotal = 0, lowTotal = 0;
    brands.forEach(function (b) {
      cardTotal += summary.cardStock[b] || 0;
      plasticTotal += summary.plasticStock[b] || 0;
      itemTotal += summary.counts[b] || 0;
      lowTotal += summary.lowCounts[b] || 0;
    });
    var html = '<table class="brand-summary-table"><thead><tr><th>Merek</th><th style="text-align:right">Card</th><th style="text-align:right">Plastik</th><th style="text-align:right">Total sisa</th><th style="text-align:right">Item</th><th style="text-align:right">Hampir habis</th></tr></thead><tbody>';
    brands.forEach(function (b) {
      var card = summary.cardStock[b] || 0, plastic = summary.plasticStock[b] || 0;
      html += '<tr><td><b>' + b + '</b></td><td class="num">' + card.toLocaleString('id-ID') + '</td><td class="num">' + plastic.toLocaleString('id-ID') + '</td><td class="num">' + (card + plastic).toLocaleString('id-ID') + '</td><td class="num">' + (summary.counts[b] || 0) + '</td><td class="num">' + (summary.lowCounts[b] || 0) + '</td></tr>';
    });
    html += '<tr><td><b>TOTAL</b></td><td class="num"><b>' + cardTotal.toLocaleString('id-ID') + '</b></td><td class="num"><b>' + plasticTotal.toLocaleString('id-ID') + '</b></td><td class="num"><b>' + (cardTotal + plasticTotal).toLocaleString('id-ID') + '</b></td><td class="num"><b>' + itemTotal + '</b></td><td class="num"><b>' + lowTotal + '</b></td></tr></tbody></table>';
    target.innerHTML = html;
    if ($('stockBrandLabel')) $('stockBrandLabel').textContent = 'Total stok: ' + (cardTotal + plasticTotal).toLocaleString('id-ID') + ' pcs';
  }

  // ---- Stock tab: ringkasan merek + item hampir habis/habis ----
  var stockTabFilter = 'low';
  function renderStockTab() {
    renderBrandSummaryUi();
    var lowRows = state.stock.filter(function (r) { return isLowStock(Number(r.stok) || 0); });
    var outRows = state.stock.filter(function (r) { return isOutStock(Number(r.stok) || 0); });
    var query = String(($('stockSearch') && $('stockSearch').value) || '').trim().toLowerCase();
    var rows = (stockTabFilter === 'out' ? outRows : lowRows).filter(function (r) { return !query || r.nama.toLowerCase().indexOf(query) >= 0; });
    $('stockLowCount').textContent = lowRows.length;
    $('stockOutCount').textContent = outRows.length;
    var grid = $('stockGrid');
    grid.innerHTML = rows.length ? rows.map(function (r) {
      var stok = Number(r.stok) || 0;
      var photo = r.fotoUrl ? '<img src="' + escapeHtml(r.fotoUrl) + '" loading="lazy" onerror="this.parentNode.innerHTML=\'<div class=&quot;ci-placeholder&quot;>&#128196;</div>\'">' : '<div class="ci-placeholder">&#128196;</div>';
      return '<div class="catalog-item" data-nama="' + escapeHtml(r.nama) + '"><div class="ci-photo-wrap">' + photo + '</div><div class="ci-brand">' + brandBadgeHtml(r.nama) + '</div><div class="ci-label">' + escapeHtml(r.nama) + '</div><div class="ci-stock ' + (stockTabFilter === 'out' ? (stok < 0 ? 'neg' : 'zero') : 'low') + '">' + (stockTabFilter === 'out' ? 'HABIS · ' : 'HAMPIR HABIS · ') + stok.toLocaleString('id-ID') + ' pcs</div></div>';
    }).join('') : '<div style="grid-column:1/-1;text-align:center;color:var(--muted);padding:24px">' + (stockTabFilter === 'out' ? 'Tidak ada item yang sudah habis.' : 'Tidak ada item yang hampir habis.') + '</div>';
    grid.querySelectorAll('.catalog-item').forEach(function (el) { el.addEventListener('click', function () { openDetail(el.dataset.nama); }); });
    $('stockEmpty').style.display = 'none';
    $('stockLoading').style.display = 'none';
  }

  document.querySelectorAll('.stock-tab').forEach(function (tab) {
    tab.addEventListener('click', function () {
      stockTabFilter = tab.dataset.tab;
      document.querySelectorAll('.stock-tab').forEach(function (t) { t.classList.toggle('active', t === tab); });
      renderStockTab();
    });
  });
  $('stockSearch').addEventListener('input', renderStockTab);
  $('btnStockReload').addEventListener('click', function () { loadInventory(true); });

  // ---- Mutasi tab event listeners ----
  document.querySelectorAll('.mutasi-tab').forEach(function (tab) {
    tab.addEventListener('click', function () {
      state.mutasiTab = tab.dataset.tab;
      document.querySelectorAll('.mutasi-tab').forEach(function (t) { t.classList.toggle('active', t === tab); });
      renderMutasi(state.mutasi);
    });
  });
  $('mutasiSearch').addEventListener('input', function () {
    state.mutasiFilter = $('mutasiSearch').value;
    renderMutasi(state.mutasi);
  });
  $('btnMutasiReload').addEventListener('click', function () { loadMutasi(); });

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
      if (isLowStock(stok)) cls = 'low';
      var photo = r.fotoUrl
        ? '<img src="' + escapeHtml(r.fotoUrl) + '" loading="lazy" ' +
          'onerror="this.parentNode.innerHTML=\'<div class=&quot;ci-placeholder&quot;>&#128196;</div>\'">'
        : '<div class="ci-placeholder">&#128196;</div>';
      var stockLabel = 'stok: ' + stok.toLocaleString('id-ID') + ' pcs';
      if (isLowStock(stok)) stockLabel = '⚠ ' + stockLabel + ' (HAMPIR HABIS)';
      if (isOutStock(stok)) stockLabel = '⚠ stok: ' + stok.toLocaleString('id-ID') + ' pcs (HABIS)';
      return '<div class="catalog-item" data-nama="' + escapeHtml(r.nama) + '">' +
        '<div class="ci-photo-wrap">' + photo + '</div>' +
        '<div class="ci-brand">' + brandBadgeHtml(r.nama) + '</div>' +
        '<div class="ci-label">' + escapeHtml(r.nama) + '</div>' +
        '<div class="ci-stock ' + cls + '">' + stockLabel + '</div>' +
        '</div>';
    }).join('');

    $('invGrid').querySelectorAll('.catalog-item').forEach(function (el) {
      el.addEventListener('click', function () { openDetail(el.dataset.nama); });
    });
  }

  $('btnInvReload').addEventListener('click', function () { loadInventory(); });
  $('btnGotoSettingsFromInv').addEventListener('click', function () { openSettings(); });

  var btnLowStockFilter = $('btnLowStockFilter');
  if (btnLowStockFilter) btnLowStockFilter.addEventListener('click', function () {
    stockTabFilter = 'low';
    var tab = document.querySelector('.stock-tab[data-tab="low"]');
    document.querySelectorAll('.stock-tab').forEach(function (t) { t.classList.toggle('active', t === tab); });
    renderStockTab();
    switchView('stock');
  });
  var btnShowLowStock = $('btnShowLowStock');
  if (btnShowLowStock) btnShowLowStock.addEventListener('click', function () {
    stockTabFilter = 'low';
    document.querySelectorAll('.stock-tab').forEach(function (t) { t.classList.toggle('active', t.dataset.tab === 'low'); });
    if ($('stockSearch')) $('stockSearch').value = '';
    renderStockTab();
    switchView('stock');
  });

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
  var lightboxToken = 0;
  function openLightbox(url, fallbackUrl) {
    var img = $('lightboxImg');
    var loading = $('lightboxLoading');
    var token = ++lightboxToken;
    var triedFallback = false;

    img.classList.remove('loaded');
    $('lightboxLoadingText').textContent = 'Memuat foto...';
    loading.classList.remove('error');
    loading.classList.add('show');
    $('photoLightbox').classList.add('show');

    img.onload = function () {
      if (token !== lightboxToken) return;
      loading.classList.remove('show');
      img.classList.add('loaded');
    };
    img.onerror = function () {
      if (token !== lightboxToken) return;
      // Resolusi tinggi gagal: coba sekali lagi pakai foto kecil yang sudah ada.
      if (!triedFallback && fallbackUrl && fallbackUrl !== url) {
        triedFallback = true;
        img.src = fallbackUrl;
        return;
      }
      $('lightboxLoadingText').textContent = 'Gagal memuat foto';
      loading.classList.add('error');
    };
    img.src = url;
    // Gambar sudah ada di cache: onload bisa tidak terpanggil setelah src diset.
    if (img.complete && img.naturalWidth > 0) img.onload();
  }
  function closeLightbox() {
    lightboxToken++;
    $('photoLightbox').classList.remove('show');
    $('lightboxLoading').classList.remove('show');
    var img = $('lightboxImg');
    img.onload = img.onerror = null;
    img.classList.remove('loaded');
    img.src = '';
  }
  $('btnCloseLightbox').addEventListener('click', closeLightbox);
  $('photoLightbox').addEventListener('click', function (e) { if (e.target === $('photoLightbox')) closeLightbox(); });

  // ---- Detail card ----
  async function openDetail(nama) {
    var row = state.stock.filter(function (r) { return r.nama === nama; })[0];
    state.currentCard = row || { nama: nama, stok: 0 };

    $('dtName').textContent = nama;
    if ($('dtBrand')) $('dtBrand').innerHTML = brandBadgeHtml(nama);
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
    wrap.onclick = function () { openLightbox(driveHiRes(fotoUrl), fotoUrl); };
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
    var cls = stok > 0 ? '' : (stok < 0 ? ' neg' : ' zero');
    if (isLowStock(stok)) cls = ' low';
    el.className = 'rvalue mono' + cls;
    var wrap = $('dtStok').parentNode;
    if (isLowStock(stok)) {
      var badge = wrap.querySelector('.stock-alert-badge');
      if (!badge) {
        badge = document.createElement('div');
        badge.className = 'stock-alert-badge';
        wrap.appendChild(badge);
      }
      badge.textContent = 'PERINGATAN: STOK HAMPIR HABIS (\u2264 ' + LIMIT_STOCK.toLocaleString('id-ID') + ' pcs)';
    } else {
      var oldBadge = wrap.querySelector('.stock-alert-badge');
      if (oldBadge) oldBadge.remove();
    }
    if (stok <= 0) {
      var badge0 = wrap.querySelector('.stock-alert-badge');
      if (!badge0) {
        badge0 = document.createElement('div');
        badge0.className = 'stock-alert-badge';
        wrap.appendChild(badge0);
      }
      badge0.textContent = 'PERINGATAN: STOK HABIS';
    }
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

  // Android: ML Kit. Web: webcam lewat webscan.js (jsQR / BarcodeDetector).
  function scanCode(options) {
    if (IS_WEB) return window.WebScanner.scan(options);
    return BarcodeScanner.scan(options);
  }

  async function ensureScannerReady() {
    if (IS_WEB) return;
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
      var result = await scanCode(options);
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

  // Scan kode item dari tab Inventory lalu langsung siapkan transaksi inbound.
  async function startInventoryInboundScan() {
    if (scanning) return;
    scanning = true;
    var btn = $('btnScanInvInbound');
    btn.disabled = true;
    btn.textContent = 'Memindai...';
    try {
      await ensureScannerReady();
      var options = {};
      if (state.qrOnly) options.formats = ['QrCode'];
      var result = await scanCode(options);
      var barcodes = (result && result.barcodes) || [];
      if (!barcodes.length) { toast('Tidak ada kode item terdeteksi.'); return; }
      var scannedValue = String(barcodes[0].rawValue || '').trim();
      await pushHistory(scannedValue);
      if (state.vibrate) { try { await Haptics.vibrate({ duration: 80 }); } catch (e) {} }
      if (!state.invLoadedOnce || !state.stock.length) await loadInventory(true);
      
      // Extract card parameter from URL if scanned value is a URL
      var scannedName = scannedValue;
      try {
        if (scannedValue.match(/^https?:\/\//i)) {
          var url = new URL(scannedValue);
          var cardParam = url.searchParams.get('card');
          if (cardParam) scannedName = cardParam;
        }
      } catch (e) {
        // If URL parsing fails, use original value
      }
      
      // Normalize: decode URL encoding, collapse whitespace, lowercase
      var normalized = decodeURIComponent(scannedName).replace(/\s+/g, ' ').trim().toLocaleLowerCase();
      var row = state.stock.find(function (item) { 
        var itemName = String(item.nama || '').replace(/\s+/g, ' ').trim().toLocaleLowerCase();
        return itemName === normalized;
      });
      if (!row) {
        toast('Item dengan kode/nama "' + scannedName + '" tidak ditemukan di katalog.');
        return;
      }
      state.currentBrand = null;
      $('invBrandLabel').textContent = 'Semua Brand';
      $('invSearch').value = '';
      state.stockFilter = '';
      showInvScreen('grid');
      renderGrid();
      await openDetail(row.nama);
      openTrx('masuk');
    } catch (e) {
      var msg = (e && e.message) || String(e);
      if (!/cancel/i.test(msg)) toast('Scan inbound gagal: ' + msg);
    } finally {
      scanning = false;
      btn.disabled = false;
      btn.innerHTML = '&#128247; Scan Masuk';
    }
  }
  $('btnScanInvInbound').addEventListener('click', startInventoryInboundScan);

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

  // ================= Lokasi: peta gudang 3D =================
  var LOKASI_SHEET = 'Lokasi_Card';
  var LOKASI_HEADER = ['Nama Card', 'Lokasi', 'Keterangan'];
  var lokasiState = { rows: [], loaded: false, view3d: null, unplacedIdx: 0, selected: null, editing: null };

  function lokasiItems() {
    var stokMap = {};
    state.stock.forEach(function (r) { stokMap[String(r.nama).trim().toLowerCase()] = r; });
    return lokasiState.rows.map(function (l) {
      var s = stokMap[l.nama.toLowerCase()];
      return { nama: (s && s.nama) || l.nama, lokasi: l.lokasi, ket: l.ket, stok: s ? (Number(s.stok) || 0) : null };
    });
  }
  function lokasiStatus(item) {
    if (item.stok === null || item.stok === undefined) return 'none';
    if (isOutStock(item.stok)) return 'out';
    if (isLowStock(item.stok)) return 'low';
    return 'ok';
  }
  function lokasiUnplaced() {
    var has = {};
    lokasiState.rows.forEach(function (l) { if (window.Lokasi3D.parseLokasi(l.lokasi)) has[l.nama.toLowerCase()] = true; });
    return state.stock.filter(function (r) { return !has[String(r.nama).trim().toLowerCase()]; });
  }

  async function getLokasiList() {
    var rows = await readRawRows(LOKASI_SHEET);
    return rows.filter(function (r) { return r[0]; }).map(function (r) {
      return { nama: String(r[0]).trim(), lokasi: String(r[1] == null ? '' : r[1]).trim(), ket: String(r[2] == null ? '' : r[2]) };
    });
  }

  function lokasiShowState(text, spinner) {
    $('lokStateText').textContent = text || '';
    $('lokSpinner').style.display = spinner ? '' : 'none';
    $('lokState').style.display = (text || spinner) ? 'flex' : 'none';
  }

  function lokasiEnsure3d() {
    if (lokasiState.view3d) return true;
    try {
      lokasiState.view3d = window.Lokasi3D.create($('lokCanvas'), {
        statusOf: lokasiStatus,
        onSelect: lokasiOnSelect,
        onDrag: function (code) { $('lokMoveTip').textContent = 'Target: ' + code + ' \u2014 lepas jari untuk memilih.'; },
        onMove: lokasiOnMove
      });
      return true;
    } catch (e) {
      lokasiShowState('Tampilan 3D tidak bisa dibuka: ' + e.message, false);
      return false;
    }
  }

  function lokasiStop() {
    if (lokasiState.view3d) lokasiState.view3d.stop();
  }

  function lokasiSisiText(parsed) {
    if (!parsed) return '';
    return (parsed.sisi === 'B' ? 'belakang' : 'depan') + (parsed.tumpuk ? ', tumpukan' : '') + (parsed.pos ? ', slot ' + parsed.pos : '');
  }
  function lokasiSetMoveUi(on) {
    $('btnLokInfoMove').textContent = on ? 'Selesai' : 'Geser';
    var tip = $('lokMoveTip');
    tip.style.display = on ? 'block' : 'none';
    if (on) tip.textContent = 'Seret kotak card yang menyala ke slot kosong, lalu lepas.';
  }
  function lokasiOnSelect(item, parsed) {
    lokasiState.selected = item;
    lokasiState.pendingMove = null;
    $('lokMove').classList.remove('show');
    lokasiSetMoveUi(false);
    var box = $('lokInfo');
    if (!item) { box.classList.remove('show'); $('lokHint').style.display = ''; return; }
    var st = lokasiStatus(item);
    var stLabel = { ok: 'Stok aman', low: 'Hampir habis', out: 'Habis', none: 'Stok tidak diketahui' }[st];
    var stColor = { ok: 'var(--green)', low: 'var(--amber)', out: 'var(--red)', none: 'var(--muted)' }[st];
    $('lokInfoName').textContent = item.nama;
    $('lokInfoMeta').innerHTML =
      'Lokasi: <b>' + escapeHtml(parsed ? parsed.label : item.lokasi) + '</b> &middot; Zona ' + escapeHtml(parsed ? parsed.zona : '-') +
      ', rak ' + (parsed ? parsed.rak : '-') + ', susun ' + (parsed ? parsed.level : '-') +
      (parsed ? ', ' + lokasiSisiText(parsed) : '') + '<br>' +
      (item.stok === null ? '' : 'Stok: <b style="color:' + stColor + '">' + item.stok.toLocaleString('id-ID') + ' pcs</b> &middot; ') +
      '<span style="color:' + stColor + '">' + stLabel + '</span>' +
      (item.ket ? '<br>' + escapeHtml(item.ket) : '');
    box.classList.add('show');
    $('lokHint').style.display = 'none';
  }

  function lokasiRenderChip() {
    var chip = $('lokUnplaced');
    var n = lokasiUnplaced().length;
    if (n > 0 && lokasiState.rows.length > 0) {
      chip.textContent = n + ' card belum punya lokasi — ketuk untuk mengisi';
      chip.style.display = 'block';
    } else {
      chip.style.display = 'none';
    }
  }

  function lokasiRender() {
    if (!lokasiEnsure3d()) return;
    var info = lokasiState.view3d.setData(lokasiItems());
    lokasiState.view3d.setFilter($('lokSearch').value);
    lokasiOnSelect(null);
    lokasiRenderChip();
    var unplaced = lokasiUnplaced().length;
    if (info.placed === 0) {
      lokasiShowState(state.stock.length
        ? 'Belum ada lokasi yang diisi. Ketuk tombol + untuk menentukan lokasi tiap card (mis. A-03-2).'
        : 'Belum ada data card.', false);
    } else {
      lokasiShowState('', false);
    }
    return { info: info, unplaced: unplaced };
  }

  async function loadLokasi() {
    if (!lokasiEnsure3d()) return;
    lokasiState.view3d.start();
    if (!isSignedIn()) { lokasiShowState('Belum masuk dengan akun Google. Buka Pengaturan untuk sign-in.', false); return; }
    if (!state.spreadsheetId) { lokasiShowState('Spreadsheet ID belum diatur. Buka Pengaturan untuk mengisinya.', false); return; }
    if (!lokasiState.loaded) lokasiShowState('Memuat lokasi gudang...', true);
    try {
      var res = await Promise.all([getStockList(), getLokasiList()]);
      state.stock = res[0];
      state.invLoadedOnce = true;
      lokasiState.rows = res[1];
      lokasiState.loaded = true;
    } catch (e) {
      if (!lokasiState.loaded) { lokasiShowState('Gagal memuat: ' + e.message, false); return; }
      toast(e.message);
    }
    lokasiRender();
  }

  function openLokasiView() {
    if (!lokasiEnsure3d()) return;
    lokasiState.view3d.start();
    if (!lokasiState.loaded || state.autoRefresh) loadLokasi();
    else lokasiRender();
  }

  // ---- Ubah / tambah lokasi
  function lokasiUpdateParsed() {
    var p = window.Lokasi3D.parseLokasi($('fLokKode').value);
    $('lokParsed').textContent = p ? ('Zona ' + p.zona + ' · Rak ' + p.rak + ' · Susun ' + p.level + ' · ' + lokasiSisiText(p) + '  →  ' + p.label) : '';
  }
  function openLokasiSheet(nama) {
    var existing = null;
    if (nama) {
      var t = String(nama).trim().toLowerCase();
      existing = lokasiState.rows.filter(function (l) { return l.nama.toLowerCase() === t; })[0] || null;
    }
    lokasiState.editing = existing ? existing.nama : null;
    $('lokCardList').innerHTML = state.stock.map(function (r) { return '<option value="' + escapeHtml(r.nama) + '">'; }).join('');
    $('fLokNama').value = nama || '';
    $('fLokKode').value = existing ? existing.lokasi : '';
    $('fLokKet').value = existing ? existing.ket : '';
    $('btnLokDelete').style.display = existing ? '' : 'none';
    lokasiUpdateParsed();
    $('lokSheet').classList.add('show');
  }
  function closeLokasiSheet() { $('lokSheet').classList.remove('show'); }

  async function saveLokasi(nama, kode, ket) {
    await ensureSheetExists(LOKASI_SHEET, LOKASI_HEADER);
    var rows = await readRawRows(LOKASI_SHEET);
    var t = nama.trim().toLowerCase();
    // Kode tanpa huruf (mis. "3-2") akan dibaca Sheets sebagai tanggal; apostrof memaksa teks.
    var kodeOut = kode && /^[0-9\-\/.\s]+$/.test(kode) ? "'" + kode : kode;
    var found = false;
    var out = [];
    rows.forEach(function (r) {
      if (!r[0]) return;
      if (String(r[0]).trim().toLowerCase() === t) {
        found = true;
        if (kode) out.push([nama, kodeOut, ket]);
      } else {
        out.push([r[0], r[1] == null ? '' : r[1], r[2] == null ? '' : r[2]]);
      }
    });
    if (!found && kode) out.push([nama, kodeOut, ket]);
    await rewriteSheetRows(LOKASI_SHEET, LOKASI_HEADER, out);
  }

  async function submitLokasi(del) {
    var nama = $('fLokNama').value.trim();
    var kode = del ? '' : $('fLokKode').value.trim().toUpperCase();
    if (!nama) { toast('Nama card wajib diisi.'); return; }
    if (!del && !window.Lokasi3D.parseLokasi(kode)) { toast('Kode lokasi belum valid, mis. A-03-2.'); return; }
    var btn = del ? $('btnLokDelete') : $('btnLokSave');
    btn.disabled = true;
    try {
      await saveLokasi(nama, kode, del ? '' : $('fLokKet').value.trim());
      closeLokasiSheet();
      toast(del ? 'Lokasi dihapus.' : 'Lokasi disimpan.');
      lokasiState.rows = await getLokasiList();
      lokasiRender();
      if (!del) lokasiState.view3d.selectByName(nama, true);
    } catch (e) {
      toast('Gagal menyimpan: ' + e.message);
    } finally {
      btn.disabled = false;
    }
  }

  // ---- Geser card di peta -> kode lokasi terisi otomatis
  function lokasiOnMove(item, slot) {
    lokasiState.pendingMove = { item: item, code: slot.code };
    $('lokMoveName').textContent = item.nama;
    $('lokMoveMeta').innerHTML = 'Pindah ke <b>' + escapeHtml(slot.code) + '</b><br>dari <b>' + escapeHtml(item.lokasi) + '</b>';
    $('lokInfo').classList.remove('show');
    $('lokMove').classList.add('show');
  }
  $('btnLokInfoMove').addEventListener('click', function () {
    if (!lokasiState.view3d || !lokasiState.selected) return;
    var on = lokasiState.view3d.setMoveMode($('btnLokInfoMove').textContent === 'Geser');
    lokasiSetMoveUi(on);
  });
  $('btnLokMoveCancel').addEventListener('click', function () {
    if (!lokasiState.view3d) return;
    lokasiState.view3d.cancelMove();
    lokasiState.pendingMove = null;
    $('lokMove').classList.remove('show');
    $('lokInfo').classList.add('show');
  });
  $('btnLokMoveSave').addEventListener('click', async function () {
    var pm = lokasiState.pendingMove;
    if (!pm) return;
    var btn = $('btnLokMoveSave');
    btn.disabled = true;
    try {
      await saveLokasi(pm.item.nama, pm.code, pm.item.ket || '');
      toast('Lokasi dipindah ke ' + pm.code);
      lokasiState.rows = await getLokasiList();
      lokasiRender();
      lokasiState.view3d.selectByName(pm.item.nama, true);
    } catch (e) {
      toast('Gagal menyimpan: ' + e.message);
    } finally {
      btn.disabled = false;
    }
  });
  $('btnLokAdd').addEventListener('click', function () { openLokasiSheet(''); });
  $('btnLokReload').addEventListener('click', function () { loadLokasi(); });
  $('btnLokReset').addEventListener('click', function () { if (lokasiState.view3d) lokasiState.view3d.resetView(); });
  $('btnLokTop').addEventListener('click', function () { if (lokasiState.view3d) lokasiState.view3d.topView(); });
  $('btnLokCancel').addEventListener('click', closeLokasiSheet);
  $('lokSheet').addEventListener('click', function (e) { if (e.target === $('lokSheet')) closeLokasiSheet(); });
  $('btnLokSave').addEventListener('click', function () { submitLokasi(false); });
  $('btnLokDelete').addEventListener('click', function () { submitLokasi(true); });
  $('fLokKode').addEventListener('input', lokasiUpdateParsed);
  $('btnLokInfoEdit').addEventListener('click', function () { if (lokasiState.selected) openLokasiSheet(lokasiState.selected.nama); });
  $('btnLokInfoDetail').addEventListener('click', function () { if (lokasiState.selected) openDetail(lokasiState.selected.nama); });
  $('lokUnplaced').addEventListener('click', function () {
    var list = lokasiUnplaced();
    if (!list.length) return;
    lokasiState.unplacedIdx = lokasiState.unplacedIdx % list.length;
    openLokasiSheet(list[lokasiState.unplacedIdx].nama);
    lokasiState.unplacedIdx++;
  });
  var lokSearchTimer = null;
  $('lokSearch').addEventListener('input', function () {
    clearTimeout(lokSearchTimer);
    lokSearchTimer = setTimeout(function () {
      if (!lokasiState.view3d) return;
      var q = $('lokSearch').value;
      var n = lokasiState.view3d.setFilter(q);
      if (q.trim() && n === 0) toast('Tidak ada card/lokasi yang cocok.');
    }, 250);
  });

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
    if (IS_WEB) {
      // Versi web selalu yang terbaru; "Cek Update APK" tidak relevan di sini.
      $('verLabel').textContent = 'Versi web (selalu terbaru)';
      $('btnCheckUpdate').style.display = 'none';
    } else {
      try {
        var info = await App.getInfo();
        if (info && info.version) { APP_VERSION = info.version; $('verLabel').textContent = 'v' + APP_VERSION; }
      } catch (e) { /* web preview: getInfo tidak tersedia */ }
    }

    await loadSettings();
    resetKalibrasiParts(null);
    switchView('scan');
  }

  init();
})();
