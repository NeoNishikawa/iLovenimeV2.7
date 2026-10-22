const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const { statusOngoing } = require(path.join(ROOT, "server.js"));
const serverSource = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
const clientSource = fs.readFileSync(path.join(ROOT, "public/js/reference-app.js"), "utf8");
const components = fs.readFileSync(path.join(ROOT, "public/css/components.css"), "utf8");

/* ---------- Sisi server: status tayang ---------- */

test("status 'Sedang Tayang' berarti masih tayang", () => {
  assert.equal(statusOngoing("Sedang Tayang ✓"), true);
  assert.equal(statusOngoing("Sedang Tayang"), true);
  assert.equal(statusOngoing("ONGOING"), true);
  assert.equal(statusOngoing("Berjalan"), true);
  assert.equal(statusOngoing("NEW TODAY"), true);
});

test("status 'Selesai' berarti sudah tamat", () => {
  assert.equal(statusOngoing("Selesai ✓"), false);
  assert.equal(statusOngoing("COMPLETE"), false);
  assert.equal(statusOngoing("Finished"), false);
});

test("status kosong atau tak dikenal bukan tayang", () => {
  assert.equal(statusOngoing(""), false);
  assert.equal(statusOngoing(undefined), false);
  /* "UPCOMING" di parser katalog berarti "badge tidak dikenali",
     bukan fakta - jadi tidak boleh dihitung tayang. */
  assert.equal(statusOngoing("UPCOMING"), false);
});

test("detail mengirim flag ongoing, dan samehadaku boleh menegur saja", () => {
  assert.match(serverSource, /ongoing, supplementedFrom/);
  assert.match(serverSource, /const ongoing = ongoingAnimasu && ongoingSamehadaku !== false;/);
  assert.match(serverSource, /statusSamehadaku = supplement\?\.status \|\| "";/);
  /* Flag harus ikut di payload data, bukan hanya di akar respons:
     klien menyimpan response.data sebagai state.detail. */
  assert.match(serverSource, /data: titleAliasRecord\(\{ \.\.\.detail, episodes, hasEpisodes: episodes\.length > 0, ongoing \}\)/);
});

/* ---------- Sisi client: tombol Next dan catatan ---------- */

function ambilLabelBerikutnya() {
  const awal = clientSource.indexOf("function labelEpisodeBerikutnya(");
  assert.notEqual(awal, -1, "labelEpisodeBerikutnya harus ada di reference-app.js");
  const akhir = clientSource.indexOf("\nfunction ", awal + 10);
  const kode = clientSource.slice(awal, akhir === -1 ? clientSource.length : akhir);
  return new Function(`${kode}; return labelEpisodeBerikutnya;`)();
}

test("di episode terakhir, anime yang masih tayang: tombol Next berubah", () => {
  const label = ambilLabelBerikutnya();
  const anime = { ongoing: true, episodes: [{ number: 1 }, { number: 2 }, { number: 3 }] };
  assert.equal(label(anime, 2), "Silahkan tunggu update selanjutnya");
});

test("di episode terakhir, anime yang sudah tamat: tombol tetap Next", () => {
  const label = ambilLabelBerikutnya();
  const anime = { ongoing: false, episodes: [{ number: 1 }, { number: 2 }, { number: 3 }] };
  assert.equal(label(anime, 2), "Next \u2192");
});

test("belum di episode terakhir, tombol tetap Next walau anime tayang", () => {
  const label = ambilLabelBerikutnya();
  const anime = { ongoing: true, episodes: [{ number: 1 }, { number: 2 }, { number: 3 }] };
  assert.equal(label(anime, 1), "Next \u2192");
  assert.equal(label(anime, 0), "Next \u2192");
});

test("anime tanpa episode tapi ongoing: tombol tetap_pending, dan catatan tak muncul", () => {
  const label = ambilLabelBerikutnya();
  assert.equal(label({ ongoing: true, episodes: [] }, 0), "Silahkan tunggu update selanjutnya");
  assert.match(clientSource, /if \(a\.ongoing && \(a\.episodes \|\| \[\]\)\.length\) \$\("#episodeList"\)\.insertAdjacentHTML/);
});

test("catatan 'tunggu eps selanjutnya' punya gaya sendiri", () => {
  assert.match(components, /\.ep-wait\{/);
  assert.match(clientSource, /<p class="ep-wait">Tunggu eps selanjutnya<\/p>/);
});
