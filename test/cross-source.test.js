/* Test pencocokan lintas sumber (Animasu + Samehadaku).
   Semua memakai fixture HTML lokal, bukan jaringan: hasil scraping situs
   berubah-ubah dan test yang bergantung pada itu akan flak, bukan mendeteksi
   regresi. Yang diuji adalah keputusan yang TIDAK boleh keliru — terutama
   dua jebakan yang sudah terbukti nyata di lapangan:

   1. Halaman search Samehadaku mencampur hasil pencarian dengan sidebar
      rekomendasi. Kalau sidebar ikut terbaca, hampir semua query "cocok"
      ke film atau spin-off yang tidak ada hubungannya.
   2. Kunci pencocokan tidak boleh slug. Animasu "black-clover-s2",
      Samehadaku "black-clover-season-2". */
const test = require("node:test");
const assert = require("node:assert/strict");
const server = require("../server");

const {
  normalizeTitleKey,
  parseSamehadakuSearch,
  parseSamehadakuAnime,
  mergeSupplementEpisodes,
  getSourceConfig,
  SOURCE_CONFIGS,
  MIRROR_ONLY_SOURCES,
} = server;

const SH = "https://v2.samehadaku.how";

test("Judul dengan penanda rilis berbeda tetap menghasilkan kunci yang sama", () => {
  assert.equal(normalizeTitleKey("Black Clover Season 2 Sub Indo"), "black clover season 2");
  assert.equal(normalizeTitleKey("Black Clover Season 2"), "black clover season 2");
  assert.equal(normalizeTitleKey("Magical★Explorer Sub Indo"), "magical explorer");
});

test("Slug yang menyingkat musim dilebur ke kunci yang sama", () => {
  /* Ini inti alasannya: kedua sumber tidak pernah punya slug yang sama. Kalau
     ada kode yang membandingkan slug, hasilnya nol tanpa error. */
  assert.equal(normalizeTitleKey("black-clover-s2"), "black clover season 2");
  assert.equal(normalizeTitleKey("Black Clover 2nd Season"), "black clover season 2");
  assert.equal(normalizeTitleKey("black clover season 2"), "black clover season 2");
});

test("Kata 'anime' tidak dibuang dari tengah judul", () => {
  /* Membuang kata "anime" di mana pun akan membuat dua judul berbeda dianggap
     sama. Yang dibuang hanya prefix "nonton anime". */
  assert.equal(normalizeTitleKey("Anime de Wakaru Zatsu"), "anime de wakaru zatsu");
  assert.equal(normalizeTitleKey("Nonton Anime Black Clover Season 2 Subtitle Indonesia"), "black clover season 2");
});

test("Penanda film tidak ikut dibuang supaya film dan TV tidak bertemu", () => {
  assert.notEqual(normalizeTitleKey("Black Clover: Mahou Tei no Ken"), normalizeTitleKey("Black Clover"));
});

const SEARCH_HTML = `
<html><body>
  <div class="animposx">
    <a href="/anime/black-clover-season-2/" title="Black Clover Season 2"><img alt="Black Clover Season 2"></a>
  </div>
  <div class="animposx">
    <a href="/anime/romelia-senki/" title="Romelia Senki"><img alt="Romelia Senki"></a>
  </div>
  <div class="imgseries">
    <a href="/anime/hibike-euphonium-the-final-movie-part-1/"><img alt="Hibike! Euphonium: The Final Movie Part 1"></a>
  </div>
  <div class="imgseries">
    <a href="/anime/gintama-movie-3-yoshiwara-daienjou/"><img alt="Gintama Movie 3: Yoshiwara Daienjou"></a>
  </div>
</body></html>`;

test("Search Samehadaku hanya membaca hasil pencarian, bukan sidebar rekomendasi", () => {
  const results = parseSamehadakuSearch(SEARCH_HTML, SH);
  assert.deepEqual(results.map((item) => item.slug), ["black-clover-season-2", "romelia-senki"]);
  /* Dua sidebar ini yang membuat probe pertama selalu mendarat di film lain. */
  assert.equal(results.some((item) => item.slug.includes("hibike")), false);
  assert.equal(results.some((item) => item.slug.includes("gintama")), false);
});

