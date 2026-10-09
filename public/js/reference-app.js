import { registerSeal } from "./integrity.js";
registerSeal("referenceapp", "copyright LoveNime");
import { api } from "./api.js?v=1.1.0";
import { attach, closeActive } from "./dropdown.js";
import { pageSizeFor, pageCountFor, pageSlice, isItemComplete, isAllowedAvatarFile, buildExportPayload, mergeImportedProfile, continueCandidates, nextUnwatched, episodeLabel, remainingCount } from "./app-utils.js";
import { animate, createTimeline, stagger, utils } from "animejs";
import { createScreenTimeTracker, mountScreenTimeUI } from "./screen-time.js";
import { createPerformanceController } from "./performance-mode.js";
import { createNetworkMonitor, mountNetworkBadge } from "./net-status.js";
import { mountMaintenanceNotice } from "./maintenance-notice.js";
import { mountSearchOrb } from "./search-orb.js";
import { runSealCheck } from "./integrity.js";

/* Kunci integritas diperiksa sebelum data apa pun dimuat. Kalau kunci tidak
   cocok, aplikasi berhenti di design: tidak ada anime, tidak ada hasil
   pencarian, tidak ada episode.

   ambient.js dimuat sebagai <script> terpisah di HTML, jadi bisa belum selesai
   dievaluasi ketika modul ini berjalan. Tunggu dulu supaya semua pecahan
   kunci terdaftar — kalau tidak, aplikasi akan mengunci dirinya sendiri. */
let SEAL_OK = false;
const sealReady = import("./ambient.js").catch(() => {}).then(() => {
  SEAL_OK = runSealCheck().ok;
  return SEAL_OK;
});

const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const TRACKING_KEY = "iln_tracking";
const PREFS_KEY = "ilovenime.reference.prefs";
const esc = (v = "") => String(v).replace(/[&<>\"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
/* XP naik dua kali lipat per level: 10, 20, 40, 80, … */
function xpForLevel(level) { return 10 * Math.pow(2, level - 1); }
function levelFromWatched(watched) { let level = 1; let remaining = Math.max(0, Math.floor(watched)); while (remaining >= xpForLevel(level)) { remaining -= xpForLevel(level); level += 1; } return { level, intoLevel: remaining, need: xpForLevel(level) }; }
const isMobileViewport = () => window.matchMedia("(max-width: 1023px)").matches;
const statusText = (v) => ({ planned: "Plan to Watch", watching: "Watching", completed: "Complete", dropped: "Dislike" }[v] || v || "All");
const mobileQuery = window.matchMedia("(max-width: 1023px)");
/* Bawaan prefs. Dipakai saat inisialisasi dan saat "Delete Data" supaya
   tempatnya mengulang nilai yang sama tidak lagi berbeda. */
const DEFAULT_PREFS = { theme: "dark", sidebarCollapsed: false, username: "Anime watcher", handle: "Local profile", avatarUrl: "" };
let prefs = (() => { try { return { ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem(PREFS_KEY) || "{}") }; } catch { return { ...DEFAULT_PREFS }; } })();
const state = { daily: [], genres: [], searchResults: [], storageItems: [], mainGenres: new Set(), storageGenres: new Set(), activeGenres: new Set(), currentTab: "All", localQuery: "", searchQuery: "", searchLoading: false, storageFilterLoading: false, updateLoading: true, detail: null, episodeIndex: -1, mirrors: [], mirrorIndex: 0, selectedStorageItems: new Set(), editMode: false, searchToken: 0, searchPage: 0, storagePage: 0, filteredSearchCount: 0, filteredStorageCount: 0 };

let screenTimeUI = null;
const screenTimeTracker = createScreenTimeTracker({ storage: localStorage, documentRef: document, windowRef: window, onReminder: (reminder) => screenTimeUI?.show(reminder) });
screenTimeUI = mountScreenTimeUI({ tracker: screenTimeTracker, documentRef: document });
screenTimeTracker.start();
const performanceController = createPerformanceController({ storage: localStorage, documentRef: document, navigatorRef: navigator });
window.ilnPerformanceController = performanceController;
/* Badge ikon jaringan di header. Latensi nyata dilaporkan lewat timed()
   di bawah setiap panggilan API, jadi ikon tidak hanya menebak dari
   effectiveType browser. */
const networkMonitor = createNetworkMonitor();
mountNetworkBadge({ monitor: networkMonitor });
networkMonitor.start();
async function timed(promise) {
  const started = performance.now();
  try { return await promise; } finally { networkMonitor.setLatency(performance.now() - started); }
}
if ("serviceWorker" in navigator && window.isSecureContext) {
  window.ilnScreenTimeServiceWorker = navigator.serviceWorker.register("/sw.js")
    .then(() => navigator.serviceWorker.ready)
    .catch(() => null);
}

/* ---------- Drawer mobile ---------- */
const sidebar = $("#sidebar");
const drawerOverlay = document.createElement("div");
drawerOverlay.className = "drawer-overlay";
drawerOverlay.hidden = true;
document.body.appendChild(drawerOverlay);

function setDrawer(open) {
  const isMobileNow = mobileQuery.matches;
  if (!isMobileNow) return;
  sidebar.classList.toggle("is-mobile-open", open);
  document.getElementById("app").classList.toggle("drawer-open", open);
  drawerOverlay.hidden = !open;
  $("#hamburgerBtn").setAttribute("aria-expanded", String(open));
  if (!open) drawerOverlay.hidden = true;
}
$("#hamburgerBtn").addEventListener("click", (event) => {
  event.stopPropagation();
  setDrawer(!sidebar.classList.contains("is-mobile-open"));
});
drawerOverlay.addEventListener("click", () => setDrawer(false));
mobileQuery.addEventListener("change", () => { if (!mobileQuery.matches) setDrawer(false); /* page size berubah (6×3 ↔ 3×3): render ulang grid */ renderStorage(); renderSearch(); });

/* ---------- Reveal / stagger animasi kartu ---------- */
function staggerIn(container) {
  if (!container) return;
  const items = [...container.children];
  if (!items.length) return;
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const tier = document.documentElement.dataset.performanceTier || "full";
  const limit = tier === "balanced" ? 8 : 12;
  items.forEach((item) => item.classList.remove("card-enter"));
  if (reduced || tier === "low") return;
  const animated = items.slice(0, limit);
  animated.forEach((item, index) => item.style.setProperty("--enter-delay", `${index * 28}ms`));
  requestAnimationFrame(() => {
    if (document.documentElement.dataset.performanceTier === "low" || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    animated.forEach((item) => item.classList.add("card-enter"));
  });
}

/* ---------- Deal: kartu hasil search "dibagikan" dari bawah search main ----------
   Jatuh staggered ala membagi kartu, impact squash multi-stage scale(1.4,.6),
   rebound, lalu settle — spring feel tanpa library. */
function dealCards(container) {
  if (!container) return;
  const items = [...container.children];
  if (!items.length) return;
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const tier = document.documentElement.dataset.performanceTier || "full";
  if (reduced || tier === "low") { staggerIn(container); return; }
  const limit = tier === "balanced" ? 8 : 12;
  const animated = items.slice(0, limit);
  animated.forEach((item) => { item.classList.remove("deal-card"); item.classList.remove("card-enter"); });
  animated.forEach((item, index) => {
    item.style.setProperty("--deal-delay", `${index * 55}ms`);
    item.style.setProperty("--deal-rot", `${index % 2 ? 1.6 : -1.6}deg`);
  });
  requestAnimationFrame(() => {
    if (document.documentElement.dataset.performanceTier === "low" || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    animated.forEach((item) => item.classList.add("deal-card"));
  });
}

/* ---------- Ganti halaman grid: kartu masuk bergeser sadar arah ---------- */
function turnPageIn(container, direction = 1) {
  if (!container) return;
  const items = [...container.children];
  if (!items.length) return;
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const tier = document.documentElement.dataset.performanceTier || "full";
  if (reduced || tier === "low") { staggerIn(container); return; }
  const limit = tier === "balanced" ? 9 : 18;
  const animated = items.slice(0, limit);
  animated.forEach((item) => item.classList.remove("turn-card", "from-left", "card-enter", "deal-card"));
  animated.forEach((item, index) => item.style.setProperty("--turn-i", String(index)));
  requestAnimationFrame(() => animated.forEach((item) => {
    if (direction < 0) item.classList.add("from-left");
    item.classList.add("turn-card");
  }));
}

/* ---------- Scroll fade in/out (IntersectionObserver) ----------
   Kartu muncul (fade+slide) saat masuk viewport dan memudar kembali saat
   keluar — hanya animasi opacity/transform, tanpa layout thrashing. */
let scrollObserver = null;
function setupScrollReveal() {
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  scrollObserver?.disconnect();
  scrollObserver = null;
  if (reduced || document.documentElement.dataset.performanceTier === "low" || !("IntersectionObserver" in window)) return;
  scrollObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) entry.target.classList.toggle("scroll-hidden", !entry.isIntersecting);
  }, { root: $("#mainScroll"), rootMargin: "0px 0px -8% 0px", threshold: 0.05 });
}
function observeScrollReveal(container) {
  if (!container || !scrollObserver) return;
  const items = [...container.querySelectorAll(".anime-card")];
  items.forEach((item) => { item.classList.add("scroll-reveal"); scrollObserver.observe(item); });
}
function installDevLongTaskMonitor() {
  if (new URLSearchParams(window.location.search).get("iln-dev") !== "1" || !("PerformanceObserver" in window)) return;
  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) console.info(`[iLoveNime dev] long task ${Math.round(entry.duration)}ms`, entry);
    });
    observer.observe({ type: "longtask", buffered: true });
    window.__ilnLongTaskObserver = observer;
  } catch { /* Long Task API is not available in every browser. */ }
}

/* ---------- Pager grid: slide 6×3 (desktop) / 3×3 (mobile) ---------- */
/* Sidebar tertutup di desktop -> grid jadi 7 kolom, jadi satu halaman muat
   7×3 = 21 kartu (bukan 18). Mobile tetap 3×3 = 9; sidebar terbuka 6×3 = 18.
   Angka 21 ini HARUS sama dengan grid-template-columns di layout.css. */
const SIDEBAR_ANIM_MS = 380;
/* Jumlah kartu per halaman DIHITUNG dari kolom grid yang benar-benar aktif
   (baris selalu 3), bukan angka manual — kalau kolom berubah lagi (mis. 6->5
   untuk tablet), pager otomatis ikut dan baris terakhir tidak bolong lagi.
   Kolom dibaca dari #storageGrid karena section itu selalu tampil. */
function pageSize() {
  const grid = $("#storageGrid");
  const kolom = grid ? getComputedStyle(grid).gridTemplateColumns.split(" ").filter(Boolean).length : 0;
  return kolom > 0 ? kolom * 3 : pageSizeFor(isMobileViewport());
}
function pagerHTML(page, pageCount, idPrefix) {
  return `<div class="grid-pager" role="navigation" aria-label="Navigasi halaman">
    <button class="pager-btn" data-pager-prev="${idPrefix}" ${page <= 0 ? "disabled" : ""} aria-label="Halaman sebelumnya"><svg class="ico"><use href="#i-chev-left"/></svg></button>
    <span class="pager-info">Halaman <b>${page + 1}</b> / ${pageCount}</span>
    <button class="pager-btn" data-pager-next="${idPrefix}" ${page >= pageCount - 1 ? "disabled" : ""} aria-label="Halaman berikutnya"><svg class="ico"><use href="#i-chev-right"/></svg></button>
  </div>`;
}
function setGridPage(which, delta) {
  if (which === "search") { state.searchPage = Math.max(0, state.searchPage + delta); renderSearch({ pageDir: delta }); }
  else { state.storagePage = Math.max(0, state.storagePage + delta); renderStorage({ pageDir: delta }); }
}
function bindPager(root) {
  if (!root) return;
  const prev = $("[data-pager-prev]", root), next = $("[data-pager-next]", root);
  prev?.addEventListener("click", () => setGridPage(prev.dataset.pagerPrev, -1));
  next?.addEventListener("click", () => setGridPage(next.dataset.pagerNext, 1));
}
function scrollToGrid(grid) { grid?.closest("section")?.scrollIntoView?.({ behavior: "smooth", block: "start" }); }

/* ---------- Data helpers ---------- */
function normalizeStored(raw = {}) { const watchedEpisodes = Array.isArray(raw.watchedEpisodes) ? [...new Set(raw.watchedEpisodes.map(Number).filter(Number.isFinite))].sort((a, b) => a - b) : []; const progress = Math.max(Number(raw.progress || 0), watchedEpisodes.at(-1) || 0); const status = raw.status || (raw.dislike ? "dropped" : raw.planToWatch || !progress ? "planned" : raw.total && progress >= raw.total ? "completed" : "watching"); return { ...raw, characters: Array.isArray(raw.characters) ? raw.characters.map((c) => typeof c === "string" ? c : c.name).filter(Boolean) : [], slug: String(raw.slug || raw.animeId || ""), animeId: String(raw.animeId || raw.slug || ""), title: String(raw.title || "Unknown title"), image: raw.image || raw.posterUrl || "", posterUrl: raw.posterUrl || raw.image || "", total: Number(raw.total || raw.totalEpisodes || 0), totalEpisodes: Number(raw.totalEpisodes || raw.total || 0), progress, watchedEpisodes, status, genres: Array.isArray(raw.genres) ? raw.genres.map((g) => typeof g === "string" ? g : g.name).filter(Boolean) : [] }; }
function readTracking() { try { const parsed = JSON.parse(localStorage.getItem(TRACKING_KEY) || "[]"); return Array.isArray(parsed) ? parsed.map(normalizeStored).filter((x) => x.slug) : []; } catch { return []; } }
state.storageItems = readTracking();
function saveState() { localStorage.setItem(TRACKING_KEY, JSON.stringify(state.storageItems.map(normalizeStored))); localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); }
function normAnime(a = {}) { const title = a.title || "Untitled"; const total = Number(a.totalEpisodes || a.total || a.episodes?.length || String(a.episode || "").match(/\d+/)?.[0] || 0); return { ...a, id: String(a.id || a.slug || ""), slug: String(a.slug || a.id || ""), title, posterUrl: a.posterUrl || a.image || "", image: a.image || a.posterUrl || "", totalEpisodes: total, total, rating: Number(a.rating || 0), genres: (a.genres || []).map((g) => typeof g === "string" ? g : g.name).filter(Boolean) }; }
function allKnown() { return state.daily.concat(state.searchResults, state.storageItems); }
function findAnime(id) { return allKnown().map(normAnime).find((a) => a.id === id || a.slug === id) || state.storageItems.find((i) => i.slug === id); }
function getStored(id) { return state.storageItems.find((i) => i.slug === id || i.animeId === id); }
function totalWatched() { return state.storageItems.reduce((sum, item) => sum + Number(item.progress || item.watchedEpisodes?.at(-1) || 0), 0); }
function isComplete(item) { return isItemComplete(item); }
function imageHTML(anime) { return anime.posterUrl ? `<img src="${esc(anime.posterUrl)}" alt="${esc(anime.title)}" loading="lazy" onerror="this.parentNode.classList.add('img-failed')">` : `<span class="art-placeholder">ANIME IMAGE</span>`; }
/* Loader Thinking Orb (kartu "Reading search / Complete" dengan orb dan
   progress bar) sudah DIHAPUS: wave physics loader di dalam grid jauh lebih
   modern dan tidak pernah menutupi konten. Semua pemanggilnya (cari, import,
   retry) sekarang toasted saja, jadi tidak ada lagi node Thought di DOM. */
function toastBusy(title, message) { toast(title, message); }
/* Retry HTTP masih perlu diberi tahu ke user. Dulu lewat kartu Thought
   loader, sekarang lewat toast: kartu itu menutupi konten dan sudah
   digantikan wave loader di dalam grid. */
