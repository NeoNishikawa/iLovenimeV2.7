/* Verifikasi LANGSUNG (bukan test): membuktikan rantai suplemen Samehadaku benar-benar
   bekerja terhadap situs nyata — pencocokan judul, pengambilan episode, sampai
   token stream.

   Pakai: node scripts/verify-supplement.js
*/
const server = require("../server");

const { fetchSamehadakuEpisodes, normalizeTitleKey, parseMirrorOptions, normalizeEpisodes } = server;

const CASES = [
  { title: "Black Clover Season 2 Sub Indo", synonym: "Black Clover 2nd Season", expect: "black clover season 2" },
  { title: "Romelia Senki Sub Indo", synonym: "", expect: "romelia senki" },
  { title: "Magical★Explorer Sub Indo", synonym: "", expect: "magical explorer" },
  /* Kasus kontrol: judul yang TIDAK ada di Samehadaku harus mengembalikan nol
     episode, bukan acak mengambil film yang tidak berhubungan. */
  { title: "Detective Conan Sub Indo", synonym: "", expect: "detective conan" },
];

(async () => {
  for (const item of CASES) {
    const key = normalizeTitleKey(item.title);
    const correct = key === item.expect;
    const result = await fetchSamehadakuEpisodes(item.title, item.synonym);
    const episodes = normalizeEpisodes(result.episodes || []);
    console.log("");
    console.log(`JUDUL   : ${item.title}`);
    console.log(`  kunci : "${key}" ${correct ? "(sesuai harapan)" : `(diharapkan "${item.expect}")`}`);
    console.log(`  judul : ${JSON.stringify(result.title)}`);
    console.log(`  match : ${result.key ? (result.key === key ? "SAMA" : `BEDA -> "${result.key}"`) : "TIDAK ADA HASIL"}`);
    console.log(`  episode: ${episodes.length}`);
    episodes.slice(0, 4).forEach((e) => console.log(`     - #${e.number} ${e.slug} (${e.sourceProvider})`));

    /* Kalau ada episode, buktikan halamannya benar-benar punya stream. */
    const first = result.episodes?.[0];
    if (first?.sourceUrl) {
      const https = require("node:https");
      const html = await new Promise((resolve) => {
        const req = https.get(first.sourceUrl, { headers: { "user-agent": "Mozilla/5.0" }, timeout: 20000 }, (res) => {
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (c) => { body += c; });
          res.on("end", () => resolve(body));
        });
        req.on("timeout", () => { req.destroy(); resolve(""); });
        req.on("error", () => resolve(""));
      });
      const streams = parseMirrorOptions(html);
      console.log(`  STREAM : ${streams.length} mirror dari halaman episode`);
      streams.slice(0, 3).forEach((s) => console.log(`     - ${s.name}: ${String(s.url).slice(0, 78)}`));
    }
  }
})().catch((e) => { console.error("GAGAL:", e.message); process.exit(1); });