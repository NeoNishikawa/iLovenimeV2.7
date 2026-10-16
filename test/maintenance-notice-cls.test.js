const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

/* Bug nyata, hasil ukur Lighthouse di produksi 13 Oktober 2026:
   CLS 0,719 dan LCP 3,6 s. Penyebabnya satu, bukan tiga:

   Pita pemeliharaan disuntik JS lewat appendChild SETELAH halaman dimuat.
   Saat lalu ia menambahkan padding-top ke <body> sebesar offsetHeight-nya.
   Semua elemen halaman melorot 123 px (242 px di layar 320 px) tepat di mata
   pengguna, dan teks pitanya sendiri jadi elemen LCP karena baru dicat 4,68 s
   setelah respons pertama.

   Perbaikannya bukan "kurangi shift sedikit". Pita harus sudah ada di HTML
   awal, keputusannya diambil sebelum body cat, dan tinggi ruangnya diputuskan
   CSS - bukan hasil pengukuran JS.

   Test ini dikunci dengan pola teks di berkas, bukan browser: yang perlu
   adalah bentuk kodenya, dan bentuknya bisa dibaca tanpa menjalankan
   peramban. Kalau suatu saat pita dibangun ulang di tempat lain, test ini
   yang akan berteriak. */

const ROOT = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(ROOT, "public/index.html"), "utf8");
const css = fs.readFileSync(path.join(ROOT, "public/css/seal.css"), "utf8");
const js = fs.readFileSync(path.join(ROOT, "public/js/maintenance-notice.js"), "utf8");

test("pita pemeliharaan sudah ada di index.html, bukan dibuat oleh JS", () => {
  assert.match(html, /id="noticeBanner"/, "markup pita harus ada di HTML awal");
  assert.match(html, /id="maintenanceNoticeTitle"/, "judul harus ada di HTML awal");
  assert.match(html, /data-notice-ok/, "tombol Mengerti harus ada di HTML awal");
});

test("keputusan tampil diambil sebelum body cat", () => {
  const diHead = html.indexOf("notice-open");
  const awalBody = html.search(/<body[\s>]/);
  assert.ok(diHead > -1, "penanda notice-open harus ada di index.html");
  assert.ok(diHead < awalBody,
    `penanda notice-open harus di <head> (posisi ${diHead}), bukan setelah <body> (posisi ${awalBody})`);

  /* Sifat script-nya penting: script di <head> secara default async atau defer
     berjalan SETELAH HTML selesai diurai, yaitu tepat waktu yang sedang
    $k causes shift. Jadi penandanya harusNAHEN bukan async/defer. */
  const blok = html.slice(Math.max(0, diHead - 900), diHead + 200);
  assert.doesNotMatch(blok, /<script[^>]*\bdefer\b/i, "script penanda tidak boleh defer");
  assert.doesNotMatch(blok, /<script[^>]*\basync\b/i, "script penanda tidak boleh async");
});

test("sisa aturan yang sama dikenal di head, termasuk pengecualian shell", () => {
  /* Kalau penjaga WebView / shell tidak ikut di head, maka shell APK akan
     mendapat ruang kosong 64-118 px di atas although tidak pernah
     menampilkan pita. Itu bug baru, dan lebih buruk daripada yang lama. */
  const diHead = html.slice(0, html.search(/<body[\s>]/));
  assert.match(diHead, /wv/, "penjaga WebView Android harus ikut di script head");
  assert.match(diHead, /Android/, "penjaga WebView Android harus ikut di script head");
  assert.match(diHead, /shell/, "penjaga ?shell=apk harus ikut di script head");
  assert.match(diHead, /iln\.notice\.lastShownAt/, "kunci localStorage harus sama dengan yang dipakai modul");
  assert.match(diHead, /14 \* 24 \* 60 \* 60 \* 1000/, "interval harus tetap 14 hari");
});

test("ruang pita tidak perlu diperkirakan, dan JS tidak boleh mengukurnya", () => {
  /* Percobaan pertama memesan ruang dengan padding sebesar --notice-h per
     breakpoint. Cara itu memaksa menebak angka: tinggi pita berubah dari 107px
     di 800px jadi 224px di 320px, jadi satu konstan pasti sometime salah -
     dan saat kucoba 106px untuk pita 107px, pita menutupi konten.

     Kontrak yang dikunci di sini: ruang adalah ruang pita sendiri (aliran
     biasa), jadi tidak ada angka yang perlu benar. */
  assert.doesNotMatch(css, /--notice-h/, "tidak ada lagi tinggi yang diperkirakan per breakpoint");
  /* Hanya aturan .notice-banner yang diperiksa. Melacak "position:fixed"
     di seluruh berkas akan menangkap aturan lain dan jadi sia-sia. */
  const mulai = css.indexOf(".notice-banner{");
  const aturanPita = css.slice(mulai, css.indexOf("}", mulai));
  assert.ok(mulai > -1, "aturan .notice-banner harus ada");
  assert.doesNotMatch(aturanPita, /position\s*:\s*fixed/, "pita tidak lagi di-fix ke viewport");
  assert.doesNotMatch(js, /offsetHeight/, "JS tidak boleh mengukur tinggi pita");
  assert.doesNotMatch(js, /addEventListener\("resize"/, "JS tidak boleh memasang listener resize");
});

test("pita tidak lagi disuntik ke body di jalur produksi", () => {
  /* Hanya jalur produksi yang dikunci. Modul boleh tetap punya builder's
     cadangan buatPita() untuk halaman yang tidak menyertakan markup dan
     untuk test - yang dilarang adalah mountMaintenanceNotice() menyuntik
     sendiri, karena itulah yang bikin halaman melorot. */
  const mulai = js.indexOf("export function mountMaintenanceNotice");
  assert.ok(mulai > -1, "mountMaintenanceNotice harus ada");
  const badan = js.slice(mulai, js.indexOf("\n}", mulai));
  assert.doesNotMatch(badan, /appendChild/, "jalur produksi tidak boleh menyuntik pita");
  assert.match(badan, /querySelector\("#noticeBanner"\)/, "jalur produksi memakai pita dari HTML");
});

test("markup di index.html dan buildNoticeHtml() tidak berbeda versi", () => {
  /* Dua sumber kebenaran untuk markup yang sama pasti akan menyimpang. Yang
     bukan salah ketik, tapi layar yang berbeda antara dua jalur. Kunci bagian
     yang dilihat mata: id, tombol, dan kalimat inti. */
  const wajib = ['id="maintenanceNoticeTitle"', "data-notice-ok", "Mengerti", "Mohon maaf"];
  for (const frag of wajib) {
    assert.ok(html.includes(frag), `index.html kehilangan: ${frag}`);
    assert.ok(js.includes(frag), `maintenance-notice.js kehilangan: ${frag}`);
  }
});