window.addEventListener("iln:catalog-retry", (event) => {
  if (!state.searchLoading) return;
  toastBusy("Mencoba lagi", `Server sedang sibuk — percobaan ${event.detail.attempt}.`, 2200);
});
function toast(title, message = "", duration = 3600) { const el = document.createElement("div"); el.className = "toast"; el.innerHTML = `<div class="t-ico"><svg class="ico"><use href="#i-bell"/></svg></div><div class="t-body"><div class="t-title">${esc(title)}</div><div class="t-msg">${esc(message)}</div></div><button class="t-close" aria-label="Tutup"><svg class="ico"><use href="#i-close"/></svg></button><div class="toast-progress running" style="animation-duration:${duration}ms"></div>`; const close = () => { el.classList.add("leaving"); setTimeout(() => el.remove(), 240); }; $(".t-close", el).onclick = close; $("#toastStack").appendChild(el); if (duration > 0) setTimeout(close, duration); }
function applyProfile() { const name = prefs.username || "Anime watcher"; const initial = name.trim().slice(0, 1).toUpperCase() || "A"; const { level, intoLevel, need } = levelFromWatched(totalWatched()); $$("#pcName,#sbName").forEach((el) => el.textContent = name); $("#pcHandle").textContent = prefs.handle; $("#pcTitle").textContent = level >= 5 ? "Anime Scholar" : level >= 3 ? "Otaku Enthusiast" : "Watcher Novice"; $("#sbLevel").textContent = `Level ${level}`; $("#pcLevelText").textContent = `Level ${level}`; $("#pcXpText").textContent = `${intoLevel} / ${need} XP`;  $("#pcXpBar").style.width = `${Math.min(100, (intoLevel / need) * 100)}%`;
  const levelTitle = level >= 5 ? "Anime Scholar" : level >= 3 ? "Otaku Enthusiast" : "Watcher Novice";
  $("#ppLevelTitle").textContent = `Level ${level} — ${levelTitle}`;
  $("#ppLevelBadge").textContent = `Lv ${level}`;
  $("#ppXpBar").style.width = `${Math.min(100, (intoLevel / need) * 100)}%`;
  $("#ppXpTextLeft").textContent = `${intoLevel} XP`;
  $("#ppXpTextRight").textContent = `${intoLevel} / ${need}`;  $("#pcStorage").innerHTML = `${state.storageItems.length} <small>Titles</small>`;
  $("#pcEpisodes").innerHTML = `${totalWatched()} <small>Episodes</small>`;
  /* Stat popup profil: sinkron dengan data nyata (dulu selalu 0) */
  const ppEps = $("#ppTotalEps"), ppTitles = $("#ppTotalTitles"), ppDone = $("#ppCompleted");
  if (ppEps) ppEps.textContent = totalWatched();
  if (ppTitles) ppTitles.textContent = state.storageItems.length;
  if (ppDone) ppDone.textContent = state.storageItems.filter(isComplete).length;
  $("#navStorageCount").textContent = state.storageItems.length; [$("#pcAvatar"), $("#sbAvatar"), $("#ppAvatar")].forEach((el) => { if (!el) return; el.classList.toggle("level-border", level >= 5); el.classList.toggle("level-water", level >= 10); el.innerHTML = prefs.avatarUrl ? `<img class="avatar-img" src="${esc(prefs.avatarUrl)}" alt="${esc(name)}">` : `<span class="avatar-initial">${esc(initial)}</span>`; }); }

function cardHTML(anime, options = {}) { const a = normAnime(anime); const item = options.storageItem || getStored(a.slug); const watched = Number(item?.progress || item?.watchedEpisodes?.at(-1) || 0); const total = Number(a.totalEpisodes || item?.total || 0); const pct = total ? Math.min(100, Math.round(watched / total * 100)) : 0; const selected = options.selected ? " selected" : ""; const inStorage = Boolean(item || options.inStorage); /* Permintaan Neo: menu morph HANYA untuk kartu di bagian Local Storage. Di tampilan lain, kartu yang sudah tersimpan tidak menampilkan tombol + lagi — begitu anime masuk lewat + dan halaman di-render ulang, + hilang dan tersisa tombol mata. */   /* Permintaan Neo 6 Okt: di beranda dan Local Storage, tombol "See Detail" dan ikon mata digabung jadi SATU tombol selebar dua tombol; lanjutan permintaannya isi tombol ini CUKUP ikon mata saja (tanpa teks). Icon-only tetap dipakai di hasil pencarian dan di tombol kedua saat anime belum tersimpan. Lanjutan 6 Okt: di Local Storage tombol detail disamakan ukurannya dengan tombol + (ikon-only 44px); lebar penuh hanya tersisa di beranda untuk kartu tersimpan. */
  const btnDetailWide = `<button class="btn btn-sm" data-act="detail" data-id="${esc(a.slug)}" aria-label="Lihat detail" title="Lihat detail"><svg class="ico"><use href="#i-eye"/></svg></button>`;
  const btnDetailIcon = `<button class="btn btn-sm btn-icon-only" data-act="detail" data-id="${esc(a.slug)}" aria-label="Lihat detail" title="Lihat detail"><svg class="ico"><use href="#i-eye"/></svg></button>`;
  const actionButtons = options.removeMode ? `<button class="btn btn-sm btn-remove" data-act="remove" data-id="${esc(a.slug)}" aria-label="Remove" title="Klik untuk hapus, tahan untuk hapus langsung"><span class="hold-fill"></span><svg class="ico"><use href="#i-trash"/></svg><span class="btn-label">Remove</span></button>` : `${inStorage && options.storageSection ? `<button class="btn btn-sm btn-primary btn-icon-only btn-morph" data-act="goo" data-id="${esc(a.slug)}" aria-haspopup="menu" aria-expanded="false" aria-label="Aksi ${esc(a.title)}" title="Favorite, Dislike, Reset, Hapus"><svg class="ico ico-plus"><use href="#i-plus"/></svg></button>${btnDetailIcon}` : inStorage ? (options.homeSection ? btnDetailWide : btnDetailIcon) : `<button class="btn btn-sm btn-primary btn-icon-only" data-act="add" data-id="${esc(a.slug)}" aria-label="Tambah ke storage" title="Tambah ke Local Storage"><svg class="ico"><use href="#i-plus"/></svg></button><button class="btn btn-sm btn-icon-only" data-act="detail" data-id="${esc(a.slug)}" aria-label="Lihat detail" title="Lihat detail"><svg class="ico"><use href="#i-eye"/></svg></button>`}`; return `<article class="anime-card${selected}"${options.removeMode || options.checkbox ? "" : " data-card-open"} data-id="${esc(a.slug)}"><div class="thumb">${options.rank ? `<span class="rank-badge${options.rank <= 2 ? " top" : ""}">#${options.rank}</span>` : ""}${options.epsBadge ? `<span class="eps-badge">${esc(options.epsBadge)}</span>` : ""}${item?.favorite ? `<span class="fav-mark"><svg class="ico"><use href="#i-star"/></svg></span>` : ""}${options.checkbox ? `<button class="check-wrap${options.selected ? " on" : ""}" data-act="check" data-id="${esc(a.slug)}" aria-label="Pilih ${esc(a.title)}">${options.selected ? "✓" : ""}</button>` : ""}${options.removeMode || options.checkbox ? "" : `<button class="card-play" type="button" data-act="play" data-id="${esc(a.slug)}" aria-label="Tonton ${esc(a.title)}"><svg class="ico"><use href="#i-play"/></svg><span>Tonton</span></button>`}${imageHTML(a)}</div><div class="card-body"><h3 class="card-title" title="${esc(a.title)}">${esc(a.title)}</h3><div class="card-meta"><span class="star"><svg class="ico"><use href="#i-star"/></svg>${a.rating ? a.rating.toFixed(1) : "—"}</span><span class="dot"></span><span>${total || "?"} Eps</span>${isComplete({ ...a, progress: watched }) ? `<span class="dot"></span><span style="color:var(--gold)">Complete</span>` : ""}</div>${options.showProgress ? `<div class="progress-row"><div class="progress-top"><span>Ep <b>${watched}</b> / ${total || "?"}</span><span>${pct}%</span></div><div class="bar thin"><i style="width:${pct}%"></i></div></div>` : ""}<div class="card-actions">${actionButtons}</div></div></article>`; }
function empty(title, message) { return `<div class="empty-mini"><strong>${esc(title)}</strong>${esc(message)}</div>`; }
function typeMatches(item, wanted) { if (!wanted) return true; const type = String(item.type || item.format || "").toLowerCase(); if (wanted === "Serial TV") return ["tv", "series", "serial tv", "ona"].some((v) => type.includes(v)); return type === wanted.toLowerCase(); }
function statusMatches(item, wanted) { if (!wanted || wanted === "Rating" || wanted === "Terpopuler") return true; const status = String(item.airingStatus || item.status || "").toLowerCase(); if (wanted === "Selesai Tayang") return /complete|completed|finished|selesai/.test(status); if (wanted === "Sedang Tayang") return /ongoing|airing|sedang|new today/.test(status); if (wanted === "Segera Tayang") return /upcoming|segera|not yet/.test(status); return status === wanted.toLowerCase(); }
function sortItems(items, key) { return [...items].sort((a,b) => key === "az" ? a.title.localeCompare(b.title) : key === "za" ? b.title.localeCompare(a.title) : key === "rating" ? Number(b.rating||0)-Number(a.rating||0) : key === "newest" || key === "updated" ? String(b.updatedAt || b.updateAt || b.aired || "").localeCompare(String(a.updatedAt || a.updateAt || a.aired || "")) : key === "oldest" ? String(a.updatedAt || a.updateAt || a.aired || "").localeCompare(String(b.updatedAt || b.updateAt || b.aired || "")) : key === "popular" ? Number(b.views||b.popularity||0)-Number(a.views||a.popularity||0) : 0); }
async function hydrateStorageMetadata() { const targets = state.storageItems.filter((item) => (!item.genres?.length || !Number(item.rating)) && item.slug); await Promise.allSettled(targets.map(async (item) => { const response = await api.detail(item.slug); const data = response.data || {}; item.genres = (data.genres || item.genres || []).map((g) => typeof g === "string" ? g : g.name).filter(Boolean); item.characters = (data.characters || item.characters || []).map((c) => typeof c === "string" ? c : c.name).filter(Boolean); item.type = data.type || item.type; item.airingStatus = data.status || item.airingStatus || ""; item.rating = Number(data.rating || item.rating || 0); })); saveState(); }
async function refreshStorageFilters() { state.storageFilterLoading = true; renderStorage(); await hydrateStorageMetadata(); state.storageFilterLoading = false; renderStorage(); }
function renderStorage(options = {}) { const q = state.localQuery.toLowerCase(); let items = state.storageItems.filter((item) => { if (state.currentTab === "Complete" && !isComplete(item)) return false; if (state.currentTab === "Plan to Watch" && item.progress) return false; if (state.currentTab === "Dislike" && !item.dislike && item.status !== "dropped") return false; if (state.currentTab === "Favorite" && !item.favorite) return false; if (!typeMatches(item, state.storageType)) return false; if (!statusMatches(item, state.storageStatus)) return false; if (!tagMatch(item, state.storageGenres, "genres")) return false; return !q || `${item.title} ${item.genres.join(" ")}`.toLowerCase().includes(q); }); if (state.storageStatus === "Rating") items = sortItems(items, "rating"); else if (state.storageStatus === "Terpopuler") items = sortItems(items, "popular"); else items = sortItems(items, state.storageSort); const counts = { All: state.storageItems.length, Complete: state.storageItems.filter(isComplete).length, "Plan to Watch": state.storageItems.filter((i) => !i.progress).length, Dislike: state.storageItems.filter((i) => i.dislike || i.status === "dropped").length, Favorite: state.storageItems.filter((i) => i.favorite).length }; $$("#storageTabs .count").forEach((el) => el.textContent = counts[el.dataset.count] || 0); $$("#storageTabs .tab").forEach((el) => el.classList.toggle("active", el.dataset.tab === state.currentTab)); $("#editBar").hidden = !state.editMode; $("#editCount").textContent = `${state.selectedStorageItems.size} dipilih`;
  /* Slide 6×3 (desktop) / 3×3 (mobile): pager muncul hanya jika > 1 halaman */
  const size = pageSize(); const pageCount = pageCountFor(items.length, size);
  state.storagePage = Math.min(state.storagePage, pageCount - 1); state.filteredStorageCount = items.length;
  const paged = pageSlice(items, state.storagePage, size);
  const gridEl = $("#storageGrid");
  gridEl.innerHTML = state.storageFilterLoading ? `<div class="search-skeleton-grid">${[1,2].map(() => `<div class="skeleton-card"></div>`).join("")}</div>` : (paged.length ? paged.map((item) => cardHTML(item, { storageItem: item, storageSection: true, showProgress: true, removeMode: state.editMode, checkbox: state.editMode, selected: state.selectedStorageItems.has(item.slug) })).join("") : empty(state.storageItems.length ? "Tidak ada anime yang ditemukan." : "Belum ada anime di Local Storage.", state.storageItems.length ? "Coba ubah kata kunci, genre, atau kategori." : "Tambahkan anime dari tombol +Storage pada card."));
  const pagerSlot = $("#storagePager"); if (pagerSlot) pagerSlot.innerHTML = pageCount > 1 ? pagerHTML(state.storagePage, pageCount, "storage") : "";
  if (options.pageDir && !state.storageFilterLoading && paged.length) turnPageIn(gridEl, options.pageDir); else staggerIn(gridEl);
  observeScrollReveal(gridEl); bindPager(pagerSlot); bindActions(); }
function renderProfile() { applyProfile(); }
function renderAll() { renderProfile(); renderUpdates(); renderStorage(); renderSearch(); renderContinue(); bindActions(); }

/* ---------- Wave Physics Loader ----------
   Tongak + bola bouncing-ball. Fisikanya dihitung sekali jadi keyframe, lalu
   diputar lewat Web Animations API — bukan rAF — supaya loader tetap hidup
   walau tab tidak terlihat. Tinggi tongbak diubah lewat scaleY supaya tidak
   ada layout tiap frame. */
const WAVE_BARS = 15;
const WAVE_MAX_H = 64;
const WAVE_STEP = 20;
const WAVE_FRAMES = 81;
const WAVE_DURATION = 4000;
function buildWavePhysics() {
  const barScale = [], barOpacity = [], ballX = [], ballY = [], ballScale = [];
  for (let k = 0; k < WAVE_FRAMES; k += 1) {
    const t = k / (WAVE_FRAMES - 1);
    const xFrac = t < 0.5 ? t / 0.5 : (1 - t) / 0.5;
    const ballIdx = xFrac * (WAVE_BARS - 1);
    ballX.push(`${(ballIdx * WAVE_STEP).toFixed(2)}px`);
    let bounceF = (xFrac * 4) % 1;
    if (xFrac === 1 || xFrac === 0) bounceF = 0;
    const bounceH = 4 * bounceF * (1 - bounceF);
    const heightFactor = Math.max(0, 1 - bounceH * 2);
    ballY.push(`${(-((16 + 48 - heightFactor * 20) + bounceH * 60)).toFixed(2)}px`);
    /* WAAPI menolak scale(a b) — harus koma. Tanpa ini keyframe bola jadi
       kosong dan bola diam di tempat. */
    ballScale.push(`${(1 + heightFactor * 0.25).toFixed(4)}, ${(1 - heightFactor * 0.3).toFixed(4)}`);
    for (let i = 0; i < WAVE_BARS; i += 1) {
      const dist = Math.abs(i - ballIdx);
      const wave = dist < 3 ? Math.cos((dist / 3) * (Math.PI / 2)) : 0;
      const indent = dist < 1.5 ? Math.cos((dist / 1.5) * (Math.PI / 2)) * heightFactor * 20 : 0;
      barScale.push((Math.max(4, 16 + wave * 48 - indent) / WAVE_MAX_H).toFixed(4));
      barOpacity.push((0.34 + wave * 0.66).toFixed(4));
    }
  }
  return { barScale, barOpacity, ballX, ballY, ballScale };
}
const wavePhysics = buildWavePhysics();
/* Orb "searching" di dalam input pencarian. Dipasang sekali saat boot,
   lalu hanya dikendalikan lewat setBusy(). */
let orb = null;

/* ---------- Kunci input search saat permintaan berjalan ----------
   Setelah Enter, kolom dikunci sampai hasil benar-benar keluar atau gagal.
   Dipakai readOnly, bukan disabled: disabled membuat kolom kehilangan fokus dan
   caret, sedangkan yang kita mau adalah "tidak bisa di otak atik" tanpa
   membuat kolom terasa mati. */
function lockSearch(locked) {
  const input = $("#globalSearch");
  const wrap = $(".search-wrap");
  if (input) input.readOnly = locked;
  wrap?.classList.toggle("is-locked", locked);
  const sub = $("#searchSub");
  sub?.classList.toggle("shiny", locked);
}

/* ---------- Placeholder mesin ketik (text-type) ----------
   Mengganti placeholder statis "Cari anime…" dengan beberapa frasa yang
   diketik lalu dihapus bergantian. Berhenti saat input dipakai supaya tidak
   bertabrakan dengan ketikan pengguna, dan mati total saat reduced-motion. */
(function typePlaceholder() {
  const input = $("#globalSearch");
  if (!input || !input.placeholder) return;
  const PHRASES = ["Cari anime…", "Ketik judul atau genre…", "Contoh: Sailor moon "];
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
  if (reduced.matches) return;
  input.placeholder = PHRASES[0];
  let phrase = 0, chars = 0, deleting = false, timer = 0;
  const tick = () => {
    const current = PHRASES[phrase];
    chars += deleting ? -1 : 1;
    input.placeholder = current.slice(0, chars);
    let wait = deleting ? 45 : 95;
    if (!deleting && chars === current.length) { deleting = true; wait = 1500; }
    else if (deleting && chars === 0) { deleting = false; phrase = (phrase + 1) % PHRASES.length; wait = 500; }
    timer = setTimeout(tick, wait);
  };
  const stop = () => { clearTimeout(timer); timer = 0; };
  input.addEventListener("focus", stop, { once: true });
  input.addEventListener("input", stop, { once: true });
  /* Jangan mengetik ketika ada permintaan yang sedang jalan. */
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") stop(); });
  timer = setTimeout(tick, 900);
})();
function waveLoaderHTML(caption = "Memuat update terbaru…") {
  const bars = Array.from({ length: WAVE_BARS }, (_, index) => {
    /* Bentuk diam dipakai kalau Web Animations atau reduced-motion tidak
       tersedia: lengkung sinus ringan, bukan tongak rata. */
    const rest = 0.3 + 0.34 * Math.sin((Math.PI * (index + 0.5)) / WAVE_BARS);
    return `<span class="wave-bar" style="transform:scaleY(${rest.toFixed(3)})"></span>`;
  }).join("");
  const skeleton = Array.from({ length: 6 }, () => `<div class="fluid-skel update-skel-card"></div>`).join("");
  return `<div class="wave-loader" id="waveLoader" role="status" aria-live="polite">
      <div class="wave-stage">${bars}<span class="wave-ball"></span></div>
      <div class="wave-caption">${caption}</div>
    </div>${skeleton}`;
}
function startWavePhysics(root) {
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!root || reduced || document.documentElement.dataset.performanceTier === "low" || !root.querySelector(".wave-bar")?.animate) return;
  const timing = { duration: WAVE_DURATION, iterations: Infinity, easing: "linear" };
  $$(".wave-bar", root).forEach((bar, index) => {
    const from = index * WAVE_BARS;
    bar.animate({
      transform: wavePhysics.barScale.slice(from, from + WAVE_BARS).map((value) => `scaleY(${value})`),
      opacity: wavePhysics.barOpacity.slice(from, from + WAVE_BARS).map(String),
    }, timing);
  });
  $(".wave-ball", root)?.animate({
    transform: wavePhysics.ballScale.map((scale, index) => `translate(${wavePhysics.ballX[index]}, ${wavePhysics.ballY[index]}) scale(${scale})`),
  }, timing);
}
function renderUpdates() {
  const sub = $("#updateSub");
  const grid = $("#updateGrid");
  /* API butuh waktu memberi feedback, jadi selama itu section New Update
     menampilkan wave loader + fluid skeleton, bukan "Belum ada update". */
  if (state.updateLoading) {
    if (sub) sub.textContent = "Memuat update terbaru…";
    if (grid) { grid.innerHTML = waveLoaderHTML(); startWavePhysics($("#waveLoader", grid)); }
    return;
  }
  if (sub) sub.textContent = `New Update — ${state.daily.length} Title`;
  if (grid) grid.innerHTML = state.daily.length ? state.daily.map((a) => cardHTML(a, { epsBadge: "New Update", homeSection: true })).join("") : empty("Belum ada update.", "Coba lagi nanti.");
  staggerIn(grid); bindActions();
}
function renderSearch(options = {}) { const active = state.searchQuery || state.mainGenres.size || state.mainType || state.mainStatus; const section = $("#searchSection"); if (!active) { hideSection(section); if (orb) orb.setBusy(false); updateSearchUI(); return; } showSection(section); let items = state.searchResults.filter((a) => typeMatches(a, state.mainType) && statusMatches(a, state.mainStatus)); if (state.mainStatus === "Rating") items = sortItems(items, "rating"); else if (state.mainStatus === "Terpopuler") items = sortItems(items, "popular"); $("#searchSub").textContent = state.searchLoading ? "Mencari…" : `${items.length} hasil`;
  /* Slide 6×3 (desktop) / 3×3 (mobile): pager muncul hanya jika > 1 halaman */
  const size = pageSize(); const pageCount = pageCountFor(items.length, size);
  state.searchPage = Math.min(state.searchPage, pageCount - 1); state.filteredSearchCount = items.length;
  const paged = pageSlice(items, state.searchPage, size);
  const gridEl = $("#searchGrid");
  /* Skeleton search disuntik LANGSUNG ke .card-grid, sama seperti
     renderUpdates(). Sebelumnya dibungkus .search-skeleton-grid, dan
     wrapper itu jadi satu cell grid — akibatnya kartu skeleton turun ke
     bawah satu per satu, bukan mendatar seperti kartu hasil aslinya.
     Loader-nya juga disamakan dengan New Update: wave physics + fluid
     skeleton, supaya tidak ada dua bahasa loading di aplikasi yang sama. */
  if (state.searchLoading) {
    gridEl.innerHTML = waveLoaderHTML("Mencari…");
    startWavePhysics($("#waveLoader", gridEl));
    if (orb) orb.setBusy(true);
    lockSearch(true);
  } else {
    lockSearch(false);
    if (orb) orb.setBusy(false);
    gridEl.innerHTML = paged.length ? paged.map((a) => cardHTML(a, { showProgress: true, inStorage: Boolean(getStored(a.slug)) })).join("") : empty("Tidak ada anime yang ditemukan.", "Coba ubah kata kunci atau filter.");
  }
  const pagerSlot = $("#searchPager"); if (pagerSlot) pagerSlot.innerHTML = pageCount > 1 ? pagerHTML(state.searchPage, pageCount, "search") : "";
  if (options.deal && !state.searchLoading && paged.length) dealCards(gridEl);
  else if (options.pageDir && !state.searchLoading && paged.length) turnPageIn(gridEl, options.pageDir);
  else staggerIn(gridEl);
  observeScrollReveal(gridEl); bindPager(pagerSlot); bindActions(); updateSearchUI(); }

