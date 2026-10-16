/* Probe gap yang DIPERBAIKI: hanya menghitung kartu hasil search asli
   Samehadaku (div.animposx). Versi pertama ikut menghitung sidebar
   rekomendasi (div.imgseries) sehingga hampir semua query cocok ke
   "Hibike Euphonium" dan angkanya tidak bisa dipercaya.

   Pakai: node scripts/probe-gap.js
*/
const https = require("node:https");
const cheerio = require("cheerio");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)";

function get(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { "user-agent": UA }, timeout: 20000 }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { body += c; });
      res.on("end", () => resolve(body));
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
  });
}

/* Judul yang SAMA persis setelah normalisasi. Tanpa filter ini, "Black Clover
   Season 2" bisa berpasangan dengan film atau spin-off karena slugnya mirip.
   Kalau kuncinya tidak sama, tidak ada fallback sama sekali. */
const NOISE = /\b(sub indo|subtitle indonesia|subtitle|indonesian|dub|bd|bluray|nonton)\b/g;

function normalizeTitleKey(value) {
  const base = String(value || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  if (!base) return "";
  return base
    .replace(/\bs(\d{1,2})\b/g, "season $1")
    .replace(/\b(\d)\s*(?:st|nd|rd|th)\s*season\b/g, "season $1")
    .replace(NOISE, " ")
    .replace(/\s+/g, " ")
    .trim();
}

(async () => {
  const ANI = "https://animasu.love";
  const SH = "https://v2.samehadaku.how";
  const server = require("../server");

  const list = await get(`${ANI}/anime-sedang-tayang-terbaru/`);
  const cards = server.parseAnimeCards(list).filter((c) => c.title && c.slug).slice(0, 8);
  console.log(`kandidat: ${cards.length}\n`);

  let cocok = 0;
  for (const card of cards) {
    const aniDetail = server.parseAnimeDetail(await get(`${ANI}/anime/${encodeURIComponent(card.slug)}/`), card.slug, ANI);
    const aniEp = aniDetail.episodes.length;
    const aniKey = normalizeTitleKey(aniDetail.title || card.title);

    let shEp = 0;
    let shSlug = "-";
    let shKey = "-";
    let shTitle = "-";
    try {
      const $s = cheerio.load(await get(`${SH}/?s=${encodeURIComponent(card.title)}`));
      // Hanya .animposx = hasil search. .imgseries = sidebar rekomendasi.
      let best = null;
      $s("div.animposx a[href*='/anime/']").each((_, el) => {
        const a = $s(el);
        const href = a.attr("href") || "";
        const title = (a.attr("title") || a.find("img").first().attr("alt") || "").trim();
        if (!title) return;
        const key = normalizeTitleKey(title);
        if (key && key === aniKey && !best) best = { href, title, key };
      });
      if (best) {
        shSlug = best.href.replace(SH, "");
        shKey = best.key;
        shTitle = best.title;
        const $d = cheerio.load(await get(new URL(best.href, SH).toString()));
        const seen = new Set();
        $d("a[href]").each((_, el) => {
          const href = $d(el).attr("href") || "";
          // /daftar-batch/ adalah item menu, bukan episode.
          if (!/-episode-\d+/.test(href) || seen.has(href)) return;
          seen.add(href);
        });
        shEp = seen.size;
        cocok += 1;
      }
    } catch (e) { shSlug = `GAGAL ${e.message}`; }

    console.log(`  ${(aniDetail.title || card.title).slice(0, 40).padEnd(42)} Ani=${String(aniEp).padStart(3)}  SH=${String(shEp).padStart(3)}  ${shEp > aniEp ? "<<< LENGKAP" : ""}`);
    console.log(`      kunci: ani="${aniKey}"`);
    console.log(`             sh ="${shKey}"  slug=${shSlug}`);
  }
  console.log(`\ncocok judul persis: ${cocok}/${cards.length}`);
})().catch((e) => console.log("GAGAL TOTAL:", e.message));