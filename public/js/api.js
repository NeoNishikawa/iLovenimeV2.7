import { registerSeal } from "./integrity.js";
registerSeal("api", "copyright LoveNime");
const cache = new Map();
let activeCatalogController = null;

/* Cache sisi klien tidak pernah expire di versi lama: query yang sama
   dipanggil lagi beberapa menit kemudian dijawab dari memori, padahal
   server sudah punya data baru. TTL pendek + batas jumlah entri menjaga
   hasil tetap akurat tanpa request ulang yang sia-sia. */
const CACHE_TTL_MS = 60_000;
const CACHE_MAX_ENTRIES = 40;
function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) { cache.delete(key); return null; }
  return entry.promise;
}
function cacheSet(key, promise) {
  cache.delete(key);
  cache.set(key, { promise, timestamp: Date.now() });
  while (cache.size > CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value);
}

/* Setiap request punya batas waktu. Tanpa ini, satu request yang macet
   menggantung antarmuka SELAMANYA - bukan "lambat", tapi tidak pernah selesai,
   dan tidak ada pesan apa pun yang sampai ke pengguna. 20 detik: cukup untuk
   katalog dingin yang memang butuh ~10 detik, dan masih bisa gagal cepat
   daripada menggantung. */
const REQUEST_TIMEOUT_MS = 20_000;

function denganBatasWaktu(options) {
  const kendali = new AbortController();
  let lewatWaktu = false;
  const timer = setTimeout(() => { lewatWaktu = true; kendali.abort(); }, REQUEST_TIMEOUT_MS);
  const luar = options.signal;
  if (luar) {
    if (luar.aborted) kendali.abort();
    else luar.addEventListener("abort", () => kendali.abort(), { once: true });
  }
  return {
    signal: kendali.signal,
    lewatWaktu: () => lewatWaktu,
    berhenti: () => clearTimeout(timer),
  };
}

async function request(path, options = {}) {
  const batas = denganBatasWaktu(options);
  try {
    const response = await fetch(path, { ...options, signal: batas.signal });
    /* response.text() WAJIB di dalam jendela batas waktu. Versi pertama
       menghentikan timer sebelum body dibaca, jadi server yang sudah
       mengirim header lalu macet di body akan menggantung selamanya -
       persis cacat yang seharusnya ditutup. Diuji dengan skenario
       "header lalu body macet". */
    const body = await response.text();
    let json;
    try { json = JSON.parse(body); } catch (_) { const error = new Error(`Server mengembalikan respons tidak valid (HTTP ${response.status})`); error.status = response.status; throw error; }
    /* JSON primitive (null, angka, string) sah bagi JSON.parse tapi bukan
       bentuk respons yang kita pakai. Tanpa penjaga ini `json.error`
       meledak jadi TypeError tanpa pesan yang berguna. */
    if (!json || typeof json !== "object") { const error = new Error(`Server mengembalikan respons tidak valid (HTTP ${response.status})`); error.status = response.status; throw error; }
    if (!response.ok || json.error) {
      const error = new Error(json.error || `HTTP ${response.status}`);
      error.status = response.status;
      /* Server sudah tahu persis kapan kuota terisi lagi. Pakai angka itu
         supaya retry benar-benar berhasil, bukan menebak 350ms lalu kena 429
         lagi dan exhausting retry. */
      error.retryAfterMs = Number(json.retryAfterMs) > 0 ? Number(json.retryAfterMs) : Number(response.headers.get("Retry-After")) * 1000;
      if (!(error.retryAfterMs > 0)) delete error.retryAfterMs;
      throw error;
    }
    return json;
  } catch (e) {
    if (batas.lewatWaktu()) {
      const error = new Error(`Server tidak merespons dalam ${Math.round(REQUEST_TIMEOUT_MS / 1000)} detik`);
      /* status 0 = bukan HTTP, jadi tidak masuk daftar retryable: error
         batas waktu harus berhenti, bukan mengulang dan menambah 20 detik. */
      error.status = 0;
      error.timeout = true;
      throw error;
    }
    throw e;
  } finally {
    batas.berhenti();
  }
}

function retryableStatus(status) { return [408, 425, 429, 500, 502, 503, 504].includes(Number(status)); }
async function requestWithRetry(path, options = {}, retries = 1, onRetry) {
  for (let attempt = 0; ; attempt += 1) {
    try { return await request(path, options); } catch (error) {
      if (options.signal?.aborted || attempt >= retries || !retryableStatus(error.status)) throw error;
      const waitMs = Number(error.retryAfterMs) || 350 * (attempt + 1);
      /* 429 dengan Retry-After panjang = antrean penuh, bukan glitch. Menunggu
         10 detik di dalam UI lebih buruk daripada memberi tahu user. */
      if (Number(error.status) === 429 && waitMs > 5_000) throw error;
      const delay = waitMs;
      onRetry?.(attempt + 1, delay, error);
      if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("iln:catalog-retry", { detail: { attempt: attempt + 1, delay, status: error.status || 0 } }));
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, delay);
        options.signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new DOMException("Aborted", "AbortError")); }, { once: true });
      });
    }
  }
}

function cachedRequest(key, path, options = {}) {
  const hit = cacheGet(key);
  if (hit) return hit;
  const pending = request(path, options).catch((error) => {
    if (cache.get(key)?.promise === pending) cache.delete(key);
    throw error;
  });
  cacheSet(key, pending);
  return pending;
}

export const api = {
  health: () => request("/api/health"),
  daily: () => request("/api/daily"),
  genres: () => request("/api/genres"),
  cancelCatalog() { activeCatalogController?.abort(); activeCatalogController = null; },
  catalog(query, genre, onRetry) {
    const normalizedQuery = String(query || "").trim();
    const normalizedGenre = String(genre || "").trim();
    const key = `${normalizedQuery.toLocaleLowerCase()}|${normalizedGenre.toLocaleLowerCase()}`;
    const hit = cacheGet(key);
    if (hit) return hit;
    activeCatalogController?.abort();
    const controller = new AbortController();
    activeCatalogController = controller;
    const params = new URLSearchParams({ search: normalizedQuery, genre: normalizedGenre });
    const pending = requestWithRetry(`/api/catalog?${params}`, { signal: controller.signal }, 1, onRetry).catch((error) => {
      /* Jangan simpan error ke cache: satu 429 tidak boleh membuat query
         yang sama ikut gagal selama 60 detik ke depan. */
      if (cache.get(key)?.promise === pending) cache.delete(key);
      throw error;
    }).finally(() => {
      if (activeCatalogController === controller) activeCatalogController = null;
    });
    cacheSet(key, pending);
    return pending;
  },
  detail: (slug) => request(`/api/anime/${encodeURIComponent(slug)}`),
  mirrors: (slug) => request(`/api/streams/${encodeURIComponent(slug)}`),
};
