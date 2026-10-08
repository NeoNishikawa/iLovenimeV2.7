const test = require("node:test");
const assert = require("node:assert/strict");
const { slices, uniqueBySlug, normalizeEpisodes, todayKey, decodeMirror, parseMirrorOptions, parseAnimeDetail } = require("../server");

test("catalog results are split into slides of no more than twenty titles", () => {
  const data = Array.from({ length: 43 }, (_, index) => ({ slug: `anime-${index}` }));
  const result = slices(data);
  assert.equal(result.length, 3);
  assert.equal(result[0].length, 20);
  assert.equal(result[1].length, 20);
  assert.equal(result[2].length, 3);
});

test("duplicate YAOI result slugs are removed while order is preserved", () => {
  const result = uniqueBySlug([{ slug: "one" }, { slug: "two" }, { slug: "one" }, { slug: "three" }]);
  assert.deepEqual(result.map((item) => item.slug), ["one", "two", "three"]);
});

test("episodes are sorted by their source number instead of source order", () => {
  const result = normalizeEpisodes([
    { episode: "Episode 25", slug: "anime-episode-25" },
    { episode: "Episode 12", slug: "anime-episode-12" },
    { episode: "Episode 1", slug: "anime-episode-1" },
  ]);
  assert.deepEqual(result.map((episode) => [episode.number, episode.title]), [
    [1, "Episode 1"],
    [12, "Episode 12"],
    [25, "Episode 25"],
  ]);
});

test("23 August 2026 resolves to the Sunday schedule in the user timezone", () => {
  assert.equal(todayKey(new Date("2026-08-23T00:00:00Z")), "minggu");
});

test("base64 mirror markup produces an iframe URL", () => {
  const encoded = Buffer.from('<iframe src="https://mirror.example/watch"></iframe>').toString("base64");
  assert.equal(decodeMirror(encoded), "https://mirror.example/watch");
});

test("mirror parser keeps direct data-url options", () => {
  const html = `<select class="mirror"><option value="https://mirror.example/one">Mirror 1</option><option data-url="https://mirror.example/two">Mirror 2</option></select>`;
  assert.deepEqual(parseMirrorOptions(html).map((item) => item.url), ["https://mirror.example/one", "https://mirror.example/two"]);
});

test("detail parser returns a title and episode slug", () => {
  const html = `<div class="infox"><h1>Tensei shitara Slime Datta Ken</h1><div class="alter">That Time I Got Reincarnated as a Slime</div></div><div id="daftarepisode"><ul><li><a href="/nonton-tensei-shitara-slime-datta-ken-episode-1/">Episode 1</a></li></ul></div>`;
  const detail = parseAnimeDetail(html, "tensei-shitara-slime-datta-ken");
  assert.equal(detail.title, "Tensei shitara Slime Datta Ken");
  assert.equal(detail.episodes[0].slug, "nonton-tensei-shitara-slime-datta-ken-episode-1");
});

test("detail parser mengenali rating di beberapa posisi markup", () => {
  const primary = parseAnimeDetail(`<div class="infox"><h1>Test A</h1></div><div class="rating"><strong>Rating: 8.2</strong></div><div id="daftarepisode"></div>`, "test-a");
  assert.equal(primary.rating, 8.2);
  const itemprop = parseAnimeDetail(`<div class="infox"><h1>Test B</h1><span itemprop="ratingValue" content="7.9">7.9</span></div><div id="daftarepisode"></div>`, "test-b");
  assert.equal(itemprop.rating, 7.9);
  const comma = parseAnimeDetail(`<div class="infox"><h1>Test C</h1><div class="spe"><span>Rating: 8,5</span></div></div><div id="daftarepisode"></div>`, "test-c");
  assert.equal(comma.rating, 8.5);
  const missing = parseAnimeDetail(`<div class="infox"><h1>Test D</h1></div><div id="daftarepisode"></div>`, "test-d");
  assert.equal(missing.rating, 0);
});