/* Animasi buka/tutup section search */
function showSection(section) {
  if (!section.hidden) return;
  section.hidden = false;
  section.classList.add("section-in");
  section.addEventListener("animationend", () => section.classList.remove("section-in"), { once: true });
  window.setTimeout(() => section.classList.remove("section-in"), 450);
}
function hideSection(section) {
  if (section.hidden) return;
  section.classList.add("section-out");
  const finish = () => { section.hidden = true; section.classList.remove("section-out"); };
  section.addEventListener("animationend", finish, { once: true });
  window.setTimeout(finish, 300);
}

/* Pencarian gabungan: nama + genre dikirim ke server; tipe & status difilter
   dari hasil yang sama di sisi klien (endpoint server hanya menerima search
   + genre). Satu tekan cari = nama + genre + tipe + status sekaligus. */
async function search(query = state.searchQuery) {
  state.searchQuery = String(query || "").trim();
  const input = $("#globalSearch"); if (input && input.value !== state.searchQuery) input.value = state.searchQuery;
  state.searchLoading = true; state.searchResults = []; state.searchPage = 0; renderSearch(); const token = ++state.searchToken;
  try {
    const selectedGenres = [...state.mainGenres]; const results = [];
    if (selectedGenres.length) { for (const genre of selectedGenres) { const part = await timed(api.catalog(state.searchQuery, genre)); results.push(...(part.data || [])); } }
    else { const result = await timed(api.catalog(state.searchQuery, "")); results.push(...(result.data || [])); }
    if (token !== state.searchToken) return;
    state.searchResults = [...new Map(results.map((item) => [item.slug || item.id || item.title, item])).values()].map(normAnime);
    state.searchLoading = false; renderSearch({ deal: true });
  } catch (error) {
    if (token !== state.searchToken) return;
    state.searchResults = []; state.searchLoading = false; $("#searchSub").textContent = error.message; renderSearch();
  }
}

/* ---------- Search main: hint, chip pilihan, morph Search↔X ---------- */
function activeSearchPicks() {
  const picks = [];
  [...state.mainGenres].forEach((slug) => picks.push({ kind: "genre", label: labelForGenre(slug), slug }));
  if (state.mainType) picks.push({ kind: "tipe", label: state.mainType });
  if (state.mainStatus) picks.push({ kind: "status", label: state.mainStatus });
  return picks;
}
function updateSearchUI() {
  const picks = activeSearchPicks();
  const hasPicks = picks.length > 0;
  /* Ketikan hidup juga dihitung agar chip naik ke dalam search SEGERA saat
     pengguna menulis nama, bukan hanya setelah Enter. */
  const liveQuery = ($("#globalSearch")?.value || "").trim();
  const hasQuery = Boolean(liveQuery || state.searchQuery);
  const hasSearched = Boolean(state.searchQuery || state.searchResults.length);
  const hint = $("#searchHint"), tags = $("#searchHintTags"), chips = $("#searchFilterChips"), morph = $("#searchMorphBtn");
  /* Pemilihan saja → hint dropdown "Cari sesuai pilihan" di bawah kotak.
     Pemilihan + nama → hint naik jadi chip di dalam kotak search. */
  if (hint) {
    hint.hidden = !(hasPicks && !hasQuery);
    /* Bersihkan isi saat tersembunyi agar tidak menyisakan tag basi */
    tags.innerHTML = !hint.hidden ? picks.map((p) => `<span class="sh-tag">${esc(p.label)}</span>`).join("") : "";
  }
  if (chips) {
    chips.hidden = !(hasPicks && hasQuery);
    /* Kosongkan saat tersembunyi — jangan tinggalkan chip basi di dalam DOM */
    chips.innerHTML = !chips.hidden ? picks.map((p) => `<button class="sf-chip" data-chip-kind="${p.kind}" data-chip-key="${esc(p.slug || p.label)}" title="Hapus pilihan ini">${esc(p.label)}<svg class="ico"><use href="#i-close"/></svg></button>`).join("") : "";
    if (!chips.hidden) $$("[data-chip-kind]", chips).forEach((btn) => btn.onclick = (event) => { event.stopPropagation(); removeSearchPick(btn.dataset.chipKind, btn.dataset.chipKey); });
  }
  if (morph) {
    morph.classList.toggle("is-clear", hasSearched);
    morph.dataset.mode = hasSearched ? "clear" : "search";
    morph.title = hasSearched ? "Bersihkan pencarian & pilihan" : "Cari";
  }
  $(".search-wrap")?.classList.toggle("has-picks", hasPicks);
}
function removeSearchPick(kind, key) {
  if (kind === "genre") {
    state.mainGenres.delete(key);
    $(`.gf-header .gf-chip[data-genre="${CSS.escape(key)}"]`)?.classList.remove("on");
    updateFilterLabel($(".gf-header"), state.mainGenres, "All Genre");
  } else if (kind === "tipe") { state.mainType = ""; resetDropdownUI("mainType"); }
  else { state.mainStatus = ""; resetDropdownUI("mainStatus"); }
  renderSearch(); updateSearchUI();
}
function resetDropdownUI(key) {
  const root = $(`.styled-filter[data-filter="${key}"]`);
  if (!root) return;
  $(".gf-label", root).textContent = root.dataset.label || "—";
  root.classList.remove("has-active-root");
  $(".gf-trigger", root).classList.remove("has-active");
  $$(".gf-chip.on", root).forEach((b) => b.classList.remove("on"));
}
/* X di search main: bersihkan kata kunci + semua pilihan (genre/tipe/status)
   + hasil sekaligus. */
function clearAllSearch() {
  const input = $("#globalSearch");
  if (input) input.value = "";
  state.searchQuery = ""; state.searchResults = []; state.searchPage = 0;
  state.mainType = ""; state.mainStatus = "";
  $(".gf-header [data-gf-clear]")?.click();
  resetDropdownUI("mainType"); resetDropdownUI("mainStatus");
  renderSearch(); updateSearchUI();
}

/* ---------- Tema: morph icon sun/moon + transisi warna halaman ----------
   View Transitions API untuk crossfade warna dark↔light; browser tanpa
   dukungan dapat fallback fade ringan. Tanpa slide kanan-kiri. */
function applyTheme(theme, { animate = false } = {}) {
  const rootEl = document.documentElement;
  const commit = () => {
    rootEl.dataset.theme = theme;
    $$("[data-theme-toggle]").forEach((btn) => btn.classList.toggle("is-light", theme === "light"));
  };
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!animate || reduced || typeof document.startViewTransition !== "function") {
    if (animate && !reduced) rootEl.animate?.([{ opacity: 0.88 }, { opacity: 1 }], { duration: 240, easing: "ease-out" });
    commit();
    return;
  }
  document.startViewTransition(commit);
}
/* ---------- Urutan tombol + ----------
   cross-spinner → tombol bergetar + sapuan shine + partikel kilau → tombol
   pecah → baru anime masuk ke Local Storage. Semua murni CSS/WAAPI; kalau
   pengguna minta reduced motion atau tier rendah, commit langsung. */
const ADD_FX_SPIN_MS = 460;
const ADD_FX_SHAKE_MS = 280;
const ADD_FX_BURST_MS = 300;
const ADD_FX_SPARKS = 14;
function addFxBurst(button) {
  const rect = button.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  const layer = document.createElement("div");
  layer.className = "add-fx";
  layer.style.left = `${rect.left}px`;
  layer.style.top = `${rect.top}px`;
  layer.style.width = `${rect.width}px`;
  layer.style.height = `${rect.height}px`;
  const sweep = document.createElement("div");
  sweep.className = "add-fx-sweep";
  layer.appendChild(sweep);
  /* Partikel meledak radial dari tengah tombol, setengah emas setengah putih. */
  for (let index = 0; index < ADD_FX_SPARKS; index += 1) {
    const angle = (Math.PI * 2 * index) / ADD_FX_SPARKS + (index % 3) * 0.22;
    const distance = 26 + (index % 4) * 13;
    const spark = document.createElement("i");
    spark.className = index % 2 ? "add-fx-spark gold" : "add-fx-spark";
    spark.style.left = "50%";
    spark.style.top = "50%";
    spark.style.setProperty("--dx", `${(Math.cos(angle) * distance).toFixed(1)}px`);
    spark.style.setProperty("--dy", `${(Math.sin(angle) * distance).toFixed(1)}px`);
    spark.style.animationDelay = `${(index % 4) * 22}ms`;
    layer.appendChild(spark);
  }
  document.body.appendChild(layer);
  return layer;
}
function playAddSequence(button, commit) {
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!button || reduced || document.documentElement.dataset.performanceTier === "low") { commit(); return; }
  button.classList.add("btn-add-busy");
  const spinner = document.createElement("span");
  spinner.className = "cross-spinner is-on";
  spinner.innerHTML = "<i></i><i></i>";
  button.appendChild(spinner);
  let layer = null;
  setTimeout(() => {
    spinner.remove();
    button.classList.add("btn-add-shake");
    layer = addFxBurst(button);
    setTimeout(() => {
      button.classList.remove("btn-add-shake");
      button.classList.add("btn-add-burst");
      setTimeout(() => {
        layer?.remove();
        button.classList.remove("btn-add-busy", "btn-add-burst");
        commit();
      }, ADD_FX_BURST_MS);
    }, ADD_FX_SHAKE_MS);
  }, ADD_FX_SPIN_MS);
}
function commitAddStorage(id) {
  const a = normAnime(findAnime(id));
  if (!a || getStored(a.slug)) return;
  state.storageItems.unshift(normalizeStored({ slug: a.slug, title: a.title, image: a.image, total: a.total, status: "planned", progress: 0, watchedEpisodes: [], genres: a.genres }));
  saveState(); renderAll();
  toast("Ditambahkan ke Local Storage", a.title);
}
function addStorage(id, button) {
  const a = normAnime(findAnime(id));
  if (!a || getStored(a.slug)) return;
  playAddSequence(button, () => commitAddStorage(id));
}
function removeStorage(id) { const removed = state.storageItems.find((i) => i.slug === id); state.storageItems = state.storageItems.filter((i) => i.slug !== id); state.selectedStorageItems.delete(id); saveState(); renderAll(); toast("Berhasil dihapus", `${removed?.title || "Anime"} dihapus dari Local Storage.`); }
/* Favorite / Dislike dari detail page: membuat entri storage bila belum ada,
   lalu toggle reaksinya (saling eksklusif). Tombol di-update langsung tanpa
   renderDetail penuh agar player yang sedang berjalan tidak ikut ter-reset. */
