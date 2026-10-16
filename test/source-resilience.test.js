/* Dua perbaikan dari pengukuran Samehadaku yang membalas 403 rate-limit
   dengan HTML utuh. Bukti kerusakan: `curl "https://v2.samehadaku.how/?s=naruto"`
   -> HTTP 403, body 108430 byte, judul `<title>Search Results for "naruto"
   – Samehadaku</title>`. Statusnya jelek, isinya tetap bisa di-parse. */
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  SOURCE_ACCEPT_STATUS,
  isUsableSourceBody,
  isBlockedSourceHtml,
  stateFor,
  primarySourceState,
  snapshotSourceStates,
  SOURCE_CONFIGS,
  MIRROR_ONLY_SOURCES,
} = require("../server");

const kodeServer = require("node:fs").readFileSync(require.resolve("../server"), "utf8");

/* ---------- 1. Status 403 yang isinya konten ---------- */

test("403 diterima sebagai status yang boleh lewat", () => {
  /* Before: validateStatus (status) => status >= 200 && status < 300.
     Status 403 ditolak aturan ini, jadi respons dibuang sebelum body-nya
     pernah dibaca - padahal isinya 108 KB HTML Samehadaku yang utuh. */
  for (const status of [200, 201, 204, 299, 302, 400, 403, 404, 429, 500, 503]) {
    assert.equal(SOURCE_ACCEPT_STATUS(status), status === 403 || (status >= 200 && status < 300),
      `status ${status} punya keputusan yang tidak terduga`);
  }
});

test("403 dari Cloudflare yang sungguhan tetap ditolak, lewat isi body", () => {
  /* STATUS 403 yang sama, tapi body-nya halaman challenge. Di sinilah
     letak pembeda: angka status bukan bukti, isi body yang jadi bukti. */
  const challenge = "<html><head><title>Just a moment...</title></head><body><div id='cf-chl-widget'>";
  assert.equal(isBlockedSourceHtml(challenge), true, "halaman challenge harus terdeteksi");
  assert.equal(isBlockedSourceHtml("<div class='checking your browser'>cloudflare</div>"), true);
  assert.equal(isBlockedSourceHtml("<p>Verify you are human</p> cloudflare"), true);
});

test("halaman Samehadaku sungguhan bukan halaman blokir", () => {
  /* Body yang benar-benar balik dari server saat kena rate limit. Kalau
     ini ikut dianggap blokir, perbaikan ini jadi tidak berguna. */
  const asli = '<!DOCTYPE html><html lang="en-US" class="h-full"><head><meta charset="UTF-8">'
    + '<title>Search Results for &#8220;naruto&#8221; &#8211; Samehadaku</title></head><body>'
    + '<div class="post-listing">Black Clover</div></body></html>';
  assert.equal(isBlockedSourceHtml(asli), false, "HTML Samehadaku asli tidak boleh dianggap blokir");
  assert.equal(isUsableSourceBody(asli), true);
});

test("body kosong tidak pernah dianggap berguna", () => {
  for (const kosong of ["", "   ", "\n\t ", null, undefined]) {
    assert.equal(isUsableSourceBody(kosong), false, "body kosong tidak bisa dipakai");
  }
});

