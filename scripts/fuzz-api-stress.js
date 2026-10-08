/* ===========================================================================
   Fuzz waktu untuk lapisan request() web (public/js/api.js).
   ---------------------------------------------------------------------------
   Menjalankan request() + denganBatasWaktu() di atas fetch palsu dengan delay
   acak, supaya kondisi batas dan race ikut tertangkap: sedikit di bawah batas,
   tepat di batas, sedikit di atas, dan tidak pernah datang sama sekali.

   Yang dijaga setiap percobaan:
   - tidak pernah HANG (that's the bug this found: timer berhenti sebelum
     response.text(), jadi server yang kirim header lalu macet body =
     menggantung selamanya)
   - delay di bawah batas -> harus berhasil
   - delay di atas batas -> harus jadi error timeout yang jelas
   - respons aneh (null/HTML/429) tidak boleh dianggap sukses

   Seed tetap (bawaan 20261008) supaya hasil bisa diulang; ganti seed untuk
   menjelajah wilayah acak yang berbeda.

   Pakai: node scripts/fuzz-api-stress.js [percobaan] [seed]
   Contoh: node scripts/fuzz-api-stress.js 800 424242
   =========================================================================== */
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const src = fs.readFileSync(path.join(ROOT, "public/js/api.js"), "utf8");

/* dua rentang: deklarasi cache terpisah di baris paling atas. */
const a1 = src.indexOf("const cache = new Map();");
const a2 = src.indexOf("/* Setiap request punya batas waktu");
const b = src.indexOf("export const api");
if (a1 < 0 || a2 < 0 || b < 0) {
  console.error("Blok api.js tidak ditemukan - struktur kode berubah?");
  process.exit(2);
}
const kode = src.slice(a1, a2) + src.slice(a2, b).replace("REQUEST_TIMEOUT_MS = 20_000", "REQUEST_TIMEOUT_MS = 300");
const BATAS_MS = 300;

function respons({ status = 200, body = "{}", headers = {} }) {
  const h = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (k) => (h.has(k.toLowerCase()) ? h.get(k.toLowerCase()) : null) },
    text: async () => body,
  };
}
function abortError() { const e = new Error("aborted"); e.name = "AbortError"; return e; }

/* delayMs === Infinity berarti tidak pernah datang. */
function buatFetch(delayMs, jenis) {
  return (pth, opts) => new Promise((resolve, reject) => {
    const sig = opts && opts.signal;
    let sudah = false;
    const onAbort = () => { if (sudah) return; sudah = true; reject(abortError()); };
    if (sig) {
      if (sig.aborted) { onAbort(); return; }
      sig.addEventListener("abort", onAbort, { once: true });
    }
    if (delayMs === Infinity) return;
    setTimeout(() => {
      if (sudah) return;
      sudah = true;
      const body = jenis === "null" ? "null"
        : jenis === "html" ? "<html>x</html>"
        : jenis === "429" ? '{"error":"kena"}'
        : '{"data":[1]}';
      resolve(respons({ status: jenis === "429" ? 429 : 200, body }));
    }, delayMs);
  });
}

const { request } = new Function(
  "fetch", "respons", "abortError",
  `${kode}\nreturn { request };`
)(buatFetch(0, "ok"), respons, abortError);

let seed = Number(process.argv[3] || 20261008);
if (!Number.isSafeInteger(seed) || seed < 0) seed = 20261008;
/* mulberry32: acak tapi bisa diulang dari seed yang sama */
function acak() {
  seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

const PERCOBAAN = Number(process.argv[2] || 400);
const hitung = { hang: 0, salahBawah: 0, salahAtas: 0, salahBentuk: 0, wajar: 0 };
const contoh = [];

async function main() {
  for (let i = 0; i < PERCOBAAN; i++) {
    const r = acak();
    let delay;
    if (r < 0.25) delay = 0;
    else if (r < 0.45) delay = Math.floor(acak() * BATAS_MS * 0.9);
    else if (r < 0.60) delay = BATAS_MS + Math.floor(acak() * 40) - 20;
    else if (r < 0.90) delay = BATAS_MS + 30 + Math.floor(acak() * 500);
    else delay = Infinity;

    const jenis = ["ok", "null", "html", "429"][Math.floor(acak() * 4)];
    const req = new Function(
      "fetch", "respons", "abortError",
      `${kode}\nreturn { request };`
    )(buatFetch(delay, jenis), respons, abortError).request;

    const hasil = await Promise.race([
      req("/x").then((v) => ({ ok: true, v })).catch((e) => ({ ok: false, e })),
      new Promise((r2) => setTimeout(() => r2({ hang: true }), BATAS_MS * 4)),
    ]);

    if (hasil.hang) { hitung.hang++; contoh.push(`HANG delay=${delay} jenis=${jenis}`); continue; }

    const lambat = typeof delay === "number" && delay >= BATAS_MS;
    const harusGagal = lambat || jenis !== "ok";

    if (hasil.ok) {
      if (harusGagal) {
        if (lambat) { hitung.salahBawah++; contoh.push(`delay=${delay} (<batas) tapi gagal`); }
        else { hitung.salahBentuk++; contoh.push(`jenis=${jenis} tapi dianggap sukses`); }
      } else hitung.wajar++;
    } else if (!lambat && jenis === "ok") {
      hitung.salahAtas++; contoh.push(`delay=${delay} (<batas) tapi error: ${hasil.e && hasil.e.message}`);
    } else if (lambat && !(hasil.e && hasil.e.timeout)) {
      hitung.salahBentuk++; contoh.push(`delay=${delay} (>batas) tapi bukan error timeout`);
    } else hitung.wajar++;
  }

  console.log(`percobaan : ${PERCOBAAN}  (seed ${process.argv[3] || 20261008}, batas ${BATAS_MS}ms)`);
  console.log(`sesuai    : ${hitung.wajar}`);
  console.log(`HANG      : ${hitung.hang}`);
  console.log(`salah bawah batas : ${hitung.salahBawah}`);
  console.log(`salah atas batas  : ${hitung.salahAtas}`);
  console.log(`bentuk respons salah : ${hitung.salahBentuk}`);
  if (contoh.length) {
    console.log("\ncontoh:");
    for (const c of contoh.slice(0, 8)) console.log("  " + c);
  }
  const cacat = hitung.hang + hitung.salahBawah + hitung.salahAtas + hitung.salahBentuk;
  console.log(`\ntotal cacat: ${cacat}`);
  process.exit(cacat ? 1 : 0);
}
main();