function setAnimeReaction(slug, kind) {
  let item = getStored(slug);
  if (!item) {
    const a = normAnime(findAnime(slug) || state.detail);
    if (!a?.slug) return;
    state.storageItems.unshift(normalizeStored({ slug: a.slug, title: a.title, image: a.image, total: a.total, status: "watching", progress: 0, watchedEpisodes: [], genres: a.genres }));
    item = getStored(a.slug);
  }
  if (!item) return;
  const next = kind === "favorite" ? { favorite: !item.favorite, dislike: false } : { dislike: !item.dislike, favorite: false };
  Object.assign(item, next);
  saveState();
  if (next.favorite) toast("Ditambahkan ke Favorite", item.title || "Anime");
  else if (next.dislike) toast("Ditandai Dislike", item.title || "Anime");
  const stored = getStored(slug);
  const favBtn = $("[data-detail-fav]"), disBtn = $("[data-detail-dislike]");
  if (favBtn) { favBtn.classList.toggle("is-fav", Boolean(stored?.favorite)); favBtn.setAttribute("aria-pressed", String(Boolean(stored?.favorite))); $(".rb-label", favBtn).textContent = stored?.favorite ? "Favorit" : "Favorite"; }
  if (disBtn) { disBtn.classList.toggle("is-dislike", Boolean(stored?.dislike)); disBtn.setAttribute("aria-pressed", String(Boolean(stored?.dislike))); }
  renderProfile(); renderStorage();
}
/* options.silent = true melewati animasi "Menghapus data…". Animasi itu
   bernada perpisahan dan hanya cocok untuk penghapusan permanen; untuk
   aksi lain (mis. reset progress) hanya membingungkan. */
function openConfirm(title, message, onConfirm, options = {}) { const root = $("#confirmRoot"); /* Dialog bersifat modal: jangan menumpuk kalau pemicu terpicu dua kali (mis. hold selesai dua kali). */ root.querySelectorAll(".overlay").forEach((lama) => lama.remove()); const overlay = document.createElement("div"); overlay.className = "overlay"; const confirmLabel = options.confirmLabel || "Hapus"; const confirmClass = options.confirmClass || "btn btn-danger"; overlay.innerHTML = `<div class="confirm-modal${options.silent ? "" : " destructive"}" role="dialog" aria-modal="true"><div class="confirm-alert"><svg class="ico"><use href="#i-alert"/></svg></div><h3>${esc(title)}</h3><p>${esc(message)}</p><div class="confirm-actions">${options.hold ? `<button class="${confirmClass} hold-btn" data-confirm title="Tahan ${(options.hold / 1000).toFixed(1)} detik untuk menghapus"><span class="hold-fill"></span>${esc(confirmLabel)} — Hold ${(options.hold / 1000).toFixed(1)}s</button>` : `<button class="${confirmClass}" data-confirm>${esc(confirmLabel)}</button>`}<button class="btn btn-ghost" data-cancel>Batal</button></div></div>`; root.appendChild(overlay); const close = () => { overlay.classList.add("is-closing"); $(".confirm-modal", overlay).classList.add("is-closing"); setTimeout(() => overlay.remove(), 220); }; const runConfirm = () => { close(); setTimeout(() => (options.silent ? onConfirm() : playEraseSequence(onConfirm)), 230); }; $("[data-cancel]", overlay).onclick = close; const confirmBtn = $("[data-confirm]", overlay); /* Hapus-total jadi tahan tombol, sama seperti Delete Data di sidebar: satu klik tak boleh menghapus semua koleksi. */ if (options.hold) holdable(confirmBtn, options.hold, runConfirm); else confirmBtn.onclick = runConfirm; overlay.onclick = (e) => { if (e.target === overlay) close(); }; }
/* Alert popup sederhana (bukan window.alert) — gaya sama dengan confirm */
function openAlert(title, message) { const root = $("#confirmRoot"); const overlay = document.createElement("div"); overlay.className = "overlay"; overlay.innerHTML = `<div class="confirm-modal" role="alertdialog" aria-modal="true"><div class="confirm-alert warn"><svg class="ico"><use href="#i-alert"/></svg></div><h3>${esc(title)}</h3><p>${esc(message)}</p><div class="confirm-actions"><button class="btn btn-primary" data-alert-close>Mengerti</button></div></div>`; root.appendChild(overlay); const close = () => { overlay.classList.add("is-closing"); setTimeout(() => overlay.remove(), 220); }; $("[data-alert-close]", overlay).onclick = close; overlay.onclick = (e) => { if (e.target === overlay) close(); }; }
/* Urutan hapus data: overlay sad.jpg + progress erase, lalu jalankan aksi */
function playEraseSequence(onDone) {
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduced) { onDone(); return; }
  const wrap = document.createElement("div");
  wrap.className = "erase-overlay";
  wrap.innerHTML = `<div class="erase-card"><img class="erase-sad" src="/assets/sad.jpg" alt="Sedih kehilangan data"><div class="erase-title">Menghapus data…</div><div class="erase-sub">Koleksi dan progresmu sedang dihapus. Semoga bertemu lagi di lain pengaturan.</div><div class="erase-track"><i class="erase-fill"></i></div><div class="erase-pct">0%</div></div>`;
  document.body.appendChild(wrap);
  const fill = $(".erase-fill", wrap), pct = $(".erase-pct", wrap);
  const started = performance.now();
  const DURATION = 1800;
  const tick = (now) => {
    const p = Math.min(1, (now - started) / DURATION);
    fill.style.width = `${p * 100}%`;
    pct.textContent = `${Math.round(p * 100)}%`;
    if (p < 1) requestAnimationFrame(tick);
    else { $(".erase-card", wrap).classList.add("erase-done"); setTimeout(() => { wrap.remove(); onDone(); }, 650); }
  };
  requestAnimationFrame(tick);
}
function holdable(el, duration, onDone) { if (!el) return; let raf = 0; let start = 0; let holding = false; const stop = (done = false) => { holding = false; cancelAnimationFrame(raf); el.style.setProperty("--hold", done ? 1 : 0); if (done) onDone(); }; const tick = () => { if (!holding) return; const progress = Math.min(1, (performance.now() - start) / duration); el.style.setProperty("--hold", progress); if (progress >= 1) stop(true); else raf = requestAnimationFrame(tick); }; el.addEventListener("pointerdown", (e) => { if (e.button !== 0) return; e.preventDefault(); holding = true; start = performance.now(); raf = requestAnimationFrame(tick); }); ["pointerup", "pointerleave", "pointercancel"].forEach((event) => el.addEventListener(event, () => stop(false))); }
function markWatched(number) { const a = state.detail; if (!a) return; const current = getStored(a.slug) || normalizeStored({ slug: a.slug, title: a.title, image: a.image, total: a.total, watchedEpisodes: [], progress: 0, status: "watching", genres: a.genres }); current.watchedEpisodes = [...new Set([...(current.watchedEpisodes || []), Number(number)])].sort((x, y) => x - y); current.progress = Math.max(current.progress, Number(number)); current.status = isComplete(current) ? "completed" : "watching"; current.lastWatchedAt = Date.now(); state.storageItems = [...state.storageItems.filter((i) => i.slug !== current.slug), current]; saveState(); renderProfile(); renderStorage(); renderContinue(); syncWatchedMarks(); }

/* ---------- Jam tonton: episode hanya dicentang setelah benar-benar ditonton ----------
   Dulu episode langsung dicentang begitu iframe selesai dimuat. Akibatnya
   pengguna yang kebetulan membuka lalu menutup episode ikut tercentang, dan
   "Lanjutkan Menonton" melompat ke episode berikutnya. Centang baru muncul
   setelah nonton cukup lama.

   Mirror berada di iframe lintas domain, jadi posisi playback tidak bisa
   dibaca dari sini. Yang dipakai adalah waktu tempel (wall clock) selama
   modal terbuka dan tab sedang terlihat. */
const WATCHED_SECONDS = 600;
let watchClock = { number: 0, elapsed: 0, timer: null, committed: false };

function startWatchClock(number) {
  stopWatchClock();
  watchClock = { number: Number(number), elapsed: 0, timer: null, committed: false };
  if (!Number.isFinite(watchClock.number) || watchClock.number <= 0) return;
  watchClock.timer = setInterval(() => {
    /* Tab tersembunyi atau minimize tidak dihitung sebagai menonton. */
    if (document.visibilityState !== "visible" || !state.detail) return;
    watchClock.elapsed += 5;
    if (watchClock.elapsed >= WATCHED_SECONDS) commitWatchClock();
  }, 5000);
}
function commitWatchClock() {
  if (watchClock.committed) return;
  watchClock.committed = true;
  const number = watchClock.number;
  stopWatchClock();
  markWatched(number);
  toast("Episode ditandai ditonton", `EP ${String(number).padStart(2, "0")} sudah cukup ditonton.`);
}
function stopWatchClock() {
  clearInterval(watchClock.timer);
  watchClock = { number: 0, elapsed: 0, timer: null, committed: false };
}

/* Centang di daftar episode diperbarui tanpa renderDetail(), karena
   renderDetail() mengosongkan #playerBox dan player yang sedang berjalan
   ikut ter-reset. */
function syncWatchedMarks() {
  const slug = state.detail?.slug;
  if (!slug) return;
  const watched = new Set((getStored(slug)?.watchedEpisodes || []).map(Number));
  $$("#episodeList .ep-item").forEach((button) => {
    const on = watched.has(Number(button.dataset.episodeNumber));
    button.classList.toggle("watched", on);
    const mark = $(".st", button);
    if (mark) mark.textContent = on ? "✓" : "";
  });
}

/* ---------- Hapus seluruh data lokal ----------
   Koleksi/progres TIDAK CUMA dihapus: prefs (nama, foto, tema, sidebar) juga
   dikembalikan ke bawaan. Sebelumnya prefs tidak pernah disentuh sehingga
   nama dan foto profil tetap nempel padahal pesan konfirmasinya menjanjikan
   semuanya terhapus. */
function deleteAllLocal() {
  state.storageItems = [];
  state.selectedStorageItems.clear();
  state.currentTab = "All";
  state.localQuery = "";
  state.storageGenres.clear();
  state.editMode = false;
  prefs = { ...DEFAULT_PREFS };
  localStorage.removeItem(PREFS_KEY);
  saveState();
  applyTheme(prefs.theme);
  $("#app").classList.remove("collapsed");
  $("#profilePopup").hidden = true;
  renderAll();
  toast("Data lokal dihapus", "Koleksi, progres, dan profil sudah kembali ke awal.");
}

/* ---------- Reset progress ----------
   Mengosongkan episode yang ditandai, mengembalikan status ke "planned", lalu
   memutar ulang dari episode pertama. Item tetap ada di Local Storage. */
function resetProgress(slug) {
  const item = getStored(slug);
  if (!item) return;
  stopWatchClock();
  item.watchedEpisodes = [];
  item.progress = 0;
  item.status = "planned";
  delete item.lastWatchedAt;
  state.storageItems = state.storageItems.map((i) => (i.slug === slug ? item : i));
  saveState(); renderProfile(); renderStorage(); renderContinue();
  const first = state.detail?.episodes?.[0];
  if (first?.slug) playEpisode(first.slug, Number(first.number), null);
  else renderDetail();
  toast("Progress direset", `${item.title} kembali ke Episode 1.`);
}

async function playEpisode(slug, number, button) { const episodes = state.detail?.episodes || []; const newIndex = episodes.findIndex((e) => e.slug === slug); const direction = newIndex > state.episodeIndex ? "right" : "left"; state.episodeIndex = newIndex; startWatchClock(number); renderDetail(); updateEpisodeNav(); $("#playerBox").innerHTML = `<div class="player-loading"><div class="spinner"></div></div>`; try { const response = await api.mirrors(slug); state.mirrors = response.data || []; if (!state.mirrors.length) throw new Error("Mirror tidak tersedia saat ini."); state.mirrorIndex = 0; loadMirror(0, direction); button?.classList.add("watched"); } catch (error) { state.mirrors = []; state.mirrorIndex = 0; $("#mirrorLabel").textContent = "Mirror tidak tersedia"; $("#playerBox").innerHTML = `<div class="player-ph"><div class="msg">${esc(error.message)}</div></div>`; } }
function loadMirror(index, direction = "right") { const mirror = state.mirrors[index]; if (!mirror) return; state.mirrorIndex = index; const box = $("#playerBox"); box.classList.add("mirror-fading"); setTimeout(() => { box.innerHTML = `<iframe src="${esc(mirror.url)}" title="Anime stream" allow="autoplay; fullscreen; picture-in-picture" allowfullscreen></iframe>`; box.classList.remove("mirror-fading"); box.classList.add(`mirror-in-${direction === "left" ? "left" : "right"}`); box.addEventListener("animationend", () => box.classList.remove("mirror-in-right", "mirror-in-left"), { once: true }); showVideoControls(); }, 170); $("#mirrorLabel").textContent = mirror.name || `Mirror ${index + 1}`; $("#mirrorOptions").innerHTML = state.mirrors.map((m, i) => `<button data-mirror-index="${i}" class="${i === index ? "active" : ""}">${esc(m.name || `Mirror ${i + 1}`)}</button>`).join(""); closeActive(); $$("#mirrorOptions [data-mirror-index]").forEach((b) => b.onclick = (event) => { event.stopPropagation(); loadMirror(Number(b.dataset.mirrorIndex), Number(b.dataset.mirrorIndex) > index ? "right" : "left"); }); $("#mirrorNote").textContent = "Mirror aktif dari source streaming. Jika gagal, pilih mirror lain."; }
function renderDetail() { const a = state.detail; const item = getStored(a.slug); $("#watchTitle").textContent = a.title; $("#watchSub").textContent = `${a.type || "Series"} · ${a.status || "Unknown"}`; const epMulai = cwNextFor(item || {}) || (a.episodes || [])[0]; $("#playerBox").innerHTML = (a.episodes || []).length ? `<div class="player-ph"><button class="play-cta" type="button" data-player-start aria-label="Mulai episode ${esc(String(epMulai?.number ?? 1))}"><svg class="ico"><use href="#i-play"/></svg><span>Mulai EP ${String(epMulai?.number ?? 1).padStart(2, "0")}</span></button><div class="msg">${item?.watchedEpisodes?.length ? "Lanjut ke episode berikutnya, atau pilih di daftar." : "Satu klik untuk mulai — atau pilih episode di daftar."}</div></div>` : `<div class="player-ph"><div class="msg">Episode belum tersedia.</div></div>`; const tombolMulai = $("[data-player-start]"); if (tombolMulai && epMulai?.slug) tombolMulai.onclick = () => playEpisode(epMulai.slug, Number(epMulai.number), null); $("#watchDetailGrid").innerHTML = `<div class="detail-item"><div class="k">Episodes</div><div class="v">${a.episodes?.length || a.total || "?"}</div></div><div class="detail-item"><div class="k">Rating</div><div class="v">${a.rating || "—"}</div></div><div class="detail-item"><div class="k">Studio</div><div class="v">${esc(a.studio || "—")}</div></div>`; $("#watchSynopsis").textContent = a.synopsis || "Sinopsis belum tersedia dari source."; $("#watchGenres").innerHTML = (a.genres || []).map((g) => `<span class="chip">${esc(g.name || g)}</span>`).join(""); const favOn = Boolean(item?.favorite), disOn = Boolean(item?.dislike);
$("#watchActions").innerHTML = `<button class="btn react-btn${favOn ? " is-fav" : ""}" data-detail-fav aria-pressed="${favOn}" title="Favorite"><svg class="ico"><use href="#i-star"/></svg><span class="rb-label">${favOn ? "Favorit" : "Favorite"}</span></button><button class="btn react-btn${disOn ? " is-dislike" : ""}" data-detail-dislike aria-pressed="${disOn}" title="Dislike"><svg class="ico"><use href="#i-thumb-down"/></svg><span class="rb-label">Dislike</span></button><button class="btn btn-primary" data-detail-add>${item ? "Saved locally" : "+Storage"}</button><button class="btn reset-btn" data-detail-reset ${item && (item.watchedEpisodes?.length || item.progress) ? "" : "disabled"} title="Ulangi dari Episode 1"><svg class="ico"><use href="#i-refresh"/></svg><span class="rb-label">Reset</span></button><button class="btn" data-detail-prev ${state.episodeIndex <= 0 ? "disabled" : ""}>← Previous</button><button class="btn" data-detail-next ${state.episodeIndex >= (a.episodes?.length || 1) - 1 ? "disabled" : ""}>Next →</button>`; $("#episodeList").innerHTML = (a.episodes || []).map((ep, index) => `<button class="ep-item ${item?.watchedEpisodes?.includes(Number(ep.number)) ? "watched" : ""}" data-episode-slug="${esc(ep.slug)}" data-episode-number="${esc(ep.number)}"><span class="st">${item?.watchedEpisodes?.includes(Number(ep.number)) ? "✓" : ""}</span><span>EP ${String(ep.number).padStart(2, "0")} · ${esc(ep.title || "Episode")}</span></button>`).join("") || empty("Episode belum tersedia.", "Source belum mengembalikan episode."); $("[data-detail-add]").onclick = (event) => addStorage(a.slug, event.currentTarget); $("[data-detail-reset]").onclick = () => { const item = getStored(a.slug); if (!item) return; openConfirm("Reset progress?", `Semua centang episode ${item.title} akan dihapus dan mulai lagi dari Episode 1.`, () => resetProgress(a.slug), { silent: true, confirmLabel: "Reset", confirmClass: "btn btn-primary" }); }; $("[data-detail-fav]").onclick = () => setAnimeReaction(a.slug, "favorite"); $("[data-detail-dislike]").onclick = () => setAnimeReaction(a.slug, "dislike"); $("[data-detail-prev]").onclick = () => navigateEpisode(-1); $("[data-detail-next]").onclick = () => navigateEpisode(1); $$('[data-episode-slug]').forEach((b) => b.onclick = () => playEpisode(b.dataset.episodeSlug, Number(b.dataset.episodeNumber), b)); }
function navigateEpisode(delta) { const episodes = state.detail?.episodes || []; const target = episodes[state.episodeIndex + delta]; if (!target) return; playEpisode(target.slug, Number(target.number), null); updateEpisodeNav(); }
function updateEpisodeNav() { $("[data-detail-prev]")?.toggleAttribute("disabled", state.episodeIndex <= 0); $("[data-detail-next]")?.toggleAttribute("disabled", state.episodeIndex >= (state.detail?.episodes?.length || 1) - 1); /* Sinkronkan tombol overlay video */ const prev = $("#prevEpBtn"), next = $("#nextEpBtn"); prev?.toggleAttribute("disabled", state.episodeIndex <= 0); next?.toggleAttribute("disabled", state.episodeIndex >= (state.detail?.episodes?.length || 1) - 1); }

