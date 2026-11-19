/*
 * Scanner QR berbasis webcam untuk versi web (browser PC).
 * Dipakai app.js hanya saat TIDAK berjalan di dalam APK Capacitor.
 *
 * API: window.WebScanner.scan({ formats: ['QrCode'] })
 *      -> Promise<{ barcodes: [{ rawValue }] }>
 *      -> reject Error('cancel') kalau ditutup pengguna.
 *
 * Memakai BarcodeDetector bawaan browser kalau mendukung format yang diminta,
 * kalau tidak jatuh ke jsQR (vendor/jsqr.js, hanya QR). Chrome/Edge di Windows
 * umumnya TIDAK punya BarcodeDetector, jadi jsQR adalah jalur utamanya di sana.
 */
(function () {
  'use strict';

  var FORMAT_MAP = {
    QrCode: 'qr_code', Code128: 'code_128', Code39: 'code_39', Code93: 'code_93',
    Ean13: 'ean_13', Ean8: 'ean_8', UpcA: 'upc_a', UpcE: 'upc_e',
    DataMatrix: 'data_matrix', Pdf417: 'pdf417', Aztec: 'aztec', Itf: 'itf', Codabar: 'codabar'
  };

  var active = false;

  async function makeDetector(formats) {
    if (!('BarcodeDetector' in window)) return null;
    try {
      var supported = await window.BarcodeDetector.getSupportedFormats();
      var want = (formats && formats.length ? formats.map(function (f) { return FORMAT_MAP[f] || f; }) : supported)
        .filter(function (f) { return supported.indexOf(f) !== -1; });
      if (!want.length) return null;
      return new window.BarcodeDetector({ formats: want });
    } catch (e) { return null; }
  }

  function el(tag, css, text) {
    var n = document.createElement(tag);
    if (css) n.style.cssText = css;
    if (text) n.textContent = text;
    return n;
  }

  function scan(options) {
    options = options || {};
    if (active) return Promise.reject(new Error('Scanner sedang berjalan.'));
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      return Promise.reject(new Error('Browser ini tidak mendukung akses kamera.'));
    }
    if (!window.isSecureContext) {
      return Promise.reject(new Error('Kamera hanya bisa dipakai lewat HTTPS atau localhost.'));
    }
    active = true;

    return new Promise(function (resolve, reject) {
      var stream = null;
      var stopped = false;
      var rafId = 0;

      var overlay = el('div', 'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.92);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;padding:16px;');
      var video = el('video', 'max-width:min(92vw,640px);max-height:68vh;border-radius:14px;background:#000;');
      video.setAttribute('playsinline', '');
      video.muted = true;
      var hint = el('div', 'color:#e6e8eb;font:14px system-ui,sans-serif;text-align:center;', 'Arahkan QR ke kamera...');
      var btnClose = el('button', 'padding:10px 22px;border:0;border-radius:10px;font:600 14px system-ui,sans-serif;cursor:pointer;background:#2a2f36;color:#e6e8eb;', 'Batal');
      var canvas = document.createElement('canvas');
      var ctx = canvas.getContext('2d', { willReadFrequently: true });
      overlay.appendChild(video); overlay.appendChild(hint); overlay.appendChild(btnClose);
      document.body.appendChild(overlay);

      function cleanup() {
        stopped = true;
        cancelAnimationFrame(rafId);
        document.removeEventListener('keydown', onKey);
        if (stream) stream.getTracks().forEach(function (t) { t.stop(); });
        video.srcObject = null;
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
        active = false;
      }
      function finish(value) { if (stopped) return; cleanup(); resolve({ barcodes: [{ rawValue: value }] }); }
      function fail(err) { if (stopped) return; cleanup(); reject(err); }
      function onKey(e) { if (e.key === 'Escape') fail(new Error('cancel')); }

      btnClose.addEventListener('click', function () { fail(new Error('cancel')); });
      document.addEventListener('keydown', onKey);

      (async function run() {
        try {
          try {
            stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } }, audio: false });
          } catch (e) {
            if (e && (e.name === 'NotAllowedError' || e.name === 'SecurityError')) throw new Error('Izin kamera ditolak. Izinkan kamera untuk situs ini di browser.');
            if (e && e.name === 'NotFoundError') throw new Error('Kamera tidak ditemukan di perangkat ini.');
            throw e;
          }
          if (stopped) { stream.getTracks().forEach(function (t) { t.stop(); }); return; }
          video.srcObject = stream;
          await video.play();

          var detector = await makeDetector(options.formats);
          var useJsQr = !detector;
          if (useJsQr && typeof window.jsQR !== 'function') throw new Error('Pustaka pembaca QR (jsQR) tidak termuat.');
          if (useJsQr && options.formats && options.formats.length && options.formats.indexOf('QrCode') === -1) {
            hint.textContent = 'Browser ini hanya bisa membaca QR code.';
          }

          var busy = false;
          var tick = async function () {
            if (stopped) return;
            if (!busy && video.readyState >= 2 && video.videoWidth) {
              busy = true;
              try {
                if (detector) {
                  var found = await detector.detect(video);
                  if (found && found.length && found[0].rawValue) { finish(found[0].rawValue); return; }
                } else {
                  var scale = Math.min(1, 720 / video.videoWidth);
                  var w = Math.round(video.videoWidth * scale), h = Math.round(video.videoHeight * scale);
                  if (canvas.width !== w) canvas.width = w;
                  if (canvas.height !== h) canvas.height = h;
                  ctx.drawImage(video, 0, 0, w, h);
                  var img = ctx.getImageData(0, 0, w, h);
                  var code = window.jsQR(img.data, w, h, { inversionAttempts: 'dontInvert' });
                  if (code && code.data) { finish(code.data); return; }
                }
              } catch (e) { /* frame gagal dibaca, coba frame berikutnya */ }
              busy = false;
            }
            rafId = requestAnimationFrame(tick);
          };
          rafId = requestAnimationFrame(tick);
        } catch (e) {
          fail(e);
        }
      })();
    });
  }

  window.WebScanner = { scan: scan };
})();
