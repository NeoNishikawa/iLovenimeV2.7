const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

/* Laporan visual Neo, 13 Oktober 2026, jendela setengah (band 768-1023px):
   header jadi tiga baris dan 177px tinggi, dengan:
   header jadi tiga baris dan 177px tinggi:
     - baris 2  : "All Genre" melebar 758px, isinya hanya ~130px
     - baris 3  : "Type" + "Status" melebar 768px, isinya hanya ~180px

   Semuanya muat satu baris di 800px: 42 + 220 + 130 + 86 + 86 + 90 + 32 = 712px.

   Penyebabnya dua aturan di blok @media (max-width:1023px):
     .header .genre-filter, .header .compact-filters { order:5; width:100% }
     .search-wrap { flex:1 1 100% }

   Yang kedua tidak pernah bekerja. `.search-wrap` itu anak dari `.search-zone`,
   dan yang jadi flex item header adalah `.search-zone`, bukan `.search-wrap`.
   Jadi "cari memenuhi baris" tidak pernah terjadi, sementara filter tetap
   dipaksa turun ke baris penuh sendiri. Hasilnya: ruang kosong besar dan
   header setinggi tiga baris. */

const ROOT = path.join(__dirname, "..");
const responsive = fs.readFileSync(path.join(ROOT, "public/css/responsive.css"), "utf8");
const morph = fs.readFileSync(path.join(ROOT, "public/css/morph.css"), "utf8");

function blokTablet() {
  const mulai = responsive.indexOf("@media (max-width:1023px)");
  assert.ok(mulai > -1, "blok tablet harus ada");
  const selesai = responsive.indexOf("@media", mulai + 10);
  return responsive.slice(mulai, selesai > -1 ? selesai : undefined);
}

test("filter tidak lagi dipaksa menjadi baris penuh di lebar tablet", () => {
  const blok = blokTablet();
  assert.doesNotMatch(blok, /order:5;width:100%/,
    "filter tidak boleh dipaksa turun ke baris sendiri yang selebar layar");
  assert.match(blok, /\.header\{[^}]*flex-wrap:wrap/,
    "header harus boleh membungkus sendiri kalau memang tidak muat");
});

test("elemen yang diregangkan adalah .search-zone, bukan .search-wrap", () => {
  const blok = blokTablet();
  assert.match(blok, /\.search-zone\{[^}]*flex:1/,
    ".search-zone adalah flex item header, jadi panjangnya harus nyasar ke sana");
  assert.doesNotMatch(blok, /\.search-wrap\{[^}]*flex:1 1 100%/,
    "menyasar .search-wrap tidak pernah berpengaruh: itu bukan flex item header");
});

test("aturan dasar .search-zone tetap boleh menyusut", () => {
  /* Kalau .search-zone dibuat flex:1 tanpa min-width:0, isinya tidak mau
     menyusut dan header bisa meluber. Ini penjaga saat ini. */
  assert.match(morph, /\.search-zone\{[^}]*min-width:0/,
    ".search-zone wajib punya min-width:0 supaya bisa menyusut");
});