/* ---------- In-video control overlay ----------
   Klik di area video memunculkan kontrol (mirror, prev/next, PiP);
   toolbar tetap tersedia, sementara area iframe tetap menerima klik video. */
const videoOverlay = $("#videoOverlay");
const playerStage = $("#playerStage");
let voHideTimer = 0;
function showVideoControls() {
  if (!videoOverlay || videoOverlay.closest("#watchOverlay")?.hidden) return;
  if (!state.mirrors.length) return;
  videoOverlay.hidden = false;
  videoOverlay.classList.add("show");
}
function hideVideoControls() { videoOverlay?.classList.remove("show"); clearTimeout(voHideTimer); }
/* Dengarkan klik dari stage, bukan dari lapisan di atas iframe. Dengan begitu
   klik pertama tetap diterima kontrol play milik mirror di dalam iframe. */
playerStage?.addEventListener("click", (event) => {
  if (event.target.closest("#videoOverlay")) return;
  showVideoControls();
});
playerStage?.addEventListener("pointerenter", showVideoControls);
playerStage?.addEventListener("pointermove", showVideoControls);
videoOverlay?.addEventListener("click", (event) => {
  /* Klik pada area kosong overlay (di luar bar) menyembunyikan kontrol */
  if (event.target === videoOverlay) { hideVideoControls(); return; }
  if (!event.target.closest(".vo-bar")) return;
  clearTimeout(voHideTimer);
  voHideTimer = window.setTimeout(hideVideoControls, 3000);
});
$("#prevEpBtn")?.addEventListener("click", () => { if (state.episodeIndex > 0) navigateEpisode(-1); });
$("#nextEpBtn")?.addEventListener("click", () => { const total = state.detail?.episodes?.length || 0; if (state.episodeIndex < total - 1) navigateEpisode(1); });

/* ---------- Draggable mini popup player (Picture-in-Picture-like) ----------
   Untuk iframe cross-origin, gunakan floating PiP di dokumen yang sama.
   Memindahkan iframe ke Document PiP lintas window dapat membuat browser
   me-reparent/reload browsing context dan menimbulkan jeda atau reset waktu.
   Floating PiP memindahkan node iframe yang sama tanpa mengganti src. */
let pipPort = null;
let pipDragCleanup = null;
const SEAMLESS_IFRAME_PIP = true;
function clampPipPosition(el, left, top) {
  const rect = el.getBoundingClientRect();
  const maxLeft = Math.max(0, window.innerWidth - rect.width);
  const maxTop = Math.max(0, window.innerHeight - rect.height);
  return { left: Math.max(0, Math.min(Number(left) || 0, maxLeft)), top: Math.max(0, Math.min(Number(top) || 0, maxTop)) };
}
function setPipPosition(el, left, top) {
  const position = clampPipPosition(el, left, top);
  el.style.left = `${position.left}px`;
  el.style.top = `${position.top}px`;
  el.style.right = "auto";
  el.style.bottom = "auto";
  return position;
}
function setupPipDrag(el) {
  const handle = el.querySelector("[data-pip-drag-handle]");
  if (!handle) return;
  const initial = el.getBoundingClientRect();
  setPipPosition(el, initial.left, initial.top);
  const saved = (() => { try { return JSON.parse(sessionStorage.getItem("iln:pip-position") || "null"); } catch { return null; } })();
  if (saved && Number.isFinite(saved.left) && Number.isFinite(saved.top)) setPipPosition(el, saved.left, saved.top);
  let dragging = false;
  let offsetX = 0;
  let offsetY = 0;
  const onPointerDown = (event) => {
    if (event.button !== undefined && event.button !== 0) return;
    if (event.target.closest("button")) return;
    const rect = el.getBoundingClientRect();
    dragging = true;
    offsetX = event.clientX - rect.left;
    offsetY = event.clientY - rect.top;
    el.classList.add("is-dragging");
    handle.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  };
  const onPointerMove = (event) => {
    if (!dragging) return;
    const position = setPipPosition(el, event.clientX - offsetX, event.clientY - offsetY);
    try { sessionStorage.setItem("iln:pip-position", JSON.stringify(position)); } catch { }
  };
  const stop = (event) => {
    if (!dragging) return;
    dragging = false;
    el.classList.remove("is-dragging");
    if (event?.pointerId !== undefined) handle.releasePointerCapture?.(event.pointerId);
    const rect = el.getBoundingClientRect();
    try { sessionStorage.setItem("iln:pip-position", JSON.stringify({ left: rect.left, top: rect.top })); } catch { }
  };
  const onKeyDown = (event) => {
    if (!event.altKey || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home"].includes(event.key)) return;
    const rect = el.getBoundingClientRect();
    const step = event.shiftKey ? 80 : 24;
    const next = event.key === "Home" ? { left: window.innerWidth - rect.width - 20, top: window.innerHeight - rect.height - 20 } : {
      left: rect.left + (event.key === "ArrowRight" ? step : event.key === "ArrowLeft" ? -step : 0),
      top: rect.top + (event.key === "ArrowDown" ? step : event.key === "ArrowUp" ? -step : 0),
    };
    setPipPosition(el, next.left, next.top);
    const position = el.getBoundingClientRect();
    try { sessionStorage.setItem("iln:pip-position", JSON.stringify({ left: position.left, top: position.top })); } catch { }
    event.preventDefault();
  };
  const onViewportChange = () => { const rect = el.getBoundingClientRect(); setPipPosition(el, rect.left, rect.top); };
  handle.addEventListener("pointerdown", onPointerDown);
  handle.addEventListener("pointermove", onPointerMove);
  handle.addEventListener("pointerup", stop);
  handle.addEventListener("pointercancel", stop);
  handle.addEventListener("keydown", onKeyDown);
  window.addEventListener("resize", onViewportChange);
  window.addEventListener("orientationchange", onViewportChange);
  pipDragCleanup = () => {
    handle.removeEventListener("pointerdown", onPointerDown);
    handle.removeEventListener("pointermove", onPointerMove);
    handle.removeEventListener("pointerup", stop);
    handle.removeEventListener("pointercancel", stop);
    handle.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("resize", onViewportChange);
    window.removeEventListener("orientationchange", onViewportChange);
  };
}
async function openPipWindow() {
  const mirror = state.mirrors[state.mirrorIndex];
  if (!mirror || !state.detail) { toast("Belum ada video", "Pilih episode dulu sebelum membuka popup."); return; }
  const iframe = $("#playerBox iframe");
  if (!iframe) { toast("Belum ada video", "Player belum memuat stream."); return; }
  if (document.pictureInPictureElement) { try { await document.exitPictureInPicture(); } catch { } }
  if (!SEAMLESS_IFRAME_PIP && "documentPictureInPicture" in window && window.documentPictureInPicture.requestWindow) {
    try {
      const win = await window.documentPictureInPicture.requestWindow({ width: 480, height: 300 });
      const doc = win.document;
      doc.body.style.cssText = "margin:0;background:#000;font-family:system-ui;overflow:hidden";
      const style = doc.createElement("style");
      style.textContent = `.pipbar{position:fixed;top:0;left:0;right:0;height:40px;display:flex;align-items:center;gap:6px;padding:4px 6px;background:linear-gradient(rgba(0,0,0,.7),transparent);z-index:9;transition:opacity .2s;opacity:0}.pipbar:hover{opacity:1}.pipbar button{width:30px;height:30px;border-radius:8px;border:1px solid rgba(255,255,255,.25);background:rgba(0,0,0,.5);color:#fff;display:grid;place-items:center;cursor:pointer;font-size:13px}.pipbar button:hover{border-color:#FFD700;color:#FFD700}.pipbar .t{flex:1;font-size:11px;color:#fff;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.pipwrap{position:fixed;inset:40px 0 0 0}.pipwrap iframe{width:100%;height:100%;border:0}`;
      doc.head.appendChild(style);
      const bar = doc.createElement("div"); bar.className = "pipbar";
      bar.innerHTML = `<span class="t">${esc(state.detail.title)} — EP ${state.episodeIndex + 1}</span><button data-p="prev" title="Episode sebelumnya">‹</button><button data-p="next" title="Episode berikutnya">›</button><button data-p="close" title="Tutup popup">✕</button>`;
      const wrapEl = doc.createElement("div"); wrapEl.className = "pipwrap";
      wrapEl.appendChild(iframe); /* pindahkan iframe: video tetap jalan */
      doc.body.append(bar, wrapEl);
      bar.addEventListener("click", async (event) => {
        const act = event.target.closest("button")?.dataset.p;
        if (act === "close") {
          $("#playerBox").appendChild(iframe); /* kembalikan iframe */
          win.close();
        } else if (act === "prev" || act === "next") {
          const delta = act === "prev" ? -1 : 1;
          const episodes = state.detail?.episodes || [];
          const target = episodes[state.episodeIndex + delta];
          if (target) {
            state.episodeIndex += delta;
            startWatchClock(target.number);
            try { const response = await api.mirrors(target.slug); state.mirrors = response.data || []; state.mirrorIndex = 0; const m = state.mirrors[0]; if (m) { iframe.src = m.url; bar.querySelector(".t").textContent = `${state.detail.title} — EP ${state.episodeIndex + 1}`; $("#mirrorLabel").textContent = m.name || "Mirror 1"; } } catch { }
          }
        }
      });
      win.addEventListener("pagehide", () => { if (iframe.isConnected && !$("#playerBox").contains(iframe)) $("#playerBox").appendChild(iframe); });
      return;
    } catch { /* fall through ke fallback */ }
  }
  /* Fallback: window mengambang di dalam halaman */
  closePipWindow();
  const el = document.createElement("div");
  el.className = "pip-window always-bar";
  el.innerHTML = `<div class="pip-head" data-pip-drag-handle tabindex="0" role="group" aria-label="Pindahkan popup player"><span class="pip-title">${esc(state.detail.title)} — EP ${state.episodeIndex + 1}</span><button class="pip-btn" data-pip-prev title="Episode sebelumnya" aria-label="Episode sebelumnya"><svg class="ico"><use href="#i-prev"/></svg></button><button class="pip-btn" data-pip-next title="Episode berikutnya" aria-label="Episode berikutnya"><svg class="ico"><use href="#i-next"/></svg></button><button class="pip-btn" data-pip-close title="Tutup popup" aria-label="Tutup popup"><svg class="ico"><use href="#i-close"/></svg></button></div><div class="pip-body"></div>`;
  $(".pip-body", el).appendChild(iframe);
  document.body.appendChild(el);
  pipPort = el;
  setupPipDrag(el);
  el.addEventListener("click", (event) => {
    const act = event.target.closest("[data-pip-prev],[data-pip-next],[data-pip-close]")?.dataset;
    if (!act) return;
    if (act.pipClose !== undefined) closePipWindow();
    else if (act.pipPrev !== undefined) { const target = state.detail?.episodes?.[state.episodeIndex - 1]; if (target) { playEpisodeInPip(target); } }
    else if (act.pipNext !== undefined) { const target = state.detail?.episodes?.[state.episodeIndex + 1]; if (target) { playEpisodeInPip(target); } }
  });
}
async function playEpisodeInPip(target) {
  state.episodeIndex = state.detail.episodes.findIndex((e) => e.slug === target.slug);
  startWatchClock(target.number);
  updateEpisodeNav(); renderDetail();
  try { const response = await api.mirrors(target.slug); state.mirrors = response.data || []; state.mirrorIndex = 0; const m = state.mirrors[0]; const iframe = pipPort?.querySelector("iframe"); if (m && iframe) { iframe.src = m.url; $("#mirrorLabel").textContent = m.name || "Mirror 1"; const t = pipPort?.querySelector(".pip-title"); if (t) t.textContent = `${state.detail.title} — EP ${state.episodeIndex + 1}`; } } catch { }
}
function closePipWindow() { if (!pipPort) return; const iframe = pipPort.querySelector("iframe"); if (iframe) $("#playerBox").appendChild(iframe); pipDragCleanup?.(); pipDragCleanup = null; pipPort.classList.add("is-closing"); const el = pipPort; setTimeout(() => el.remove(), 220); pipPort = null; }
$("#pipBtn")?.addEventListener("click", () => openPipWindow());
async function openDetail(id, options = {}) { const source = normAnime(findAnime(id) || { slug: id, id }); $("#watchOverlay").hidden = false; document.body.style.overflow = "hidden"; $("#watchTitle").textContent = source.title; $("#watchSub").textContent = ""; $("#playerBox").innerHTML = `<div class="player-loading"><div class="spinner"></div></div>`; try { const response = await api.detail(source.slug); state.detail = normAnime({ ...response.data, id: response.data.slug || source.slug }); state.detail.episodes = response.data.episodes || []; state.episodeIndex = -1; renderDetail(); /* preferUnwatched: dipakai rail "Lanjutkan Menonton" supaya membuka
       episode BERIKUTNYA, bukan episode 1. Modal-nya tetap sama persis
       dengan tombol "See Detail" supaya pengguna tidak bingung. */
       const start = options.preferUnwatched ? (cwNextFor(getStored(state.detail.slug) || {}) || state.detail.episodes[0]) : state.detail.episodes[0]; if (start?.slug) playEpisode(start.slug, Number(start.number), null); } catch (error) { $("#watchSub").textContent = error.message; } }
function closeWatch() { const overlay = $("#watchOverlay"); const modal = $("#watchModal"); stopWatchClock(); closePipWindow(); hideVideoControls(); overlay.classList.add("is-closing"); modal.classList.add("is-closing"); setTimeout(() => { overlay.hidden = true; overlay.classList.remove("is-closing"); modal.classList.remove("is-closing"); document.body.style.overflow = ""; state.detail = null; bindActions(); }, 200); }
function bindActions() { /* hold pada Remove dipasang di sini (jalan tiap render); klik singkat ditangani delegasi di setup() */ $$('[data-act="remove"]').forEach((b) => { if (b.dataset.holdBound === "1") return; b.dataset.holdBound = "1"; holdable(b, 1200, () => { b.dataset.holdDone = String(Date.now()); removeStorage(b.dataset.id); }); }); }
const GENRE_OPTIONS = "Aksi|Anak-Anak|Antariksa|Avant Garde|Dimensia|Donghua|Drama|Ecchi|Fantasi|Fantasi Urban|Game|Gourmet|Harem|Horror|Iblis|Isekai|Josei|Ketegangan|Komedi|Live Action|Makanan|Martial Arts|Medis|Militer|Misteri|Mitologi|Mobil|Musik|Olahraga|Parodi|Perang|Petualangan|Polisi|Politik|Psikologis|Reinkarnasi|Robot|Romansa|Samurai|Sci-Fi|Seinen|Sejarah|Sekolahan|Shoujo|Shoujo Ai|Shounen|Shounen Ai|Sihir|Slice of Life|Super Power|Supranatural|Thriller|Time Travel|Vampir".split("|").map((name) => ({ name, slug: name.toLowerCase().replace(/[^a-z0-9]+/g, "-") }));
function labelForGenre(slug) { return state.genres.find((g) => g.slug === slug)?.name || slug; }
function tagMatch(item, selected, key) { if (!selected.size) return true; const values = (item[key] || []).map((v) => String(typeof v === "string" ? v : v.name || v.slug || "").toLowerCase()); return [...selected].some((value) => values.includes(String(value).toLowerCase()) || values.some((v) => v.includes(String(value).toLowerCase()))); }
function updateFilterLabel(root, set, fallback) { $(".gf-label", root).textContent = set.size ? `${set.size} dipilih` : fallback; root.classList.toggle("has-active-root", set.size > 0); $(".gf-trigger", root).classList.toggle("has-active", set.size > 0); }
const FILTER_OPTIONS = { mainType: [["","Tipe"],["Serial TV","Serial TV"],["Live Action","Live Action"],["Movie","Movie"],["OVA","OVA"],["ONA","ONA"],["Spesial","Spesial"]], storageType: [["","Tipe"],["Serial TV","Serial TV"],["Live Action","Live Action"],["Movie","Movie"],["OVA","OVA"],["ONA","ONA"],["Spesial","Spesial"]], mainStatus: [["","Status"],["Segera Tayang","Segera Tayang"],["Sedang Tayang","Sedang Tayang"],["Selesai Tayang","Selesai Tayang"],["Rating","Rating"],["Terpopuler","Terpopuler"]], storageStatus: [["","Status"],["Segera Tayang","Segera Tayang"],["Sedang Tayang","Sedang Tayang"],["Selesai Tayang","Selesai Tayang"],["Rating","Rating"],["Terpopuler","Terpopuler"]] };
/* Tipe/Status: klik chip aktif = batal pilih, klik chip lain = ganti pilihan.
   Scope main TIDAK memicu render/pencarian otomatis (anti auto-search) —
   hanya memperbarui hint & chip di search main; pencarian lewat tombol cari
   atau Enter. Scope storage tetap memfilter daftar lokal secara langsung. */
/* ---------- Menu Download ---------- */
/* URL unduhan diisi terpisah, sengaja TIDAK ditebak di sini: installer .exe
   sekitar 96 MB dan .apk 1,5 MB tidak disimpan di repo ini.

   .exe sudah diisi (rilis 10 Oktober 2026). .apk sengaja masih kosong -
   belum ada ril-nya, dan link yang klik-nya mati lebih buruk daripada
   tombol yang disabled dengan alasannya ditulis.

   PENTING: URL .exe ini juga dipakai oleh auto-update EXE sebagai sumber
   metadata (latest.yml). Jadi kalau tautan ini diganti ke tempat lain,
   build berikutnya harus ikut mengarahkan publish-nya, atau pemeriksaan
   update akan mengarahkan pengguna ke rilis yang salah. */
const DOWNLOAD_LINKS = {
  exe: "https://github.com/NeoNishikawa/ilovenime-model/releases/download/exe/iLoveNime-X1.6.0-Setup-x64.exe",
  apk: "",
};

/* EXE punya aplikasinya sendiri; APK memblokir navigasi ke luar lewat NavGuard
   dan mematikan multi-window. Di keduanya tombol unduh tidak berguna, jadi
   dibuang dari DOM (bukan disembunyikan) supaya tidak pernah bisa diklik. */
function diDesktop() { return Boolean(window.ilnDesktop && window.ilnDesktop.isElectron) || /Electron/i.test(navigator.userAgent || ""); }
function diWebViewAndroid() { const ua = navigator.userAgent || ""; return /;\s*wv\)/.test(ua) || (/Android/.test(ua) && /Version\/[\d.]+\s*Chrome/.test(ua)); }
/* Shell iLoveNime yang sudah terpasang memuat "?shell=apk". Penanda ini
   dibaca server juga, supaya halaman maintenance tidak.snare shell yang
   tidak punya browser untuk ditutup. */