test("Search Samehadaku menyertakan kunci yang sudah dinormalisasi", () => {
  const [first] = parseSamehadakuSearch(SEARCH_HTML, SH);
  assert.equal(first.key, "black clover season 2");
  assert.equal(first.sourceUrl, `${SH}/anime/black-clover-season-2/`);
});

const ANIME_HTML = `
<html><body>
  <h1>Black Clover Season 2 Sub Indo</h1>
  <nav><ul><li class="menu-item"><a href="/daftar-batch/">Batch</a></li></ul></nav>
  <div class="grid">
    <div><a href="/black-clover-season-2-episode-1/"></a></div>
    <div><a href="/black-clover-season-2-episode-2/"></a></div>
    <div><a href="/black-clover-season-2-episode-1/"></a></div>
    <div><a href="/black-clover-season-2-episode-1-2-batch/">Download Batch</a></div>
  </div>
</body></html>`;

test("Link unduhan massal bukan episode, meski polanya mengandung -episode-", () => {
  /* "/judul-episode-1-24-batch" TEPATNYA mengandung "-episode-1", jadi tanpa
     pengecualian ia terhitung sebagai episode nomor 1 kedua. Terbukti nyata:
     Iruma Season 4 terbaca 25 episode padahal nyatanya 24. */
  const detail = parseSamehadakuAnime(ANIME_HTML, `${SH}/anime/black-clover-season-2/`, SH);
  assert.equal(detail.episodes.length, 2);
  assert.equal(detail.episodes.some((item) => item.slug.includes("batch")), false);
  assert.equal(detail.key, "black clover season 2");
});

test("Nomor episode Samehadaku diambil dari slug, bukan urutan indeks", () => {
  /* Link Samehadaku tidak punya teks. Kalau nomornya dari urutan, episode
     yang belum tayang akan membuat semua nomor berikutnya bergeser. */
  const detail = parseSamehadakuAnime(ANIME_HTML, `${SH}/anime/black-clover-season-2/`, SH);
  assert.deepEqual(detail.episodes.map((item) => item.episode), ["Episode 1", "Episode 2"]);
  assert.deepEqual(detail.episodes.map((item) => item.sourceProvider), ["samehadaku", "samehadaku"]);
});

test("Link episode duplikat dihitung satu kali", () => {
  const detail = parseSamehadakuAnime(ANIME_HTML, "", SH);
  assert.equal(new Set(detail.episodes.map((item) => item.sourceUrl)).size, detail.episodes.length);
});

test("Animasu menang kalau nomor episode sama-sama ada", () => {
  const primary = [{ number: 1, slug: "animasu-1", sourceProvider: "animasu" }];
  const supplement = [{ number: 1, slug: "samehadaku-1", sourceProvider: "samehadaku" }, { number: 2, slug: "samehadaku-2", sourceProvider: "samehadaku" }];
  const merged = mergeSupplementEpisodes(primary, supplement);
  assert.equal(merged.added, 1);
  assert.deepEqual(merged.episodes.map((item) => item.number), [1, 2]);
  assert.equal(merged.episodes[0].sourceProvider, "animasu");
  assert.equal(merged.episodes[1].sourceProvider, "samehadaku");
});

test("Suplemen diurutkan ulang sesuai nomor episode", () => {
  const merged = mergeSupplementEpisodes([{ number: 5, slug: "a" }], [{ number: 2, slug: "b" }, { number: 9, slug: "c" }]);
  assert.deepEqual(merged.episodes.map((item) => item.number), [2, 5, 9]);
});

test("Samehadaku tidak boleh masuk daftar sumber katalog", () => {
  /* dailyWithSources() dan genresWithSources() mencoba SETIAP sumber sebagai
     cadangan. Kalau Samehadaku ikut di sana, markup-nya yang tidak bisa
     diparse hanya akan menggeser katalog ke daftar kosong. */
  assert.deepEqual(SOURCE_CONFIGS.map((source) => source.id), ["animasu"]);
  assert.deepEqual(MIRROR_ONLY_SOURCES.map((source) => source.id), ["samehadaku"]);
});

test("getSourceConfig mengenali kedua sumber dan jatuh ke katalog untuk yang asing", () => {
  assert.equal(getSourceConfig("samehadaku").baseUrl, "https://v2.samehadaku.how");
  assert.equal(getSourceConfig("animasu").id, "animasu");
  assert.equal(getSourceConfig("tidak-ada").id, "animasu");
});