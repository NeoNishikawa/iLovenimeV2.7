const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

/* Empat kegagalan nyata dari Lighthouse ke produksi, 13 Oktober 2026.
   Semuanya murah, dan tiga di antaranya tidak terlihat sama sekali kalau
   aplikasinya jalan - itu sebabnya bisa bertahan lama.

   1. robots.txt tidak ada. `server.js:1093` punya catch-all
      `app.get("*", sajikanSesuaiMode)`, jadi /robots.txt membalas 200 dengan
      index.html. Hasilnya 485 baris "Syntax not understood".
   2. Tidak ada meta description.
   3. Tidak ada landmark <main>.
   4. Rail "Lanjutkan Menonton" ber-role=list, tapi pada keadaan kosong isinya
      bukan listitem. Kartu yang terisi sudah pakai role="listitem"; yang
      kosong tidak - jadi audit yang gagal justru pada tampilan paling sering
      dilihat pengguna baru. */

const ROOT = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(ROOT, "public/index.html"), "utf8");
const app = fs.readFileSync(path.join(ROOT, "public/js/reference-app.js"), "utf8");
const robotsPath = path.join(ROOT, "public/robots.txt");

test("robots.txt ada dan bisa dibaca crawler", () => {
  assert.ok(fs.existsSync(robotsPath), "public/robots.txt harus ada");
  const isi = fs.readFileSync(robotsPath, "utf8");
  assert.match(isi, /User-agent:\s*\*/i, "harus ada User-agent");
  assert.match(isi, /^(Allow|Disallow):/im, "harus ada minimal satu Allow atau Disallow");
  assert.doesNotMatch(isi, /<[a-z!]/i, "robots.txt tidak boleh berisi HTML");
});

test("ada meta description yang terisi", () => {
  const m = html.match(/<meta name="description" content="([^"]+)"/i);
  assert.ok(m, "index.html harus punya meta description");
  assert.ok(m[1].length > 30, "deskripsi terlalu pendek untuk mesin pencari");
  assert.ok(m[1].length <= 300, "deskripsi terlalu panjang, akan dipotong");
  assert.doesNotMatch(m[1], /undefined|null|NaN/, "isi deskripsi tidak boleh berisi nilai programming");
});

test("ada tepat satu landmark main, dan itu pembungkus konten utama", () => {
  const jumlah = (html.match(/<main[\s>]/g) || []).length;
  assert.equal(jumlah, 1, "harus tepat satu <main>, tidak nol dan tidak dua");
  assert.match(html, /<main class="main">/, "wrapper konten utama harus jadi <main>");
  assert.match(html, /<\/main>/, "<main> harus ditutup");
});

test("rail Lanjutkan Menonton tetap konsisten role-nya saat kosong", () => {
  /* Keadaan kosong memakai markup berbeda dari kartu terisi. Kalau yang kosong
     kehilangan role="listitem", role="list" pada induknya jadi tidak valid. */
  const kosong = (app.match(/<div class="cw-empty"[^>]*>/) || [])[0];
  assert.ok(kosong, "markup keadaan kosong harus ada");
  assert.match(kosong, /role="listitem"/,
    "anak dari role=list wajib role=listitem, termasuk pada keadaan kosong");
});