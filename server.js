const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");
const path = require("path");
const fs = require("fs");
const { ANIMASU_BASE_URL, SAMEHADAKU_BASE_URL, SUPPLEMENT_BELOW_EPISODES, PORT, REQUEST_TIMEOUT_MS, SEARCH_BUDGET_MS, DAILY_CACHE_MS, DETAIL_CACHE_MS, STREAM_CACHE_MS, MAX_UPSTREAM_CONCURRENCY, SEARCH_UPSTREAM_CONCURRENCY, UPSTREAM_MIN_INTERVAL_MS, SEARCH_UPSTREAM_MIN_INTERVAL_MS, SEARCH_RETRY_COUNT, SEARCH_RETRY_BACKOFF_MS, SOURCE_BLOCK_COOLDOWN_MS, MAINTENANCE, HEALTH_DETAIL, TRUST_PROXY, SEARCH_RATE_BURST, SEARCH_RATE_REFILL_MS, DETAIL_RATE_BURST, DETAIL_RATE_REFILL_MS, STREAM_RATE_BURST, STREAM_RATE_REFILL_MS, CONTENT_RATE_BURST, CONTENT_RATE_REFILL_MS, RATE_LIMIT_MAX_KEYS, UPSTREAM_QUEUE_LIMIT, UPSTREAM_QUEUE_RETRY_MS } = require("./settings");

process.env.ANIMASU_BASE_URL = ANIMASU_BASE_URL;
const { animasu } = require("yaoi");
axios.defaults.timeout = REQUEST_TIMEOUT_MS;

const app = express();
const memory = new Map();
const pending = new Map();
const staleKeys = new Set();
const CACHE_MS = 75_000;
const upstreamQueue = [];
let upstreamActive = 0;
const upstreamActiveByLane = new Map();
const upstreamLastStarted = new Map();
const upstreamLastStartedByLane = new Map();
const upstreamCooldownUntil = new Map();
let upstreamDrainTimer = null;
const MAX_CACHE_ENTRIES = Number(process.env.MAX_CACHE_ENTRIES) > 0 ? Number(process.env.MAX_CACHE_ENTRIES) : 64;
/* "Tidak ditemukan" adalah jawaban yang valid, bukan kegagalan. Tanpa ini,
   mengetik ulang query yang memang kosong menembak upstream lagi setiap kali
   dan memotong kuota untuk hasil yang sudah pasti sama. TTL-nya pendek
   supaya anime baru tetap muncul cepat. */
const EMPTY_CACHE_MS = 20_000;
const SLIDE_SIZE = 20;
const MAX_SEARCH_PAGES = Number(process.env.MAX_SEARCH_PAGES) > 0 ? Number(process.env.MAX_SEARCH_PAGES) : 20;
const MIN_SEARCH_LENGTH = 2;
const USER_TIME_ZONE = "Asia/Bangkok";
const DAY_KEYS = ["minggu", "senin", "selasa", "rabu", "kamis", "jumat", "sabtu"];
const TITLE_ALIASES_PATH = path.join(__dirname, "public", "data", "title-aliases.json");
const BUILTIN_TITLE_ALIASES = { "that time i got reincarnated as a slime": ["Tensei shitara Slime Datta Ken"] };
const ALIAS_MAX_CANDIDATES = 6;
const FALLBACK_DAILY_PATH = path.join(__dirname, "public", "data", "last-known-daily.json");

function storeCache(key, data) {
  memory.delete(key);
  memory.set(key, { data, timestamp: Date.now() });
  while (memory.size > MAX_CACHE_ENTRIES) memory.delete(memory.keys().next().value);
}

function isEmptyData(data) {
  return data === undefined || data === null || (Array.isArray(data) && data.length === 0) || (Array.isArray(data?.data) && data.data.length === 0);
}

function cached(key, task, ttl = CACHE_MS, staleOnError = false) {
  const previous = memory.get(key);
  const freshTtl = previous && isEmptyData(previous.data) ? Math.min(ttl, EMPTY_CACHE_MS) : ttl;
  if (previous && Date.now() - previous.timestamp < freshTtl) {
    staleKeys.delete(key);
    return Promise.resolve(previous.data);
  }
  if (pending.has(key)) return pending.get(key);
  const promise = Promise.resolve().then(task).then((data) => {
    storeCache(key, data);
    staleKeys.delete(key);
    if (!isEmptyData(data)) return data;
    if (staleOnError && previous) {
      staleKeys.add(key);
      return previous.data;
    }
    return data;
  }).catch((error) => {
    if (staleOnError && previous) {
      staleKeys.add(key);
      return previous.data;
    }
    throw error;
  }).finally(() => pending.delete(key));
  pending.set(key, promise);
  return promise;
}

function isStale(key) { return staleKeys.has(key); }

function readFallbackDaily() {
  try {
    const fallback = JSON.parse(fs.readFileSync(FALLBACK_DAILY_PATH, "utf8"));
    const data = Array.isArray(fallback.data) ? fallback.data : [];
    return { ...fallback, data, slides: slices(data), total: data.length, slideSize: SLIDE_SIZE, provider: "fallback", stale: true };
  } catch (_) { return null; }
}

function fallbackDetailFromDaily(slug) {
  const item = readFallbackDaily()?.data?.find((anime) => anime.slug === String(slug || ""));
  if (!item) return null;
  return {
    ...item,
    synonym: "",
    synopsis: "Detail live sedang tidak tersedia; metadata dasar ini berasal dari snapshot jadwal terakhir.",
    rating: 0,
    genres: [],
    status: item.status || "UNKNOWN",
    aired: "Unknown",
    duration: "Unknown",
    studio: "Unknown",
    season: "Unknown",
    trailer: "",
    updateAt: "",
    episodes: [],
    batches: [],
    source: "local-snapshot",
  };
}

/* Temuan Fuzz Putaran 2 (8 Oktober): parser tidak null-safe/type-safe —
   45 throw jika struktur upstream berubah, walau jalur HTTP hari ini masih
   aman. Dibereskan di sini, bukan di tujuan: kebijakannya "parser menerima
   TIDAK APA PUN dan menjawab nilai kosong yang sah", bukan memaksa semua
   pemanggil. Objek tanpa primitive ({toString:null}) melempar dari String(),
   jadi primitif diteruskan, dan sisanya diganti string kosong. */
