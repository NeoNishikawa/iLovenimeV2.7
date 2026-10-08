/* Load test pra-publish: simulasi banyak player melakukan pencarian dan
   request bersamaan ke server berjalan.

   Yang diukur:
   - breakdown status (200/429/503/5xx) per skenario
   - latency p50/p95/p99 dari SISI KLIEN (waktu neighbourhood yang dirasakan
     user, termasuk antrean di server)
   - apakah server tetap hidup dan queue kembali kosong setelah beban

   Semua request dikirim paralel dari satu proses memakai fetch, sehingga
   semuanya Uttid satu "IP" (::1) dari pandangan server — ini justru
   skenario terburuk: satu kuota bersama untuk semua user. Kalau load test
   ini sehat, satu user dengan banyak request juga sehat.

   Pakai: node scripts/load-test.js [totalRequest] [concurrency]  */

const BASE = process.env.BASE_URL || "http://localhost:3099";

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

async function timedFetch(path, { asClient = false, forwardedFor = "" } = {}) {
  const started = Date.now();
  const headers = forwardedFor ? { "X-Forwarded-For": forwardedFor } : undefined;
  let attempt = 0;
  let last = null;
  /* asClient = true meniru api.js: satu kali retry untuk status transient,
     menghormati Retry-After milik server. Ini yang dirasakan user sebenarnya. */
  for (;;) {
    try {
      const response = await fetch(`${BASE}${path}`, { headers });
      const text = await response.text();
      last = { status: response.status, ms: Date.now() - started, bytes: text.length, retryAfter: response.headers.get("retry-after"), attempts: attempt + 1 };
      if (!asClient || attempt >= 1 || !retryableStatus(response.status)) return last;
      const waitMs = Number(response.headers.get("retry-after")) * 1000 || 350 * (attempt + 1);
      if (response.status === 429 && waitMs > 5000) return last;
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      attempt += 1;
    } catch (error) {
      return { status: 0, ms: Date.now() - started, bytes: 0, error: error.message, attempts: attempt + 1 };
    }
  }
}

function retryableStatus(status) {
  return [408, 425, 429, 500, 502, 503, 504].includes(Number(status));
}

async function runBatch(paths, concurrency, options = {}) {
  const results = [];
  let cursor = 0;
  async function worker() {
    while (cursor < paths.length) {
      const index = cursor;
      cursor += 1;
      const forwardedFor = options.forwardedFor ? `203.0.113.${(index % 250) + 1}` : "";
      results.push(await timedFetch(paths[index], { asClient: options.asClient, forwardedFor }));
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, paths.length) }, () => worker()));
  return results;
}

function summarize(label, results, wallMs) {
  const byStatus = {};
  let bytes = 0;
  for (const result of results) {
    byStatus[result.status] = (byStatus[result.status] || 0) + 1;
    bytes += result.bytes;
  }
  const latencies = results.map((result) => result.ms).sort((a, b) => a - b);
  const serverErrors = Object.entries(byStatus).filter(([status]) => Number(status) >= 500).reduce((sum, [, count]) => sum + count, 0);
  const line = Object.keys(byStatus).sort().map((status) => `${status}x${byStatus[status]}`).join(" ");
  console.log(`\n== ${label} ==`);
  console.log(`   total request : ${results.length}`);
  console.log(`   status        : ${line}`);
  console.log(`   latency p50   : ${percentile(latencies, 50)}ms`);
  console.log(`   latency p95   : ${percentile(latencies, 95)}ms`);
  console.log(`   latency p99   : ${percentile(latencies, 99)}ms`);
  console.log(`   max latency   : ${latencies[latencies.length - 1]}ms`);
  console.log(`   wall time     : ${wallMs}ms`);
  console.log(`   payload       : ${(bytes / 1024).toFixed(1)} KiB total`);
  if (serverErrors) console.log(`   !! 5xx muncul : ${serverErrors}`);
  const retried = results.filter((result) => result.status === 429 && result.retryAfter);
  if (retried.length) console.log(`   Retry-After pada 429: ada di ${retried.length} respons (Retry-After: ${retried[0].retryAfter})`);
  return { byStatus, serverErrors, p95: percentile(latencies, 95), max: latencies[latencies.length - 1], bytes, ok: byStatus[200] || byStatus["200"] || 0, count: results.length };
}

async function serverAlive() {
  try {
    const response = await fetch(`${BASE}/api/health`);
    const body = await response.json();
    return { alive: response.ok, text: `http=${response.status} body=${JSON.stringify(body)}` };
  } catch (error) {
    return { alive: false, text: `GAGAL: ${error.message}` };
  }
}

