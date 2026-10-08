const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

let view;
const componentsCss = fs.readFileSync(path.join(__dirname, "../public/css/components.css"), "utf8");
const referenceApp = fs.readFileSync(path.join(__dirname, "../public/js/reference-app.js"), "utf8");
const apiSource = fs.readFileSync(path.join(__dirname, "../public/js/api.js"), "utf8");
const indexHtml = fs.readFileSync(path.join(__dirname, "../public/index.html"), "utf8");
const screenTimeSource = fs.readFileSync(path.join(__dirname, "../public/js/screen-time.js"), "utf8");
const screenTimeCss = fs.readFileSync(path.join(__dirname, "../public/css/screen-time.css"), "utf8");
const serviceWorkerSource = fs.readFileSync(path.join(__dirname, "../public/sw.js"), "utf8");
const continueCss = fs.readFileSync(path.join(__dirname, "../public/css/continue.css"), "utf8");
const morphCss = fs.readFileSync(path.join(__dirname, "../public/css/morph.css"), "utf8");
const motionCss = fs.readFileSync(path.join(__dirname, "../public/css/motion.css"), "utf8");
test.before(async () => {
  const source = fs.readFileSync(path.join(__dirname, "../public/js/view.js"), "utf8");
  view = await import(`data:text/javascript,${encodeURIComponent(source)}`);
});

test("Local Data dirender sebagai kartu poster dengan progres dan aksi Open", () => {
  const html = view.renderCollection([{ slug: "one", title: "One Anime", image: "poster.jpg", status: "watching", progress: 3, total: 12 }]);
  assert.match(html, /class="saved-card"/);
  assert.match(html, /class="saved-card__art"/);
  assert.match(html, /Episode 3 \/ 12/);
  assert.match(html, /25%/);
  assert.match(html, /data-open="one"/);
  assert.match(html, /class="saved-card__action"/);
});

test("filter Local Data menampilkan label status yang ramah pengguna", () => {
  const html = view.renderCollectionFilters([
    { status: "completed" },
    { status: "watching" },
    { status: "planned" },
    { status: "dropped" },
  ], "completed");
  assert.match(html, /Sudah ditonton/);
  assert.match(html, /Belum selesai/);
  assert.match(html, /Rencana/);
  assert.match(html, /Block/);
  assert.match(html, /aria-pressed="true"/);
});