test("blocked source HTML is detected before it becomes an empty catalog", () => {
  const { isBlockedSourceHtml } = require("../server");
  assert.equal(isBlockedSourceHtml("<title>Just a moment...</title><div>Checking your browser</div>"), true);
  assert.equal(isBlockedSourceHtml("<main><div class=bs><div class=tt>Anime</div></div></main>"), false);
});

test("daily fallback snapshot is available when live schedule is unavailable", () => {
  const { readFallbackDaily } = require("../server");
  const fallback = readFallbackDaily();
  assert.ok(fallback?.data?.length > 0);
  assert.equal(fallback.provider, "fallback");
  assert.equal(fallback.stale, true);
});

test("ZIP cache coalesces concurrent calls and preserves stale data", async () => {
  const { cached, isStale } = require("../server");
  let calls = 0;
  const value = await Promise.all([
    cached("zip:coalesce", async () => { calls += 1; return ["ok"]; }, 1000),
    cached("zip:coalesce", async () => { calls += 1; return ["ok"]; }, 1000),
  ]);
  assert.equal(calls, 1);
  assert.deepEqual(value[0], ["ok"]);
  await cached("zip:stale", async () => ["old"], 0, true);
  const stale = await cached("zip:stale", async () => { throw new Error("403"); }, 0, true);
  assert.deepEqual(stale, ["old"]);
  assert.equal(isStale("zip:stale"), true);
});


test("snapshot detail exists for a known daily title during source block", () => {
  const { fallbackDetailFromDaily } = require("../server");
  const detail = fallbackDetailFromDaily("black-torch");
  assert.equal(detail.source, "local-snapshot");
  assert.equal(detail.title, "Black Torch");
  assert.deepEqual(detail.episodes, []);
});

/* ---------- Rate limit: token bucket ---------- */
const { createTokenBucket } = require("../server");

test("token bucket hanya menolak setelah burst habis, bukan di detik pertama", () => {
  const bucket = createTokenBucket({ capacity: 3, refillMs: 1000 });
  assert.equal(bucket.take("ip").allowed, true);
  assert.equal(bucket.take("ip").allowed, true);
  assert.equal(bucket.take("ip").allowed, true);
  const denied = bucket.take("ip");
  assert.equal(denied.allowed, false);
  assert.equal(denied.remaining, 0);
  assert.ok(denied.retryAfterMs > 0 && denied.retryAfterMs <= 1000, "retryAfter harus sebentar dan masuk akal");
});

test("token bucket mengisi ulang perlahan sesuai refillMs, bukan satu token sekaligus", () => {
  let now = 1_000_000;
  const bucket = createTokenBucket({ capacity: 2, refillMs: 1000, clock: () => now });
  bucket.take("ip");
  bucket.take("ip");
  assert.equal(bucket.take("ip").allowed, false);
  now += 400;
  assert.equal(bucket.take("ip").allowed, false, "400ms dari 1000ms refill belum cukup untuk satu token penuh");
  now += 700;
  assert.equal(bucket.take("ip").allowed, true, "setelah 1100ms refill, satu token tersedia");
});

test("retryAfterMs yang hilang tidak menggantung dan tidak negatif", () => {
  const bucket = createTokenBucket({ capacity: 1, refillMs: 60_000 });
  bucket.take("ip");
  const denied = bucket.take("ip");
  assert.equal(denied.allowed, false);
  assert.ok(Number.isFinite(denied.retryAfterMs));
  assert.ok(denied.retryAfterMs > 0);
});

test("tiap IP punya bucket terpisah dan peek tidak mengubah kuota", () => {
  const bucket = createTokenBucket({ capacity: 1, refillMs: 60_000 });
  assert.equal(bucket.take("ip-a").allowed, true);
  assert.equal(bucket.take("ip-a").allowed, false);
  assert.equal(bucket.take("ip-b").allowed, true, "IP lain tidak boleh ikut terpengaruh");
  assert.equal(bucket.peek("ip-a"), 0);
  assert.equal(bucket.peek("ip-a"), 0, "peek tidak boleh mengambil token");
});