function teksAman(value) {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

/* cheerio melempar "Cannot create property 'prev'" kalau diberi input
   bukan-string yang truthy (angka, objek, Buffer). Semua parser membaca
   dari sumber upstream; satu payload baru saja tidak boleh membuat 500. */
function htmlAman(html) {
  return typeof html === "string" ? html : "";
}

function normalizeSearchText(value) {
  return teksAman(value).normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/* Map bantu dibatasi agar query unik jangka panjang tidak menumbuhkan
   memori tanpa batas (temuan fuzz 6 Oktober 2026). Map mempertahankan
   urutan sisip, jadi cukup buang kunci tertua (FIFO) begitu lewat limit. */
const AUX_MAP_LIMIT = 256;
function capMap(map) { while (map.size > AUX_MAP_LIMIT) map.delete(map.keys().next().value); }
const aliasMemory = new Map();
const aliasPending = new Map();
async function fetchEnglishAliases(search) {
  const normalized = normalizeSearchText(search);
  if (normalized.length < 3) return [];
  const aliases = (BUILTIN_TITLE_ALIASES[normalized] || []).filter((item) => normalizeSearchText(item) !== normalized).slice(0, ALIAS_MAX_CANDIDATES);
  aliasMemory.set(normalized, { data: aliases, timestamp: Date.now() });
  capMap(aliasMemory);
  return aliases;
}

function splitAliases(value) {
  if (Array.isArray(value)) return value.flatMap((item) => splitAliases(item));
  return teksAman(value).split(/[|;\n,]+/).map((item) => item.replace(/^(synonym|alternative|english title|judul inggris)\s*[:：-]\s*/i, "").trim()).filter(Boolean);
}

let titleAliasIndex;
let titleAliasBySlug;
let titleAliasByTitle;
function readTitleAliases() {
  if (titleAliasIndex) return titleAliasIndex;
  try {
    const parsed = JSON.parse(fs.readFileSync(TITLE_ALIASES_PATH, "utf8"));
    titleAliasIndex = Array.isArray(parsed.data) ? parsed.data : [];
  } catch (_) { titleAliasIndex = []; }
  titleAliasBySlug = new Map(titleAliasIndex.filter((record) => record.slug).map((record) => [record.slug, record]));
  titleAliasByTitle = new Map(titleAliasIndex.filter((record) => record.title).map((record) => [normalizeSearchText(record.title), record]));
  return titleAliasIndex;
}

function findTitleAlias(item) {
  readTitleAliases();
  const itemSlug = String(item.slug || "");
  const normalizedTitle = normalizeSearchText(item.title);
  return titleAliasBySlug.get(itemSlug) || [...titleAliasBySlug.entries()].find(([slug]) => itemSlug.startsWith(`${slug}-`))?.[1] || titleAliasByTitle.get(normalizedTitle) || [...titleAliasByTitle.entries()].find(([title]) => normalizedTitle.startsWith(`${title} `))?.[1] || titleAliasIndex.find((record) => record.aliases?.some((alias) => normalizeSearchText(alias) === normalizedTitle));
}

function titleAliasRecord(item) {
  const aliases = [...new Set([item.title, item.englishTitle, ...splitAliases(item.aliases), ...splitAliases(item.synonym)].filter(Boolean))];
  const normalizedTitle = normalizeSearchText(item.title);
  const known = findTitleAlias(item);
  const mergedAliases = [...new Set([...aliases, ...(known?.aliases || [])])];
  const suffix = known?.title && item.title && normalizeSearchText(item.title).startsWith(normalizeSearchText(known.title)) ? String(item.title).slice(String(known.title).length).trim().replace(/^[:：-]\s*/, "") : "";
  const knownEnglish = known?.englishTitle ? `${known.englishTitle}${suffix ? ` ${suffix}` : ""}` : "";
  return { ...item, englishTitle: knownEnglish || item.englishTitle || mergedAliases.find((alias) => normalizeSearchText(alias) !== normalizedTitle && /^[\p{L}\p{N} ]+$/u.test(alias)) || "", aliases: mergedAliases };
}

function matchesTitle(item, query) {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) return true;
  const enriched = item.aliases && Object.prototype.hasOwnProperty.call(item, "englishTitle") ? item : titleAliasRecord(item);
  return [enriched.title, enriched.englishTitle, ...(enriched.aliases || [])].some((value) => normalizeSearchText(value).includes(normalizedQuery));
}

function uniqueBySlug(items) {
  if (!Array.isArray(items)) return [];
  const seen = new Set();
  /* Temuan fuzz Manas 8 Okt: elemen ber-Proxy yang throw saat get membuat
     item?.slug melempar; elemen macam itu dilewati, bukan menjatuhkan route. */
  return items.filter((item) => {
    try {
      return item?.slug && !seen.has(item.slug) && seen.add(item.slug);
    } catch {
      return false;
    }
  });
}

function episodeNumber(value, fallback) {
  const match = String(value || "").match(/(?:episode|eps?|ep)?\s*(\d+(?:\.\d+)?)/i);
  const number = match ? Number(match[1]) : NaN;
  return Number.isFinite(number) ? number : fallback;
}

function normalizeEpisodes(episodes = []) {
  /* null dan non-array membuat .map melempar; jawaban kosong yang aman
     supaya route detail tidak 500 massal saat struktur upstream berubah. */
  if (!Array.isArray(episodes)) return [];
  /* Temuan fuzz Manas 8 Okt: elemen ber-Proxy yang throw saat get membuat
     episode?.slug melempar; elemen macam itu dilewati (slug kosong), bukan
     menjatuhkan route detail. */
  return episodes
    .map((episode, index) => {
      try {
        return {
          number: episodeNumber(episode?.episode || episode?.title, index + 1),
          title: episode?.episode || episode?.title || `Episode ${index + 1}`,
          slug: episode?.slug || "",
          sourceUrl: episode?.sourceUrl || "",
          sourceProvider: episode?.sourceProvider || "",
          sourceIndex: index,
        };
      } catch {
        return { number: index + 1, title: `Episode ${index + 1}`, slug: "", sourceUrl: "", sourceProvider: "", sourceIndex: index };
      }
    })
    .filter((episode) => episode.slug)
    .sort((left, right) => left.number - right.number || left.sourceIndex - right.sourceIndex)
    .map(({ sourceIndex, ...episode }) => episode);
}

function slices(items) {
  return Array.from({ length: Math.ceil(items.length / SLIDE_SIZE) }, (_, index) => items.slice(index * SLIDE_SIZE, (index + 1) * SLIDE_SIZE));
}

function todayKey(date = new Date()) {
  const weekday = new Intl.DateTimeFormat("id-ID", { weekday: "long", timeZone: USER_TIME_ZONE }).format(date).toLowerCase();
  return DAY_KEYS.includes(weekday) ? weekday : "minggu";
}

function todayLabel(date = new Date()) {
  return new Intl.DateTimeFormat("id-ID", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: USER_TIME_ZONE }).format(date);
}

async function dailyAnime() {
  const day = todayKey();
  const { result } = await sourceRequest("/jadwal/", { headers: SOURCE_HEADERS, timeout: REQUEST_TIMEOUT_MS, validateStatus: (status) => status >= 200 && status < 300 });
  const scheduled = uniqueBySlug(parseDailyCards(result.data, day));
  if (!scheduled.length) throw new Error("Animasu tidak mengembalikan jadwal untuk hari ini.");
  return scheduled.map((anime) => titleAliasRecord({ ...anime, type: anime.type || "Series", episode: anime.episode || "Rilis hari ini", status: "NEW TODAY", daily: true, sourceProvider: "animasu" }));
}

async function dailyFromProvider() {
  return dailyAnime();
}

async function dailyWithSources() {
  let lastError;
  for (const source of SOURCE_CONFIGS) {
    try { return { data: await dailyFromProvider(source.id), provider: source.id }; } catch (error) { lastError = error; }
  }
  throw lastError || new Error("Tidak ada source anime yang dapat diakses.");
}

async function genresWithSources() {
  let lastError;
  for (const source of SOURCE_CONFIGS) {
    try {
      const { result } = await sourceRequestFor(source.id, "/", { headers: SOURCE_HEADERS, timeout: REQUEST_TIMEOUT_MS, validateStatus: (status) => status >= 200 && status < 300 });
      const data = parseGenreLinks(result.data, source.baseUrl);
      if (data.length) return { data, provider: source.id };
    } catch (error) { lastError = error; }
  }
  throw lastError || new Error("Tidak ada source anime yang mengembalikan genre.");
}

function absoluteUrl(value, baseUrl = ANIMASU_BASE_URL) {
  if (!value) return "";
  try { return new URL(value, baseUrl).toString(); } catch { return value.startsWith("//") ? `https:${value}` : value; }
}

const SOURCE_HEADERS = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36", Accept: "text/html,application/xhtml+xml" };
const SOURCE_CONFIGS = [{ id: "animasu", baseUrl: ANIMASU_BASE_URL, kind: "animasu" }];
const SOURCE_BASE_URLS = SOURCE_CONFIGS.map((source) => source.baseUrl);
/* Samehadaku SENGAJA tidak masuk SOURCE_CONFIGS. Fungsi dailyWithSources() dan
   genresWithSources() mencoba setiap sumber sebagai cadangan, dan markup
   Samehadaku tidak punya .bixbox maupun /genre/. Kalau ikut di sana, ia hanya
   menambah cadangan yang mengembalikan daftar kosong — atau lebih buruk, menggeser
   katalog ke sumber yang tidak bisa diparse. Ia hanya boleh lewat sebagai
   penyumbang episode, lewat getSourceConfig() di bawah. */
