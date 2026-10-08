module.exports = {
  // Ganti hanya nilai ini setiap kali domain sumber berpindah.
  ANIMASU_BASE_URL: process.env.ANIMASU_BASE_URL || "https://animasu.love",
  /* Sumber KEDUA, khusus menyumbang episode yang Animasu belum punya.
     PENTING: domain .com sudah jadi halaman parkir iklan yang mengarahkan ke
     landing page; yang masih melayani konten adalah v2 ini. Jangan mengembalikan
     ke .com tanpa probe ulang. */
  SAMEHADAKU_BASE_URL: process.env.SAMEHADAKU_BASE_URL || "https://v2.samehadaku.how",
  /* Ambang suplemen episode. Kalau Animasu punya episode FEWER dari angka ini,
     Samehadaku dipanggil untuk mengisi nomor yang kurang; Animasu tetap menang
     kalau nomornya bentrok.

     Default 1 = hanya saat Animasu benar-benar nol episode. Diperiksa pada 10
     anime airing (4 Oktober 2026) TIDAK SATU pun punya nol episode — Animasu
     selalu mencantumkan episode terakhir. Jadi default ini paling aman, tapi
     kalau hasilnya sering kosong, naikkan (misal SUPPLEMENT_BELOW_EPISODES=3)
     agar anime dengan 1-2 episode ikut ditambah dari Samehadaku.

     Setiap kenaikan berarti satu search upstream TAMBAHAN per anime, jadi
     jangan dinaikkan tanpa alasan: lane detail dibatasi token bucket. */
  SUPPLEMENT_BELOW_EPISODES: Number(process.env.SUPPLEMENT_BELOW_EPISODES) >= 0 ? Number(process.env.SUPPLEMENT_BELOW_EPISODES) : 1,
  // Gunakan PORT=3100 npm start bila port default sedang dipakai proses lain.
  PORT: Number.isInteger(Number(process.env.PORT)) && Number(process.env.PORT) > 0 ? Number(process.env.PORT) : 3099,
  // Mode maintenance bulanan: MAINTENANCE=1 menjadikan halaman utama
  // maintenance (route non-API), sementara semua /api/* tetap hidup.
  MAINTENANCE: ["1", "true", "yes", "on"].includes(String(process.env.MAINTENANCE || "").toLowerCase()),
  REQUEST_TIMEOUT_MS: Number(process.env.REQUEST_TIMEOUT_MS) > 0 ? Number(process.env.REQUEST_TIMEOUT_MS) : 8000,
  // Beri source waktu cukup untuk menyelesaikan pagination dan alias search.
  SEARCH_BUDGET_MS: Number(process.env.SEARCH_BUDGET_MS) > 0 ? Number(process.env.SEARCH_BUDGET_MS) : 15000,
  DAILY_CACHE_MS: Number(process.env.DAILY_CACHE_MS) > 0 ? Number(process.env.DAILY_CACHE_MS) : 300000,
  DETAIL_CACHE_MS: Number(process.env.DETAIL_CACHE_MS) > 0 ? Number(process.env.DETAIL_CACHE_MS) : 1800000,
  STREAM_CACHE_MS: Number(process.env.STREAM_CACHE_MS) > 0 ? Number(process.env.STREAM_CACHE_MS) : 600000,
  // Rate limiting untuk mengurangi beban source; bukan untuk melewati proteksi anti-bot.
  /* Token bucket per IP. Burst = token yang boleh dipakai mendadak; refill =
     ms per token, jadi laju jangka panjang = 60000 / refill token per menit.
     Pakai token bucket, bukan sliding window: bucket hemat satu objek per IP
     (window menyimpan array timestamp) dan tidak bisa "dilewati" di batas
     menit, jadi hasil hitungannya tidak bergantung pada sudut waktu. */
  SEARCH_RATE_BURST: Number(process.env.SEARCH_RATE_BURST) > 0 ? Number(process.env.SEARCH_RATE_BURST) : 12,
  SEARCH_RATE_REFILL_MS: Number(process.env.SEARCH_RATE_REFILL_MS) > 0 ? Number(process.env.SEARCH_RATE_REFILL_MS) : 2000,
  DETAIL_RATE_BURST: Number(process.env.DETAIL_RATE_BURST) > 0 ? Number(process.env.DETAIL_RATE_BURST) : 30,
  DETAIL_RATE_REFILL_MS: Number(process.env.DETAIL_RATE_REFILL_MS) > 0 ? Number(process.env.DETAIL_RATE_REFILL_MS) : 1000,
  STREAM_RATE_BURST: Number(process.env.STREAM_RATE_BURST) > 0 ? Number(process.env.STREAM_RATE_BURST) : 12,
  STREAM_RATE_REFILL_MS: Number(process.env.STREAM_RATE_REFILL_MS) > 0 ? Number(process.env.STREAM_RATE_REFILL_MS) : 1000,
  CONTENT_RATE_BURST: Number(process.env.CONTENT_RATE_BURST) > 0 ? Number(process.env.CONTENT_RATE_BURST) : 20,
  CONTENT_RATE_REFILL_MS: Number(process.env.CONTENT_RATE_REFILL_MS) > 0 ? Number(process.env.CONTENT_RATE_REFILL_MS) : 1000,
  // Batas jumlah IP yang dilacak agar map tidak tumbuh tanpa batas.
  RATE_LIMIT_MAX_KEYS: Number(process.env.RATE_LIMIT_MAX_KEYS) > 0 ? Number(process.env.RATE_LIMIT_MAX_KEYS) : 512,
  // Antrean upstream yang sudah terlalu dalam = tolak cepat (429 + Retry-After
  // pendek) daripada diam 15 detik lalu balas 503 timeout.
  UPSTREAM_QUEUE_LIMIT: Number(process.env.UPSTREAM_QUEUE_LIMIT) > 0 ? Number(process.env.UPSTREAM_QUEUE_LIMIT) : 12,
  UPSTREAM_QUEUE_RETRY_MS: Number(process.env.UPSTREAM_QUEUE_RETRY_MS) > 0 ? Number(process.env.UPSTREAM_QUEUE_RETRY_MS) : 1000,
  MAX_UPSTREAM_CONCURRENCY: Number(process.env.MAX_UPSTREAM_CONCURRENCY) > 0 ? Number(process.env.MAX_UPSTREAM_CONCURRENCY) : 1,
  SEARCH_UPSTREAM_CONCURRENCY: Number(process.env.SEARCH_UPSTREAM_CONCURRENCY) > 0 ? Number(process.env.SEARCH_UPSTREAM_CONCURRENCY) : 2,
  UPSTREAM_MIN_INTERVAL_MS: Number(process.env.UPSTREAM_MIN_INTERVAL_MS) >= 0 ? Number(process.env.UPSTREAM_MIN_INTERVAL_MS) : 1500,
  SEARCH_UPSTREAM_MIN_INTERVAL_MS: Number(process.env.SEARCH_UPSTREAM_MIN_INTERVAL_MS) >= 0 ? Number(process.env.SEARCH_UPSTREAM_MIN_INTERVAL_MS) : 500,
  SEARCH_RETRY_COUNT: Number(process.env.SEARCH_RETRY_COUNT) >= 0 ? Number(process.env.SEARCH_RETRY_COUNT) : 1,
  SEARCH_RETRY_BACKOFF_MS: Number(process.env.SEARCH_RETRY_BACKOFF_MS) >= 0 ? Number(process.env.SEARCH_RETRY_BACKOFF_MS) : 250,
  SOURCE_BLOCK_COOLDOWN_MS: Number(process.env.SOURCE_BLOCK_COOLDOWN_MS) > 0 ? Number(process.env.SOURCE_BLOCK_COOLDOWN_MS) : 60000,
  /* /api/health dipanggil siapa pun, jadi versi publik hanya membalas
     status yang dibutuhkan visitor. Angka internal (jumlah cache, IP yang
     dilacak, error upstream, konfigurasi rate limit) tetap tersedia untuk
     monitoring lokal dengan HEALTH_DETAIL=1. */
  HEALTH_DETAIL: ["1", "true", "yes", "on"].includes(String(process.env.HEALTH_DETAIL || "").toLowerCase()),
  /* Railway, Render, dan reverse proxy lain meneruskan IP asli lewat
     X-Forwarded-For. Tanpa TRUST_PROXY=1, Express mengabaikan header itu
     dan semua user terlihat sebagai satu IP, sehingga kuota burst dibagi
     ke seluruh pengunjung, bukan per orang.

     Default DIMATKAN dengan sengaja: kalau server dibuka langsung ke
     internet tanpa proxy, mempercayai X-Forwarded-For berarti siapa pun
     bisa memalsukan IP dan melewati rate limit. Nyalakan hanya ketika
     traffic benar-benar lewat proxy yang kamu percaya. */
  TRUST_PROXY: ["1", "true", "yes", "on"].includes(String(process.env.TRUST_PROXY || "").toLowerCase()),
};