function shellTerpasang() { try { return new URLSearchParams(window.location.search).get("shell") === "apk"; } catch (_) { return false; } }

function pasangMenuDownload() {
  const wrap = $("#dlWrap");
  if (!wrap) return;
  if (diDesktop() || diWebViewAndroid()) { wrap.remove(); return; }
  /* Penjaga listener ganda. Dua listener document untuk hal yang sama
     tidak merusak apa pun, tapi boros dan menutup menu dua kali. Pola ini
     sama dengan penjaga holdBound di bindActions(). */
  if (wrap.dataset.dlBound === "1") return;
  wrap.dataset.dlBound = "1";

  const toggle = $("#dlToggle");
  const menu = $("#dlMenu");
  const items = $$(".dl-item");
  const tutup = () => { wrap.classList.remove("open"); toggle.setAttribute("aria-expanded", "false"); menu.hidden = true; };
  const buka = () => { wrap.classList.add("open"); toggle.setAttribute("aria-expanded", "true"); menu.hidden = false; };

  toggle.onclick = (event) => { event.stopPropagation(); menu.hidden ? buka() : tutup(); };
  document.addEventListener("click", (event) => { if (!wrap.contains(event.target)) tutup(); });
  document.addEventListener("keydown", (event) => { if (event.key === "Escape" && !menu.hidden) { tutup(); toggle.focus(); } });

  const kosong = items.every((item) => !DOWNLOAD_LINKS[item.dataset.dl]);
  if (kosong) {
    items.forEach((item) => { item.disabled = true; });
    $("#dlNote").hidden = false;
    return;
  }
  items.forEach((item) => {
    const url = DOWNLOAD_LINKS[item.dataset.dl];
    if (!url) { item.disabled = true; return; }
    item.onclick = () => {
      setDrawer(false);
      /* Installer belum ditandatangani CA, jadi Windows pasti menampilkan
         "Windows protected your PC". Menosokan pengguna ke file 96 MB tanpa
         penjelasan membuat mereka mengira aplikasinya rusak - dan browser
         yang menampilkan SmartScreen bukan situs kita, jadipenjelasannya
         harus muncul SEBELUM unduhan mulai.

         .apk sengaja tidak lewat sini: Android tidak punya SmartScreen,
         dan OS Android punya flow permission sendiri yang tidak bisa
         dicampur instructions Windows. */
      if (item.dataset.dl === "exe") { showSmartScreenNotice(url); return; }
      window.open(url, "_blank", "noopener");
    };
  });
}

/* Konfirmasi sebelum unduh .exe. Ada dua tombol: "Batal" membatalkan,
   "Saya mengerti" baru membuka link GitHub. Menaruh link langsung di menu
   berarti link tanpa penjelasan; menaruhnya setelah konfirmasi
   berarti penundaan yang perlu dibaca dulu. */
function showSmartScreenNotice(url) {
  const root = $("#confirmRoot");
  if (!root || !url) return;
  /* Jangan menumpuk kalau klik berulang cepat. */
  root.querySelectorAll(".overlay").forEach((lama) => lama.remove());
  const overlay = document.createElement("div");
  overlay.className = "overlay";
  overlay.innerHTML = `<div class="confirm-modal ss-modal" role="dialog" aria-modal="true" aria-labelledby="ssTtl">
    <div class="confirm-alert warn"><svg class="ico"><use href="#i-info"/></svg></div>
    <h3 id="ssTtl">Sebelum mengunduh</h3>
    <p class="ss-lead">Saat installer dibuka, Windows mungkin menampilkan peringatan <strong>"Windows protected your PC"</strong> atau <strong>"Unknown Publisher"</strong>. Itu <strong>wajar</strong> untuk perangkat lunak independen yang baru - bukan tanda file rusak.</p>
    <p class="ss-why">iLoveNime dibuat independen, jadi installer-nya belum punya sertifikat digital resmi. Windows tidak mengenali penerbitnya, makanya peringatan muncul.</p>
    <p class="ss-steps-t">Cara membukanya:</p>
    <ol class="ss-steps">
      <li>Klik <strong>"More info"</strong> di kiri bawah jendela.</li>
      <li>Klik <strong>"Run anyway"</strong>.</li>
    </ol>
    <div class="confirm-actions">
      <button class="btn btn-primary" data-ss-go>Lanjut unduh</button>
      <button class="btn btn-ghost" data-ss-cancel>Batal</button>
    </div></div>`;
  root.appendChild(overlay);
  const close = () => { overlay.classList.add("is-closing"); $(".confirm-modal", overlay).classList.add("is-closing"); setTimeout(() => overlay.remove(), 220); };
  $("[data-ss-cancel]", overlay).onclick = close;
  $("[data-ss-go]", overlay).onclick = () => { close(); setTimeout(() => window.open(url, "_blank", "noopener"), 230); };
  overlay.onclick = (e) => { if (e.target === overlay) close(); };
  /* Fokus ke tombol utama: keyboard bisa menyelesaikan tanpa mouse, dan
     Escape membatalkan - dialog yang bisa dijebak mouse saja menyisakan
     pengguna yang masih terjebak. */
  $("[data-ss-go]", overlay).focus();
  overlay.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });
}

function bindDropdown(root) {
  if (!root) return;
  const key = root.dataset.filter; const panel = $(".gf-panel", root); attach(root);
  const isStorage = Boolean(root.closest("[data-filter-scope=storage]"));
  const applyLabel = () => {
    const chosen = (FILTER_OPTIONS[key] || []).find(([value]) => value && value === state[key]);
    $(".gf-label", root).textContent = chosen ? chosen[1] : root.dataset.label || "—";
    root.classList.toggle("has-active-root", Boolean(state[key]));
    $(".gf-trigger", root).classList.toggle("has-active", Boolean(state[key]));
  };
  const setOptions = () => { $(".gf-grid", root).innerHTML = (FILTER_OPTIONS[key] || []).map(([value,label]) => `<button class="gf-chip ${state[key] === value ? "on" : ""}" data-value="${esc(value)}">${esc(label)}</button>`).join(""); };
  setOptions(); applyLabel();
  /* Delegasi event di panel — setOptions() membuat ulang chip setiap klik,
     handler per-chip akan mati setelah render pertama (akar bug "tidak bisa
     ganti/cancel pilihan"). Delegasi bertahan lintas render. */
  panel.addEventListener("click", (event) => {
    const button = event.target.closest("[data-value]");
    if (!button) return;
    state[key] = state[key] === button.dataset.value ? "" : button.dataset.value;
    applyLabel(); setOptions(); closeActive();
    isStorage ? refreshStorageFilters() : updateSearchUI();
  });
}
function bindGenre(root) { if (!root) return; attach(root); const panel = $(".gf-panel", root); const storage = root.classList.contains("gf-storage"); const set = storage ? state.storageGenres : state.mainGenres; const genres = [...new Map([...GENRE_OPTIONS, ...state.genres].map((g) => [g.slug, g])).values()]; $(".gf-grid", root).innerHTML = genres.map((g) => `<button class="gf-chip ${set.has(g.slug) ? "on" : ""}" data-genre="${esc(g.slug)}">${esc(g.name)}</button>`).join(""); updateFilterLabel(root, set, "All Genre"); $$('[data-genre]', panel).forEach((b) => b.onclick = () => { set.has(b.dataset.genre) ? set.delete(b.dataset.genre) : set.add(b.dataset.genre); b.classList.toggle("on", set.has(b.dataset.genre)); updateFilterLabel(root, set, "All Genre"); storage ? refreshStorageFilters() : updateSearchUI(); }); $(`[data-gf-clear]`, root).onclick = () => { set.clear(); updateFilterLabel(root, set, "All Genre"); $$("[data-genre]", panel).forEach((b) => b.classList.remove("on")); storage ? refreshStorageFilters() : updateSearchUI(); }; }
/* Pindah section: crossfade — section lama memudar, scroll, section tujuan
   muncul. Menghormati prefers-reduced-motion (langsung tanpa animasi). */
/* Pindah section: crossfade — section lama memudar, scroll, section tujuan
   muncul. Ada token supaya transisi yang sudah kalah tidak ikut membersihkan
   state milik transisi yang lebih baru, dan pembersihannya selalu mengembalikan
   SEMUA section (bukan cuma daftar saat ini) supaya tidak ada section yang
   tersangkut is-crossfading dan jadi tak terlihat selamanya. */
let sectionTransitionToken = 0;
function clearSectionFx() {
  $$(".canvas>section").forEach((section) => {
    section.style.opacity = "";
    section.style.transform = "";
    section.classList.remove("is-crossfading", "section-in");
  });
}
function scrollToSection(selector, button) { const target = $(selector); if (!target) return; $$(".nav-item[data-nav]").forEach((b) => b.classList.toggle("active", b === button)); const scroller = $("#mainScroll"); if (!scroller) return; const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches || document.documentElement.dataset.performanceTier === "low"; const jump = () => scroller.scrollTo({ top: target.offsetTop - 20, behavior: "smooth" }); const token = ++sectionTransitionToken; if (reduced) { clearSectionFx(); target.classList.add("section-in"); jump(); setTimeout(() => clearSectionFx(), 420); return; } /* Target dibersihkan DULU: kalau transisi sebelumnya sempat menandainya is-crossfading, ia harus dilepas sekarang, bukan nanti. */
  target.style.opacity = ""; target.style.transform = ""; target.classList.remove("is-crossfading", "section-in");
  const current = $$(".canvas>section").filter((s) => { const r = s.getBoundingClientRect(); return r.bottom > 0 && r.top < window.innerHeight; });
  current.forEach((s) => { if (s !== target) s.classList.add("is-crossfading"); });
  const fadeOut = { opacity: [1, 0], duration: 170, ease: "outQuad", onComplete: () => { if (token !== sectionTransitionToken) return; jump(); target.classList.add("section-in"); animate(target, { opacity: [0, 1], translateY: [10, 0], duration: 320, ease: "outQuad", composition: "replace", onComplete: () => { if (token !== sectionTransitionToken) return; clearSectionFx(); } }); } };
  animate(current.length ? current : target, { ...fadeOut, composition: "replace" });
  /* Pengaman: kalau animasi somehow tidak menyelesaikan onComplete-nya, section
     tetap dikembalikan supaya tidak ada konten yang hilang permanen. */
  setTimeout(() => { if (token === sectionTransitionToken) clearSectionFx(); }, 900); }
function openAbout() { const root = $("#confirmRoot"); const overlay = document.createElement("div"); overlay.className = "overlay"; overlay.innerHTML = 
  `<div class="about-modal" role="dialog" aria-modal="true" aria-labelledby="about-modal-title">
  <h3 id="about-modal-title">Tentang iLoveNime</h3>
  
  <div class="modal-content">
    <p><strong>iLoveNime</strong> adalah platform streaming anime independen yang dapat diakses secara gratis dan bebas dari iklan.</p>
    
    <hr class="modal-divider" />

    <div class="about-section">
      <h4>📌 Penting Mengenai Data &amp; Progres</h4>
      <p>Koleksi dan progres menonton Anda disimpan secara lokal di browser (<em>Local Storage</em>). Karena domain berganti secara berkala, pastikan untuk menggunakan fitur <strong>Export</strong> untuk mencadangkan data, dan <strong>Import</strong> di domain baru agar progres tidak hilang.</p>
    </div>

    <div class="about-section">
      <h4>🌐 Server &amp; Pergantian Domain</h4>
      <p>Ketersediaan <em>source</em> dan <em>mirror</em> dapat berubah mengikuti kondisi jaringan. Kami memohon maaf jika alamat web harus berganti link setiap bulannya demi menekan biaya operasional hosting agar layanan tetap gratis.</p>
    </div>

  </div>

  <div class="confirm-actions">
    <button class="btn btn-primary" data-close-about>Tutup</button>
  </div>
</div>`; root.appendChild(overlay); $("[data-close-about]", overlay).onclick = () => overlay.remove(); overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); }; }
/* ==========================================================================
   Lanjutkan Menonton — rail episode berikutnya + stage ala Netflix.
   Anime.js dipakai di sini untuk slide kiri/kanan dan crossfade section.
   Data episodes hanya ada dari /api/anime/:slug, jadiRail dirender dari
   localStorage dulu (tanpa network), lalu dilengkapi bertahap.
   ========================================================================== */
const CW_MAX_CARDS = 8;
const CW_PREVIEW_DELAY = 420;
const CW_DETAIL_CONCURRENCY = 3;
const cw = { episodes: new Map(), pending: new Set(), stage: null };
let sectionFadeObserver = null;

/* Amber iterator sederhana: detail diambil bertahap supaya 25 item di
   Local Storage tidak menembak 25 request sekaligus ke upstream. */
function cwPool(tasks, limit = CW_DETAIL_CONCURRENCY) {
  const queue = [...tasks];
  if (!queue.length) return Promise.resolve();
  return new Promise((resolve) => {
    let active = 0;
    const next = () => {
      if (active >= limit) return;
      const task = queue.shift();
      /* Antrean kosong + tidak ada yang jalan = selesai. Kalau masih ada
         yang aktif, Jangan resolve dulu — pemanggil akan merender rail
         sebelum episode-nya siap. */
      if (!task) { if (!active) resolve(); return; }
      active += 1;
      Promise.resolve().then(task).catch(() => null).then(() => { active -= 1; next(); });
    };
    next();
  });
}

function cwNextFor(item) {
  const episodes = cw.episodes.get(item.slug);
  if (!episodes) return null;
  return nextUnwatched(item.watchedEpisodes || [], episodes);
}

