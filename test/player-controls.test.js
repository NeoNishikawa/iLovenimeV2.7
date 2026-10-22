const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const indexHtml = fs.readFileSync(path.join(ROOT, "public/index.html"), "utf8");
const components = fs.readFileSync(path.join(ROOT, "public/css/components.css"), "utf8");
const referenceApp = fs.readFileSync(path.join(ROOT, "public/js/reference-app.js"), "utf8");

test("Kontrol player (pilihan mirror + tombol episode) hidup di dalam area iframe", () => {
  /* Bar kontrol dipotong dari <div class="vo-bar"> sampai blok judul
     setelahnya - bukan dengan regex "</div></div>" yang bisa berhenti
     di div pertama (yaitu pembungkus mirror-select). */
  const mulai = indexHtml.indexOf('<div class="vo-bar">');
  const akhir = indexHtml.indexOf('<div class="watch-title"', mulai);
  assert.ok(mulai > 0 && akhir > mulai, "vo-bar harus ada dan diikuti blok judul");
  const bar = indexHtml.slice(mulai, akhir);
  assert.match(bar, /id="mirrorSelectWrapper"/, "pilihan mirror harus di dalam vo-bar");
  assert.match(bar, /id="pipBtn"/);
  assert.match(bar, /id="prevEpBtn"/);
  assert.match(bar, /id="nextEpBtn"/);
  /* Baris penuh di bawah iframe sudah dihapus. */
  assert.doesNotMatch(indexHtml, /class="mirror-row"/);
  /* Dan tidak ada lagi baris mirror di luar overlay. */
  assert.ok(indexHtml.indexOf('id="mirrorSelectWrapper"') > indexHtml.indexOf('class="vo-bar"'), "mirror select tidak boleh di luar bar");
});

test("Bar kontrol melayang di BAWAH video, bukan di atas", () => {
  assert.match(components, /\.vo-bar\{[^}]*position:absolute;bottom:0/);
  assert.doesNotMatch(components, /\.vo-bar\{[^}]*position:absolute;top:0/);
});

test("Panel mirror membuka ke atas supaya tetap di dalam frame", () => {
  assert.match(components, /\.vo-bar \.mirror-options\{[^}]*bottom:calc\(100% \+ 6px\)/);
  assert.match(components, /\.vo-bar \.mirror-options\{[^}]*top:auto/);
});

test("Gradien overlay ikut ke bawah, mengikuti bar kontrol", () => {
  assert.match(components, /\.video-overlay\{[^}]*linear-gradient\(to top/);
});

test("Bagian tengah bar kontrol meneruskan klik ke iframe", () => {
  /* Kalau bar-nya pointer-events:auto, tombol play pihak ketiga di
     bawah-kiri video tertutup. Bar harus tembus; hanya anaknya yang
     bisa diklik. */
  assert.match(components, /\.vo-bar\{[^}]*pointer-events:none/);
  assert.match(components, /\.vo-bar \.custom-mirror-select,\s*\.vo-bar \.vo-actions\{pointer-events:auto/);
});

test("Bar kontrol tidak hilang selama panel mirror masih terbuka", () => {
  assert.match(referenceApp, /function hideVideoControls\(\)[\s\S]{0,500}?if \(!\$\("#mirrorOptions"\)\?\.hidden\)/);
});
