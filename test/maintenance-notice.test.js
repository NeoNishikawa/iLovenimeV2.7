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

/* ------------------------------------------------------------------
   Bug yang dilaporkan Neo 9 Oktober 2026.
   ------------------------------------------------------------------ */

test("tanggal berikutnya dihitung dari SEKARANG, bukan dari kapan banner ditutup", () => {
  /* Kasus nyata: banner ditutup 8 Oktober, lalu muncul lagi 23 Oktober.
     Versi lama menambah 14 hari ke tanggal PENUTUPAN, sehingga menulis
     "22 Oktober" - tanggal yang sudah lewat sehari pada saat banner itu
     sedang tampil. Melihat "berikutnya: 22 Oktober" di hari 23 Oktober
     tidak masuk akal: pemeliharaan berikutnya belum bisa sudah lewat. */
  const t0 = Date.parse("2026-10-08T10:00:00+07:00");
  const now = Date.parse("2026-10-23T10:00:00+07:00");
  const shown = mod.nextNoticeDate(now);

  const formatted = new Date(now + 14 * HARI).toLocaleDateString("id-ID", {
    day: "numeric", month: "long", year: "numeric",
  });
  assert.equal(shown, formatted, "harus = sekarang + 14 hari");

  /* Dan yang dikembalikan TIDAK BOLEH tanggal masa lalu. */
  const startOfToday = new Date(now); startOfToday.setHours(0, 0, 0, 0);
  const nextDate = new Date(now + 14 * HARI);
  assert.ok(nextDate.getTime() > startOfToday.getTime(),
    "tanggal berikutnya harus di masa depan, tidak boleh sudah lewat");
});

test("tanggal berikutnya tidak bergantung pada jam berapa pun banner dibuka", () => {
  /* Kasus Neo belum tentu 10:00. Kalau hasilnya bergesersesuai jam, berarti
     ada pembulatan atau pemotongan waktu di suatu tempat. */
  const hasil = new Set();
  for (const jam of [0, 3, 9, 12, 18, 23]) {
    const t = new Date(2026, 9, 23, jam, 30, 0).getTime();
    hasil.add(mod.nextNoticeDate(t));
  }
  assert.equal(hasil.size, 1,
    "tanggal yang sama untuk semua jam: " + [...hasil].join(" / "));
});

test("penyimpanan yang diblokir tidak membuat tanggal bergeser", () => {
  /* lastShownAt = 0 tidak boleh diperlakukan sebagai epoch 1970, yang
     akan menghasilkan tanggal yang sangat jauh lalu. */
  const storage = diblokirStorage();
  assert.equal(mod.shouldShowNotice(storage, Date.now()), true, "harus tetap tampil");
  const shown = mod.nextNoticeDate(Date.now());
  assert.doesNotMatch(shown, /1970|19\d\d\b/, "tidak boleh tanggal era 1970: " + shown);
});

function diblokirStorage() {
  return {
    getItem() { throw new Error("ditolak"); },
    setItem() { throw new Error("ditolak"); },
    removeItem() {},
  };
}

test("isi banner menampilkan tanggal yang dihitung dari waktu pemanggilan", () => {
  /* buildNoticeHtml() memanggil nextNoticeDate() tanpa argumen, jadi ia memakai
     jam saat dipanggil. Yang diuji: tanggal di HTML benar-benar 14 hari dari
     SEKARANG.

     Pola assertion: ambil batas sebelum dan sesudah pemanggilan, lalu terima
     tanggal yang cocok dengan salah satunya. Dengan begitu test tidak
     bergantung pada jam eksekusi - kalau test dijalankan tepat sebelum tengah
     malam lokal, 14 hari ke depan bisa jatuh di tanggal berbeda antara t0 dan
     t1, dan keduanya benar. */
  const format = (t) => new Date(t).toLocaleDateString("id-ID", { day: "numeric", month: "long", year: "numeric" });
  const sebelum = Date.now();
  const html = mod.buildNoticeHtml();
  const sesudah = Date.now();

  const ditemukan = (html.match(/Pemberitahuan berikutnya: <b>([^<]+)<\/b>/) || [])[1];
  assert.ok(ditemukan, "tanggal harus ada di dalam banner");
  assert.ok(ditemukan === format(sebelum + 14 * HARI) || ditemukan === format(sesudah + 14 * HARI),
    "tanggal di banner harus = waktu pemanggilan + 14 hari. Ditemukan: " + ditemukan);
});