function cwProgressPct(item, episodes = null) {
  const list = episodes || cw.episodes.get(item.slug) || [];
  const total = Number(item.total || item.totalEpisodes || list.length || 0);
  const watched = new Set((item.watchedEpisodes || []).map(Number)).size || Number(item.progress || 0);
  return total > 0 ? Math.min(100, Math.round((watched / total) * 100)) : 0;
}

/* ---------- Render rail ---------- */
function renderContinue() {
  const rail = $("#continueRail"); if (!rail) return;
  clearCwPreviews();
  const candidates = continueCandidates(state.storageItems, CW_MAX_CARDS);
  const badge = $("#navContinueCount");
  if (badge) badge.textContent = String(candidates.length);
  const sub = $("#continueSub");

  if (!candidates.length) {
    rail.innerHTML = `<div class="cw-empty"><strong>Belum ada yang bisa dilanjutkan</strong><span>Mulai tonton satu episode dari anime mana pun, lalu episode berikutnya akan otomatis muncul di sini.</span></div>`;
    if (sub) sub.textContent = "Belum ada tontonan berjalan";
    rail.parentElement?.querySelectorAll(".cw-nav").forEach((b) => b.toggleAttribute("disabled", true));
    return;
  }

  rail.innerHTML = candidates.map((item) => {
    const ep = cwNextFor(item);
    const pct = cwProgressPct(item);
    const ready = Boolean(ep);
    return `<article class="cw-card${ready ? "" : " is-loading"}" role="listitem" tabindex="0" data-cw-slug="${esc(item.slug)}">
      ${ready ? "" : `<div class="cw-skel"></div>`}
      <div class="cw-art">${item.image ? `<img src="${esc(item.image)}" alt="${esc(item.title)}" loading="lazy" onerror="this.parentNode.classList.add('img-failed')">` : `<span class="cw-art-fallback">ANIME IMAGE</span>`}</div>
      <button class="cw-play" type="button" data-cw-play="${esc(item.slug)}" ${ready ? "" : "disabled"}><svg class="ico"><use href="#i-play"/></svg><span>Lanjutkan</span></button>
      <div class="cw-body">
        <span class="cw-eyebrow">EP ${ready ? String(ep.number).padStart(2, "0") : "—"}</span>
        <h3 class="cw-title">${esc(item.title)}</h3>
        <p class="cw-ep">${ready ? esc(episodeLabel(ep, item.title)) : "Memuat episode berikutnya…"}</p>
        <div class="cw-bar"><i style="width:${pct}%"></i></div>
      </div>
    </article>`;
  }).join("");

  if (sub) sub.textContent = `${candidates.length} anime menunggu episode berikutnya`;
  bindCwCards();
  syncCwNav();
  loadCwDetails(candidates);
}

/* Detail belum pernah diambil: ambil sekarang, lalu render ulang hanya rail. */
async function loadCwDetails(candidates) {
  const todo = candidates.filter((i) => !cw.episodes.has(i.slug) && !cw.pending.has(i.slug));
  todo.forEach((i) => cw.pending.add(i.slug));
  if (todo.length) await cwPool(todo.map((item) => async () => {
    try { const res = await api.detail(item.slug); cw.episodes.set(item.slug, res?.data?.episodes || []); }
    catch (_) { cw.episodes.set(item.slug, []); }
    finally { cw.pending.delete(item.slug); }
  }));
  const rail = $("#continueRail"); if (!rail) return;
  /* Anime yang ternyata sudah tamat (tidak ada episode tersisa) dibuang. */
  const valid = candidates.filter((item) => cwNextFor(item));
  if (!valid.length) { renderContinue(); return; }
  rail.innerHTML = valid.map((item) => cwCardHTML(item)).join("");
  const subLabel = $("#continueSub");
  if (subLabel) subLabel.textContent = `${valid.length} anime menunggu episode berikutnya`;
  const countBadge = $("#navContinueCount");
  if (countBadge) countBadge.textContent = String(valid.length);
  bindCwCards(); syncCwNav();
}

function cwCardHTML(item) {
  const ep = cwNextFor(item);
  const pct = cwProgressPct(item);
  const left = remainingCount(item, cw.episodes.get(item.slug)?.length || 0);
  return `<article class="cw-card${ep ? "" : " is-loading"}" role="listitem" tabindex="0" data-cw-slug="${esc(item.slug)}">
    ${ep ? "" : `<div class="cw-skel"></div>`}
    <div class="cw-art">${item.image ? `<img src="${esc(item.image)}" alt="${esc(item.title)}" loading="lazy" onerror="this.parentNode.classList.add('img-failed')">` : `<span class="cw-art-fallback">ANIME IMAGE</span>`}</div>
    <button class="cw-play" type="button" data-cw-play="${esc(item.slug)}" ${ep ? "" : "disabled"}><svg class="ico"><use href="#i-play"/></svg><span>Lanjutkan</span></button>
    <div class="cw-body">
      <span class="cw-eyebrow">EP ${ep ? String(ep.number).padStart(2, "0") : "—"}</span>
      <h3 class="cw-title">${esc(item.title)}</h3>
      <p class="cw-ep">${ep ? `${esc(episodeLabel(ep, item.title))}${left > 1 ? ` · ${left} episode tersisa` : ""}` : "Memuat episode berikutnya…"}</p>
      <div class="cw-bar"><i style="width:${pct}%"></i></div>
    </div>
  </article>`;
}

/* ---------- Interaksi kartu ---------- */
function bindCwCards() {
  const rail = $("#continueRail"); if (!rail) return;
  $$(".cw-card", rail).forEach((card) => {
    const slug = card.dataset.cwSlug;
    card.onmouseenter = () => schedulePreview(card, slug);
    card.onmouseleave = () => clearCwPreviews(card);
    card.onfocus = () => schedulePreview(card, slug);
    card.onblur = () => clearCwPreviews(card);
    const play = $("[data-cw-play]", card);
    /* Membuka modal yang SAMA dengan tombol "See Detail" (bukan player
       terpisah), hanya boleh dimulai dari episode berikutnya. */
    const open = (event) => { event?.stopPropagation(); openDetail(slug, { preferUnwatched: true }); };
    if (play) play.onclick = open;
    card.onclick = open;
    card.onkeydown = (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); open(); } };
  });
}

/* Pratinjau Netflix: hanya satu iframe aktif pada satu waktu. Status
   pratinjau disimpan PADA KARTU ITU SENDIRI (bukan satu variabel global),
   jadi rail yang kebetulan re-render tidak membuat iframe yatim atau
   menumpuk: setiap kartu selalu tahu pratinjaunya sendiri. */
function schedulePreview(card, slug) {
  if (!card) return;
  clearTimeout(Number(card.dataset.cwTimer || 0));
  card.dataset.cwTimer = String(setTimeout(() => startPreview(card, slug), CW_PREVIEW_DELAY));
}
async function startPreview(card, slug) {
  if (!card || card.dataset.cwBusy === "1") return;
  /* Cuma satu pratinjau pada satu waktu: SEMUA kartu yang sedang aktif
     dibersihkan lebih dulu, bukan hanya kartu ini. Kalau kursor pindah
     cepat atau mouseleave sempat terlewat, dua iframe tidak akan menumpuk. */
  clearCwPreviews();
  const episode = cwNextFor(getStored(slug) || {});
  if (!episode?.slug) return;
  card.dataset.cwBusy = "1";
  try {
    const res = await api.mirrors(episode.slug);
    const mirror = res?.data?.[0];
    /* Sambil menunggu mirror, kursor bisa sudah pergi, kartu sudah
       dilepas karena re-render, atau kartu lain sudah mengambil alih. */
    if (!mirror?.url || !document.body.contains(card) || card.dataset.cwBusy !== "1") return;
    const frame = document.createElement("iframe");
    frame.className = "cw-preview";
    frame.src = mirror.url;
    frame.title = "Pratinjau episode";
    frame.loading = "lazy";
    frame.allow = "autoplay; fullscreen; picture-in-picture";
    frame.muted = true;
    frame.setAttribute("muted", "");
    card.classList.add("is-previewing");
    card.insertBefore(frame, $(".cw-body", card));
    /* Iframe dibongkar setelah 12 detik: halaman mirror sering menampilkan
       halaman interstitial yang menutupi video setelah beberapa detik. */
    setTimeout(() => { if (card.contains(frame)) frame.remove(); }, 12000);
  } catch (_) { /* pratinjau gagal = diamkan saja, kartu tetap bisa dibuka manual */ }
  finally { card.dataset.cwBusy = "0"; }
}
/* Bersihkan satu kartu, atau seluruh kartu bila argumen dikosongkan. */
function clearCwPreviews(onlyCard = null) {
  const cards = onlyCard ? [onlyCard] : $$(".cw-card");
  for (const card of cards) {
    clearTimeout(Number(card.dataset.cwTimer || 0));
    card.dataset.cwTimer = "0";
    card.dataset.cwBusy = "0";
    card.classList.remove("is-previewing");
    $$(".cw-preview", card).forEach((frame) => frame.remove());
  }
}

/* Panah geser rail */
function syncCwNav() {
  const rail = $("#continueRail"); if (!rail) return;
  const max = rail.scrollWidth - rail.clientWidth;
  const prev = $("[data-cw-prev]"), next = $("[data-cw-next]");
  if (prev) prev.toggleAttribute("disabled", rail.scrollLeft <= 4);
  if (next) next.toggleAttribute("disabled", rail.scrollLeft >= max - 4);
}
function cwScrollRail(dir) {
  const rail = $("#continueRail"); if (!rail) return;
  const card = $(".cw-card", rail);
  const step = card ? card.getBoundingClientRect().width + 14 : rail.clientWidth * 0.8;
  rail.scrollBy({ left: dir * step * 2, behavior: "smooth" });
  setTimeout(syncCwNav, 320);
}

/* ---------- Crossfade ikut scroll ---------- */
/* Section yang sedang terlihat penuh; yang lain memudar redup. Pakai
   IntersectionObserver supaya tidak ada handler scroll yang berat. */
function setupSectionCrossfade() {
  sectionFadeObserver?.disconnect();
  sectionFadeObserver = null;
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches || document.documentElement.dataset.performanceTier === "low";
  if (reduced || !("IntersectionObserver" in window)) { $$(".canvas>section").forEach((s) => s.classList.remove("is-scroll-dim")); return; }
  sectionFadeObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) entry.target.classList.toggle("is-scroll-dim", !entry.isIntersecting);
  }, { root: $("#mainScroll"), rootMargin: "-12% 0px -12% 0px", threshold: 0.01 });
  $$(".canvas>section").forEach((section) => sectionFadeObserver.observe(section));
}