const MIRROR_ONLY_SOURCES = [{ id: "samehadaku", baseUrl: SAMEHADAKU_BASE_URL, kind: "samehadaku" }];
function isBlockedSourceHtml(html) {
  const text = String(html || "").toLowerCase();
  return text.includes("cf-chl-") || text.includes("just a moment") || (text.includes("cloudflare") && (text.includes("checking your browser") || text.includes("verify you are human")));
}
function getSourceConfig(provider = "animasu") {
  return [...SOURCE_CONFIGS, ...MIRROR_ONLY_SOURCES].find((source) => source.id === provider) || SOURCE_CONFIGS[0];
}
async function sourceRequestFor(provider, pathname, options = {}, lane = "default") {
  const source = getSourceConfig(provider);
  try {
    const result = await upstreamGet(new URL(pathname, source.baseUrl).toString(), options, lane);
    if (result.status < 200 || result.status >= 300) {
      const error = new Error(`${source.id} HTTP ${result.status}`);
      error.sourceBlocked = result.status === 403 || result.status === 429;
      throw error;
    }
    if (isBlockedSourceHtml(result.data)) {
      const error = new Error(`${source.id} mengembalikan halaman block/Cloudflare`);
      error.sourceBlocked = true;
      throw error;
    }
    markSourceSuccess(source.baseUrl, source.id);
    return { result, source };
  } catch (error) {
    const status = error?.response?.status;
    if (status === 403 || status === 429 || /block|cloudflare/i.test(error?.message || "")) error.sourceBlocked = true;
    error.sourceId = source.id;
    if (isSourceUnavailable(error)) markSourceFailure(error);
    throw error;
  }
}
async function sourceRequest(pathname, options = {}, lane = "default") {
  const { result, source } = await sourceRequestFor("animasu", pathname, options, lane);
  return { result, baseUrl: source.baseUrl };
}
function originFor(url) {
  try { return new URL(url).origin; } catch { return "unknown"; }
}
function scheduleUpstreamDrain(delayMs) {
  if (upstreamDrainTimer) return;
  upstreamDrainTimer = setTimeout(() => { upstreamDrainTimer = null; drainUpstreamQueue(); }, Math.max(0, delayMs));
}
function laneLimit(lane) { return lane === "search" ? SEARCH_UPSTREAM_CONCURRENCY : MAX_UPSTREAM_CONCURRENCY; }
function laneInterval(lane) { return lane === "search" ? SEARCH_UPSTREAM_MIN_INTERVAL_MS : UPSTREAM_MIN_INTERVAL_MS; }
function laneOriginKey(lane, origin) { return `${lane}:${origin}`; }
function drainUpstreamQueue() {
  let nextDelay = Infinity;
  while (upstreamQueue.length) {
    const now = Date.now();
    let selectedIndex = -1;
    for (let index = 0; index < upstreamQueue.length; index += 1) {
      const request = upstreamQueue[index];
      if (request.options.signal?.aborted) { upstreamQueue.splice(index, 1)[0].reject(new Error("Upstream request dibatalkan oleh client.")); index -= 1; continue; }
      const active = upstreamActiveByLane.get(request.lane) || 0;
      if (active >= laneLimit(request.lane)) continue;
      const origin = request.origin;
      const cooldown = upstreamCooldownUntil.get(origin) || 0;
      if (cooldown > now) { nextDelay = Math.min(nextDelay, cooldown - now); continue; }
      const key = laneOriginKey(request.lane, origin);
      const nextAllowed = (upstreamLastStartedByLane.get(key) || 0) + laneInterval(request.lane);
      if (nextAllowed > now) { nextDelay = Math.min(nextDelay, nextAllowed - now); continue; }
      selectedIndex = index;
      break;
    }
    if (selectedIndex < 0) break;
    const request = upstreamQueue.splice(selectedIndex, 1)[0];
    const origin = request.origin;
    const key = laneOriginKey(request.lane, origin);
    const nowStart = Date.now();
    upstreamLastStarted.set(origin, nowStart);
    upstreamLastStartedByLane.set(key, nowStart);
    upstreamActive += 1;
    upstreamActiveByLane.set(request.lane, (upstreamActiveByLane.get(request.lane) || 0) + 1);
    axios.get(request.url, request.options).then((result) => {
      if (result.status === 403 || result.status === 429) { upstreamCooldownUntil.set(origin, Date.now() + SOURCE_BLOCK_COOLDOWN_MS); capMap(upstreamCooldownUntil); }
      request.resolve(result);
    }, (error) => {
      if (error?.response?.status === 403 || error?.response?.status === 429) { upstreamCooldownUntil.set(origin, Date.now() + SOURCE_BLOCK_COOLDOWN_MS); capMap(upstreamCooldownUntil); }
      request.reject(error);
    }).finally(() => {
      upstreamActive -= 1;
      const active = Math.max(0, (upstreamActiveByLane.get(request.lane) || 1) - 1);
      if (active) upstreamActiveByLane.set(request.lane, active); else upstreamActiveByLane.delete(request.lane);
      drainUpstreamQueue();
    });
  }
  if (Number.isFinite(nextDelay)) scheduleUpstreamDrain(nextDelay);
}
function upstreamGet(url, options = {}, lane = "default") {
  return new Promise((resolve, reject) => { upstreamQueue.push({ url, origin: originFor(url), options, lane, resolve, reject }); drainUpstreamQueue(); });
}
function withTimeout(task, timeoutMs, label) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timeout setelah ${timeoutMs}ms`)), timeoutMs); });
  return Promise.race([Promise.resolve().then(task), timeout]).finally(() => clearTimeout(timer));
}
function transientUpstreamError(error) {
  const status = error?.response?.status;
  return !error?.sourceBlocked && (!status || status === 408 || status === 425 || status === 429 || status >= 500);
}
async function withRetry(task, retries, backoffMs, signal) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (signal?.aborted) throw new Error("Pencarian dibatalkan oleh client.");
    try { return await task(attempt); } catch (error) {
      lastError = error;
      if (attempt >= retries || !transientUpstreamError(error)) throw error;
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, backoffMs * (attempt + 1));
        signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("Pencarian dibatalkan oleh client.")); }, { once: true });
      });
    }
  }
  throw lastError;
}
function runtimeStats() { return { cacheEntries: memory.size, pendingKeys: pending.size, upstreamActive, upstreamQueued: upstreamQueue.length, upstreamActiveByLane: Object.fromEntries(upstreamActiveByLane), maxUpstreamConcurrency: MAX_UPSTREAM_CONCURRENCY, searchUpstreamConcurrency: SEARCH_UPSTREAM_CONCURRENCY, minIntervalMs: UPSTREAM_MIN_INTERVAL_MS, searchMinIntervalMs: SEARCH_UPSTREAM_MIN_INTERVAL_MS, cooldownMs: SOURCE_BLOCK_COOLDOWN_MS, rateLimit: { search: { burst: SEARCH_RATE_BURST, refillMs: SEARCH_RATE_REFILL_MS }, detail: { burst: DETAIL_RATE_BURST, refillMs: DETAIL_RATE_REFILL_MS }, streams: { burst: STREAM_RATE_BURST, refillMs: STREAM_RATE_REFILL_MS }, queueLimit: UPSTREAM_QUEUE_LIMIT, trackedClients: searchBucket.size + detailBucket.size + streamBucket.size + contentBucket.size } }; }
const sourceState = { status: "unknown", sourceId: null, baseUrl: null, lastSuccessAt: null, lastError: null };
function markSourceSuccess(baseUrl, sourceId = "animasu") { sourceState.status = "up"; sourceState.sourceId = sourceId; sourceState.baseUrl = baseUrl; sourceState.lastSuccessAt = new Date().toISOString(); sourceState.lastError = null; }
function markSourceFailure(error) { sourceState.status = "down"; sourceState.sourceId = error?.sourceId || sourceState.sourceId; sourceState.lastError = error?.message || String(error); }
/* 404/410 berarti pola URL yang dicoba tidak ada, bukan sumber mati.
   Tanpa ini, satu halaman yang gagal lalu digantikan path fallback yang
   sukses tetap menandai source "down", jadi /api/health melaporkan outage
   padahal pencarian berjalan normal. */
function isSourceUnavailable(error) {
  const fromResponse = Number(error?.response?.status) || 0;
  const fromMessage = Number((/\bHTTP (\d{3})\b/.exec(String(error?.message || "")) || [])[1]) || 0;
  const code = fromResponse || fromMessage;
  return code !== 404 && code !== 410;
}
/* ---------- Rate limit: token bucket per IP ----------
   Sliding window lama menyimpan array timestamp per IP: alokasi per request,
   bisa "dilewati" di batas menit, dan tetap memotong kuota untuk request yang
   sebenarnya dilayani cache. Token bucket menggantinya: satu objek per IP,
   laju jangka panjang = 60000 / refillMs token per menit, dan request yang
   dilayani cache atau sedang di-pending tidak diambilkan token sama sekali. */
function createTokenBucket({ capacity, refillMs, maxKeys = RATE_LIMIT_MAX_KEYS, clock = () => Date.now() }) {
  const buckets = new Map();
  let lastSweep = 0;
  function sweep(t, keepKey) {
    if (t - lastSweep < 60_000) return;
    lastSweep = t;
    for (const [storedKey, bucket] of buckets) {
      if (storedKey === keepKey) continue;
      if (bucket.tokens >= capacity || t - bucket.updatedAt >= refillMs * capacity) buckets.delete(storedKey);
      if (buckets.size <= maxKeys) return;
    }
    while (buckets.size > maxKeys) {
      const oldestKey = buckets.keys().next().value;
      if (oldestKey === keepKey) break;
      buckets.delete(oldestKey);
    }
  }
  return {
    take(key, cost = 1) {
      const t = clock();
      let bucket = buckets.get(key);
      if (!bucket) { bucket = { tokens: capacity, updatedAt: t }; buckets.set(key, bucket); }
      else {
        const elapsed = t - bucket.updatedAt;
        if (elapsed > 0) {
          bucket.tokens = Math.min(capacity, bucket.tokens + elapsed / refillMs);
          bucket.updatedAt = t;
        }
      }
      sweep(t, key);
      if (bucket.tokens < cost) {
        const retryAfterMs = Math.max(1, Math.ceil((cost - bucket.tokens) * refillMs));
        return { allowed: false, retryAfterMs, remaining: 0 };
      }
      bucket.tokens -= cost;
      return { allowed: true, retryAfterMs: 0, remaining: Math.floor(bucket.tokens) };
    },
    peek(key) { const bucket = buckets.get(key); return bucket ? Math.floor(bucket.tokens) : capacity; },
    get size() { return buckets.size; },
  };
}

const searchBucket = createTokenBucket({ capacity: SEARCH_RATE_BURST, refillMs: SEARCH_RATE_REFILL_MS });
const detailBucket = createTokenBucket({ capacity: DETAIL_RATE_BURST, refillMs: DETAIL_RATE_REFILL_MS });
const streamBucket = createTokenBucket({ capacity: STREAM_RATE_BURST, refillMs: STREAM_RATE_REFILL_MS });
const contentBucket = createTokenBucket({ capacity: CONTENT_RATE_BURST, refillMs: CONTENT_RATE_REFILL_MS });

function clientKey(request) { return request.ip || request.socket?.remoteAddress || "unknown"; }
function rateLimitResponse(response, verdict, message) {
  const retryAfterSeconds = Math.max(1, Math.ceil(verdict.retryAfterMs / 1000));
  response.set("Retry-After", String(retryAfterSeconds));
  return response.status(429).json({ data: [], slides: [], total: 0, error: message, retryAfterMs: verdict.retryAfterMs, retryAfterSeconds });
}
/* Antrean upstream yang sudah menumpuk = tolak seketika dengan Retry-After
   pendek, bukan biarkan user menunggu SEARCH_BUDGET_MS lalu dapat 503. */
function upstreamQueueGuard(request, response, next) {
  if (upstreamQueue.length < UPSTREAM_QUEUE_LIMIT) return next();
  return rateLimitResponse(response, { retryAfterMs: UPSTREAM_QUEUE_RETRY_MS }, "Server sedang sibuk. Coba lagi sebentar lagi.");
}
/* Middleware pembatas: hanya dipasang bila request benar-benar menembak
   upstream. Kalau kunci-nya masih di cache atau sedang di-pending, request
   itu gratis dan tidak boleh memotong kuota. */
function upstreamBudget(bucket, isFree, message) {
  return (request, response, next) => {
    if (isFree && isFree(request)) return next();
    const verdict = bucket.take(clientKey(request));
    if (verdict.allowed) return next();
    return rateLimitResponse(response, verdict, message);
  };
}
function isFreshCacheKey(key, ttl = CACHE_MS) {
  const entry = memory.get(key);
  if (!entry) return false;
  const freshTtl = isEmptyData(entry.data) ? Math.min(ttl, EMPTY_CACHE_MS) : ttl;
  return Date.now() - entry.timestamp < freshTtl;
}
const NON_ANIME_PATHS = new Set(["page", "pencarian", "jadwal", "genre", "genres", "studio", "karakter"]);

function extractSlug(value) {
  /* Temuan fuzz Manas 8 Okt: fallback String(value) di luar try melempar
     untuk objek dengan toString yang melempar, Proxy jahat, dan Symbol.
     teksAman() di pintu membuat semua jalur di bawahnya pasti string. */
  const raw = teksAman(value);
  if (!raw) return "";
  try {
    const pathname = new URL(raw, ANIMASU_BASE_URL).pathname;
    const segments = pathname.split("/").filter(Boolean);
    const candidate = segments.at(-1) || "";
    const slug = decodeURIComponent(candidate).trim();
    return !slug || /^\d+$/.test(slug) || NON_ANIME_PATHS.has(slug.toLowerCase()) ? "" : slug;
  } catch {
    const slug = raw.split("?")[0].split("#")[0].split("/").filter(Boolean).at(-1)?.trim() || "";
    return /^\d+$/.test(slug) || NON_ANIME_PATHS.has(slug.toLowerCase()) ? "" : slug;
  }
}

function parseAnimeCard($, element) {
  const card = $(element);
  const link = card.find("a[href]").first().attr("href") || "";
  const title = card.find(".tt, .title, .entry-title").first().text().trim();
  const image = card.find("img").first().attr("data-src") || card.find("img").first().attr("src") || "";
  let status = card.find(".sb").first().text().trim();
  if (status === "🔥🔥🔥") status = "ONGOING";
  else if (status === "Selesai ✓") status = "COMPLETE";
  else status = "UPCOMING";
  return { title, slug: extractSlug(link), image, type: card.find(".typez").first().text().trim(), episode: card.find(".epx").first().text().trim(), status };
}

function parseAnimeCardsWithDiagnostics(html) {
  const $ = cheerio.load(htmlAman(html));
  const cards = $(".bs, .listupd .bs, .list-anime .bs").map((_, element) => parseAnimeCard($, element)).get();
  return { rawCount: cards.length, data: cards.filter((anime) => anime.title && anime.slug), missingSlug: cards.filter((anime) => anime.title && !anime.slug).map((anime) => anime.title) };
}

function parseAnimeCards(html) {
  return parseAnimeCardsWithDiagnostics(html).data;
}

function parseGenreLinks(html, baseUrl) {
  const $ = cheerio.load(htmlAman(html));
  const result = [];
  $("a[href*='/genre/'], a[href*='/category/']").each((_, element) => {
    const anchor = $(element);
    const name = anchor.text().replace(/\s+/g, " ").trim();
    const href = anchor.attr("href") || "";
    const slug = href.split("/").filter(Boolean).at(-1) || "";
    if (name && slug && !result.some((item) => item.slug === slug)) result.push({ name, slug, sourceUrl: absoluteUrl(href, baseUrl) });
  });
  return result;
}



function parseDailyCards(html, day) {
  const $ = cheerio.load(htmlAman(html));
  const normalizedDay = String(day || "").toLowerCase();
  const result = [];
  $(".bixbox").each((_, element) => {
    const box = $(element);
    const label = box.find(".releases h3 span, .releases h3, h3").first().text().trim().toLowerCase().replace("update acak", "random").replace("'", "");
    if (label === normalizedDay) box.find(".bs").each((__, card) => result.push(parseAnimeCard($, card)));
  });
  return result.filter((anime) => anime.title && anime.slug);
}

function hasNextPage(html) {
  const $ = cheerio.load(htmlAman(html));
  return $(".hpage .r, .pagination .next, a.next, a[rel=next]").length > 0;
}

function parseAlphabetCardsWithDiagnostics(html) {
  const $ = cheerio.load(htmlAman(html));
  const cards = $(".bx").map((_, element) => {
    const card = $(element);
    const anchor = card.find(".inx h2 a[href], h2 a[href], a[href]").first();
    const title = anchor.text().trim() || card.find(".tt, .title").first().text().trim();
    const image = card.find(".imgx img").first().attr("data-src") || card.find(".imgx img").first().attr("src") || "";
    return { title, slug: extractSlug(anchor.attr("href") || ""), image, type: card.find(".inx span").eq(3).text().trim(), episode: card.find(".inx span").eq(4).text().trim().replace(", ", ""), status: card.find("[class*=status], .sb").first().text().trim() };
  }).get();
  return { rawCount: cards.length, data: cards.filter((anime) => anime.title && anime.slug), missingSlug: cards.filter((anime) => anime.title && !anime.slug).map((anime) => anime.title) };
}

async function fetchAlphabetPage({ letter, page = 1 }) {
  const attempts = SOURCE_BASE_URLS.map((baseUrl) => ({ baseUrl, promise: upstreamGet(new URL(`/daftar-anime/page/${page}/`, baseUrl).toString(), { params: { show: String(letter || "").toUpperCase() }, headers: SOURCE_HEADERS, timeout: REQUEST_TIMEOUT_MS, validateStatus: (status) => status >= 200 && status < 400 }) }));
  const results = await Promise.allSettled(attempts.map((attempt) => attempt.promise));
  let lastError;
  for (let index = 0; index < results.length; index += 1) {
    const result = results[index];
    if (result.status === "rejected") { lastError = result.reason; continue; }
    const diagnostics = parseAlphabetCardsWithDiagnostics(result.value.data);
    if (diagnostics.rawCount) { markSourceSuccess(attempts[index].baseUrl); return { ...diagnostics, hasNext: hasNextPage(result.value.data), source: attempts[index].baseUrl }; }
  }
  const failure = lastError || new Error("Semua domain Animasu tidak mengembalikan daftar anime.");
  if (isSourceUnavailable(failure)) markSourceFailure(failure);
  throw failure;
}

/* --------------------------------------------------------------------------
   Pencocokan lintas sumber: Animasu (katalog) + Samehadaku (episode)

   Kunci pencocokan BUKAN slug. Kedua situs menyingkat musim secara berbeda:
   Animasu menulis "black-clover-s2", Samehadaku "black-clover-season-2".
   Dicocokkan lewat slug, hasilnya nol tanpa error — diam, bukan terlihat,
   dan jauh lebih sulit ditelemetry daripada error yang biasa dilapor.

   Yang dibandingkan adalah judul ternormalisasi. Both situs Adding "Sub Indo"
   ke judul, jadi penanda rilis justru dibuang sebelum dibandingkan.
   -------------------------------------------------------------------------- */

/* Penanda rilis &pingsan navigasi. "movie"/"part" SENGAJA tidak ikut dibuang:
   "Black Clover: Mahou Tei no Ken" (film) dan "Black Clover" (TV) itu entri
   berbeda, dan membiarkan keduanya bertemu adalah cara tercepat menonton
   episode yang salah. */
const TITLE_NOISE = /\b(sub indo|subtitle indonesia|subtitle|indonesian|bersub|dub|bluray|bd)\b/g;

function normalizeTitleKey(value) {
  const base = normalizeSearchText(value);
  if (!base) return "";
  return base
    .replace(/\bs(\d{1,2})\b/g, "season $1")
    .replace(/\b(\d)\s*(?:st|nd|rd|th)\s*season\b/g, "season $1")
    /* Prefix "Nonton Anime ..." dibuang sebagai FRASA, bukan kata "anime"
      (global). Judul asli kedua situs sudah bersih, jadi ini hanya jaring
       pengaman kalau format judul sumber berubah; membuang kata "anime" di
       mana pun akan membuat "Anime de ..." dan "... Anime" dianggap sama. */
    .replace(/\bnonton\s+(anime|movie)\b/g, " ")
    .replace(TITLE_NOISE, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/* Halaman search Samehadaku memuat DUA jenis link /anime/: hasil pencarian
   (dibungkus div.animposx) dan sidebar rekomendasi (div.imgseries). Kalau
   keduanya ikut diambil, hampir semua query "cocok" ke film atau spin-off yang
   tidak ada hubungannya — itulah yang membuat probe pertama selalu mendarat di
   "Hibike Euphonium". Hanya .animposx yang dibaca. */
function pathSlugOf(url) {
  try { return new URL(url).pathname.split("/").filter(Boolean).at(-1) || ""; } catch { return ""; }
}

function parseSamehadakuSearch(html, baseUrl = SAMEHADAKU_BASE_URL) {
  const $ = cheerio.load(htmlAman(html));
  const result = [];
  $("div.animposx a[href*='/anime/']").each((_, element) => {
    const anchor = $(element);
    const sourceUrl = absoluteUrl(anchor.attr("href") || "", baseUrl);
    const title = (anchor.attr("title") || anchor.find("img").first().attr("alt") || "").trim();
    const slug = pathSlugOf(sourceUrl);
    if (!title || !slug || result.some((item) => item.slug === slug)) return;
    result.push({ title, slug, key: normalizeTitleKey(title), sourceUrl });
  });
  return result;
}

/* Link episode Samehadaku diletakkan di root (/judul-episode-1), bukan di bawah
   /anime/. Pola "-episode-\d+" dipakai karena itu, TAPI ada dua jenis jebakan:
     - "/daftar-batch/" = item menu navigasi.
     - "/judul-episode-1-24-batch" = halaman unduhan massal. Polanya tetap
       mengandung "-episode-", jadi tanpa pengecualian ini ia terhitung sebagai
       episode nomor 1 kedua dan membuat jumlah episode Samehadaku lebih banyak
       daripada kenyataan (terbukti: Iruma Season 4 terbaca 25, padahal 24). */
function parseSamehadakuAnime(html, sourceUrl = "", baseUrl = SAMEHADAKU_BASE_URL) {
  const $ = cheerio.load(htmlAman(html));
  const title = $("h1").first().text().replace(/\s+/g, " ").trim();
  const episodes = [];
  const seen = new Set();
  $("a[href]").each((_, element) => {
    const anchor = $(element);
    const href = anchor.attr("href") || "";
    if (!/-episode-\d+/.test(href)) return;
    if (/-batch\/?$/.test(href.split(/[?#]/)[0])) return;
    const url = absoluteUrl(href, baseUrl);
    if (seen.has(url)) return;
    seen.add(url);
    const slug = pathSlugOf(url);
    if (!slug) return;
    /* Teks link Samehadaku kosong; nomor aslinya hidup di slug. Ambil dari
       sana, jangan pakai urutan indeks — episode yang belum tayang akan
       membuat nomor setelahnya bergeser. */
    const fromSlug = /-episode-(\d+)/.exec(slug);
    const label = (anchor.attr("title") || anchor.find("img").first().attr("alt") || anchor.text() || "").replace(/\s+/g, " ").trim();
    episodes.push({ episode: label || `Episode ${fromSlug ? fromSlug[1] : episodes.length + 1}`, slug, sourceUrl: url, sourceProvider: "samehadaku" });
  });
  return { title, key: normalizeTitleKey(title), episodes, sourceUrl };
}

async function fetchSamehadakuEpisodes(title, synonym = "") {
  const wanted = [...new Set([normalizeTitleKey(title), normalizeTitleKey(synonym)].filter(Boolean))];
  if (!wanted.length) return { title: "", key: "", episodes: [] };
  try {
    /* Search dikirim dengan kunci yang sudah bersih. "Sub Indo" tidak ada di
       index Samehadaku, jadi mengirimnya hanya menambah kata yang tidak pernah
       menghasilkan hit — dan memiringkan hasil ke film atau spin-off. */
    const search = await sourceRequestFor("samehadaku", "/", {
      params: { s: wanted[0] }, headers: SOURCE_HEADERS, timeout: REQUEST_TIMEOUT_MS, validateStatus: (status) => status >= 200 && status < 300,
    });
    /* Syaratnya SAMA PERSIS, bukan "mirip". Melonggarkan ke pencocokan
       sebagian berarti film/spin-off bisa ikut terbawa sebagai episode. */
    const match = parseSamehadakuSearch(search.result.data, search.source.baseUrl).find((item) => wanted.includes(item.key));
    if (!match) return { title: "", key: "", episodes: [] };
    const page = await sourceRequestFor("samehadaku", new URL(match.sourceUrl).pathname, {
      headers: SOURCE_HEADERS, timeout: REQUEST_TIMEOUT_MS, validateStatus: (status) => status >= 200 && status < 300,
    });
    return parseSamehadakuAnime(page.result.data, match.sourceUrl, page.source.baseUrl);
  } catch (error) {
    /* Sumber kedua tidak boleh menjatuhkan halaman. Kegagalan di sini berarti
       "tidak ada tambahan", bukan "error". */
    console.error(`Suplemen Samehadaku gagal untuk "${title}": ${error.message}`);
    return { title: "", key: "", episodes: [] };
  }
}

/* Animasu tetap menang wherever ada nomor episode yang sama. Sumber kedua hanya
   mengisi nomor yang belum ada, supaya tidak menimpa pilihan pengguna. */
function mergeSupplementEpisodes(primary = [], supplement = []) {
  const byNumber = new Map();
  for (const episode of primary) byNumber.set(episode.number, episode);
  let added = 0;
  for (const episode of supplement) {
    if (byNumber.has(episode.number)) continue;
    byNumber.set(episode.number, episode);
    added += 1;
  }
  return { episodes: [...byNumber.values()].sort((left, right) => left.number - right.number), added };
}

function parseAnimeDetail(html, slug, baseUrl = ANIMASU_BASE_URL) {
  const $ = cheerio.load(htmlAman(html));
  const info = $(".infox");
  const title = info.find("h1[itemprop='headline'], h1, .title").first().text().trim();
  const synonym = info.find(".alter, .synonym, [class*=alternative]").first().text().trim();
  const image = $(".bigcontent .thumb img, .thumb img, img[itemprop=image]").first().attr("src") || $(".bigcontent .thumb img, .thumb img").first().attr("data-src") || "";
  const readInfo = (label) => info.find(".spe span").filter((_, element) => $(element).text().toLowerCase().startsWith(`${label}:`)).first().text().split(":").slice(1).join(":").trim();
  const genres = [];
  info.find(".spe span").first().find("a[href]").each((_, element) => genres.push({ name: $(element).text().trim(), slug: extractSlug($(element).attr("href")) }));
  const episodes = [];
  const episodeNodes = $("#daftarepisode li").length ? $("#daftarepisode li") : $("#daftarepisode a[href]");
  episodeNodes.each((_, element) => {
    const anchor = $(element).is("a") ? $(element) : $(element).find(".lchx a[href], a[href]").first();
    const episodeSlug = extractSlug(anchor.attr("href"));
    const episodeTitle = anchor.text().trim();
    if (episodeSlug && episodeTitle) episodes.push({ episode: episodeTitle, slug: episodeSlug, sourceUrl: absoluteUrl(anchor.attr("href"), baseUrl), sourceProvider: "animasu" });
  });
  /* Rating: primary selector + beberapa fallback (markup source sering berubah);
     angka format koma ("8,2") ikut dinormalisasi ke 8.2 */
  const ratingCandidates = [
    $(".rating strong").first().text(),
    $("[itemprop=ratingValue]").first().attr("content") || $("[itemprop=ratingValue]").first().text(),
    $(".rating, .score, .rtg").first().text(),
    readInfo("rating"),
    info.find("span").filter((_, el) => /rating/i.test($(el).text()) && /[0-9]/.test($(el).text())).first().text(),
  ];
  const rating = ratingCandidates.reduce((found, text) => {
    if (found) return found;
    const m = String(text || "").replace(",", ".").match(/(\d+(?:\.\d+)?)/);
    const value = m ? Number(m[1]) : 0;
    return value > 0 && value <= 10 ? value : 0;
  }, 0);
  return { slug, title, synonym, synopsis: $(".sinopsis p, .synopsis p").first().text().trim(), image: absoluteUrl(image, baseUrl), rating, genres, status: readInfo("status"), aired: readInfo("rilis"), type: readInfo("jenis") || "Unknown", episode: readInfo("episode") || "Unknown", duration: readInfo("durasi") || "Unknown", studio: readInfo("studio") || "Unknown", season: readInfo("musim") || "Unknown", trailer: $(".trailer iframe").attr("src") || "", updateAt: info.find("time[itemprop=dateModified]").attr("datetime") || "", episodes, batches: [] };
}

async function fetchAnimeDetail(slug) {
  const { result, source } = await sourceRequestFor("animasu", `/anime/${encodeURIComponent(slug)}/`, { headers: SOURCE_HEADERS, timeout: REQUEST_TIMEOUT_MS, validateStatus: (status) => status >= 200 && status < 300 });
  const detail = parseAnimeDetail(result.data, slug, source.baseUrl);
  if (!detail.title) throw new Error("Animasu detail tidak berisi judul anime.");
  detail.image = absoluteUrl(detail.image, source.baseUrl);
  detail.sourceProvider = "animasu";
  detail.sourceUrl = new URL(`/anime/${encodeURIComponent(slug)}/`, source.baseUrl).toString();
  return detail;
}

async function fetchCatalogPage({ search = "", genre = "", page = 1, signal }) {
  const paths = search ? [`/page/${page}/`, "/pencarian/"] : ["/pencarian/"];
  let lastError;
  let reachable = false;
  for (const pathname of paths) {
    try {
      const { result, baseUrl } = await sourceRequest(pathname, { params: { s: search, halaman: page, urutan: "update", "genre[]": genre ? [genre] : [] }, headers: SOURCE_HEADERS, timeout: REQUEST_TIMEOUT_MS, signal, validateStatus: (status) => status >= 200 && status < 300 }, "search");
      reachable = true;
      const diagnostics = parseAnimeCardsWithDiagnostics(result.data);
      if (diagnostics.data.length) return { data: diagnostics.data, hasNext: hasNextPage(result.data), diagnostics, source: baseUrl };
      lastError = new Error("Source katalog mengembalikan halaman kosong.");
    } catch (error) {
      lastError = error;
      if (error.sourceBlocked) break;
    }
  }
  if (reachable) return { data: [], hasNext: false, diagnostics: { rawCount: 0, data: [], missingSlug: [] }, source: ANIMASU_BASE_URL };
  if (lastError && !isSourceUnavailable(lastError)) markSourceFailure(lastError);
  throw lastError || new Error("Animasu tidak dapat diakses.");
}

function decodeMirror(value) {
  if (!value) return "";
  let raw = teksAman(value).trim();
  if (!raw) return "";
  try { raw = decodeURIComponent(raw); } catch (_) { /* value was not URI encoded */ }
  if (/^(https?:)?\/\//i.test(raw)) return absoluteUrl(raw);
  try {
    const normalized = raw.replace(/-/g, "+").replace(/_/g, "/");
    const decoded = Buffer.from(normalized, "base64").toString("utf8");
    const $ = cheerio.load(decoded);
    return absoluteUrl($("iframe").attr("src") || $("source").attr("src") || $("video").attr("src") || "");
  } catch { return ""; }
}

function parseMirrorOptions(html) {
  const $ = cheerio.load(htmlAman(html));
  const streams = [];
  $(".mirror option, .mirrors option, select option[data-url], [data-mirror-url], .mirror a[href], .mirrors a[href], iframe[src], video source[src], video[src]").each((_, element) => {
    const option = $(element);
    const candidates = [option.attr("data-url"), option.attr("data-mirror-url"), option.attr("href"), option.attr("value"), option.attr("src")].filter(Boolean);
    const url = candidates.map(decodeMirror).find(Boolean) || "";
    if (url) streams.push({ name: option.text().trim() || `Mirror ${streams.length + 1}`, url, source: "Animasu" });
  });
  const seen = new Set();
  return streams.filter((stream) => !seen.has(stream.url) && seen.add(stream.url));
}

async function readMirrorOptions(episodeSlug, provider = "animasu", sourceUrl = "") {
  const source = getSourceConfig(provider);
  const pathName = sourceUrl ? new URL(sourceUrl).pathname : `/${encodeURIComponent(episodeSlug)}/`;
  try {
    const { result } = await sourceRequestFor(provider, pathName, { headers: SOURCE_HEADERS, timeout: REQUEST_TIMEOUT_MS, validateStatus: (status) => status >= 200 && status < 300 });
    return { reachable: true, streams: parseMirrorOptions(result.data).map((stream) => ({ ...stream, source: source.id })) };
  } catch (error) {
    return { reachable: false, streams: [], error };
  }
}

async function yaoMirrors(episodeSlug, provider = "animasu", sourceUrl = "") {
  const direct = await readMirrorOptions(episodeSlug, provider, sourceUrl);
  // Only Animasu can use the YAOI library fallback; other providers have their own HTML.
  const libraryStreams = provider === "animasu" && !direct.streams.length ? await animasu.getStreams(episodeSlug, { noCache: true }).catch(() => []) : [];
  const collected = [...direct.streams, ...(libraryStreams || []).map((stream) => ({ name: stream.name || "Mirror", url: absoluteUrl(stream.url), source: "YAOI API" }))];
  const seen = new Set();
  return collected.filter((stream) => stream.url && !seen.has(stream.url) && seen.add(stream.url));
}

/* Di belakang reverse proxy (Railway, Render, Nginx), semua koneksi masuk
   dari IP proxy sehingga clientKey() selalu sama dan rate limit jadi satu
   kuota bersama untuk semua pengunjung. TRUST_PROXY=1 membuat Express
   memakai X-Forwarded-For sebagai IP asli. Default mati: server yang
   dibuka langsung ke internet tidak boleh mempercayai header itu. */
if (TRUST_PROXY) app.set("trust proxy", true);
/* Kunci integritas sisi server. Kalau seal di file ini berubah, route data
   berhenti melayani isinya dan hanya mengembalikan design kosong. Bukan
   pengaman sungguhan — siapa pun yang punya salinannya bisa mengubah
   sekalian ceknya. Glass house, bukan benteng.

   Cek ini memakai alat yang sama dengan `npm run seal:check`, jadi
   benar-benar membaca pecahan dari file di disk — bukan sekadar
   membandingkan literal dengan dirinya sendiri. */
const SEAL_PHRASE = "copyright LoveNime";
let sealIntact = null;
function sealIsIntact() {
  try {
    const { collect, verifyAgainstManifest } = require("./scripts/seal");
    return verifyAgainstManifest(collect()).ok;
  } catch (error) {
    console.error(`Gagal membaca kunci integritas: ${error.message}`);
    return false;
  }
}
app.use((request, response, next) => {
  if (sealIntact === null) sealIntact = sealIsIntact();
  if (sealIntact) return next();
  if (request.path.startsWith("/api/")) return response.status(503).json({ data: [], total: 0, error: "Kunci integritas tidak valid. Aplikasi terkunci." });
  next();
});
/* Batas body eksplisit: body JSON raksasa ditolak 413 oleh body-parser
   sebelum sempat menghabiskan memori (temuan fuzz 6 Oktober 2026). */
app.use(express.json({ limit: "100kb" }));
/* Saat MAINTENANCE=1, "/" harus didaftar SEBELUM express.static, karena  
   static otomatis menyajikan public/index.html untuk permintaan direktori
   dan akan membayangi catch-all maintenance di bawah. */
const MAINTENANCE_PAGE = path.join(__dirname, "public", "maintenance-page", "index.html");

/* Shell iLoveNime yang sudah terpasang memuat "?shell=apk". Pemeliharaan
   resmi tidak boleh snare aplikasi yang sudah terpasang: pengguna tidak
   punya tab browser yang bisa ditutup, dan halaman maintenance tidak punya
   jalan keluar ke aplikasi. Pengunjung web tetap melihat halaman
   maintenance seperti biasa - hanya shell terpasang yang dilewati.

   Penandanya eksplisit, bukan dikira dari User-Agent: server tidak boleh
   menebak siapa yang sedang bertanya. Tanpa parameter ini, perilakunya
   persis seperti sebelumnya.

   Pengecekan WAJIB di dalam handler, bukan di `if (MAINTENANCE)`: fungsi
   harus dijalankan per permintaan. `if (MAINTENANCE && !dariShell)` akan
   selalu salah karena fungsi selalu dianggap benar - maintenance mati
   total untuk semua orang, termasuk pengunjung web. */
function dariShellTerpasang(request) {
  return String((request.query && request.query.shell) || "") === "apk";
}
function sajikanSesuaiMode(request, response) {
  if (MAINTENANCE && !dariShellTerpasang(request)) {
    return response.sendFile(MAINTENANCE_PAGE);
  }
  return response.sendFile(path.join(__dirname, "public", "index.html"));
}

if (MAINTENANCE) app.get("/", sajikanSesuaiMode);
app.use("/vendor/animejs", express.static(path.join(__dirname, "node_modules", "animejs", "dist", "bundles")));
app.use("/vendor/three", express.static(path.join(__dirname, "node_modules", "three", "build")));
app.use(express.static(path.join(__dirname, "public")));
app.get("/api/health", (_, response) => {
  const publicView = { ok: true, sourceStatus: sourceState.status };
  /* Tanpa detail, /api/health hanya memberi tahu hidup atau mati, itu saja
     yang dibutuhkan visitor. Pemeriksa keamanan tidak boleh mendapat peta
     internal: jumlah cache, berapa banyak IP yang sedang dilacak, pesan
     error upstream, antrean, sampai konfigurasi rate limit. */
  if (!HEALTH_DETAIL) return response.json(publicView);
  response.json({ ...publicView, source: ANIMASU_BASE_URL, sources: [{ id: "animasu", baseUrl: ANIMASU_BASE_URL }, { id: "yaoi", baseUrl: "npm:yaoi" }], sourceId: sourceState.sourceId, sourceBaseUrl: sourceState.baseUrl, sourceLastSuccessAt: sourceState.lastSuccessAt, sourceLastError: sourceState.lastError, ...runtimeStats() });
});

async function collectCatalog(search, genre, signal) {
  const found = [];
  let partial = false;
  const deadline = Date.now() + SEARCH_BUDGET_MS;
  for (let page = 1; page <= MAX_SEARCH_PAGES; page += 1) {
    if (signal?.aborted) throw new Error("Pencarian dibatalkan oleh client.");
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      if (!found.length) throw new Error(`Search timeout setelah ${SEARCH_BUDGET_MS}ms`);
      partial = true;
      break;
    }
    try {
      const result = await withRetry(() => {
        const attemptRemaining = deadline - Date.now();
        if (attemptRemaining <= 0) throw new Error(`Search timeout setelah ${SEARCH_BUDGET_MS}ms`);
        return withTimeout(() => fetchCatalogPage({ search, genre, page, signal }), attemptRemaining, "Search");
      }, SEARCH_RETRY_COUNT, SEARCH_RETRY_BACKOFF_MS, signal);
      const pageData = (result.data || []).filter((item) => !search || matchesTitle(item, search));
      found.push(...pageData);
      if (!result.hasNext || !pageData.length) break;
    } catch (error) {
      if (!found.length) throw error;
      partial = true;
      break;
    }
  }
  return { data: uniqueBySlug(found).map(titleAliasRecord), partial, provider: "animasu" };
}

async function searchCatalog(search, genre, signal) {
  const errors = [];
  let successfulAttempt = false;
  for (const source of SOURCE_CONFIGS) {
    try {
      const direct = await collectCatalog(search, genre, signal, source.id);
      successfulAttempt = true;
      if (direct.data.length || !search) return { data: direct.data, aliasUsed: "", partial: direct.partial, provider: source.id };
    } catch (error) { errors.push(error); }
  }
  const aliases = await fetchEnglishAliases(search);
  for (const alias of aliases) {
    if (signal?.aborted) throw new Error("Pencarian dibatalkan oleh client.");
    for (const source of SOURCE_CONFIGS) {
      try {
        const result = await collectCatalog(alias, genre, signal, source.id);
        successfulAttempt = true;
        if (result.data.length) return { data: result.data, aliasUsed: alias, partial: result.partial, provider: source.id };
      } catch (error) { errors.push(error); }
    }
  }
  if (errors.length && !successfulAttempt) throw errors.at(-1);
  return { data: [], aliasUsed: "", partial: false, provider: "none" };
}

/* Kunci cache harus dihitung dengan cara yang sama persis seperti di route,
   supaya "gratis" benar-benar berarti request itu dilayani memory cache. */
function catalogBudgetKey(request) { return `catalog:${normalizeSearchText(String(request.query.search || "").trim().slice(0, 100))}:${normalizeSearchText(String(request.query.genre || "").trim().slice(0, 80))}`; }
const catalogRateLimit = upstreamBudget(searchBucket, (request) => {
  const key = catalogBudgetKey(request);
  return isFreshCacheKey(key) || pending.has(key);
}, "Terlalu banyak pencarian. Tunggu sebentar lalu coba lagi.");

app.get("/api/catalog", upstreamQueueGuard, catalogRateLimit, async (request, response) => {
  const search = String(request.query.search || "").trim().slice(0, 100);
  const genre = String(request.query.genre || "").trim().slice(0, 80);
  const key = `catalog:${normalizeSearchText(search)}:${normalizeSearchText(genre)}`;
  if (search && normalizeSearchText(search).length < MIN_SEARCH_LENGTH) return response.json({ data: [], slides: [], total: 0, slideSize: SLIDE_SIZE, provider: "local", stale: false, notice: `Masukkan minimal ${MIN_SEARCH_LENGTH} karakter untuk mencari.` });
  const abortController = new AbortController();
  request.on("close", () => { if (!response.writableEnded) abortController.abort(); });
  try {
    const result = await cached(key, () => searchCatalog(search, genre, abortController.signal));
    const data = result.data || [];
    if (data.length) return response.json({ data, slides: slices(data), total: data.length, slideSize: SLIDE_SIZE, provider: result.provider || "yaoi", aliasUsed: result.aliasUsed || "", partial: Boolean(result.partial), stale: false });
    response.json({ data: [], slides: [], total: 0, slideSize: SLIDE_SIZE, provider: result.provider || "none", aliasUsed: "", stale: false, notice: "Source merespons tetapi tidak menemukan judul yang cocok." });
  } catch (error) {
    if (abortController.signal.aborted) return;
    response.status(503).json({ data: [], slides: [], total: 0, error: `Source live tidak tersedia: ${error.message}` });
  }
});

app.get("/api/daily", upstreamBudget(contentBucket, (request) => isFreshCacheKey(`daily:${todayKey()}`, DAILY_CACHE_MS) || pending.has(`daily:${todayKey()}`), "Terlalu banyak permintaan jadwal. Coba lagi sebentar lagi."), async (_, response) => {
  try {
    const key = `daily:${todayKey()}`;
    const result = await cached(key, dailyWithSources, DAILY_CACHE_MS, true);
    const data = result?.data || [];
    if (data.length) return response.json({ data, slides: slices(data), total: data.length, slideSize: SLIDE_SIZE, day: todayKey(), label: todayLabel(), provider: result.provider || "yaoi", stale: isStale(key) });
    throw new Error("Animasu tidak mengembalikan judul jadwal.");
  } catch (error) {
    const fallback = readFallbackDaily();
    if (fallback?.data?.length) return response.json({ ...fallback, day: todayKey(), label: `Source offline · data terakhir ${fallback.label || "tersedia"}`, warning: `Jadwal live sedang tidak merespons; menampilkan snapshot lokal terakhir. (${error.message})` });
    response.status(503).json({ data: [], slides: [], total: 0, day: todayKey(), label: todayLabel(), error: `Jadwal live tidak tersedia: ${error.message}` });
  }
});

app.get("/api/genres", upstreamBudget(contentBucket, (request) => isFreshCacheKey("genres") || pending.has("genres"), "Terlalu banyak permintaan genre. Coba lagi sebentar lagi."), async (_, response) => {
  try {
    const key = "genres";
    const result = await cached(key, genresWithSources, CACHE_MS, true);
    if (!result?.data?.length) throw new Error("Source live tidak mengembalikan genre.");
    response.json({ data: result.data, provider: result.provider || "yaoi", stale: isStale(key) });
  } catch (error) { response.status(503).json({ data: [], error: `Genre live tidak tersedia: ${error.message}` }); }
});

app.get("/api/anime/:slug", upstreamQueueGuard, upstreamBudget(detailBucket, (request) => { const key = `detail:animasu:${request.params.slug}`; return isFreshCacheKey(key, DETAIL_CACHE_MS) || pending.has(key); }, "Terlalu banyak permintaan detail. Tunggu sebentar lalu coba lagi."), async (request, response) => {
  const provider = "animasu";
  try {
    const key = `detail:${provider}:${request.params.slug}`;
    const detail = await cached(key, () => fetchAnimeDetail(request.params.slug, provider), DETAIL_CACHE_MS, true);
    if (!detail?.title) throw new Error("detail tidak memiliki data yang valid");
    let episodes = normalizeEpisodes(detail.episodes || []);

    /* Source kedua hanya dipanggil kalau Animasu punya episode lebih sedikit dari
       ambang. Search Samehadaku adalah permintaan upstream TAMBAHAN, dan lane
       detail sudah dibatasi token bucket; membayarkannya di setiap request
       berarti mengorbankan kapasitas Animasu untuk pengambil yang tidak perlu. */
    let supplementedFrom = "";
    if (episodes.length < SUPPLEMENT_BELOW_EPISODES) {
      const supplement = await cached(`supplement:samehadaku:${detail.slug || request.params.slug}`, () => fetchSamehadakuEpisodes(detail.title, detail.synonym), DETAIL_CACHE_MS, true);
      const merged = mergeSupplementEpisodes(episodes, normalizeEpisodes(supplement?.episodes || []));
      if (merged.added) { episodes = merged.episodes; supplementedFrom = "samehadaku"; }
    }

    /* hasEpisodes dikirim terpisah: "anime ini belum ada episodenya" adalah
       jawaban yang SAH, bukan kegagalan. Tanpa flag ini, klien menampilkan
       pesan error untuk hal yang sebenarnya hanya belum tayang. */
    response.json({ data: titleAliasRecord({ ...detail, episodes, hasEpisodes: episodes.length > 0 }), provider: detail.sourceProvider || provider, hasEpisodes: episodes.length > 0, supplementedFrom, stale: isStale(key) });
  } catch (error) {
    const fallback = fallbackDetailFromDaily(request.params.slug);
    if (fallback) return response.json({ data: fallback, provider: "local-snapshot", stale: true, warning: `Detail live tidak tersedia (${error.message}); metadata dasar dari snapshot lokal ditampilkan.` });
    response.status(502).json({ data: null, error: `Source anime tidak dapat membaca detail ini: ${error.message}` });
  }
});

app.get("/api/streams/:episodeSlug", upstreamQueueGuard, upstreamBudget(streamBucket, (request) => { const key = `streams:yaoi:${request.params.episodeSlug}`; return isFreshCacheKey(key, STREAM_CACHE_MS) || pending.has(key); }, "Terlalu banyak permintaan mirror. Tunggu sebentar lalu coba lagi."), async (request, response) => {
  const provider = "yaoi";
  try {
    const key = `streams:${provider}:${request.params.episodeSlug}`;
    const data = await cached(key, () => yaoMirrors(request.params.episodeSlug, "animasu"), STREAM_CACHE_MS, true);
    if (!data?.length) throw new Error("mirror tidak memiliki data yang valid");
    response.json({ data, total: data.length, provider, stale: isStale(key) });
  } catch (error) { response.status(502).json({ data: [], total: 0, error: `${provider} tidak dapat membaca mirror: ${error.message}` }); }
});

/* --------------------------------------------------------------------------
   Halaman maintenance (public/maintenance-page/index.html)
   - GET /maintenance          : selalu tersedia untuk preview kapan saja.
   - MAINTENANCE=1             : semua route non-API menyajikan halaman
                                 maintenance sebagai halaman utama; semua
                                 /api/* TETAP hidup (playback dari storage).
   -------------------------------------------------------------------------- */
app.get("/maintenance", (_, response) => response.sendFile(MAINTENANCE_PAGE));
/* Route /api/* yang tidak dikenal HARUS dibalas JSON 404, bukan halaman SPA.
   Sebelumnya apa pun di bawah /api/ jatuh ke catch-all "*" sehingga klien
   menerima HTML dengan status 200; api.js lalu gagal saat JSON.parse dan
   melaporkan "respons tidak valid (HTTP 200)" untuk kesalahan yang
   sebenarnya cuma route yang tidak ada. Search engine dan uptime monitor
   juga salah membaca status karena melihat 200 di mana-mana. */
app.all("/api/*", (request, response) => {
  response.status(404).json({ error: `Endpoint tidak ditemukan: ${request.method} ${request.path}` });
});
/* Shell terpasang (lihat dariShellTerpasang di atas) melewati mode
   maintenance dan menerima halaman aplikasi seperti biasa. */
app.get("*", sajikanSesuaiMode);
/* Global error handler — WAJIB terdaftar paling akhir setelah semua rute.
   Tanpa ini, URI cacat (mis. /%ff) atau JSON body korup melempar URIError/
   SyntaxError ke handler default Express: HTML stack trace + log terminal
   penuh (temuan fuzz 6 Oktober 2026). Status diambil dari error bila ada
   (mis. 413 body terlalu besar), default 400. */
app.use((error, request, response, next) => {
  if (response.headersSent) return next(error);
  const status = error.status || error.statusCode || 400;
  if (request.path.startsWith("/api/")) {
    return response.status(status).json({ error: status === 400 ? "Permintaan tidak valid (Bad Request)" : status === 413 ? "Body permintaan terlalu besar" : "Terjadi kesalahan internal server" });
  }
  response.status(status).send("Permintaan tidak valid");
});
if (require.main === module) {
  // Railway and other container hosts route traffic through the container
  // network, so binding only to loopback makes the service unreachable.
  // "::" = dual-stack: melayani localhost (::1 / IPv6) DAN 127.0.0.1 (IPv4)
  // sekaligus, sehingga browser Windows yang me-resolve localhost ke IPv6
  // tidak lagi gagal membuka halaman.
  const HOST = process.env.HOST || "::";
  const server = app.listen(PORT, HOST, () => {
    console.log(`ILoveNime personal: http://localhost:${PORT}`);
    if (MAINTENANCE) console.log("MAINTENANCE MODE AKTIF: route non-API menyajikan halaman maintenance. API tetap hidup.");
    /* HOST default "::" membuat server terjangkau dari internet. Kalau nanti
       dibungkus Railway/Render/Nginx tanpa TRUST_PROXY=1, semua pengunjung
       terhitung sebagai satu IP sehingga rate limit jadi kuota bersama:
       dari 20 pengguna berbeda hanya ~12 yang bisa mencari bersamaan. */
    if (!TRUST_PROXY && HOST !== "127.0.0.1" && HOST !== "localhost") {
      console.log("PERINGATAN: TRUST_PROXY belum aktif. Kalau server ini di belakang reverse proxy, set TRUST_PROXY=1 supaya rate limit membedakan IP asli tiap pengguna.");
    }
  });

  server.on("error", (error) => {
    if (error.code === "EADDRINUSE") {
      console.error(
        `Port ${PORT} sedang dipakai proses lain. Hentikan proses lama atau jalankan dengan PORT=3100 npm start.`
      );
    } else {
      console.error(`Server gagal dijalankan: ${error.message}`);
    }

    process.exitCode = 1;
  });
}

module.exports = { app, isSourceUnavailable, slices, uniqueBySlug, normalizeEpisodes, todayKey, todayLabel, decodeMirror, normalizeSearchText, splitAliases, titleAliasRecord, matchesTitle, cached, isStale, readFallbackDaily, fallbackDetailFromDaily, runtimeStats, extractSlug, isBlockedSourceHtml, parseAnimeCards, parseAnimeCardsWithDiagnostics, parseGenreLinks, parseDailyCards, parseAlphabetCardsWithDiagnostics, parseAnimeDetail, parseMirrorOptions, hasNextPage, fetchCatalogPage, fetchAlphabetPage, fetchAnimeDetail, createTokenBucket, normalizeTitleKey, parseSamehadakuSearch, parseSamehadakuAnime, mergeSupplementEpisodes, getSourceConfig, SOURCE_CONFIGS, MIRROR_ONLY_SOURCES, fetchSamehadakuEpisodes };
