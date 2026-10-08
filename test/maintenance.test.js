const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

const html = read("public/maintenance-page/index.html");
const css = read("public/maintenance-page/maintenance.css");
const js = read("public/maintenance-page/maintenance.js");
const settings = read("settings.js");
const server = read("server.js");

test("halaman maintenance terdiri dari tiga file terpisah (html/css/js)", () => {
  for (const rel of ["public/maintenance-page/index.html", "public/maintenance-page/maintenance.css", "public/maintenance-page/maintenance.js"]) {
    assert.ok(fs.existsSync(path.join(root, rel)), `${rel} harus ada`);
  }
  assert.match(html, /href="\/maintenance-page\/maintenance\.css\?v=/);
  assert.match(html, /src="\/maintenance-page\/maintenance\.js\?v=/);
});

test("tanpa Tailwind CDN dan tanpa dependensi gambar eksternal", () => {
  assert.doesNotMatch(html, /cdn\.tailwindcss\.com/);
  assert.doesNotMatch(html, /googleusercontent\.com/);
  assert.match(html, /src="\/assets\/hyouta\.jpg"/, "background harus aset lokal");
});

test("logo iLoveNime murni: tanpa fungsi, tanpa hamburger/menu/search/user", () => {
  assert.match(html, /class="brand" role="img"/);
  assert.doesNotMatch(html, /<a[^>]*class="brand/);
  assert.doesNotMatch(html, /burger/i, "tombol menu dihapus");
  assert.doesNotMatch(html, /hdr-menu/);
  assert.doesNotMatch(html, /aria-label="Search"/);
  assert.doesNotMatch(html, /aria-label="User Account"/);
});

test("teks maintenance rapi + CTA storage + placeholder link web baru", () => {
  assert.match(html, /berganti hosting/);
  assert.match(html, /upgrade server/);
  assert.match(html, /Buka Storage Lokal/);
  assert.match(html, /data-newsite/, "placeholder link web baru harus ada di bawah CTA storage");
  const ctaPos = html.indexOf("Buka Storage Lokal");
  const newsPos = html.indexOf("data-newsite");
  assert.ok(ctaPos > -1 && newsPos > ctaPos, "link web baru berada setelah CTA storage");
});

test("section storage: search lokal, tab, edit mode, import/export, grid 6 kolom", () => {
  assert.match(html, /id="localSearch"/);
  assert.match(html, /id="storageTabs"/);
  assert.match(html, /id="editModeBtn"/);
  assert.match(html, /id="importBtn"/);
  assert.match(html, /id="exportBtn"/);
  assert.match(js, /pageSizeFor\(/, "ukuran halaman grid memakai pageSizeFor (18 = 6×3 desktop)");
  assert.match(css, /grid-template-columns:\s*repeat\(6,\s*1fr\)/, "grid desktop wajib 6 kolom");
  assert.match(css, /hold-fill/, "hold-to-confirm hapus");
});

test("data memakai key yang sama dengan aplikasi utama (sinkron dua arah)", () => {
  assert.match(js, /TRACKING_KEY = "iln_tracking"/);
  assert.match(js, /PREFS_KEY = "ilovenime\.reference\.prefs"/);
  assert.match(js, /from "\/js\/app-utils\.js"/, "helper export dipakai ulang");
  assert.match(js, /buildExportPayload/);
});

test("tidak ada panggilan upstream saat halaman dibuka; hanya saat Lanjut Tonton", () => {
  const initSection = js.slice(js.indexOf("/* ---------- Init"));
  assert.doesNotMatch(initSection, /fetch\(/, "init tidak boleh fetch");
  assert.match(js, /\/api\/anime\//);
  assert.match(js, /\/api\/streams\//);
  const streamFn = js.slice(js.indexOf("async function startStreaming"), js.indexOf("/* ---------- Import"));
  assert.doesNotMatch(streamFn, /loadLive|api\.daily|api\.genres/);
});

test("optimasi render: coalescing rAF + signature anti-tulis-ulang DOM", () => {
  assert.match(js, /function scheduleRender/, "render harus coalesced via rAF");
  assert.match(js, /requestAnimationFrame/, );
  assert.match(js, /renderSignatures\.get\("grid"\)/, "grid pakai signature");
  assert.match(js, /renderSignatures\.get\("pager"\)/, "pager pakai signature");
});

test("optimasi API: cache TTL, dedupe in-flight, AbortController, guard double-click", () => {
  assert.match(js, /DETAIL_TTL_MS = 600_000/);
  assert.match(js, /MIRROR_TTL_MS = 300_000/);
  assert.match(js, /inFlight\.has\(url\)/, "dedupe request paralel");
  assert.match(js, /new AbortController\(\)/);
  assert.match(js, /streamAbort\.get\(state\.current\.slug\)\?\.abort\(\)/, "tutup modal membatalkan fetch");
  assert.match(js, /if \(state\.streaming\) return/, "guard double-click streaming");
  assert.match(js, /timeoutMs = 12_000/);
});

test("optimasi CSS: tanpa paint berat, pause off-screen, content-visibility", () => {
  assert.doesNotMatch(css, /backdrop-filter/, "backdrop-filter dilarang (blur live mahal)");
  assert.doesNotMatch(css, /filter:\s*blur\(/, "filter blur dilarang pada elemen beranimasi");
  assert.doesNotMatch(css, /@keyframes[^{]*\{[^}]*box-shadow/s, "tidak ada animasi box-shadow");
  assert.doesNotMatch(css, /@keyframes[^{]*\{[^}]*background-position/s, "tidak ada animasi background-position");
  assert.match(css, /hero-offscreen[^{]*\{[^}]*animation-play-state:\s*paused/s, "animasi hero pause saat off-screen");
  assert.match(css, /content-visibility:\s*auto/, "storage skip render saat di bawah viewport");
  assert.match(css, /dotPing/, "pulse dot pakai transform scale, bukan box-shadow");
  assert.match(css, /radial-gradient\(circle closest-side/, "orb pakai gradient statis, bukan blur");
});

test("optimasi loading: preload hero + decoding async", () => {
  assert.match(html, /<link rel="preload" as="image" href="\/assets\/hyouta\.jpg"/, "hero image dipreload");
  assert.match(js, /decoding="async"/, "poster kartu decode off main thread");
});

test("server: route /maintenance + flag MAINTENANCE menjaga API tetap hidup", () => {
  assert.match(settings, /MAINTENANCE:/);
  assert.match(server, /MAINTENANCE_PAGE/);
  assert.match(server, /app\.get\("\/maintenance"/);
  assert.match(server, /if \(MAINTENANCE\)/);
  const maintBlock = server.slice(server.indexOf("MAINTENANCE_PAGE"), server.indexOf("if (require.main === module)"));
  assert.doesNotMatch(maintBlock, /app\.use\("\/api/, "flag tidak boleh menonaktifkan API");
});

/* ===== v1.2.0: player overlay gaya watch-overlay aplikasi utama ===== */
test("v1.2.0: markup player overlay lengkap (top bar, mirror dropdown, episode list)", () => {
  assert.match(html, /id="playerOverlay"/);
  assert.match(html, /id="povPlayerBox"/);
  assert.match(html, /id="povStage"/);
  assert.match(html, /id="povEpisodeList"/);
  assert.match(html, /iLoveNime \u00b7 Player/, "judul top bar persis app utama");
  assert.match(html, /class="kbd"[^>]*>Esc</, "badge Esc di top bar");
  assert.match(html, /data-pov-close/);
  assert.match(js, /mirror-trigger/, "dropdown mirror dibangun renderMirrorControls");
  assert.match(js, /mirror-options/, "opsi mirror dibangun renderMirrorControls");
  assert.doesNotMatch(html, /pipBtn|data-pip/, "tombol PiP disembunyikan (keputusan desain v1.2.0)");
});

test("v1.2.0: episode list di modal + progres sinkron ke iln_tracking", () => {
  assert.match(html, /id="mEpisodes"/);
  assert.match(html, /id="mEpisodeList"/);
  assert.match(js, /data-modal-episode/, "klik episode modal membuka player");
  assert.match(js, /function markWatched/);
  assert.match(js, /item\.progress = Math\.max\(Number\(item\.progress \|\| 0\), Number\(number\)\)/, "progress ikut maju");
  assert.match(js, /item\.status = isComplete\(item\) \? "completed" : "watching"/, "status ikut update");
  assert.match(js, /saveState\(\)/, "markWatched menulis ke iln_tracking via saveState");
});

test("v1.2.0: player engine - mirror, prev/next, cache dipakai ulang", () => {
  assert.match(js, /function openPlayer/);
  assert.match(js, /function loadMirror/);
  assert.match(js, /function playPlayerEpisode/);
  assert.match(js, /function navigatePlayerEpisode/);
  assert.match(js, /function mountMirror/);
  assert.match(js, /data-vo-prev/);
  assert.match(js, /data-vo-next/);
  assert.match(js, /DETAIL_TTL_MS = 600_000/, "cache detail v1.1.0 dipakai ulang");
  assert.match(js, /MIRROR_TTL_MS = 300_000/, "cache mirror v1.1.0 dipakai ulang");
  assert.match(js, /povPlayer\(\)\.innerHTML = ""/, "tutup player membongkar iframe");
  assert.match(js, /streamAbort\.get\(state\.current\.slug\)\?\.abort\(\)/, "abort kontrak v1.1.0 tetap ada");
});

test("v1.2.0: player CSS tanpa blur & hanya animasi transform/opacity", () => {
  assert.match(css, /\.pov \{/, "overlay player ada di maintenance.css");
  assert.match(css, /\.vo-bar/);
  assert.match(css, /\.ep-item\.current/);
  assert.match(css, /mirrorInRight/, "transisi ganti mirror dipertahankan");
  assert.doesNotMatch(css.slice(css.indexOf("PLAYER OVERLAY")), /backdrop-filter|filter:\s*blur\(/, "blok player bebas blur");
  const povKeyframes = css.slice(css.indexOf("@keyframes mirrorInRight"), css.indexOf("@keyframes mirrorOutFade"));
  assert.doesNotMatch(povKeyframes, /box-shadow|background-position|\bwidth\b|\bheight\b|\btop\b|\bleft\b/, "keyframes mirror compositor-only");
});