function bindSelect(id, key, render) { const el = $(id); if (!el) return; el.value = state[key] || ""; el.onchange = () => { state[key] = el.value; render(); }; }
function setup() {
  document.addEventListener("click", (event) => { const play = event.target.closest?.('[data-act="play"]'); const detail = event.target.closest?.('[data-act="detail"]'); const add = event.target.closest?.('[data-act="add"]'); const check = event.target.closest?.('[data-act="check"]'); const remove = event.target.closest?.('[data-act="remove"]'); /* Kartu bisa diklik langsung untuk buka detail, jadi tidak wajib pakai tombol mata.
   Guard pertama: APAPUN elemen yang punya data-act TIDAK boleh memicu buka
   detail. Tombol morph punya listener klik document-nya sendiri (baris lain),
   jadi tanpa guard ini satu klik goo akan membuka menu DAN modal detail. */
   const aksi = event.target.closest?.('[data-act]'); const card = (aksi || event.target.closest?.('a,input,select,textarea,label')) ? null : event.target.closest?.('.anime-card[data-card-open]'); if (play) { event.preventDefault(); event.stopPropagation(); openDetail(play.dataset.id, { preferUnwatched: true }); } else if (detail) { event.preventDefault(); event.stopPropagation(); openDetail(detail.dataset.id); } else if (add) { event.preventDefault(); event.stopPropagation(); addStorage(add.dataset.id, add); } else if (check) { event.preventDefault(); event.stopPropagation(); const id = check.dataset.id; state.selectedStorageItems.has(id) ? state.selectedStorageItems.delete(id) : state.selectedStorageItems.add(id); renderStorage(); } else if (remove) { /* Hold selesai memicu removeStorage sendiri (holdDone).
     Klik singkat TIDAK menghapus dan TIDAK memunculkan popup — hanya
     memberi petunjuk cara memakainya. Konsisten dengan menu morph, dan
     popup konfirmasi kini khusus Delete All Data di sidebar. */
     const btn = remove; const heldAt = Number(btn.dataset.holdDone || 0); if (Date.now() - heldAt < 600) return; event.preventDefault(); event.stopPropagation(); const item = state.storageItems.find((i) => i.slug === btn.dataset.id); toast("Tahan tombol Remove", `${item?.title || "Anime ini"} — tahan 1,2 detik untuk menghapus, lepas lebih awal untuk batal.`, 2600); } else if (card) { event.preventDefault(); openDetail(card.dataset.id); } });
  document.documentElement.dataset.theme = prefs.theme;
  $$('[data-theme-toggle]').forEach((btn) => btn.classList.toggle("is-light", prefs.theme === "light"));
  /* Kontrol manual mode performa (dropdown Animasi) dihapus dari UI;
     auto-tier performance-mode.js tetap berjalan di belakang layar. */
  document.addEventListener("iln:performance-change", () => setupScrollReveal());
  installDevLongTaskMonitor();
  $$('[data-theme-toggle]').forEach((btn) => { btn.classList.toggle("is-light", prefs.theme === "light"); btn.onclick = () => { prefs.theme = prefs.theme === "light" ? "dark" : "light"; saveState(); /* View Transitions: crossfade warna halaman (fallback ringan bila tak didukung) */ applyTheme(prefs.theme, { animate: true }); }; });
  /* Grid cuma perlu digambar ulang kalau UKURAN HALAMAN berubah. Di desktop
     sidebar tertutup = 7 kolom = 21 kartu; di tablet dan mobile pageSize
     tetap 9, jadi di sana tidak boleh ada render sama sekali — stutter
     ~1 detik itu persis dari renderAll() yang jalan di tengah animasi.
     Kalau memang berubah, render SETELAH animasi sidebar selesai supaya
     perpindahan 6 -> 7 kolom tidak men-drop frame. */
  $("#sbToggle").onclick = () => { const appEl = $("#app"); /* Matikan biaya paint mahal (backdrop-filter & transisi kartu)
     selama animasi collapse/expand agar frame tidak drop */ appEl.classList.add("animating"); /* Ukuran halaman dibaca SEBELUM dan SESUDAH class ditoggle — bukan snapshot saat load, supaya tetap benar walau viewport berubah. */ const sizeSebelum = pageSize(); appEl.classList.toggle("collapsed"); prefs.sidebarCollapsed = appEl.classList.contains("collapsed"); saveState(); setTimeout(() => appEl.classList.remove("animating"), SIDEBAR_ANIM_MS); const nextSize = pageSize(); if (nextSize === sizeSebelum) return; setTimeout(() => { renderStorage(); renderSearch(); }, SIDEBAR_ANIM_MS + 40); };
  if (prefs.sidebarCollapsed && !mobileQuery.matches) $("#app").classList.add("collapsed");
  $("#globalSearch").onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); search(e.currentTarget.value); } };
  $("#globalSearch").oninput = () => updateSearchUI();
  $("#searchMorphBtn").onclick = () => { if (state.searchQuery || state.searchResults.length) clearAllSearch(); else search($("#globalSearch").value); };
  $("#clearSearchBtn").onclick = () => clearAllSearch();
  $("#localSearch").oninput = (e) => { state.localQuery = e.target.value; state.storagePage = 0; renderStorage(); };
  $$("#storageTabs .tab").forEach((b) => b.onclick = () => { state.currentTab = b.dataset.tab; state.storagePage = 0; renderStorage(); });
  /* Edit Mode pindah ke dalam dropdown Data (permintaan Neo 6 Okt) supaya
     toolbar storage lebih bersih. Label tombol tetap disinkronkan dari sini. */
  const editModeLabel = (on) => { const btn = $("#editModeBtn"); if (!btn) return; btn.innerHTML = on ? "Done" : `<svg class="ico"><use href="#i-edit"/></svg> Edit Mode`; btn.classList.toggle("is-on", on); };
  const closeDataMenu = () => { closeActive(); };
  $("#editModeBtn").onclick = () => { state.editMode = !state.editMode; state.selectedStorageItems.clear(); editModeLabel(state.editMode); closeDataMenu(); renderStorage(); };
  $("#selectAllBtn").onclick = () => { filterVisible().forEach((item) => state.selectedStorageItems.add(item.slug)); renderStorage(); };
  $("#cancelEditBtn").onclick = () => { state.editMode = false; state.selectedStorageItems.clear(); editModeLabel(false); renderStorage(); };
  holdable($("#bulkDeleteBtn"), 1500, () => { state.storageItems = state.storageItems.filter((i) => !state.selectedStorageItems.has(i.slug)); state.selectedStorageItems.clear(); saveState(); renderAll(); toast("Anime terpilih dihapus"); });
  holdable($("#deleteDataBtn"), 1500, () => openConfirm("Hapus seluruh data lokal?", "Tindakan ini permanen dan menghapus koleksi, progres, nama, foto profil, dan setelan lokal. Koleksi, progres, dan profile lokal.", () => deleteAllLocal(), { hold: 1500 }));
  holdable($("#ppDeleteBtn"), 1500, () => openConfirm("Hapus seluruh data lokal?", "Tindakan ini permanen dan menghapus koleksi, progres, nama, foto profil, dan setelan lokal. Koleksi, progres, dan profile lokal.", () => deleteAllLocal(), { hold: 1500 }));
  $("#watchClose").onclick = closeWatch;
  $("#watchOverlay").onclick = (e) => { if (e.target.id === "watchOverlay") closeWatch(); };
  attach($("#mirrorSelectWrapper"));
  attach($(".data-menu-wrap"));
  $("#sbUser").onclick = () => { if (mobileQuery.matches) return; /* profil sudah tampil di main saat mobile */ const popup = $("#profilePopup"); popup.hidden = !popup.hidden; $("#ppNameInput").value = prefs.username; };
  const openProfileEditor = () => { const popup = $("#profilePopup"); popup.hidden = false; popup.classList.add("is-inline"); $("#ppNameInput").value = prefs.username; applyProfile(); };
  $("#pcEditBtn").onclick = (event) => { event.stopPropagation(); openProfileEditor(); };
  const finishEdit = () => { $("#profilePopup").classList.remove("is-inline"); $("#profilePopup").hidden = true; saveState(); renderProfile(); };
  $("#ppClose").addEventListener("click", (event) => { event.stopPropagation(); finishEdit(); });
  $("#ppNameInput").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); const value = e.currentTarget.value.trim(); if (value) { prefs.username = value; toast("Profil diperbarui", "Nama tersimpan di perangkat ini."); } finishEdit(); } });
  $("#ppChangeAvatar").addEventListener("click", (e) => {
    e.stopPropagation();
    /* Suspend 30 dtk setelah 3× memaksa format tidak didukung */
    const until = Number(prefs.avatarSuspendedUntil || 0);
    if (Date.now() < until) { toast("Upload ditangguhkan", `Coba lagi dalam ${Math.ceil((until - Date.now()) / 1000)} detik.`); return; }
    $("#ppAvatarFile").click();
  });
  $("#ppAvatarFile").onchange = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    /* Hanya PNG / WebP / GIF — GIF membuat avatar beranimasi. */
    if (!isAllowedAvatarFile(file)) {
      e.target.value = "";
      const strikes = Number(prefs.avatarStrikes || 0) + 1;
      if (strikes >= 3) {
        prefs.avatarStrikes = 0;
        prefs.avatarSuspendedUntil = Date.now() + 30000;
        saveState();
        openAlert("Upload ditangguhkan", "Kamu 3 kali mencoba format yang tidak didukung. Ganti foto profil dikunci selama 30 detik.");
      } else {
        prefs.avatarStrikes = strikes;
        saveState();
        openAlert("Format tidak didukung", `Avatar hanya menerima PNG, WebP, atau GIF. Percobaan ke-${strikes} dari 3.`);
      }
      return;
    }
    prefs.avatarStrikes = 0;
    const reader = new FileReader();
    reader.onload = () => { prefs.avatarUrl = String(reader.result); saveState(); renderProfile(); toast("Foto profil diperbarui", /gif/i.test(file.type) ? "Avatar GIF beranimasi aktif." : ""); };
    reader.readAsDataURL(file);
    e.target.value = "";
  };
  $("#ppNameInput").onchange = (e) => { prefs.username = e.target.value.trim() || "Anime watcher"; saveState(); renderProfile(); };
  $("#aboutButton")?.addEventListener("click", openAbout);
  $("#importBtn").onclick = () => { closeActive(); $("#dataMenu").hidden = true; $("#importFile").click(); };
  $("#exportBtn").onclick = () => { closeActive(); $("#dataMenu").hidden = true; const payload = buildExportPayload(state.storageItems, prefs); const link = document.createElement("a"); link.href = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" })); link.download = `ilovenime-tracking-${new Date().toISOString().slice(0, 10)}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 0); toast("Backup diunduh", `${payload.items.length} anime + profil (nama & foto).`); };
  $("#importFile").onchange = (e) => { const file = e.target.files?.[0]; if (!file) return; toast("Membaca backup…", "Memulihkan koleksi dari file yang dipilih.", 2200); const reader = new FileReader(); reader.onload = async () => { try { const data = JSON.parse(reader.result); const items = Array.isArray(data) ? data : data.items || data.storageItems; if (!Array.isArray(items)) throw new Error("Format backup tidak dikenali."); state.storageItems = items.map(normalizeStored).filter((x) => x.slug); /* v2: pulihkan juga profil (nama, handle, foto, tema) */ const restoredProfile = Boolean(data.profile); if (restoredProfile) { prefs = mergeImportedProfile(data, prefs); applyTheme(prefs.theme); if (prefs.sidebarCollapsed && !mobileQuery.matches) $("#app").classList.add("collapsed"); else $("#app").classList.remove("collapsed"); } saveState(); renderAll(); toast("Import selesai", `${state.storageItems.length} anime dipulihkan.${restoredProfile ? " Profil juga dipulihkan." : ""}`); } catch (error) { toast("Import gagal", error.message); } }; reader.readAsText(file); e.target.value = ""; };
  $$(".nav-item[data-nav]").forEach((b) => b.onclick = () => { const map = { dashboard: "#profileSection", continue: "#continueSection", update: "#updateSection", storage: "#storageSection" }; scrollToSection(map[b.dataset.nav], b); setDrawer(false); });
  /* Rail "Lanjutkan Menonton": panah geser + tombol kiri/kanan keyboard. */
  $("[data-cw-prev]")?.addEventListener("click", () => cwScrollRail(-1));
  $("[data-cw-next]")?.addEventListener("click", () => cwScrollRail(1));
  $("#continueRail")?.addEventListener("scroll", syncCwNav, { passive: true });
  setupSectionCrossfade();
  const mainScroll = $("#mainScroll");
  let scrollFrame = 0;
  const updateActiveNav = () => {
    scrollFrame = 0;
    if (!mainScroll) return;
    const scrollTop = mainScroll.scrollTop;
    const sections = [["#profileSection", "dashboard"], ["#continueSection", "continue"], ["#updateSection", "update"], ["#storageSection", "storage"]]
      .map(([selector, name]) => ({ top: $(selector)?.offsetTop, name }))
      .filter((section) => Number.isFinite(section.top));
    let active = "dashboard";
    for (const section of sections) if (section.top - scrollTop < 180) active = section.name;
    const navItems = $$(".nav-item[data-nav]");
    navItems.forEach((button) => button.classList.toggle("active", button.dataset.nav === active));
  };
  mainScroll?.addEventListener("scroll", () => { if (!scrollFrame) scrollFrame = requestAnimationFrame(updateActiveNav); }, { passive: true });
  updateActiveNav();
  $$(".nav-item[data-support]").forEach((b) => b.onclick = () => { setDrawer(false); if (b.dataset.support === "about") openAbout(); if (b.dataset.support === "donate") window.open("https://sociabuzz.com/neonishikawa/tribe", "_blank", "noopener"); if (b.dataset.support === "feedback") window.open("https://tally.so/r/7RAZd2", "_blank", "noopener"); });
  pasangMenuDownload();
  $("#profilePopup").addEventListener("click", (e) => { if (e.target === $("#profilePopup")) finishEdit(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") { if (!$("#watchOverlay").hidden) closeWatch(); else $("#profilePopup").hidden = true; } });
  [$(".gf-header"), $(".gf-storage")].forEach(bindGenre);
  $$(".styled-filter").forEach(bindDropdown);
}
function filterVisible() { const q = state.localQuery.toLowerCase(); return state.storageItems.filter((item) => { if (state.currentTab === "Complete" && !isComplete(item)) return false; if (state.currentTab === "Plan to Watch" && item.progress) return false; if (state.currentTab === "Dislike" && !item.dislike && item.status !== "dropped") return false; if (state.currentTab === "Favorite" && !item.favorite) return false; return !q || item.title.toLowerCase().includes(q); }); }
async function loadLive() {
  state.updateLoading = true;
  renderUpdates();
  const results = await Promise.allSettled([timed(api.daily()), api.genres()]);
  state.updateLoading = false;
  state.daily = results[0].status === "fulfilled" ? (results[0].value.data || []).map(normAnime) : [];
  renderUpdates();
  if (results[1].status === "fulfilled") { state.genres = results[1].value.data || []; bindGenre($(".gf-header")); bindGenre($(".gf-storage")); }
  bindActions();
}
/* Kunci tidak cocok? Kerangka design tetap dirender, tapi tidak ada satu pun
   request ke server: tanpa anime, tanpa hasil pencarian, tanpa episode. */
setup(); setupScrollReveal(); renderAll();
/* Pemberitahuan pemeliharaan: muncul di kunjungan pertama, lalu sekali
   setiap 14 hari. Tidak bergantung pada server, jadi tetap tampil walau
   katalog sedang lambat.

   Tidak ditampilkan di shell APK. Dua alasan: shell terpasang memuat
   "?shell=apk" (penanda yang sama dipakai server untuk melewati halaman
   maintenance), dan WebView Android dikenali dari User-Agent-nya. Keduanya
   dicek supaya notifikasi tetap hilang walau suatu saat penanda URL tidak
   ikut terkirim. Browser biasa dan EXE tetap melihat notifikasi. */
if (!diWebViewAndroid() && !shellTerpasang()) mountMaintenanceNotice();
orb = mountSearchOrb($(".search-wrap"));

/* ---------- Gooey morph: tombol "+" di SETIAP kartu anime ----------
   Gumpalan/cairan dibuat oleh SVG filter (#gooFilter: blur + contrast alpha)
   yang sekarang tinggal SATU definisi global, dipakai ulang semua kartu lewat
   filter:url(#gooFilter). Ikon dan teks berada di luar filter itu, jadi tetap
   tajam. Menu juga tunggal: #gooMenu dipindah ke posisi tombol yang diklik,
   bukan satu panel per kartu (18 kartu = 18 panel sia-sia).
   Isi menu: Favorite, Dislike, Reset, Hapus — untuk SATU anime, itu sebabnya
   tombolnya ada di dalam box anime dan bukan di toolbar. */
const gooMenu = $("#gooMenu");
let gooAnchor = null;
/* Hapus dari menu morph memakai jalur yang SAMA dengan tombol Remove di Edit
   Mode: TAHAN tombolnya (holdable + fill progress), lalu removeStorage() yang
   sudah memunculkan toast. Tidak ada popup dan tidak ada animasi erase di
   sini — dua-duanyadialog khusus untuk Delete All Data di sidebar, satu-
   satunya hapus yang benar-benar menghapus semuanya sekaligus. */
const MORPH_HOLD_MS = 1200;
const closeGooMenu = (refocus) => {
  if (!gooMenu) return;
  gooMenu.setAttribute("hidden", "");
  gooMenu.classList.remove("is-open");
  if (gooAnchor) gooAnchor.setAttribute("aria-expanded", "false");
  if (refocus && gooAnchor) gooAnchor.focus();
  gooAnchor = null;
};
if (gooMenu) {
  const scopeLine = $(".goo-scope", gooMenu);
  /* Panel diposisikan relatif viewport: di atas tombol, tapi tetap di dalam
     layar kalau tombolnya berada di baris paling atas grid. */
  const place = (btn) => {
    const r = btn.getBoundingClientRect();
    gooMenu.style.visibility = "hidden";
    gooMenu.removeAttribute("hidden");
    const h = gooMenu.offsetHeight, w = gooMenu.offsetWidth;
    const above = r.top - h - 10;
    const top = above < 8 ? Math.min(r.bottom + 10, window.innerHeight - h - 8) : above;
    const left = Math.max(8, Math.min(r.left + r.width / 2 - w / 2, window.innerWidth - w - 8));
    gooMenu.style.top = `${Math.round(Math.max(8, top))}px`;
    gooMenu.style.left = `${Math.round(left)}px`;
    gooMenu.style.visibility = "";
    gooMenu.classList.add("is-open");
  };
  const openGooMenu = (btn, slug) => {
    const item = getStored(slug);
    if (!item) return;
    gooAnchor = btn;
    btn.setAttribute("aria-expanded", "true");
    if (scopeLine) scopeLine.textContent = item.title || "Anime ini";
    place(btn);
    gooMenu.querySelector("button")?.focus();
  };
  gooMenu.addEventListener("click", (e) => {
    const item = e.target.closest("[data-goo]");
    if (!item || !gooAnchor) return;
    e.stopPropagation();
    const action = item.dataset.goo;
    const slug = gooAnchor.dataset.id;
    const entry = getStored(slug);
    if (!entry) return;
    /* Hapus TIDAK menutup menu di sini: tombolnya harus tetap kelihatan
       supaya bisa ditahan. Semua aksi lain menutup. */
    if (action !== "remove") closeGooMenu(false);
    if (action === "favorite" || action === "dislike") {
      /* Favorite dan Dislike saling meniadakan, aturan sama seperti
         setAnimeReaction(). Di sini SET, bukan toggle: satu kartu, satu
         klik, status pasti. */
      const isFavorite = action === "favorite";
      const already = isFavorite ? entry.favorite : entry.dislike;
      if (already) { toast(isFavorite ? "Sudah Favorite" : "Sudah Dislike", entry.title || ""); return; }
      Object.assign(entry, isFavorite ? { favorite: true, dislike: false } : { dislike: true, favorite: false });
      saveState();
      renderStorage(); renderProfile();
      toast(isFavorite ? "Ditandai Favorite" : "Ditandai Dislike", entry.title || "");
      return;
    }
    if (action === "reset") {
      /* Reset lewat konfirmasi (silent), lalu aturan resetProgress() yang
         sudah ada: episode dikosongkan, status planned, mulai ulang. */
      if (!entry.watchedEpisodes?.length && !entry.progress) { toast("Tidak ada progress untuk direset.", entry.title || ""); return; }
      openConfirm("Reset progress?", `Semua centang episode ${entry.title} akan dihapus dan mulai lagi dari Episode 1.`, () => resetProgress(slug), { silent: true, confirmLabel: "Reset", confirmClass: "btn btn-primary" });
      return;
    }
    if (action === "remove") {
      /* Hapus: TIDAK langsung jalan. Tombol Hapus di menu ini di-bound
         holdable() di bawah — pointerdown + tahan 1200ms. Klik singkat
         hanya memberi petunjuk cara memakainya. Konsisten dengan tombol
         Remove di Edit Mode, dan popup erase dikhususkan untuk Delete All
         Data di sidebar. */
      toast("Tahan tombol Hapus", `${entry.title || "Anime ini"} — tahan 1,2 detik untuk menghapus, lepas lebih awal untuk batal.`, 2600);
      return;
    }
  });
  /* Hold pada tombol Hapus menu. Menu ini statis di HTML (satu panel untuk
     semua kartu), jadi cukup diikat sekali di sini. */
  const removeBtn = gooMenu.querySelector('[data-goo="remove"]');
  if (removeBtn) {
    holdable(removeBtn, MORPH_HOLD_MS, () => {
      const anchor = gooAnchor;
      if (!anchor) return;
      const slug = anchor.dataset.id;
      const entry = getStored(slug);
      closeGooMenu(false);
      if (!entry) return;
      removeStorage(slug);
    });
  }
  /* Klik di luar menutup; Escape menutup dan mengembalikan fokus ke tombol. */
  document.addEventListener("click", (e) => {
    if (!gooAnchor) return;
    if (gooMenu.contains(e.target) || e.target.closest?.('[data-act="goo"]')) return;
    closeGooMenu(false);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !gooAnchor) return;
    const back = gooAnchor;
    closeGooMenu(false);
    back.focus();
  });
  /* Delegasi: tombol morph dibangun ulang tiap renderStorage/renderSearch/
     renderUpdates, jadi tidak boleh diikat satu per satu. */
  document.addEventListener("click", (e) => {
    const btn = e.target.closest?.('[data-act="goo"]');
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    const slug = btn.dataset.id;
    if (gooAnchor === btn) { closeGooMenu(true); return; }
    closeGooMenu(false);
    openGooMenu(btn, slug);
  });
}
sealReady.then((ok) => {
  if (!ok) return;
  loadLive();
  /* Hydrate metadata storage (rating, genre, karakter) di belakang layar agar
     kartu storage & detail tidak menampilkan "—" selamanya */
  if (state.storageItems.length) hydrateStorageMetadata().then(() => { renderStorage(); renderProfile(); });
});
