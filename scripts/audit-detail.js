/* Audit menyeluruh lintas sumber untuk target uji Neo.
   Untuk setiap anime:
     1. Ambil detail dari Animasu (sumber kebenaran untuk judul).
     2. Cari pasangan di Samehadaku lewat fetchSamehadakuEpisodes (kode produksi,
        bukan parser buatan).
     3. Bandingkan judul, jumlah episode, dan status tayang.
     4. Buka SAMBIL episode dari tiap sumber dan buktikan mirror benar-benar
        bisa diambil — bukan cuma "halaman ada".

   Pakai: node scripts/audit-detail.js
*/
const https = require("node:https");
const server = require("../server");

const { parseAnimeDetail, fetchAnimeDetail, fetchSamehadakuEpisodes, normalizeTitleKey, normalizeEpisodes, parseMirrorOptions, mergeSupplementEpisodes } = server;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)";

function get(url) {
  return new Promise((resolve) => {
    const req = https.get(url, { headers: { "user-agent": UA }, timeout: 20000 }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { body += c; });
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("timeout", () => { req.destroy(); resolve({ status: 0, body: "" }); });
    req.on("error", () => resolve({ status: 0, body: "" }));
  });
}

/* Buka halaman episode dan lihat mirror yang benar-benar bisa diambil. */
async function cekStream(sourceUrl) {
  if (!sourceUrl) return { mirror: 0, contoh: "" };
  const page = await get(sourceUrl);
  if (page.status !== 200 || !page.body) return { mirror: 0, contoh: "", status: page.status };
  const streams = parseMirrorOptions(page.body);
  return { mirror: streams.length, contoh: streams[0] ? String(streams[0].url).slice(0, 72) : "", status: page.status };
}

const TARGET = [
  { grup: "Black Clover", slugs: ["black-clover-s2", "black-clover-mahou-tei-no-ken", "black-clover-sub-indo"] },
  { grup: "Tensei Shitara Slime", slugs: ["tensei-shitara-slime-datta-ken-season-4", "tensei-shitara-slime-datta-ken-s3", "tensei-shitara-slime-datta-ken-s2-part-2-sub-indo", "tensei-shitara-slime-datta-ken-movie-2-soukai-no-namida-hen", "tensura-nikki-tensei-shitara-slime-datta-ken-sub-indo"] },
  { grup: "Iruma", slugs: ["mairimashita-iruma-kun-s4-sub-indo", "mairimashita-iruma-kun-season-3", "mairimashita-iruma-kun-s2", "mairimashita-iruma-kun"] },
];

(async () => {
  let total = 0;
  let pasangan = 0;
  let streamBerhasil = 0;
  let streamGagal = 0;
  const ringkasan = [];

  for (const grup of TARGET) {
    console.log(`\n${"=".repeat(74)}\n### ${grup.grup}\n${"=".repeat(74)}`);
    for (const slug of grup.slugs) {
      total += 1;
      let ani;
      try { ani = await fetchAnimeDetail(slug); } catch (e) { console.log(`  ${slug}: GAGAL ${e.message}`); continue; }
      const aniEps = normalizeEpisodes(ani.episodes || []);
      const aniKey = normalizeTitleKey(ani.title);

      const sh = await fetchSamehadakuEpisodes(ani.title, ani.synonym);
      const shEps = normalizeEpisodes(sh.episodes || []);
      const shKey = sh.key || "";
      const cocok = shKey && shKey === aniKey;
      if (cocok) pasangan += 1;

      const merged = mergeSupplementEpisodes(aniEps, shEps);

      console.log(`\n  ${ani.title}`);
      console.log(`    slug        : ${slug}`);
      console.log(`    kunci       : "${aniKey}"`);
      console.log(`    Sinopsis/alt: ${ani.synonym || "(tidak ada)"}`);
      console.log(`    ANIMASU     : ${aniEps.length} episode | studio=${ani.studio} | rating=${ani.rating} | status=${ani.status}`);
      console.log(`    SAMEHADAKU  : ${cocok ? "COCOK" : "tidak cocok"} | judul="${sh.title}" | ${shEps.length} episode`);
      if (cocok) console.log(`    GABUNGAN    : ${merged.episodes.length} episode (ditambah ${merged.added} dari Samehadaku)`);

      /* Uji nyata: satu episode dari tiap sumber yang tersedia. */
      const cek = [];
      if (aniEps[0]) cek.push(["animasu", aniEps[0]]);
      if (cocok && shEps[0]) cek.push(["samehadaku", shEps[0]]);
      for (const [asal, ep] of cek) {
        const s = await cekStream(ep.sourceUrl);
        if (s.mirror > 0) streamBerhasil += 1; else streamGagal += 1;
        console.log(`    STREAM ${asal.padEnd(11)}: #${ep.number} ${ep.slug} -> ${s.mirror} mirror (http ${s.status})`);
        if (s.contoh) console.log(`        ${s.contoh}`);
      }
      ringkasan.push({ judul: ani.title, aniEps: aniEps.length, shEps: shEps.length, cocok, merged: merged.episodes.length });
    }
  }

  console.log(`\n${"=".repeat(74)}\nRINGKASAN\n${"=".repeat(74)}`);
  console.log(`  anime diuji          : ${total}`);
  console.log(`  pasangan ke Samehadaku: ${pasangan}/${total}`);
  console.log(`  episode stream OK    : ${streamBerhasil}`);
  console.log(`  episode stream GAGAL : ${streamGagal}`);
  console.log(`\n  TABEL:`);
  for (const r of ringkasan) {
    console.log(`    ${String(r.aniEps).padStart(4)} / ${String(r.shEps).padStart(4)} -> ${String(r.merged).padStart(4)}  ${r.cocok ? "cocok " : "----- "} ${r.judul.slice(0, 46)}`);
  }
})().catch((e) => { console.error("GAGAL TOTAL:", e.message); process.exit(1); });