if (typeof globalThis.registerSeal === "function") globalThis.registerSeal("apputils", "copyright LoveNime");
/* ==========================================================================
   ILoveNime — Helper murni (tanpa DOM) agar bisa diuji unit di Node.
   Dipakai reference-app.js; saling terhubung dengan state & prefs di sana.
   ========================================================================== */

/* Ukuran slide grid: mobile 3x3 (9 judul), desktop 6x3 (18 judul) */
export function pageSizeFor(isMobile = false) { return isMobile ? 9 : 18; }
export function pageCountFor(total, pageSize) { return Math.max(1, Math.ceil((total || 0) / (pageSize || 1))); }
export function clampPage(page, pageCount) { return Math.min(Math.max(0, page), Math.max(0, pageCount - 1)); }
export function pageSlice(items = [], page = 0, pageSize = 18) {
  const start = clampPage(page, pageCountFor(items.length, pageSize)) * pageSize;
  return items.slice(start, start + pageSize);
}

/* Tamat = statusnya memang "completed", ATAU total diketahui dan progres
   sudah mencapai total (item lama yang statusnya completed tapi totalnya
   0/korup tetap terhitung — dulu hilang dari tab Complete & stat popup). */
export function isItemComplete(item = {}) {
  if (String(item.status || "") === "completed") return true;
  const total = Number(item.total || item.totalEpisodes || 0);
  const progress = Number(item.progress || (item.watchedEpisodes || []).at(-1) || 0);
  return total > 0 && progress >= total;
}

/* ===== Lanjutkan Menonton ===== */

/* Satu episode yang cocok untuk ditampilkan di rail. episodes = daftar dari
   /api/anime/:slug (bukan data storage), sedangkan watched = array nomor
   episode yang sudah ditonton di localStorage. */
export function nextUnwatched(watched = [], episodes = []) {
  const done = new Set((watched || []).map(Number));
  return (episodes || []).find((ep) => ep && ep.slug && !done.has(Number(ep.number))) || null;
}

/* Kandidat rail: sudah ditonton minimal 1 episode, belum tamat, dan masih
   ada sisa episode. Item dengan total 0 (tidak diketahui) tetap lolos supaya
   bisa diverifikasi nanti lewat detail, bukan langsung hilang. */
export function continueCandidates(items = [], limit = 8) {
  const candidates = (items || []).filter((item) => {
    if (!item?.slug) return false;
    const watched = (item.watchedEpisodes || []).map(Number).filter(Number.isFinite);
    if (!watched.length && Number(item.progress || 0) < 1) return false;
    if (isItemComplete(item)) return false;
    const total = Number(item.total || item.totalEpisodes || 0);
    if (total > 0 && Number(item.progress || 0) >= total) return false;
    return true;
  });
  /* Urutan gabungan: yang paling baru ditonton dulu. Item lama yang belum
     punya lastWatchedAt diberi nilai tiruan dari progresnya supaya tetap
     masuk urutan dan tidak selalu tersingkir. */
  return candidates
    .map((item) => {
      const progress = Number(item.progress || 0);
      const ratio = Number(item.total || item.totalEpisodes || 0) > 0 ? progress / Number(item.total || item.totalEpisodes) : 0;
      const stamp = Number(item.lastWatchedAt || 0) || Math.round(ratio * 1000);
      return { item, stamp, ratio };
    })
    .sort((a, b) => b.stamp - a.stamp || b.ratio - a.ratio)
    .slice(0, limit)
    .map((entry) => entry.item);
}

/* Label episode untuk kartu: "Episode 7" + judul bila ada. */
export function episodeLabel(episode = {}, animeTitle = "") {
  if (!episode?.number) return animeTitle || "Episode berikutnya";
  const base = `Episode ${Number(episode.number)}`;
  return episode.title ? `${base} · ${episode.title}` : base;
}

/* Sisa episode yang belum ditonton, dipakai untuk sub judul rail. */
export function remainingCount(item = {}, episodeTotal = 0) {
  const watched = new Set((item.watchedEpisodes || []).map(Number));
  const total = Number(episodeTotal || item.total || item.totalEpisodes || 0);
  if (!total) return 0;
  return Math.max(0, total - watched.size);
}

/* Avatar hanya menerima PNG, WebP, dan GIF (GIF = avatar beranimasi). */
export const AVATAR_ALLOWED_TYPES = ["image/png", "image/webp", "image/gif"];
export function isAllowedAvatarFile(file) {
  if (!file) return false;
  if (AVATAR_ALLOWED_TYPES.includes(file.type)) return true;
  return /\.(png|webp|gif)$/i.test(String(file.name || ""));
}

/* Export v2: koleksi + profil (nama, handle, foto, tema) agar pengguna
   tidak perlu mengatur ulang profil setelah import. */
export function buildExportPayload(items = [], prefs = {}) {
  return {
    format: "ilovenime-tracking",
    version: 2,
    exportedAt: new Date().toISOString(),
    profile: {
      username: String(prefs.username || "").slice(0, 30),
      handle: String(prefs.handle || "").slice(0, 40),
      avatarUrl: String(prefs.avatarUrl || ""),
      theme: prefs.theme === "light" ? "light" : "dark",
      sidebarCollapsed: Boolean(prefs.sidebarCollapsed),
    },
    items: items.map((i) => ({ slug: i.slug, title: i.title, image: i.image, total: i.total, status: i.status, progress: i.progress, watchedEpisodes: i.watchedEpisodes, genres: i.genres || [], characters: i.characters || [], type: i.type || "", airingStatus: i.airingStatus || "", rating: Number(i.rating || 0) })),
  };
}

/* Import: v1 (tanpa profile) tidak mengubah apa pun; v2 memulihkan profil
   dengan penyaringan ketat — avatarUrl hanya boleh data:image/* agar
   file JSON berbahaya tidak bisa menyuntik URL apa pun. */
export function mergeImportedProfile(parsed = {}, prefs = {}) {
  const p = parsed?.profile;
  if (!p || typeof p !== "object") return prefs;
  const next = { ...prefs };
  if (typeof p.username === "string" && p.username.trim()) next.username = p.username.trim().slice(0, 30);
  if (typeof p.handle === "string") next.handle = p.handle.slice(0, 40);
  if (p.avatarUrl === "" || (typeof p.avatarUrl === "string" && p.avatarUrl.startsWith("data:image/"))) next.avatarUrl = p.avatarUrl;
  if (p.theme === "light" || p.theme === "dark") next.theme = p.theme;
  if (typeof p.sidebarCollapsed === "boolean") next.sidebarCollapsed = p.sidebarCollapsed;
  return next;
}
