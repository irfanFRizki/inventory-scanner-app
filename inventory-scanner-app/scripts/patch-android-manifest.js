/**
 * scripts/patch-android-manifest.js
 *
 * Menyisipkan intent-filter redirect OAuth Google ke AndroidManifest.xml
 * hasil `npx cap add android` (folder android/ dibuat ulang tiap build,
 * jadi manifest-nya perlu dipatch lagi setiap kali).
 *
 * Kenapa perlu ini: Google mengembalikan hasil sign-in lewat browser ke
 * URI custom scheme "com.googleusercontent.apps.<CLIENT_ID>:/oauth2redirect".
 * Android hanya bisa mengarahkan URI itu balik ke aplikasi ini kalau
 * scheme tsb didaftarkan sebagai intent-filter di AndroidManifest.xml.
 * Scheme-nya diturunkan dari GOOGLE_OAUTH_CLIENT_ID di www/app.js, supaya
 * satu-satunya tempat yang perlu diisi manual cuma file itu.
 */
const fs = require('fs');
const path = require('path');

const appJsPath = path.join(__dirname, '..', 'www', 'app.js');
const manifestPath = path.join(__dirname, '..', 'android', 'app', 'src', 'main', 'AndroidManifest.xml');

const appJs = fs.readFileSync(appJsPath, 'utf8');
const m = appJs.match(/GOOGLE_OAUTH_CLIENT_ID\s*=\s*'([^']*)'/);
const clientId = m ? m[1].trim() : '';

if (!clientId) {
  console.log('GOOGLE_OAUTH_CLIENT_ID masih kosong di www/app.js — lewati patch manifest OAuth.');
  console.log('(Sign-in Google tidak akan berfungsi sampai Client ID diisi. Lihat README.)');
  process.exit(0);
}
if (!clientId.endsWith('.apps.googleusercontent.com')) {
  console.error('GOOGLE_OAUTH_CLIENT_ID di www/app.js tidak berformat "...apps.googleusercontent.com".');
  console.error('Nilai saat ini: ' + clientId);
  process.exit(1);
}

const scheme = 'com.googleusercontent.apps.' + clientId.replace('.apps.googleusercontent.com', '');

let xml = fs.readFileSync(manifestPath, 'utf8');

if (xml.indexOf(scheme) > -1) {
  console.log('Intent-filter OAuth sudah ada (scheme: ' + scheme + '), tidak dipatch ulang.');
  process.exit(0);
}

const intentFilter =
  '\n        <intent-filter>\n' +
  '            <action android:name="android.intent.action.VIEW" />\n' +
  '            <category android:name="android.intent.category.DEFAULT" />\n' +
  '            <category android:name="android.intent.category.BROWSABLE" />\n' +
  '            <data android:scheme="' + scheme + '" />\n' +
  '        </intent-filter>';

// Sisipkan sebelum penutup </activity> pertama — pada manifest hasil
// generate Capacitor, activity pertama selalu MainActivity.
const closeTag = '</activity>';
const idx = xml.indexOf(closeTag);
if (idx === -1) {
  console.error('Tidak menemukan tag </activity> di AndroidManifest.xml — patch dibatalkan.');
  process.exit(1);
}
xml = xml.slice(0, idx) + intentFilter + '\n        ' + xml.slice(idx);
fs.writeFileSync(manifestPath, xml);
console.log('AndroidManifest.xml dipatch. Redirect URI OAuth: ' + scheme + ':/oauth2redirect');