async function main() {
  const total = Number(process.argv[2]) || 120;
  const concurrency = Number(process.argv[3]) || total;
  console.log(`Load test ILoveNime -> ${BASE}`);
  console.log(`total=${total} concurrency=${concurrency}`);
  const before = await serverAlive();
  console.log(`server sebelum: ${before.text}`);
  /* Berhenti di sini kalau server tidak hidup. Menjalankan 480 request yang
     pasti gagal hanya menghasilkan angka yang menyesatkan. */
  if (!before.alive) {
    console.log(`\nVERDICT: GAGAL: ${BASE} tidak menjawab. Nyalakan server dulu (\`npm start\`), lalu ulangi.`);
    console.log("Load test tidak menyalakan server sendiri — ini bukan kelulusan, ini tidak ada tes.");
    process.exitCode = 1;
    return;
  }

  // Skenario 1: banyak player mencari BERBEDA, jadi menembus burst
  const different = Array.from({ length: total }, (_, index) => `/api/catalog?search=load${index}`);
  let wall = Date.now();
  const s1 = summarize("S1 search BERBEDA (burst path)", await runBatch(different, concurrency), Date.now() - wall);

  // Skenario 2: banyak player mencari SAMA -> harus di-coalesce, gratis
  await new Promise((resolve) => setTimeout(resolve, 2500));
  wall = Date.now();
  const same = Array.from({ length: total }, () => `/api/catalog?search=loadshared`);
  const s2 = summarize("S2 search SAMA (coalesce path)", await runBatch(same, concurrency), Date.now() - wall);

  // Skenario 3: campuran semua endpoint seperti browsing biasa
  await new Promise((resolve) => setTimeout(resolve, 2500));
  wall = Date.now();
  const mixed = Array.from({ length: total }, (_, index) => {
    const bucket = index % 4;
    if (bucket === 0) return `/api/catalog?search=mix${index}`;
    if (bucket === 1) return `/api/daily`;
    if (bucket === 2) return `/api/genres`;
    return `/api/anime/boruto-naruto-next-generations-subtitle-indo`;
  });
  const s3 = summarize("S3 campuran semua endpoint", await runBatch(mixed, concurrency), Date.now() - wall);

  // Skenario 4: 100+ player NYATA. Tiap request memakai IP berbeda
  // (X-Forwarded-For) seperti user berbeda di belakang proxy, memakai
  // retry yang sama dengan api.js di browser.
  await new Promise((resolve) => setTimeout(resolve, 2500));
  wall = Date.now();
  const players = Array.from({ length: total }, (_, index) => `/api/catalog?search=pemain${index}`);
  const s4 = summarize("S4 100+ player (IP berbeda + retry client)", await runBatch(players, concurrency, { asClient: true, forwardedFor: true }), Date.now() - wall);

  console.log("\n== SESUDAH BEBAN ==");
  console.log(`server: ${(await serverAlive()).text}`);
  await new Promise((resolve) => setTimeout(resolve, 2000));
  console.log(`server (2dtd): ${(await serverAlive()).text}`);

  const totalServerErrors = s1.serverErrors + s2.serverErrors + s3.serverErrors + s4.serverErrors;
  const semua = [s1, s2, s3, s4];
  const totalOk = semua.reduce((sum, item) => sum + item.ok, 0);
  const totalReq = semua.reduce((sum, item) => sum + item.count, 0);
  const totalBytes = semua.reduce((sum, item) => sum + item.bytes, 0);

  /* Verdict sebelumnya HANYA mengecek "tidak ada 5xx". Itu tidak menangkap
     kegagalan yang paling umum: server tidak hidup sama sekali. Semua request
     gagal di lapisan jaringan, jadi memang tidak ada 5xx — dan verdict tetap
     tercetak "SEHAT" padahal nol request benar-benar terjawab (payload 0.0
     KiB). Skrip ini tidak menyalakan server-nya sendiri; kalau dijalankan
     tanpa server, hasilnya bukan lulus, tapi GAGAL.

     Karena itu tiga syarat sekarang: server hidup, ada respons 2xx, dan ada
     payload. Tanpa semuanya, "tidak ada 5xx" bukan bukti kesehatan. */
  const masalah = [];
  if (!before.alive) masalah.push(`server tidak hidup sebelum tes (${before.text})`);
  if (totalOk === 0) masalah.push("nol respons 2xx di semua skenario");
  if (totalBytes === 0) masalah.push("payload 0 B — tidak ada request yang benar-benar terjawab");
  if (totalServerErrors > 0) masalah.push(`${totalServerErrors} respons 5xx`);

  const sehat = masalah.length === 0;
  console.log(`\n   ringkasan     : ${totalOk}/${totalReq} respons 2xx, ${(totalBytes / 1024).toFixed(1)} KiB`);
  console.log(`VERDICT: ${sehat ? "SEHAT: ada respons 2xx, payload nyata, tanpa 5xx" : `GAGAL: ${masalah.join("; ")}`}`);
  /* Exit code wajib ikut. Tanpa ini, pemanggil hanya membaca teks dan
     "SEHAT" yang salah bisa lolos ke CI tanpa complained. */
  if (!sehat) process.exitCode = 1;
}

/* Nama file ini dulu `load-test.js`, yang cocok pola `*-test.js` milik Node.
   Akibatnya `node --test` ikut memungutnya dan menghitungnya sebagai satu test,
   padahal skrip ini butuh server hidup — bukan test mandiri. Ketika `npm test`
   berjalan tanpa server, ia selalu gagal diam-diam, dan dulu dilaporkan
   "SEHAT" karena verdict hanya mengecek 5xx.

   Namanya sekarang `load-bench.js`: ia benchmark, bukan test. Guard di bawah
   tetap dipertahankan supaya meng-import file ini tidak menjalankan apa pun. */
if (require.main === module) {
  main().catch((error) => {
    console.error("load test gagal:", error);
    process.exitCode = 1;
  });
}