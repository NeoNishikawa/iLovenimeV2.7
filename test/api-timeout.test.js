const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

/* Regression untuk cacat batas waktu yang ditemukan fuzz (21 Oktober
   2026): satu jam untuk header DAN badan sekaligus membuat balasan
   yang tiba 1 milidetik sebelum batas terbuang dan dilaporkan sebagai
   timeout ("delay=299 (<batas) tapi error: Server tidak merespons dalam
   0 detik"). Sekarang header diukur sendiri, dan jam badan baru mulai
   setelah header tiba. */
const ROOT = path.join(__dirname, "..");
const src = fs.readFileSync(path.join(ROOT, "public/js/api.js"), "utf8");
const a1 = src.indexOf("const cache = new Map();");
const a2 = src.indexOf("/* Setiap request punya batas waktu");
const b = src.indexOf("export const api");
const BATAS = 80;
const kode = src.slice(a1, a2) + src.slice(a2, b).replace("REQUEST_TIMEOUT_MS = 20_000", `REQUEST_TIMEOUT_MS = ${BATAS}`);

function respons(body = '{"data":[1]}') {
  return { status: 200, ok: true, headers: { get: () => null }, text: async () => body };
}
function abortError() { const e = new Error("aborted"); e.name = "AbortError"; return e; }

function buatRequest(fetchPalsu) {
  const { request } = new Function("fetch", "respons", "abortError", `${kode}\nreturn { request };`)(fetchPalsu, respons, abortError);
  return request;
}

/* Fetch yang menjawab setelah delay tertentu. */
function fetchDenganDelay(delayMs) {
  return (pth, opts) => new Promise((resolve, reject) => {
    const sig = opts && opts.signal;
    let sudah = false;
    const onAbort = () => { if (sudah) return; sudah = true; reject(abortError()); };
    if (sig) {
      if (sig.aborted) { onAbort(); return; }
      sig.addEventListener("abort", onAbort, { once: true });
    }
    setTimeout(() => { if (sudah) return; sudah = true; resolve(respons()); }, delayMs);
  });
}

/* Fetch yang header-nya langsung tiba tapi badan tidak pernah selesai.
   Body-nya harus menolak saat signal dibatalkan, seperti fetch sungguhan. */
function fetchBadanMacet() {
  return (pth, opts) => new Promise((resolve) => {
    const sig = opts && opts.signal;
    resolve({
      status: 200, ok: true, headers: { get: () => null },
      text: () => new Promise((_, reject) => {
        if (!sig) return;
        sig.addEventListener("abort", () => reject(abortError()), { once: true });
      }),
    });
  });
}

test("balasan yang tiba sebelum batas selalu berhasil", async () => {
  const request = buatRequest(fetchDenganDelay(BATAS - 10));
  const hasil = await request("/x");
  assert.deepEqual(hasil.data, [1]);
});

test("balasan yang telat jadi error timeout yang jelas", async () => {
  const request = buatRequest(fetchDenganDelay(BATAS + 60));
  await assert.rejects(request("/x"), (error) => {
    assert.equal(error.timeout, true);
    assert.equal(error.status, 0);
    return true;
  });
});

test("header tiba tapi badan macet: error, bukan menggantung", async () => {
  const request = buatRequest(fetchBadanMacet());
  const batasPunggu = 4000;
  const hasil = await Promise.race([
    request("/x").then(() => ({ ok: true })).catch((error) => ({ ok: false, error })),
    new Promise((resolve) => setTimeout(() => resolve({ hang: true }), batasPunggu)),
  ]);
  assert.equal(hasil.hang, undefined, "tidak boleh menggantung");
  assert.equal(hasil.ok, false, "harus jadi error");
  assert.equal(hasil.error.timeout, true);
  assert.equal(hasil.error.truncated, true, "badan terpotong bukan 'tidak merespons'");
});

test("jam badan baru mulai setelah header tiba", () => {
  assert.match(src, /mulaiBadan: \(\) => \{/);
  assert.match(src, /const response = await fetch\([^;]+;[\s\S]{0,400}?batas\.mulaiBadan\(\);/);
});