test("bucket idle dibersihkan supaya map tidak tumbuh tanpa batas", () => {
  let now = 5_000_000;
  const bucket = createTokenBucket({ capacity: 4, refillMs: 1000, maxKeys: 10, clock: () => now });
  for (let index = 0; index < 40; index += 1) bucket.take(`ip-${index}`);
  now += 120_000;
  bucket.take("ip-triggers-sweep");
  assert.ok(bucket.size <= 10, `sisa bucket harus dibatasi maxKeys, dapat ${bucket.size}`);
});

test("hasil kosong di-cache singkat supaya tidak menembak upstream berulang", async () => {
  /* "Tidak ditemukan" itu jawaban valid. Tanpa cache, mengetik ulang query
     yang memang kosong menembak upstream tiap kali dan memotong kuota. */
  const { cached } = require("../server");
  let calls = 0;
  const task = async () => { calls += 1; return { data: [], provider: "none" }; };
  const first = cached("zip:empty-search", task, 75_000);
  assert.deepEqual((await first).data, []);
  const second = await cached("zip:empty-search", task, 75_000);
  assert.equal(calls, 1, "query kosong kedua harus dilayani cache, bukan fetch baru");
  assert.deepEqual(second.data, []);
});

test("hasil kosong memakai TTL pendek dan ttl eksplisit tetap dihormati", async () => {
  const { cached } = require("../server");
  let calls = 0;
  const task = async () => { calls += 1; return { data: [] }; };
  /* ttl 0 = tidak ada cache sama sekali, harus fetch tiap panggilan. */
  await cached("zip:empty-zero-ttl", task, 0);
  await cached("zip:empty-zero-ttl", task, 0);
  assert.equal(calls, 2, "ttl 0 berarti selalu fetch ulang");
  /* ttl panjang tetap memotong jadi TTL pendek untuk hasil kosong, dan
     panggilan kedua dalam jendela itu dilayani cache. */
  calls = 0;
  await cached("zip:empty-long-ttl", task, 60_000);
  await cached("zip:empty-long-ttl", task, 60_000);
  assert.equal(calls, 1, "hasil kosong tetap di-cache meski ttl normally panjang");
});

test("laju jangka panjang search = 30 token per menit setelah burst awal", () => {
  /* 12 burst lalu refill 2000ms = 30 token/menit secara berkelanjutan.
     Burst sengaja ada: satu tekan cari + beberapa filter genre = 4 request
     sekaligus, dan itu sah, bukan serangan. */
  let now = 10_000_000;
  const bucket = createTokenBucket({ capacity: 12, refillMs: 2000, clock: () => now });
  /* Habiskan burst di detik pertama, lalu ukur menit berikutnya. */
  for (let index = 0; index < 12; index += 1) { now += 50; assert.equal(bucket.take("ip").allowed, true); }
  let allowed = 0;
  for (let second = 0; second < 60; second += 1) {
    now += 1000;
    if (bucket.take("ip").allowed) allowed += 1;
  }
  assert.ok(allowed >= 28 && allowed <= 31, `laju berkelanjutan harus ~30/menit, dapat ${allowed}`);
});

test("token bucket membagi token secara merata, bukan melepas semuanya sekaligus", () => {
  /* Ini yang tidak bisa dilakukan array timestamp lama: bucket tahu persis
     berapa milidetik lagi token berikutnya siap, jadi limiter bisa mengirim
     Retry-After yang benar dan klien tidak menebak. */
  let now = 20_000_000;
  const bucket = createTokenBucket({ capacity: 2, refillMs: 4000, clock: () => now });
  bucket.take("ip");
  bucket.take("ip");
  const first = bucket.take("ip");
  assert.equal(first.allowed, false);
  assert.ok(Math.abs(first.retryAfterMs - 4000) <= 1, `retryAfter harus ~4000ms, dapat ${first.retryAfterMs}`);
  now += 2000;
  const halfway = bucket.take("ip");
  assert.equal(halfway.allowed, false, "setengah refill = setengah token, belum cukup");
  assert.ok(Math.abs(halfway.retryAfterMs - 2000) <= 1, `retryAfter harus sekitar 2000ms, dapat ${halfway.retryAfterMs}`);
  now += 2000;
  assert.equal(bucket.take("ip").allowed, true, "refill penuh = satu token siap");
});

