const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const baca = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const kode = baca("public/js/reference-app.js");
const kodeBersih = kode.replace(/\/\*[\s\S]*?\*\//g, "");
const layoutCss = baca("public/css/layout.css");
const indexHtml = baca("public/index.html");

test("menu Download ada di sidebar, tepat di bawah Feedback", () => {
  assert.match(indexHtml, /id="dlWrap"/, "wadah menu harus ada");
  const posFeedback = indexHtml.indexOf('data-support="feedback"');
  const posDownload = indexHtml.indexOf('id="dlToggle"');
  assert.ok(posFeedback > -1 && posDownload > posFeedback,
    "Download harus SETELAH Feedback di urutan sidebar");
  assert.match(indexHtml, /id="dlToggle"[^>]*aria-expanded="false"/, "toggle harus larasi keadaan terbuka");
  assert.match(indexHtml, /id="dlMenu"[^>]*role="menu"/);
  assert.match(indexHtml, /id="dlMenu"[^>]*hidden/, "menu harus tertutup sejak awal");
});

test("pilihan unduhan hanya .exe dan .apk", () => {
  const items = [...indexHtml.matchAll(/data-dl="([a-z]+)"/g)].map((m) => m[1]);
  assert.deepEqual(items, ["exe", "apk"], "harus tepat dua pilihan: exe lalu apk");
  assert.match(indexHtml, /Windows \.exe/);
  assert.match(indexHtml, /Android \.apk/);
});

test("tombol Download dibuang di EXE dan APK, bukan sekadar disembunyikan", () => {
  /* EXE punya aplikasi sendiri; APK memblokir navigasi keluar lewat NavGuard
     dan mematikan multi-window. Di keduanya link unduhan tidak akan bekerja,
     jadi diam-diam menampilkan tombol yang bisa diklik adalah jebakan. */
  /* Pakai includes + pesan pendek: assert.match mencetak seluruh isi file
     (119 KB) kalau gagal, yang menutupi pesan aslinya. */
  const ada = (potongan, pesan) => assert.ok(kodeBersih.includes(potongan), pesan);

  ada("function diDesktop()", "fungsi deteksi desktop harus ada");
  ada("function diWebViewAndroid()", "fungsi deteksi WebView Android harus ada");
  ada("window.ilnDesktop && window.ilnDesktop.isElectron", "sinyal Electron dari preload harus dibaca");
  ada("/Electron/i.test(navigator.userAgent", "user-agent Electron harus jadi cadangan");
  /* Android WebView selalu punya penanda "wv" di user-agent, sedangkan
     Chrome di HP biasa tidak - jadi ini tidak salah klasifikasi. */
  ada('return /;\\s*wv\\)/.test(ua)', "penanda wv Android WebView harus diperiksa");
  ada("if (diDesktop() || diWebViewAndroid()) { wrap.remove(); return; }",
    "harus dibuang dari DOM, bukan disembunyikan dengan CSS");
});

test("link .exe diisi ke rilis GitHub, .apk sengaja masih kosong", () => {
  /* .exe diisi 10 Oktober 2026 setelah Neo merilis ke GitHub. .apk BELUM
     ada ril-nya, jadi tetap kosong - dan link yang kliknya mati lebih
     buruk daripada tombol disabled yang alasannya ditulis. */
  const blok = kode.match(/const DOWNLOAD_LINKS = \{[\s\S]*?\};/);
  assert.ok(blok, "DOWNLOAD_LINKS tidak ditemukan");
  assert.match(blok[0], /exe:\s*"https:\/\/github\.com\/NeoNishikawa\/ilovenime-model\/releases\/download\/exe\/iLoveNime-X[\d.]+-Setup-x64\.exe"/,
    "link .exe harus menunjuk ke rilis GitHub");
  assert.match(blok[0], /apk:\s*""/, ".apk harus tetap kosong sampai ada rilisnya");
  /* Perilaku tombol kosong harus tetap ada: disabled + alasan. */
  assert.match(kodeBersih, /item\.disabled = true/);
  assert.match(kode, /\$\("#dlNote"\)\.hidden = false/,
    "alasan harus ditulis, bukan link yang kliknya mati diam-diam");
});

test("minimal satu link terisi, jadi tombolnya tidak semuanya mati", () => {
  const isi = [...kode.matchAll(/^\s*(?:exe|apk):\s*"([^"]*)"/gm)].map((m) => m[1]).filter(Boolean);
  assert.ok(isi.length >= 1, "minimal satu link harus terisi");
});

test("label .exe tidak mengikat ukuran yang akan basi", () => {
  /* "Installer 91,5 MB" berasal dari build lama dan langsung salah begitu
     ukurannya berubah - build sekarang 100.632.034 byte. Yang ditampilkan
     perkiraan, ditambah keterangan bahwa updatenya otomatis: informasi yang
     tidak perlu diperbarui setiap build. */
  assert.match(indexHtml, /Windows \.exe<\/strong><small>Installer ~96 MB/,
    "label .exe harus memakai perkiraan, bukan angka pasti");
  assert.match(indexHtml, /update otomatis/, "harus menyebut update otomatis");
  /* .apk belum ada, jadi labelnya menyatakan itu, bukan ukuran yang bisa
     disalahartikan sebagai "hampir selesai". */
  assert.match(indexHtml, /Android \.apk<\/strong><small>Segera hadir/,
    "label .apk harus menyatakan belum ada, bukan ukuran");
});

test("menu Download punya gaya sendiri dan cache-buster naik", () => {
  assert.match(layoutCss, /\.dl-menu\{/);
  assert.match(layoutCss, /\.dl-item\{/);
  assert.match(layoutCss, /\.dl-caret\{/);
  /* Sidebar collapsed tidak punya ruang untuk submenu. */
  assert.match(layoutCss, /\.app\.collapsed \.dl-menu\{display:none\}/);
  /* Cache-buster wajib ada. NOMORNYA tidak dikunci, supaya naik versi tidak
     membuat test merah tanpa ada yang rusak. */
  assert.match(indexHtml, /reference-app\.js\?v=[0-9.]+/);
  assert.match(indexHtml, /layout\.css\?v=[0-9.]+/);
});

test("api.js punya batas waktu dan gagal dengan pesan, bukan menggantung", () => {
  /* Tanpa batas waktu, satu request yang macet menggantung antarmuka selamanya
     tanpa pesan. 20 detik: katalog dingin memang ~10 detik, jadi masih wajar. */
  const api = baca("public/js/api.js");
  assert.match(api, /const REQUEST_TIMEOUT_MS = 20_000/);
  assert.match(api, /new AbortController\(\)/, "wajib pakai AbortController");
  assert.match(api, /setTimeout\(\(\) => \{ lewatWaktu = true; kendali\.abort\(\); \}, REQUEST_TIMEOUT_MS\)/);
  /* Error batas waktu harus punya status non-HTTP supaya TIDAK di-retry:
     mengulang berarti menambah 20 detik lagi per percobaan. */
  assert.match(api, /error\.status = 0/);
  assert.match(api, /error\.timeout = true/);
  assert.match(api, /Server tidak merespons dalam/);

  /* CACAT YANG SUDAH TERPERCEPAT: timer dihentikan di finally SEBELUM
     response.text(). Server yang sudah mengirim header lalu macet di body
     menggantung selamanya - persis masalah yang diklaim ditutup. */
  const posisiText = api.indexOf("await response.text()");
  const posisiFinally = api.indexOf("finally {");
  assert.ok(posisiText > -1 && posisiFinally > posisiText,
    "response.text() harus DI DALAM jendela batas waktu, bukan setelahnya");

  /* JSON primitive (null/angka/string) sah bagi JSON.parse tapi bukan bentuk
     respons kita. Tanpa penjaga, json.error meledak jadi TypeError tanpa
     pesan - ditemukan fuzz 8 Oktober. */
  assert.match(api, /if \(!json \|\| typeof json !== "object"\)/);

  /* Modul ini diimpor sebagai ES module, jadi cache-buster harus ada di
     import-specifier - tag <script> tidak berlaku untuk impor. */
  assert.match(kode, /from "\.\/api\.js\?v=[0-9.]+"/);
});

test("menu Download tidak memasang listener dua kali", () => {
  /* Bug laten ditemukan fuzz: dipasang dua kali menambah 2 listener document
     lagi. Belum terjangkau (setup() jalan sekali), tapi murah dicegah. */
  assert.match(kode, /if \(wrap\.dataset\.dlBound === "1"\) return/);
  assert.match(kode, /wrap\.dataset\.dlBound = "1"/);
});

test("gambar yang gagal menampilkan placeholder, bukan kotak kosong senyap", () => {
  /* Dulu onerror menyembunyikan img tanpa fallback, sehingga kartu Continue
     Watching yang gagal load jadi kotak tanpa penjelasan apa pun. */
  assert.doesNotMatch(kode, /onerror="this\.style\.display='none'"/);
  assert.match(kode, /onerror="this\.parentNode\.classList\.add\('img-failed'\)"/);
  const css = baca("public/css/components.css");
  assert.match(css, /\.img-failed img\{display:none\}/);
  assert.match(css, /\.cw-art\.img-failed::after\{/);
});
