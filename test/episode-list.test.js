const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const referenceApp = fs.readFileSync(path.join(ROOT, "public/js/reference-app.js"), "utf8");
const components = fs.readFileSync(path.join(ROOT, "public/css/components.css"), "utf8");

/* labelEpisode tidak diekspor ke modul lain, jadi diambil dari sumber
   dan dijalankan langsung - yang diuji perilakunya, bukan teksnya. */
function ambilLabel() {
  const awal = referenceApp.indexOf("function labelEpisode(");
  assert.notEqual(awal, -1, "labelEpisode harus ada di reference-app.js");
  const akhir = referenceApp.indexOf("\nfunction ", awal + 10);
  const kode = referenceApp.slice(awal, akhir === -1 ? referenceApp.length : akhir);
  return new Function(`${kode}; return labelEpisode;`)();
}

test("Label episode memakai judul dari source", () => {
  const label = ambilLabel();
  assert.equal(label({ title: "Episode 1", number: 1 }), "Episode 1");
  assert.equal(label({ title: "The Beginning", number: 1 }), "The Beginning");
  assert.equal(label({ episode: "S02E05 - A New Dawn", number: 5 }), "S02E05 - A New Dawn");
});

test("Label episode dirakit dari nomor kalau source tidak memberi judul", () => {
  const label = ambilLabel();
  assert.equal(label({ number: 7 }), "Episode 7");
  assert.equal(label({ number: "12" }), "Episode 12");
  assert.equal(label({}), "Episode");
  assert.equal(label({ title: "   " }), "Episode");
});

test("Daftar episode menampilkan judul, bukan nomor telanjang", () => {
  assert.match(referenceApp, /class="ep-name">\$\{esc\(labelEpisode\(ep\)\)\}/);
  /* Nomor masih ada di data-attribute, jadi klik tetap tahu episode mana. */
  assert.match(referenceApp, /data-episode-number="\$\{esc\(ep\.number\)\}"/);
});

test("Label episode dipotong dengan ellipsis, nama penuh di title attribute", () => {
  assert.match(components, /\.ep-name\{[^}]*overflow:hidden[^}]*text-overflow:ellipsis/);
  assert.match(referenceApp, /title="\$\{esc\(labelEpisode\(ep\)\)\}"/);
});