test("aturan 403 hanya hidup di SATU tempat", () => {
  /* Dua gerbang ada: validateStatus per-panggilan, lalu lagi
     sourceRequestFor. Kalau salah satu menulis ulang aturan sendiri,
     keduanya akan menyimpang diam-diam - persis bentuk "dua sumber
     kebenaran" yang sudah tercatat di persona.

     Yang diperiksa BUKAN "semua validateStatus harus bernama sama",
     karena halaman abjad memang punya aturan berbeda (ikut redirect).
     Yang diperiksa: tidak ada satu pun validateStatus anonim yang
     menulis angkanya sendiri. Beri nama, atau jangan tulis. */
  const anonim = kodeServer.match(/validateStatus:\s*\(/g) || [];
  assert.equal(anonim.length, 0,
    `masih ada ${anonim.length} validateStatus yang menulis aturan sendiri secara inline`);
  assert.equal((kodeServer.match(/validateStatus:\s*SOURCE_ACCEPT_STATUS/g) || []).length, 7,
    "tujuh pemanggilan 2xx/403 harus memakai aturan yang sama");
  assert.equal((kodeServer.match(/validateStatus:\s*SOURCE_ACCEPT_REDIRECT/g) || []).length, 1,
    "halaman abjad memakai aturan redirect-nya sendiri, yang bernama");
  assert.match(kodeServer, /const oke = SOURCE_ACCEPT_STATUS\(result\.status\)/,
    "gerbang kedua di sourceRequestFor juga harus memakai aturan yang sama");
  assert.match(kodeServer, /const forbiddenTapiBerguna = result\.status === 403/, "403 yang berguna harus dihitung");
  assert.match(kodeServer, /!isBlockedSourceHtml\(result\.data\)/, "halaman blokir tetap ditolak");
});

test("403 yang lolos tidak melewati pemeriksaan Cloudflare", () => {
  /* Kalau urutan dibalik - blokir diperiksa sebelum body diizinkan masuk -
     403 challenge akan lolos. Urutan inilah yang menjaga bedanya. */""
  const iStatus = kodeServer.indexOf("const oke = SOURCE_ACCEPT_STATUS");
  const iBlokir = kodeServer.indexOf("if (isBlockedSourceHtml(result.data))");
  assert.ok(iStatus > 0 && iBlokir > 0, "kedua pemeriksaan harus ada");
  assert.ok(iStatus < iBlokir, "pemeriksaan Cloudflare harus tetap berjalan setelah 403 diizinkan lewat");
});

/* ---------- 2. Status per sumber ---------- */

test("setiap sumber punya ember status sendiri", () => {
  /* Before: satu objek global. Satu 403 dari mirror melaporkan sumber
     utama "down" padahal utama baik-baik saja. */
  const semua = [...SOURCE_CONFIGS, ...MIRROR_ONLY_SOURCES];
  const id = semua.map((s) => s.id);
  assert.ok(id.includes("animasu") && id.includes("samehadaku"), "dua sumber harus terdaftar");
  for (const sumber of semua) {
    assert.notEqual(stateFor(sumber.id), stateFor(`${sumber.id}-lain`),
      `${sumber.id} dan turunannya harus ember berbeda`);
  }
});

test("ember mirror terpisah dari ember sumber utama", () => {
  const utama = primarySourceState();
  const mirror = stateFor("samehadaku");
  assert.notEqual(utama.sourceId, mirror.sourceId);
  assert.equal(utama.sourceId, SOURCE_CONFIGS[0].id, "health publik harus tetap milik sumber utama");
});

test("snapshot melaporkan SETIAP sumber, bukan cuma yang bicara terakhir", () => {
  const snap = snapshotSourceStates();
  const ids = snap.map((s) => s.id);
  assert.ok(ids.includes("animasu"), "sumber utama harus ada");
  assert.ok(ids.includes("samehadaku"), "mirror harus dilaporkan - ini yang bikin supplementing yang mati kelihatan");
  for (const s of snap) {
    assert.ok(["unknown", "up", "down"].includes(s.status), `status ${s.id} tidak dikenal: ${s.status}`);
    assert.ok("lastAttemptAt" in s && "lastSuccessAt" in s && "lastError" in s,
      `${s.id} harus punya jejak waktu dan error, kalau tidak "mati diam-diam" tidak bisa dilihat`);
  }
});

test("health publik tetap tidak membocorkan apa pun", () => {
  /* Keamanan yang sudah ada tidak boleh dilonggarkan oleh perbaikan ini. */
  const idxRoute = kodeServer.indexOf('app.get("/api/health"');
  const blok = kodeServer.slice(idxRoute, idxRoute + 1400);
  const publik = blok.slice(0, blok.indexOf("if (!HEALTH_DETAIL)"));
  /* Komentar harus dibuang dulu. Tanpa ini, kata "internal" di dalam
     kalimat penjelasan ikut terambil dan tes gagal karena kalimatnya,
     bukan karena kodenya - persiko salah baca yang sudah tercatat. */
  const tanpaKomentar = publik.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const kunci = [...tanpaKomentar.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*:/g)].map((m) => m[1]);
  assert.deepEqual(kunci, ["ok", "sourceStatus"],
    `health publik hanya boleh ok + sourceStatus, bukan ${kunci.join(", ")}`);
});