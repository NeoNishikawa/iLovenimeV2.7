/* ============================================================================
   Mode maintenance harus melewati shell APK yang sudah terpasang.

   Bukan ujinya regex: server benar-benar dinyalakan dengan MAINTENANCE=1
   lalu ditembak dengan dan tanpa "?shell=apk", karena yang diuji adalah
   halaman mana yang benar-benar sampai ke pengguna - bukan cara menuliskannya.

   MAINTENANCE dibaca dari environment saat settings.js di-require, jadi
   harus disetel sebelum require di baris paling atas.
   ========================================================================== */
process.env.MAINTENANCE = "1";

const test = require("node:test");
const assert = require("node:assert/strict");
const { app } = require("../server");

const JUDUL_APLIKASI = /<title>iLoveNime V2\./;
const JUDUL_MAINTENANCE = /<title>iLoveNime [^<]*Sedang Dalam Perbaikan<\/title>/;

let server = null;
let asal = "";

test.before(async () => {
  await new Promise((selesai) => {
    server = app.listen(0, "127.0.0.1", () => {
      asal = `http://127.0.0.1:${server.address().port}`;
      selesai();
    });
  });
});

test.after(async () => {
  if (server) await new Promise((selesai) => server.close(selesai));
});

async function ambil(jalur) {
  const response = await fetch(asal + jalur);
  return { status: response.status, body: await response.text() };
}

test("MAINTENANCE=1: pengunjung web tetap menerima halaman maintenance", async () => {
  const { body } = await ambil("/");
  assert.match(body, JUDUL_MAINTENANCE,
    "tanpa penanda shell, mode maintenance harus tetap berlaku");
});

test("shell terpasang dengan ?shell=apk melewati halaman maintenance", async () => {
  const { body } = await ambil("/?shell=apk");
  assert.doesNotMatch(body, JUDUL_MAINTENANCE,
    "shell terpasang tidak boleh terjebak halaman maintenance");
  assert.match(body, JUDUL_APLIKASI,
    "shell terpasang harus menerima halaman aplikasi");
});

test("catch-all juga melewati: path lain milik shell tetap aplikasi", async () => {
  /* Web ini SPA tanpa routing path, tapi tetap harus benar kalau
     WebView atau reader meminta alamat lain. */
  const { body } = await ambil("/anime/contoh-episode-1/?shell=apk");
  assert.match(body, JUDUL_APLIKASI, "catch-all harus migraines halaman aplikasi");
});

test("penanda palsu tidak membocorkan mode maintenance", async () => {
  /* Nilai lain selain "apk" bukan shell terpasang. Kalau ini lolos,
     siapa pun bisa mematikan maintenance hanya dengan mengubah URL. */
  for (const PARAM of ["?shell=web", "?shell=APK", "?shell=", "?shell=apk2", "?apk=1", ""]) {
    const { body } = await ambil("/" + PARAM);
    assert.match(body, JUDUL_MAINTENANCE,
      `parameter "${PARAM}" tidak boleh melewati maintenance`);
  }
});

test("route /api/* tetap hidup walau MAINTENANCE=1", async () => {
  const response = await fetch(asal + "/api/health");
  assert.equal(response.status, 200);
  const json = await response.json();
  assert.equal(typeof json.ok, "boolean");
});

test("route /maintenance tetap bisa dipakai untuk pratinjau", async () => {
  const { body } = await ambil("/maintenance");
  assert.match(body, JUDUL_MAINTENANCE);
});

/* ---------- Sisi klien: pita notifikasi tidak boleh dipasang di shell ---------- */

const kodeClient = require("node:fs").readFileSync(
  require("node:path").join(__dirname, "../public/js/reference-app.js"),
  "utf8"
);
/* Fungsi ini satu baris di reference-app.js, jadi pola harus berhenti di
   akhir baris. Kalau memakai "\n}", pencocokan melebar dan ikut menelan
   deklarasi fungsi lain - hasilnya SyntaxError, bukan kegagalan logika. */
const badanShellTerpasang = kodeClient.match(/function shellTerpasang\(\) (\{.*\})/);

/* Fungsi dijalankan apa adanya, hanya window.location.search yang diganti.
   Yang diuji logikanya, bukan teksnya. */
function shellTerpasangDengan(search) {
  assert.ok(badanShellTerpasang, "fungsi shellTerpasang harus ada di reference-app.js");
  const windowPalsu = { location: { search } };
  return new Function(
    "window",
    "URLSearchParams",
    `return (() => { ${badanShellTerpasang[1]} })();`
  )(windowPalsu, URLSearchParams);
}

test("klien: shellTerpasang() hanya benar untuk penanda yang tepat", () => {
  assert.equal(shellTerpasangDengan("?shell=apk"), true, "penanda shell APK harus terdeteksi");
  assert.equal(shellTerpasangDengan("?shell=apk&iln-dev=1"), true, "penanda boleh bercampur dengan parameter lain");
  assert.equal(shellTerpasangDengan("?shell=web"), false, "nilai lain bukan shell terpasang");
  assert.equal(shellTerpasangDengan("?shell=APK"), false, "penanda bersifat persis, bukan longgar");
  assert.equal(shellTerpasangDengan("?shell=apk2"), false, "prefix yang mirip tidak boleh cukup");
  assert.equal(shellTerpasangDengan("?apk=1"), false, "nama parameter harus tepat");
  assert.equal(shellTerpasangDengan(""), false, "tanpa query bukan shell terpasang");
  assert.equal(shellTerpasangDengan("?iln-dev=1"), false, "parameter lain tidak boleh menyesatkan");
});

test("klien: search yang rusak tidak membuat aplikasi meledak", () => {
  /* location.search bisa tidak berupa string di beberapa konteks;
     fungsi harus mengembalikan false, bukan melempar. */
  const windowPalsu = { location: {} };
  const hasil = new Function(
    "window",
    "URLSearchParams",
    `return (() => { ${badanShellTerpasang[1]} })();`
  )(windowPalsu, URLSearchParams);
  assert.equal(hasil, false, "search yang tidak terdefinisi harus aman");
});

test("klien: notifikasi hanya dipasang lewat penjaga shell", () => {
  assert.match(
    kodeClient,
    /if \(!diWebViewAndroid\(\) && !shellTerpasang\(\)\) mountMaintenanceNotice\(\);/,
    "notifikasi harus lewat dua penjaga: User-Agent WebView dan penanda shell"
  );
  /* Pemanggilan telanjang di tempat lain berarti notifikasi tetap muncul. */
  const telanjang = kodeClient.match(/^[ \t]*mountMaintenanceNotice\(\);/gm);
  assert.equal(telanjang, null, "tidak boleh ada mountMaintenanceNotice() tanpa penjaga");
});
