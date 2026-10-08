const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "../public/js/maintenance-notice.js"), "utf8");
const HARI = 24 * 60 * 60 * 1000;

let mod;
test.before(async () => {
  mod = await import(`data:text/javascript,${encodeURIComponent(source)}`);
});

/* localStorage palsu supaya interval bisa diuji tanpa menunggu 14 hari. */
function storagePalsu() {
  const data = new Map();
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
    diblokir: false,
  };
}

test("interval 14 hari, bukan angka lain", () => {
  assert.equal(mod.NOTICE_INTERVAL_DAYS, 14);
  assert.match(source, /NOTICE_INTERVAL_DAYS \* 24 \* 60 \* 60 \* 1000/);
});

test("kunjungan pertama selalu menampilkan pemberitahuan", () => {
  const storage = storagePalsu();
  assert.equal(mod.shouldShowNotice(storage, Date.now()), true, "belum pernah tampil = harus tampil");
});

test("tidak muncul lagi sebelum 14 hari berlalu", () => {
  const storage = storagePalsu();
  const t0 = Date.UTC(2026, 9, 3);
  mod.markNoticeShown(storage, t0);
  assert.equal(mod.shouldShowNotice(storage, t0), false, "baru saja tampil");
  assert.equal(mod.shouldShowNotice(storage, t0 + 13 * HARI), false, "hari ke-13 masih disembunyikan");
  assert.equal(mod.shouldShowNotice(storage, t0 + 13.99 * HARI), false, "hampir 14 hari masih disembunyikan");
});

test("muncul lagi tepat setelah 14 hari berlalu", () => {
  const storage = storagePalsu();
  const t0 = Date.UTC(2026, 9, 3);
  mod.markNoticeShown(storage, t0);
  assert.equal(mod.shouldShowNotice(storage, t0 + 14 * HARI), true, "tepat 14 hari harus tampil");
  assert.equal(mod.shouldShowNotice(storage, t0 + 30 * HARI), true, "30 hari kemudian juga tampil");
});

test("storage diblokir tidak membuat aplikasi error, hanya tampil lebih sering", () => {
  const diblokir = { getItem() { throw new Error("ditolak"); }, setItem() { throw new Error("ditolak"); }, removeItem() {} };
  assert.equal(mod.shouldShowNotice(diblokir, Date.now()), true, "harus tetap bisa jalan");
  assert.doesNotThrow(() => mod.markNoticeShown(diblokir, Date.now()));
});

test("isi pemberitahuan menyebut 14 hari, minta maaf, dan menjelaskan alasannya", () => {
  const html = mod.buildNoticeHtml();
  assert.match(html, /Pemeliharaan/);
  assert.match(html, /14 hari/);
  assert.match(html, /Mohon maaf/, "harus ada permintaan maaf");
  assert.match(html, /Mengerti/, "harus ada tombol yang bisa diklik");
  assert.match(html, /Pemberitahuan berikutnya/);
  /* aria-labelledby harus menunjuk ke judul, bukan ke tombol. */
  assert.match(html, /id="maintenanceNoticeTitle"/);
  assert.doesNotMatch(source, /querySelector\("\[data-notice-ok\]"\)\.id/);
  /* Tidak boleh ada kalimatInggris nyasar di notis berbahasa Indonesia. */
  assert.doesNotMatch(html, /underwent|will be|is going to/i);
});

test("setelah ditutup, kunjungan berikutnya tidak menampilkan lagi", () => {
  const storage = storagePalsu();
  const now = Date.now();
  mod.markNoticeShown(storage, now);
  assert.equal(mod.shouldShowNotice(storage, now), false, "kunjungan berikutnya harus disembunyikan");
});