test("kontrol video tidak boleh menangkap klik yang seharusnya masuk ke iframe", () => {
  assert.match(componentsCss, /\.vo-hotspot\{[^}]*pointer-events:none/);
  assert.match(referenceApp, /playerStage\?\.addEventListener\("click", \(event\) => \{/);
  assert.doesNotMatch(referenceApp, /voHotspot\?\.addEventListener\("click"/);
});

test("PiP iframe memakai handoff seamless tanpa Document PiP lintas window", () => {
  assert.match(referenceApp, /const SEAMLESS_IFRAME_PIP = true/);
  assert.match(referenceApp, /if \(!SEAMLESS_IFRAME_PIP && "documentPictureInPicture"/);
  assert.match(referenceApp, /\.pip-body.*appendChild\(iframe\)/s);
  assert.doesNotMatch(componentsCss, /\.pip-window\{[^}]*animation:pipIn/s);
});

test("PiP dapat dipindahkan dengan pointer tanpa mengganggu iframe", () => {
  assert.match(referenceApp, /data-pip-drag-handle/);
  assert.match(referenceApp, /setPointerCapture/);
  assert.match(referenceApp, /setPipPosition\(el, event\.clientX - offsetX, event\.clientY - offsetY\)/);
  assert.match(referenceApp, /window\.innerWidth - rect\.width/);
  assert.match(referenceApp, /sessionStorage\.setItem\("iln:pip-position"/);
  assert.match(componentsCss, /touch-action:none/);
  assert.match(componentsCss, /\.pip-window\.is-dragging \.pip-head\{cursor:grabbing/);
});

test("Search memiliki retry HTTP-aware dan indikator loading retry", () => {
  assert.match(apiSource, /function retryableStatus\(status\)/);
  assert.match(apiSource, /requestWithRetry\(/);
  assert.match(apiSource, /iln:catalog-retry/);
  /* Indikator retry pindah dari kartu Thought loader ke toast, karena loader
     itu sudah dihapus (wave physics loader yang menggantikan). */
  assert.match(referenceApp, /window\.addEventListener\("iln:catalog-retry"/);
  assert.match(referenceApp, /Mencoba lagi/);
  /* Kartu Thought tidak boleh muncul lagi di mana pun. */
  assert.doesNotMatch(referenceApp, /thoughtStart|thoughtStage|thoughtDone|thoughtProgress|thought-overlay/);
  assert.doesNotMatch(componentsCss, /\.thought-/);
  assert.doesNotMatch(screenTimeCss, /thought/);
});

test("Rate limit menghormati Retry-After server dan error tidak di-cache", () => {
  /* Retry 429 hanya berguna kalau ditunggu sesuai angka server, bukan
     tebakan tetap yang pasti kena 429 lagi lalu menghabiskan retry. */
  assert.match(apiSource, /error\.retryAfterMs = Number\(json\.retryAfterMs\) > 0/);
  assert.match(apiSource, /response\.headers\.get\("Retry-After"\)/);
  assert.match(apiSource, /Number\(error\.status\) === 429 && waitMs > 5_000/);
  /* Cache klien dulu tidak pernah expire dan tidak dibatasi jumlahnya. */
  assert.match(apiSource, /const CACHE_TTL_MS = 60_000/);
  assert.match(apiSource, /const CACHE_MAX_ENTRIES = 40/);
  assert.match(apiSource, /function cacheGet\(key\)/);
  assert.match(apiSource, /function cacheSet\(key, promise\)/);
  /* Satu 429 tidak boleh membuat query yang sama ikut gagal 60 detik. */
  assert.match(apiSource, /cache\.get\(key\)\?\.promise === pending/);
  assert.doesNotMatch(apiSource, /if \(cache\.has\(key\)\) return cache\.get\(key\);/);
});

test("countdown dinonaktifkan agar tidak membuat timer atau refresh berulang", () => {
  assert.doesNotMatch(indexHtml, /data-support="countdown"/);
  /* setInterval boleh ada HANYA untuk jam tonton (satu interval, dihitung
     manual). Countdown tidak boleh piggyback di sana. */
  assert.doesNotMatch(referenceApp, /COUNTDOWN_TARGETS|getCountdownParts|openCountdown/);
  const intervals = referenceApp.match(/setInterval\(/g) || [];
  assert.equal(intervals.length, 1, "hanya boleh ada satu setInterval (jam tonton)");
  assert.match(referenceApp, /watchClock\.timer = setInterval\(/);
});

test("pengingat screen-time accessible, lokal, dan tidak mengendalikan iframe/PiP", () => {
  assert.match(screenTimeSource, /role="dialog" aria-modal="true" aria-labelledby=/);
  assert.match(screenTimeSource, /if \(thresholdHours === 3 \|\| thresholdHours === 5 \|\| thresholdHours === 7 \|\| thresholdHours === 12\) showDialog\(thresholdHours, activeMs\)/);
  assert.match(screenTimeSource, /SCREEN_TIME_TEST_MODE = false/);
  assert.match(screenTimeSource, /testMode && state\.activeMs >= thresholds\[3\][\s\S]*?emitReminder\(12\)/);
  assert.match(screenTimeSource, /intervalMs = testMode \? 1_000 : SCHEDULER_MS/);
  assert.match(screenTimeSource, /const continueButton = button\("Lanjutkan", "dismiss", true\);\s*actions\.append\(button\("Tutup web", "close-website"\), continueButton\)/);
  assert.match(screenTimeSource, /windowRef\.close\(\)/);
  assert.match(screenTimeSource, /Browser tidak mengizinkan situs menutup tab ini/);
  assert.match(screenTimeSource, /eyebrow\.textContent = `\$\{formatActiveTime\(activeMs\)\} aktif hari ini`/);
  assert.match(screenTimeSource, /hours === 5 \? 3 \* 60 : 10 \* 60/);
  assert.match(screenTimeSource, /let remaining = 5/);
  assert.match(screenTimeSource, /if \(hours === 12\) \{\s*actions\.append\(button\("Tutup web", "close-website", true\)\);\s*startFinalCountdown\(\);/);
  assert.doesNotMatch(screenTimeSource.match(/else if \(hours === 12\) \{([\s\S]*?)\n    \}/)?.[1] || "", /Lanjutkan/);
  assert.match(screenTimeSource, /NotificationApi\.requestPermission\(\)/);
  assert.match(screenTimeSource, /get some sleep, Love you 💖/);
  assert.match(screenTimeSource, /registration\.showNotification\("iLoveNime", options\)/);
  assert.match(referenceApp, /serviceWorker\.register\("\/sw\.js"\)/);
  assert.match(serviceWorkerSource, /event\.notification\.close\(\)/);
  assert.ok(fs.existsSync(path.join(__dirname, "../public/assets/screen-time/12hours.jpg")));
  assert.match(screenTimeCss, /\.screen-time-overlay\{position:fixed;inset:0;z-index:590;display:grid;place-items:center/);
  assert.match(screenTimeSource, /querySelectorAll\("button:not\(\[disabled\]\)/);
  assert.match(screenTimeSource, /event\.stopPropagation\(\)/);
  assert.match(referenceApp, /createScreenTimeTracker/);
  assert.match(screenTimeSource, /localStorage/);
  assert.doesNotMatch(screenTimeSource, /iframe\.src|closePipWindow|playerBox/);
});

test("UI upgrade v2.2: dropdown performa dihapus, auto-tier tetap aktif, tombol theme morph", () => {
  /* Dropdown Animasi dihapus dari markup (permintaan upgrade); select jembatan
     juga tidak lagi dibutuhkan karena kontrol manual dihilangkan. */
  assert.doesNotMatch(indexHtml, /data-perf-dd/);
  assert.doesNotMatch(indexHtml, /perf-dd-trigger/);
  assert.doesNotMatch(indexHtml, /id="performanceMode"/);
  /* Controller auto-tier tetap terpasang di belakang layar */
  assert.match(referenceApp, /createPerformanceController/);
  /* Theme morph: tombol icon sun/moon, bukan slide track */
  assert.match(indexHtml, /theme-morph-btn/);
  assert.match(indexHtml, /data-theme-toggle/);
  assert.doesNotMatch(indexHtml, /theme-checkbox/);
  assert.match(referenceApp, /applyTheme\(/);
  assert.match(referenceApp, /data-theme-toggle/);
});

test("UI upgrade v2.2: search morph X, hint pilihan, filter tanpa auto-search", () => {
  /* Karakter & tombol search lama dihilangkan dari header main */
  assert.doesNotMatch(indexHtml, /cf-main/);
  assert.doesNotMatch(indexHtml, /mainFilterSearch/);
  /* Morph Search→X + hint "Cari sesuai pilihan" + chip dalam search */
  assert.match(indexHtml, /searchMorphBtn/);
  assert.match(indexHtml, /searchHint/);
  assert.match(indexHtml, /searchFilterChips/);
  assert.match(referenceApp, /Cari sesuai pilihan/);
  assert.match(referenceApp, /clearAllSearch/);
  assert.match(referenceApp, /updateSearchUI/);
  /* Dropdown tipe/status: klik chip aktif membatalkan pilihan */
  assert.match(referenceApp, /state\[key\] = state\[key\] === button\.dataset\.value \? "" : button\.dataset\.value/);
  /* Pemilihan di main tidak memicu render/pencarian otomatis */
  assert.match(referenceApp, /isStorage \? refreshStorageFilters\(\) : updateSearchUI\(\)/);
  /* Notifikasi: lonceng */
  assert.match(referenceApp, /i-bell/);
  /* Reaksi detail: favorite & dislike */
  assert.match(referenceApp, /setAnimeReaction/);
  assert.match(referenceApp, /data-detail-fav/);
  assert.match(referenceApp, /data-detail-dislike/);
  /* Animasi deal & page turn */
  assert.match(referenceApp, /dealCards/);
  assert.match(referenceApp, /turnPageIn/);
  /* Ikon karakter (list karakter) tak lagi dirender */
  assert.doesNotMatch(referenceApp, /CHARACTER_OPTIONS/);
});

test("Lanjutkan Menonton: section dan rail ada di markup", () => {
  assert.match(indexHtml, /id="continueSection"/);
  assert.match(indexHtml, /id="continueRail"/);
  assert.match(indexHtml, /id="navContinueCount"/);
  assert.match(indexHtml, /data-nav="continue"/);
  assert.match(indexHtml, /data-cw-prev/);
  assert.match(indexHtml, /data-cw-next/);
});

test("Lanjutkan Menonton: memakai modal See Detail yang sama, bukan player terpisah", () => {
  /* Rail WAJIB membuka #watchOverlay yang sama dengan tombol See Detail,
     supaya pengguna tidak menemukan dua tampilan berbeda. */
  assert.match(referenceApp, /openDetail\(slug, \{ preferUnwatched: true \}\)/);
  assert.match(referenceApp, /async function openDetail\(id, options = \{\}\)/);
  assert.match(referenceApp, /options\.preferUnwatched \? \(cwNextFor\(/);
  /* Bekas player khusus Lanjutkan Menonton harus benar-benar hilang. */
  assert.doesNotMatch(referenceApp, /openCwStage|cwStage|cwStep\(|cw-stage/);
  assert.doesNotMatch(indexHtml, /cwStageRoot|cw-stage/);
  assert.doesNotMatch(continueCss, /cw-stage|cw-frame|cw-step/);
});

test("Lanjutkan Menonton: anime.js terdaftar di importmap dan dipakai", () => {
  assert.match(indexHtml, /"animejs":\s*"\/vendor\/animejs\/anime\.esm\.min\.js"/);
  assert.match(referenceApp, /from "animejs"/);
  assert.match(referenceApp, /import \{ animate, createTimeline, stagger, utils \}/);
});

test("Lanjutkan Menonton: logika inti tidak hilang", () => {
  assert.match(referenceApp, /function renderContinue/);
  assert.match(referenceApp, /function startPreview/);
  assert.match(referenceApp, /function clearCwPreviews/);
  assert.match(referenceApp, /function cwScrollRail/);
  assert.match(referenceApp, /current\.lastWatchedAt = Date\.now\(\)/);
  assert.match(referenceApp, /continue: "#continueSection"/);
  assert.match(referenceApp, /\["#continueSection", "continue"\]/);
});

test("Lanjutkan Menonton: crossfade section dipatuhi prefers-reduced-motion", () => {
  assert.match(referenceApp, /function setupSectionCrossfade/);
  assert.match(referenceApp, /prefers-reduced-motion: reduce/);
  assert.match(referenceApp, /is-scroll-dim/);
  assert.match(continueCss, /\.canvas>section\.is-scroll-dim\{opacity:\.34\}/);
});

test("Lanjutkan Menonton: CSS rail dan kartu punya state yang dibutuhkan", () => {
  assert.match(continueCss, /\.cw-rail\{/);
  assert.match(continueCss, /scroll-snap-type:x proximity/);
  assert.match(continueCss, /\.cw-card\.is-previewing \.cw-preview\{opacity:1/);
  assert.match(continueCss, /\.cw-skel\{/);
  assert.match(continueCss, /@media \(max-width:767px\)/);
  assert.doesNotMatch(continueCss, /\.cw-preview\{[^}]*filter:/);
});

test("Lanjutkan Menonton: pratinjau hover dibatasi satu iframe dan selalu dibongkar", () => {
  /* Status pratinjau per-kartu (dataset), bukan satu variabel global:
     kalau global, rail yang re-render membuat iframe yatim dan menumpuk. */
  assert.doesNotMatch(referenceApp, /previewCard/);
  assert.match(referenceApp, /card\.dataset\.cwBusy/);
  assert.match(referenceApp, /async function startPreview[\s\S]{0,400}?clearCwPreviews\(\);/);
  assert.match(referenceApp, /function clearCwPreviews[\s\S]{0,700}?\$\$\("\.cw-preview", card\)/);
});

test("Lanjutkan Menonton: detail di pengambilan bertahap, bukan semua sekaligus", () => {
  assert.match(referenceApp, /const CW_DETAIL_CONCURRENCY = 3/);
  assert.match(referenceApp, /function cwPool/);
  assert.match(referenceApp, /await cwPool\(/);
});

test("See Detail: tombol Reset progress ada dan terkonfirmasi sebelum berjalan", () => {
  assert.match(referenceApp, /data-detail-reset/);
  assert.match(referenceApp, /function resetProgress/);
  /* Reset harus lewat konfirmasi, tidak langsung menghapus. */
  assert.match(referenceApp, /openConfirm\("Reset progress\?"/);
  assert.match(referenceApp, /\(\) => resetProgress\(a\.slug\)/);
  /* Tombol nonaktif kalau belum ada apa pun untuk di-reset. */
  assert.match(referenceApp, /data-detail-reset \$\{item && \(item\.watchedEpisodes\?\.length \|\| item\.progress\)/);
  assert.match(morphCss, /\.reset-btn/);
});

test("Progress episode hanya ditandai setelah benar-benar ditonton", () => {
  /*stream nyata: episode dicentang setelah 10 menit tonton, bukan begitu iframe dimuat. */
  assert.match(referenceApp, /const WATCHED_SECONDS = 600/);
  assert.match(referenceApp, /function startWatchClock/);
  assert.match(referenceApp, /function stopWatchClock/);
  assert.match(referenceApp, /function commitWatchClock/);
  /* Tab tersembunyi tidak boleh dihitung sebagai menonton. */
  assert.match(referenceApp, /document\.visibilityState !== "visible"/);
  /* playEpisode TIDAK lagi menandai langsung saat dimuat. */
  assert.doesNotMatch(referenceApp, /if \(shouldMark\) markWatched\(number\)/);
  assert.match(referenceApp, /startWatchClock\(number\); renderDetail\(\)/);
  /* Semua jalur (modal + PiP) memakai jam yang sama. */
  assert.equal((referenceApp.match(/markWatched\(/g) || []).length, 2);
  /* Jam berhenti saat modal ditutup, dan reset juga menghentikannya. */
  assert.match(referenceApp, /function closeWatch\(\) \{[\s\S]{0,200}?stopWatchClock\(\);/);
  assert.match(referenceApp, /function resetProgress\(slug\) \{[\s\S]{0,120}?stopWatchClock\(\);/);
});

test("Reset progress mengosongkan episode dan memulai ulang dari Episode 1", () => {
  assert.match(referenceApp, /function resetProgress[\s\S]{0,700}?item\.watchedEpisodes = \[\]/);
  assert.match(referenceApp, /function resetProgress[\s\S]{0,700}?item\.progress = 0/);
  assert.match(referenceApp, /function resetProgress[\s\S]{0,700}?delete item\.lastWatchedAt/);
  /* Item tetap ada di Local Storage, hanya progress-nya yang diulang. */
  assert.match(referenceApp, /function resetProgress[\s\S]{0,700}?renderContinue\(\)/);
});

test("Centang episode diperbarui tanpa mereset player yang sedang berjalan", () => {
  /* renderDetail() mengosongkan #playerBox, jadi sinkron centang harus
     menyentuhnya secara langsung. */
  assert.match(referenceApp, /function syncWatchedMarks/);
  assert.doesNotMatch(referenceApp, /function syncWatchedMarks[\s\S]{0,800}?renderDetail\(\)/);
  assert.match(referenceApp, /markWatched[\s\S]{0,1400}?syncWatchedMarks\(\);/);
});

test("Crossfade section tidak pernah meninggalkan section tak terlihat", () => {
  /* Transisi yang kalah harus berhenti menyentuh state, dan pembersihannya
     harus mengembalikan SEMUA section — bukan cuma daftar saat transisi mulai.
     Kalau tidak, section yang kebetulan jadi target klik berikutnya akan
     tersangkut is-crossfading (opacity 0) selamanya. */
  assert.match(referenceApp, /let sectionTransitionToken = 0/);
  assert.match(referenceApp, /function clearSectionFx/);
  assert.match(referenceApp, /\$\$\("\.canvas>section"\)\.forEach\(\(section\) => \{[\s\S]{0,400}?classList\.remove\("is-crossfading", "section-in"\)/);
  /* Target dibersihkan sebelum transisi baru dimulai. */
  assert.match(referenceApp, /function scrollToSection[\s\S]{0,2200}?target\.classList\.remove\("is-crossfading", "section-in"\)/);
  /* Penjaga token + pengaman berbasis waktu. */
  assert.match(referenceApp, /if \(token !== sectionTransitionToken\) return;/);
  assert.match(referenceApp, /setTimeout\(\(\) => \{ if \(token === sectionTransitionToken\) clearSectionFx\(\); \}, 900\)/);
  /* Animation yang tumpang tindih harus saling menggantikan, bukan saling menimpa. */
  assert.match(referenceApp, /composition: "replace"/);
});

test("Search main jadi pill ringkas, bukan melar mengisi header", () => {
  /* Lebar tetap clamp + flex-grow 0: input tidak lagi mendorong All Genre /
     Tipe / Status ke ujung header. */
  assert.match(morphCss, /\.search-zone\{position:relative;flex:0 1 auto;min-width:0/);
  assert.match(morphCss, /flex:0 1 auto;width:clamp\(190px,22vw,320px\);max-width:none/);
  assert.match(morphCss, /\.search-zone \.search-wrap\{[\s\S]{0,160}?background:var\(--bg-2\)/);
  /* Hint "Cari sesuai pilihan" harus tetap terbaca walau kotaknya menyempit. */
  assert.match(morphCss, /\.search-hint\{[\s\S]{0,160}?min-width:min\(420px,72vw\)/);
  /* Shine lama digantikan motion.css, tidak boleh ada dua implementasi. */
  assert.doesNotMatch(morphCss, /btn-shine/);
  assert.doesNotMatch(referenceApp, /btn-shine/);
});

test("Load New Update memakai wave physics loader + fluid skeleton", () => {
  /* Status loading eksplisit: tanpa ini section langsung menampilkan
     "Belum ada update" padahal API masih berjalan. */
  assert.match(referenceApp, /updateLoading: true/);
  assert.match(referenceApp, /function renderUpdates\(\) \{[\s\S]{0,260}?if \(state\.updateLoading\) \{/);
  assert.match(referenceApp, /Memuat update terbaru…/);
  /* Fisika dihitung sekali jadi keyframe, diputar WAAPI — bukan rAF yang
     bisa macet saat tab tak terlihat. */
  assert.match(referenceApp, /function buildWavePhysics\(\)/);
  assert.match(referenceApp, /const wavePhysics = buildWavePhysics\(\)/);
  assert.match(referenceApp, /function startWavePhysics[\s\S]{0,900}?\.animate\(\{/);
  assert.doesNotMatch(referenceApp, /requestAnimationFrame[\s\S]{0,80}?startWavePhysics/);
  /* Fluid skeleton dipakai untuk placeholder kartu, bukan shimmer lama. */
  assert.match(referenceApp, /class="fluid-skel update-skel-card"/);
  assert.match(referenceApp, /networkMonitor\.start\(\)/);
  assert.match(motionCss, /\.fluid-skel\{position:relative;overflow:hidden/);
  assert.match(motionCss, /@keyframes fluidSweep\{from\{transform:translateX\(-100%\)\}to\{transform:translateX\(200%\)\}\}/);
  assert.match(motionCss, /\.wave-loader\{grid-column:1 \/ -1/);
  /* Loader tetap punya bentuk diam saat reduced motion / tier rendah. */
  assert.match(referenceApp, /style="transform:scaleY\(\$\{rest\.toFixed\(3\)\}\)"/);
  assert.match(motionCss, /prefers-reduced-motion: reduce[\s\S]{0,400}?\.wave-bar[\s\S]{0,200}?\.wave-ball\{animation:none !important\}/);
});

test("Tombol +: cross-spinner dulu, baru getar + shine, baru pecah", () => {
  /* Anime hanya masuk ke storage lewat commit, dan itu dipanggil setelah
     animasi selesai — bukan sebelum. */
  assert.match(referenceApp, /function playAddSequence\(button, commit\)/);
  assert.match(referenceApp, /function addStorage\(id, button\) \{[\s\S]{0,240}?playAddSequence\(button, \(\) => commitAddStorage\(id\)\)/);
  assert.match(referenceApp, /spinner\.className = "cross-spinner is-on"/);
  assert.match(referenceApp, /button\.classList\.add\("btn-add-shake"\)/);
  assert.match(referenceApp, /button\.classList\.add\("btn-add-burst"\)/);
  assert.match(referenceApp, /layer = addFxBurst\(button\)/);
  /* Partikel shine dibuat sebagai radial spark + sapuan cahaya. */
  assert.match(referenceApp, /const ADD_FX_SPARKS = 14/);
  assert.match(referenceApp, /spark\.className = index % 2 \? "add-fx-spark gold" : "add-fx-spark"/);
  assert.match(motionCss, /\.add-fx-spark\{\s*position:absolute;width:5px;height:5px/);
  assert.match(motionCss, /@keyframes addSpark\{[\s\S]{0,260}?var\(--dx\)\),calc\(-50% \+ var\(--dy\)\)\)/);
  assert.match(motionCss, /\.add-fx-sweep\{[\s\S]{0,160}?skewX\(-20deg\)/);
  /* Tombol sumber ikut meneruskan node-nya ke urutan animasi. */
  assert.match(referenceApp, /addStorage\(add\.dataset\.id, add\)/);
  assert.match(referenceApp, /addStorage\(a\.slug, event\.currentTarget\)/);
  /* Reduced motion / tier rendah: commit langsung, tanpa timer. */
  assert.match(referenceApp, /if \(!button \|\| reduced \|\| document\.documentElement\.dataset\.performanceTier === "low"\) \{ commit\(\); return; \}/);
  /* Durasi di CSS harus sama dengan konstanta timeline di JS. */
  assert.match(motionCss, /\.btn-add-shake\{animation:addShake \.28s/);
  assert.match(motionCss, /\.btn-add-burst\{animation:addBurst \.3s/);
});

test("Badge ikon jaringan ada di header dan detecting lambat/offline", () => {
  assert.match(indexHtml, /class="net-pill" id="netStatus"/);
  assert.match(indexHtml, /<symbol id="i-wifi"/);
  assert.match(indexHtml, /<symbol id="i-wifi-off"/);
  assert.match(referenceApp, /createNetworkMonitor/);
  assert.match(referenceApp, /mountNetworkBadge\(\{ monitor: networkMonitor \}\)/);
  /* Badge harus berada di dalam .header-right, bukan sekadar ada di file. */
  assert.match(indexHtml, /<div class="header-right">\s*<div class="net-pill" id="netStatus"/);
  /* Latensi API nyata dilaporkan ke monitor, bukan hanya effectiveType. */
  assert.match(referenceApp, /async function timed\(promise\) \{[\s\S]{0,220}?networkMonitor\.setLatency\(performance\.now\(\) - started\)/);
  assert.match(referenceApp, /timed\(api\.daily\(\)\)/);
  assert.match(motionCss, /\.net-pill\[data-net="slow"\]\{color:var\(--gold-2\)/);
  assert.match(motionCss, /\.net-pill\[data-net="offline"\]\{color:#f87171/);
});

test("Delete Data mengembalikan profil ke awal, bukan hanya koleksi", () => {
  assert.match(referenceApp, /function deleteAllLocal/);
  assert.match(referenceApp, /const DEFAULT_PREFS = \{/);
  /* prefs harus diset ulang, bukan dibiarkan nempel. */
  assert.match(referenceApp, /function deleteAllLocal[\s\S]{0,700}?prefs = \{ \.\.\.DEFAULT_PREFS \}/);
  assert.match(referenceApp, /function deleteAllLocal[\s\S]{0,700}?localStorage\.removeItem\(PREFS_KEY\)/);
  /* Tema ikut kembali ke bawaan dan popup profil ditutup. */
  assert.match(referenceApp, /function deleteAllLocal[\s\S]{0,900}?applyTheme\(prefs\.theme\)/);
  assert.match(referenceApp, /function deleteAllLocal[\s\S]{0,900}?\$\("#profilePopup"\)\.hidden = true/);
  /* Kedua tombol memakai fungsi yang sama. */
  assert.match(referenceApp, /\$\("#deleteDataBtn"\), 1500, \(\) => openConfirm[\s\S]{0,300}?deleteAllLocal\(\)/);
  assert.match(referenceApp, /\$\("#ppDeleteBtn"\), 1500, \(\) => openConfirm[\s\S]{0,300}?deleteAllLocal\(\)/);
  /* Pesan konfirmasi harus jujur menyebut nama & foto profil. */
  assert.match(referenceApp, /nama, foto profil, dan setelan lokal/);
  /* Tidak boleh ada lagi dua handler delete yang menyalin logika. */
  assert.doesNotMatch(referenceApp, /state\.storageItems = \[\]; state\.selectedStorageItems\.clear\(\); saveState\(\); renderAll\(\)/);
});

/* ------------------------------------------------------------------
   Regression: tombol Favorite dan badge emas hampir tidak terbaca di
   light mode. `--gold` berubah jadi #D97706 di light mode, sementara
   `.react-btn.is-fav` masih menulis #FFD700 langsung — hasilnya 1,26:1
   di atas #F1F3F5. Sekarang teks emas memakai token --gold-ink yang
   gelap di light mode, dan ikon gradient diganti solid di light mode.
   Badge yang menempel di latar gelap (fav-mark) justru harus tetap
   terang, jadi memakai --gold-on-dark.
   ------------------------------------------------------------------ */
test("warna emas sebagai teks selalu punya token yang aman per tema", () => {
  const tokensCss = fs.readFileSync(path.join(__dirname, "../public/css/tokens.css"), "utf8");
  const layoutCss = fs.readFileSync(path.join(__dirname, "../public/css/layout.css"), "utf8");

  /* --gold-ink gelap di light mode, terang di dark mode. Yang diuji adalah
     SIFATNYA (terang vs gelap), bukan hex tertentu — test yang mengunci hex
     hanya gagal saat warnanya diubah, bukan saat warnanya jadi tidak terbaca. */
  const lightGoldInk = tokensCss.match(/\[data-theme="light"\]\s*\{([^}]*)\}/) && tokensCss.match(/\[data-theme="light"\]\s*\{([^}]*)\}/)[1].match(/--gold-ink:(#[0-9A-Fa-f]{6})/);
  const darkGoldInk = (tokensCss.split('[data-theme="light"]')[0]).match(/--gold-ink:(#[0-9A-Fa-f]{6})/);
  assert.ok(lightGoldInk && darkGoldInk, "kedua tema harus punya --gold-ink");
  const lum = (hex) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  assert.ok(lum(lightGoldInk[1]) < lum(darkGoldInk[1]), "--gold-ink light harus lebih gelap dari dark");
  assert.notEqual(lightGoldInk[1].toUpperCase(), "#FFD700", "--gold-ink light tidak boleh #FFD700 (1,26:1)");
  /* Badge di atas latar gelap harus tetap terang di kedua tema. */
  assert.match(tokensCss, /--gold-on-dark:#FFD700/);

  /* Teks emas TIDAK boleh lagi menulis hex mentah. */
  assert.match(morphCss, /\.react-btn\.is-fav\{[^}]*color:var\(--gold-ink\)/);
  assert.doesNotMatch(morphCss, /\.react-btn\.is-fav\{[^}]*color:#FFD700/);
  /* Gradien #FFD700->#FF6FA5 juga harus dilepas di light mode. */
  assert.match(morphCss, /\[data-theme="light"\]\s+\.react-btn\.is-fav \.ico\{[^}]*fill:var\(--gold-ink\)/);

  assert.match(layoutCss, /\.nav-badge\{[^}]*color:var\(--gold-ink\)/);
  assert.match(componentsCss, /\.fav-mark\{[^}]*color:var\(--gold-on-dark\)/);
});

test("teks merah pada tombol Dislike memakai token per tema, bukan hex mentah", () => {
  const tokensCss = fs.readFileSync(path.join(__dirname, "../public/css/tokens.css"), "utf8");
  /* --danger tidak bisa dipakai: di dark mode #8B0000 di atas latar merah
     translucent hanya 1,76:1. Karena itu ada --danger-ink. */
  assert.match(tokensCss, /--danger-ink:#/);
  const lightRed = tokensCss.match(/\[data-theme="light"\]\s*\{([^}]*)\}/)[1].match(/--danger-ink:(#[0-9A-Fa-f]{6})/);
  const darkRed = tokensCss.split('[data-theme="light"]')[0].match(/--danger-ink:(#[0-9A-Fa-f]{6})/);
  assert.ok(lightRed && darkRed, "kedua tema harus punya --danger-ink");
  const lum = (hex) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  assert.ok(lum(darkRed[1]) > lum(lightRed[1]), "--danger-ink dark harus lebih terang dari light");
  assert.match(morphCss, /\.react-btn\.is-dislike\{[^}]*color:var\(--danger-ink\)/);
  assert.match(morphCss, /\.react-btn\.is-dislike \.ico\{[^}]*fill:var\(--danger-ink\)/);
  /* Hex merah mentah yang lama tidak boleh kembali. */
  assert.doesNotMatch(morphCss, /#C41E1E/);
});

test("CSS yang diubah ikut naikkan cache-buster supaya browser tidak memakai versi lama", () => {
  for (const file of ["tokens.css", "layout.css", "components.css", "morph.css"]) {
    assert.ok(indexHtml.includes(`/css/${file}?v=`), `${file} wajib punya cache-buster ?v=`);
  }
});