test("meneruskan 30 request di detik yang sama dibatasi capacity, tidak meledak", () => {
  let now = 30_000_000;
  const bucket = createTokenBucket({ capacity: 12, refillMs: 2000, clock: () => now });
  let allowed = 0;
  for (let index = 0; index < 30; index += 1) if (bucket.take("ip").allowed) allowed += 1;
  assert.equal(allowed, 12, "hanya capacity yang boleh lolos pada waktu yang sama persis");
});

/* ------------------------------------------------------------------
   Regression pra-publish: route /api/* yang tidak dikenal dulu jatuh
   ke catch-all "*" sehingga membalas index.html dengan status 200.
   Klien api.js kemudian gagal saat JSON.parse dan melaporkan
   "respons tidak valid (HTTP 200)" untuk route yang memang tidak ada,
   sementara uptime monitor melihat 200 di mana-mana. Server harus
   membalas JSON 404 yang bisa dibaca mesin, sementara halaman SPA
   di luar /api tetap HTML 200.
   ------------------------------------------------------------------ */
test("route /api yang tidak dikenal membalas JSON 404, bukan HTML SPA", async () => {
  const http = require("node:http");
  const { app } = require("../server");
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    const unknown = await fetch(`http://127.0.0.1:${port}/api/does-not-exist`);
    assert.equal(unknown.status, 404, "route API asing harus 404, bukan 200");
    assert.match(unknown.headers.get("content-type") || "", /application\/json/);
    const body = await unknown.json();
    assert.equal(typeof body.error, "string");
    assert.match(body.error, /tidak ditemukan/i);

    const posted = await fetch(`http://127.0.0.1:${port}/api/anything`, { method: "POST", body: "{}" });
    assert.equal(posted.status, 404, "method lain di /api/* juga harus 404");

    const spa = await fetch(`http://127.0.0.1:${port}/watch/apa-saja`);
    assert.equal(spa.status, 200, "deep link di luar /api tetap dilayani SPA");
    assert.match(spa.headers.get("content-type") || "", /text\/html/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

/* ------------------------------------------------------------------
   Regression pra-publish: /api/health dippedanggil siapa pun, jadi
   versi publik hanya boleh membalas status. Angka internal (jumlah
   cache, IP yang dilacak, error upstream, konfigurasi rate limit)
   hanya untuk monitoring lokal lewat HEALTH_DETAIL=1.
   ------------------------------------------------------------------ */
test("health publik tidak membocorkan detail internal, mode detail tetap utuh", async () => {
  const http = require("node:http");
  const serverPath = require.resolve("../server");
  const settingsPath = require.resolve("../settings");
  const savedServer = require.cache[serverPath];
  const savedSettings = require.cache[settingsPath];
  const savedFlag = process.env.HEALTH_DETAIL;
  /* Muat ulang server.js supaya instance baru membaca env yang baru. */
  const loadApp = () => {
    delete require.cache[serverPath];
    delete require.cache[settingsPath];
    return require("../server").app;
  };
  const call = async (app) => {
    const listener = http.createServer(app);
    await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
    try {
      const response = await fetch(`http://127.0.0.1:${listener.address().port}/api/health`);
      return { status: response.status, body: await response.json() };
    } finally {
      await new Promise((resolve) => listener.close(resolve));
    }
  };
  try {
    delete process.env.HEALTH_DETAIL;
    const publik = await call(loadApp());
    assert.equal(publik.status, 200);
    assert.deepEqual(Object.keys(publik.body).sort(), ["ok", "sourceStatus"], "publik hanya boleh membalas ok dan sourceStatus");
    for (const bocor of ["source", "sources", "sourceLastError", "cacheEntries", "rateLimit", "trackedClients", "upstreamQueued"]) {
      assert.equal(publik.body[bocor], undefined, `${bocor} tidak boleh muncul di health publik`);
    }

    process.env.HEALTH_DETAIL = "1";
    const detail = await call(loadApp());
    assert.equal(detail.status, 200);
    assert.ok(Array.isArray(detail.body.sources), "monitoring lokal tetap perlu daftar source");
    assert.ok(detail.body.rateLimit, "blok rate limit tetap dibutuhkan untuk tuning");
  } finally {
    if (savedFlag === undefined) delete process.env.HEALTH_DETAIL; else process.env.HEALTH_DETAIL = savedFlag;
    require.cache[serverPath] = savedServer;
    require.cache[settingsPath] = savedSettings;
  }
});

/* ------------------------------------------------------------------
   Regression pra-publish: path /page/1/ membalas 404 lalu path
   fallback /pencarian/ berhasil. 404 itu pola URL yang tidak ada,
   bukan sumber mati. Sebelumnya tetap menandai source "down" sehingga
   /api/health melaporkan outage padahal pencarian berjalan normal.
   ------------------------------------------------------------------ */
test("404 saat fallback path tidak dianggap source mati", () => {
  const { isSourceUnavailable } = require("../server");
  const notFound = Object.assign(new Error("Request failed with status code 404"), { response: { status: 404 } });
  const gone = Object.assign(new Error("animasu HTTP 410"), { response: { status: 410 } });
  const forbidden = Object.assign(new Error("animasu HTTP 403"), { response: { status: 403 } });
  const rateLimited = new Error("Request failed with status code 429");
  const serverError = new Error("Request failed with status code 503");
  const noStatus = new Error("ECONNRESET");

  assert.equal(isSourceUnavailable(notFound), false, "404 = pola URL tidak ada, bukan outage");
  assert.equal(isSourceUnavailable(gone), false, "410 juga bukan outage");
  assert.equal(isSourceUnavailable(forbidden), true, "403 = diblokir, harus dilaporkan");
  assert.equal(isSourceUnavailable(rateLimited), true, "429 harus dilaporkan");
  assert.equal(isSourceUnavailable(serverError), true, "5xx harus dilaporkan");
  assert.equal(isSourceUnavailable(noStatus), true, "koneksi putus harus dilaporkan");
});

/* ------------------------------------------------------------------
   Regression pra-publish: di belakang reverse proxy (Railway, Render,
   Nginx) semua koneksi masuk dari IP proxy. Tanpa trust proxy,
   clientKey() selalu sama sehingga kuota burst dibagi ke SELURUH
   pengunjung, bukan per orang. Bukti load test: 60 request dengan
   X-Forwarded-For berbeda tetap berbagi satu kuota (hanya ~12 yang
   lolos); setelah TRUST_PROXY=1, 20 IP berbeda = 20x200.
   Default sengaja mati supaya server yang dibuka langsung ke internet
   tidak bisa dilewati rate limit dengan memalsukan X-Forwarded-For.
   ------------------------------------------------------------------ */
test("trust proxy membuat IP berbeda punya kuota terpisah, default tetap mati", async () => {
  const serverPath = require.resolve("../server");
  const settingsPath = require.resolve("../settings");
  const savedServer = require.cache[serverPath];
  const savedSettings = require.cache[settingsPath];
  const savedFlag = process.env.TRUST_PROXY;
  const loadApp = () => {
    delete require.cache[serverPath];
    delete require.cache[settingsPath];
    return require("../server").app;
  };
  try {
    delete process.env.TRUST_PROXY;
    const off = loadApp();
    assert.equal(off.get("trust proxy"), false, "default harus mati agar header tidak bisa dipalsukan");

    process.env.TRUST_PROXY = "1";
    const on = loadApp();
    assert.equal(on.get("trust proxy"), true, "TRUST_PROXY=1 wajib mengaktifkan trust proxy");
  } finally {
    if (savedFlag === undefined) delete process.env.TRUST_PROXY; else process.env.TRUST_PROXY = savedFlag;
    require.cache[serverPath] = savedServer;
    require.cache[settingsPath] = savedSettings;
  }
});
