/* ==========================================================================
   ILoveNime — Halaman Maintenance (public/maintenance-page/maintenance.js)
   Local Storage fungsional saat maintenance:
   - Data dibaca/ditulis dari key yang SAMA dengan aplikasi utama
     (iln_tracking + ilovenime.reference.prefs) → koleksi sinkron dua arah.
   - Tidak ada panggilan upstream saat halaman dibuka. Fetch ke
     /api/anime & /api/streams (YAOI/ANIMASU via server) HANYA terjadi
     ketika pengguna membuka player (Lanjut Tonton / klik episode).
   v1.2.0: PLAYER OVERLAY gaya watch-overlay aplikasi utama —
   dropdown mirror, prev/next episode, episode list bercentang emas,
   progres episode tersimpan ke iln_tracking (sinkron antar tab).
   ========================================================================== */
import { pageSizeFor, pageCountFor, pageSlice, isItemComplete, buildExportPayload } from "/js/app-utils.js";

/* ---------- Konstanta (harus identik dengan aplikasi utama) ---------- */
const TRACKING_KEY = "iln_tracking";
const PREFS_KEY = "ilovenime.reference.prefs";

/* ---------- Optimasi runtime (v1.1.0) ----------
   - Coalescing render: banyak update dalam satu frame -> satu tulisan DOM.
   - Signature per-target: DOM tidak disentuh kalau hasil render identik.
   - Cache API in-memory + dedupe in-flight + AbortController: tidak ada
     request ganda, tidak ada "traffic jam" saat klik berulang. */
const renderFrame = { queued: false };
const renderSignatures = new Map();
const detailCache = new Map(); /* slug -> { at, data } (TTL 10 menit) */
const mirrorCache = new Map(); /* episodeSlug -> { at, data } (TTL 5 menit) */
const inFlight = new Map();    /* url -> Promise (dedupe) */
const streamAbort = new Map(); /* key -> AbortController */
const DETAIL_TTL_MS = 600_000;
const MIRROR_TTL_MS = 300_000;

/* ---------- State ---------- */
const state = {
  items: [],
  query: "",
  tab: "All",
  page: 0,
  editMode: false,
  selected: new Set(),
  current: null,
  /* Player overlay v1.2.0: judul aktif, daftar episode & mirror, posisi playback */
  player: null, /* { slug, title, image, total, episodes, episodeIndex, mirrors, mirrorIndex } */
  streaming: false, /* guard: satu pemutaran mirror dalam satu waktu */
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const ESC_MAP = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (ch) => ESC_MAP[ch]);

/* ---------- Normalisasi item (subset aman, format sama dengan aplikasi utama) ---------- */
function normalizeStored(raw = {}) {
  const watchedEpisodes = Array.isArray(raw.watchedEpisodes) ? [...new Set(raw.watchedEpisodes.map(Number).filter(Number.isFinite))].sort((a, b) => a - b) : [];
  const progress = Math.max(Number(raw.progress || 0), watchedEpisodes.at(-1) || 0);
  const status = raw.status || (raw.dislike ? "dropped" : raw.planToWatch || !progress ? "planned" : raw.total && progress >= raw.total ? "completed" : "watching");
  return {
    ...raw,
    slug: String(raw.slug || raw.animeId || ""),
    animeId: String(raw.animeId || raw.slug || ""),
    title: String(raw.title || "Unknown title"),
    image: raw.image || raw.posterUrl || "",
    posterUrl: raw.posterUrl || raw.image || "",
    total: Number(raw.total || raw.totalEpisodes || 0),
    progress,
    watchedEpisodes,
    status,
    favorite: Boolean(raw.favorite),
    dislike: Boolean(raw.dislike),
    genres: Array.isArray(raw.genres) ? raw.genres.map((g) => typeof g === "string" ? g : g.name).filter(Boolean) : [],
    rating: Number(raw.rating || 0),
  };
}

function readTracking() {
  try {
    const parsed = JSON.parse(localStorage.getItem(TRACKING_KEY) || "[]");
    return Array.isArray(parsed) ? parsed.map(normalizeStored).filter((x) => x.slug) : [];
  } catch { return []; }
}

function saveState() {
  localStorage.setItem(TRACKING_KEY, JSON.stringify(state.items.map(normalizeStored)));
}

/* ---------- Toast ---------- */
function toast(title, body = "") {
  const el = document.createElement("div");
  el.className = "toast";
  el.innerHTML = `<b>${esc(title)}</b>${body ? esc(body) : ""}`;
  $("#toasts").appendChild(el);
  setTimeout(() => { el.classList.add("leaving"); el.addEventListener("animationend", () => el.remove(), { once: true }); }, 3200);
}

/* ---------- Filter, tab, sort ---------- */
function isComplete(item) { return isItemComplete(item); }

function filteredItems() {
  const q = state.query.toLowerCase();
  return state.items.filter((item) => {
    if (state.tab === "Complete" && !isComplete(item)) return false;
    if (state.tab === "Plan to Watch" && item.progress) return false;
    if (state.tab === "Dislike" && !item.dislike && item.status !== "dropped") return false;
    if (state.tab === "Favorite" && !item.favorite) return false;
    return !q || `${item.title} ${item.genres.join(" ")}`.toLowerCase().includes(q);
  });
}

/* ---------- Kartu ---------- */
function cardHTML(item) {
  const watched = Number(item.progress || item.watchedEpisodes?.at(-1) || 0);
  const total = Number(item.total || 0);
  const pct = total ? Math.min(100, Math.round((watched / total) * 100)) : 0;
  const selected = state.editMode && state.selected.has(item.slug);
  const removeLayer = state.editMode ? `<div class="remove-wrap"><button class="btn-remove" data-act="remove" data-id="${esc(item.slug)}" title="Tahan untuk hapus"><span class="hold-fill"></span><svg class="ico"><use href="#i-trash"/></svg> Hapus</button></div>` : "";
  return `<article class="card${selected ? " selected" : ""}" data-id="${esc(item.slug)}" data-act="open" tabindex="0" role="button" aria-label="${esc(item.title)}">
    <div class="thumb">
      ${state.editMode ? `<button class="check-wrap${selected ? " on" : ""}" data-act="check" data-id="${esc(item.slug)}" aria-label="Pilih ${esc(item.title)}" tabindex="-1">${selected ? "✓" : ""}</button>` : ""}
      ${item.favorite ? `<span class="fav-mark"><svg class="ico"><use href="#i-star"/></svg></span>` : ""}
      ${total ? `<span class="eps-badge">${total} Eps</span>` : ""}
      <img src="${esc(item.image || "")}" alt="" loading="lazy" decoding="async" onerror="this.classList.add('err')">
      ${removeLayer}
    </div>
    <div class="card-body">
      <h3 class="card-title" title="${esc(item.title)}">${esc(item.title)}</h3>
      <div class="card-meta">
        <svg class="ico"><use href="#i-star"/></svg>
        <span>${item.rating ? item.rating.toFixed(1) : "—"}</span>
        <span class="dot"></span>
        <span>Ep ${watched}/${total || "?"}</span>
        ${isComplete(item) ? `<span class="dot"></span><span class="complete-tag">Complete</span>` : ""}
      </div>
      <div class="progress-row"><div class="progress-top"><span>Progres</span><span>${pct}%</span></div><div class="bar"><i style="width:${pct}%"></i></div></div>
    </div>
  </article>`;
}

function emptyHTML() {
  return state.items.length
    ? `<div class="empty"><h4>Tidak ada yang cocok</h4><p>Coba ubah kata kunci atau tab filter.</p></div>`
    : `<div class="empty"><h4>Storage masih kosong</h4><p>Tambahkan anime dari aplikasi utama, atau Import file backup JSON.</p></div>`;
}

/* ---------- Render (coalesced: maksimal 1x per frame) ----------
   Chromium menangguhkan rAF di tab tersembunyi/occluded; fallback timer
   250ms memastikan render tetap jalan (tab yang dilihat memakai rAF,
   tab yang tak terlihat memakai timer — dua-duanya sekali per update). */
function scheduleRender() {
  if (renderFrame.queued) return;
  renderFrame.queued = true;
  let ran = false;
  const run = () => { if (ran) return; ran = true; renderFrame.queued = false; renderNow(); };
  requestAnimationFrame(run);
  setTimeout(run, 250);
}
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && renderFrame.queued) { renderFrame.queued = false; renderNow(); }
});
function render() { scheduleRender(); }
function renderNow() {
  const items = filteredItems();
  const pageSize = pageSizeFor(window.innerWidth < 768);
  const pageCount = pageCountFor(items.length, pageSize);
  state.page = Math.min(state.page, pageCount - 1);
  const paged = pageSlice(items, state.page, pageSize);

  $$("#storageTabs .count").forEach((el) => {
    const key = el.dataset.count;
    const counts = {
      All: state.items.length,
      Complete: state.items.filter(isComplete).length,
      "Plan to Watch": state.items.filter((i) => !i.progress).length,
      Dislike: state.items.filter((i) => i.dislike || i.status === "dropped").length,
      Favorite: state.items.filter((i) => i.favorite).length,
    };
    el.textContent = counts[key] ?? 0;
  });
  $$("#storageTabs .tab").forEach((el) => el.classList.toggle("active", el.dataset.tab === state.tab));

  $("#editBar").hidden = !state.editMode;
  $("#editCount").textContent = `${state.selected.size} dipilih`;

  /* Signature: kalau konten identik, jangan sentuh DOM sama sekali */
  const gridSig = `${paged.length}|${paged[0]?.slug || ""}|${paged.at(-1)?.slug || ""}|${state.query}|${state.tab}|${state.page}|${state.editMode}|${state.selected.size}`;
  if (renderSignatures.get("grid") !== gridSig) {
    renderSignatures.set("grid", gridSig);
    $("#storageGrid").innerHTML = paged.length ? paged.map(cardHTML).join("") : emptyHTML();
  }

  const pagerSig = `p${state.page}/${pageCount}`;
  if (renderSignatures.get("pager") !== pagerSig) {
    renderSignatures.set("pager", pagerSig);
    $("#storagePager").innerHTML = pageCount > 1 ? pagerHTML(state.page, pageCount) : "";
  }
}

function pagerHTML(page, pageCount) {
  const btn = (label, target, extra = "") => `<button type="button" data-page="${target}" ${extra}>${label}</button>`;
  const nums = [];
  for (let n = 0; n < pageCount; n += 1) {
    if (n === 0 || n === pageCount - 1 || Math.abs(n - page) <= 1) nums.push(`<button type="button" data-page="${n}" class="${n === page ? "on" : ""}">${n + 1}</button>`);
    else if (nums.at(-1) !== "…") nums.push("…");
  }
  return `<nav class="pager" aria-label="Halaman storage">${btn("‹", page - 1, page <= 0 ? "disabled" : "")}${nums.join("")}${btn("›", page + 1, page >= pageCount - 1 ? "disabled" : "")}</nav>`;
}

/* ---------- Hold-to-confirm (hapus) ---------- */
function holdable(button, duration, onDone) {
  if (button.dataset.holdBound === "1") return;
  button.dataset.holdBound = "1";
  let timer = null;
  const fill = $(".hold-fill", button);
  const start = (event) => {
    event.preventDefault();
    if (timer) return;
    fill?.classList.add("filling");
    timer = setTimeout(() => { cleanup(); onDone(button); }, duration);
  };
  const cancel = () => cleanup();
  function cleanup() {
    if (!timer) return;
    clearTimeout(timer);
    timer = null;
    fill?.classList.remove("filling");
  }
  button.addEventListener("pointerdown", start);
  ["pointerup", "pointerleave", "pointercancel"].forEach((type) => button.addEventListener(type, cancel));
}

/* ---------- Modal detail lokal ---------- */
function openModal(slug) {
  const item = state.items.find((i) => i.slug === slug);
  if (!item) return;
  state.current = item;
  const watched = Number(item.progress || item.watchedEpisodes?.at(-1) || 0);
  const total = Number(item.total || 0);
  const pct = total ? Math.min(100, Math.round((watched / total) * 100)) : 0;

  $("#mPoster").src = item.image || "";
  $("#mTitle").textContent = item.title;
  $("#mMeta").innerHTML = `
    <span>${total || "?"} Episodes</span><span>·</span>
    <span>Rating ${item.rating ? item.rating.toFixed(1) : "—"}</span><span>·</span>
    <span>${esc(item.status || "watching")}</span>`;
  $("#mProgress").innerHTML = `<div class="progress-top"><span>Ep <b>${watched}</b> / ${total || "?"}</span><span>${pct}%</span></div><div class="bar"><i style="width:${pct}%"></i></div>`;
  $("#mGenres").innerHTML = (item.genres || []).slice(0, 8).map((g) => `<span class="chip">${esc(g)}</span>`).join("");

  /* Episode list mini di modal (data storage, tanpa upstream).
     Klik episode = langsung membuka player overlay di episode itu. */
  const epBox = $("#mEpisodes");
  if (total > 0) {
    const watchedSet = new Set((item.watchedEpisodes || []).map(Number));
    $("#mEpisodeList").innerHTML = Array.from({ length: total }, (_, i) => i + 1).map((n) => `
      <button type="button" class="ep-item${n <= watchedSet.size ? " watched" : ""}" data-modal-episode="${n}">
        <span class="st">${n <= watchedSet.size ? "✓" : ""}</span>
        <span>EP ${String(n).padStart(2, "0")} · Episode ${n}</span>
      </button>`).join("");
    epBox.hidden = false;
  } else {
    $("#mEpisodeList").innerHTML = "";
    epBox.hidden = true;
  }

  $("#mPlayerBox").hidden = true;
  $("#mPlayerBox").innerHTML = "";
  $("#mNotice").hidden = true;
  $("#mNotice").className = "modal-notice";
  const streamBtn = $("#mStream");
  streamBtn.disabled = false;
  streamBtn.innerHTML = `<svg class="ico"><use href="#i-play"/></svg> Lanjut Tonton`;
  $("#itemModal").hidden = false;
  document.body.style.overflow = "hidden";
  $(".modal-x", $("#itemModal")).focus();
}

function closeModal() {
  if (state.current) streamAbort.get(state.current.slug)?.abort();
  $("#itemModal").hidden = true;
  document.body.style.overflow = "";
  state.current = null;
}

function notice(kind, message) {
  const box = $("#mNotice");
  box.className = `modal-notice ${kind}`;
  box.innerHTML = `<svg class="ico"><use href="#i-${kind === "ok" ? "info" : "alert"}"/></svg><span>${esc(message)}</span>`;
  box.hidden = false;
}

/* ---------- PLAYER OVERLAY (v1.2.0 — gaya watch-overlay aplikasi utama) ----------
   Terbuka dari modal detail (Lanjut Tonton / klik episode di daftar).
   Fitur: dropdown mirror, prev/next episode, episode list bercentang emas.
   Progres: setiap episode yang diputar ditulis ke iln_tracking → tab lain
   (aplikasi utama terbuka paralel) ikut tersinkron lewat event "storage". */
function povPlayer() { return $("#povPlayerBox"); }

function watchedNumbers(itemLike) {
  return new Set(((itemLike?.watchedEpisodes) || []).map(Number).filter(Number.isFinite));
}

function currentStoredItem() {
  return state.items.find((i) => i.slug === state.player?.slug) || null;
}

function openPlayer(slug, { episodeNumber = null } = {}) {
  const item = state.items.find((i) => i.slug === slug);
  if (!item) return;
  const previous = state.player?.slug === slug ? state.player : null;
  state.player = previous || { slug: item.slug, title: item.title, image: item.image, total: Number(item.total || 0), episodes: [], episodeIndex: -1, mirrors: [], mirrorIndex: 0 };
  renderPlayerShell();
  $("#itemModal").hidden = true;
  document.body.style.overflow = "hidden";
  $("#playerOverlay").hidden = false;

  /* Re-open untuk judul yang sama: pakai ulang daftar episode/mirror yang
     sudah dimuat (tidak ada fetch ulang); lompat ke episode diminta. */
  if (previous?.episodes?.length) {
    const idx = episodeNumber != null
      ? state.player.episodes.findIndex((ep) => Number(ep.number) === Number(episodeNumber))
      : Math.max(0, previous.episodeIndex);
    playPlayerEpisode(Math.max(0, Math.min(idx, state.player.episodes.length - 1)), "right");
  } else {
    bootPlayerDetail(episodeNumber);
  }
}

function renderPlayerShell() {
  const p = state.player;
  $("#povTitle").textContent = p.title;
  $("#povSub").textContent = "Memuat detail episode…";
  $("#povDetail").hidden = true;
  $("#povActions").innerHTML = "";
  $("#povNote").textContent = "Mirror aktif dari source streaming. Jika gagal, pilih mirror lain.";
  renderMirrorControls();
  renderEpisodeList();
  povPlayer().innerHTML = `<div class="player-loading"><div class="spinner"></div></div>`;
}

/* Muat /api/anime (cache TTL 10 mnt), pilih episode lanjutan, lalu putar.
   Episode lanjutan = episode berikutnya yang BELUM ditonton (fallback ep 1). */
async function bootPlayerDetail(requestedNumber = null) {
  const p = state.player;
  if (!p) return;
  const slugAtStart = p.slug;
  try {
    const detail = await fetchJSON(`/api/anime/${encodeURIComponent(p.slug)}`, { ttlMs: DETAIL_TTL_MS, cache: detailCache, abortKey: `detail:${p.slug}` });
    if (state.player?.slug !== slugAtStart) return; /* player sudah ditutup/diganti */
    const episodes = (detail.data?.episodes || []).slice().sort((a, b) => Number(a.number) - Number(b.number));
    if (!episodes.length) throw new Error("Episode tidak tersedia dari server.");
    p.episodes = episodes;
    p.total = episodes.length;
    const watchedSet = watchedNumbers(currentStoredItem());
    let idx = -1;
    if (requestedNumber != null) idx = episodes.findIndex((ep) => Number(ep.number) === Number(requestedNumber));
    if (idx < 0) idx = episodes.findIndex((ep) => !watchedSet.has(Number(ep.number)));
    if (idx < 0) idx = 0; /* semua sudah ditonton → mulai dari episode 1 */
    renderPlayerMeta();
    renderEpisodeList();
    await playPlayerEpisode(idx, "right");
  } catch (error) {
    if (state.player?.slug !== slugAtStart) return;
    $("#povSub").textContent = error.message;
    povPlayer().innerHTML = `<div class="player-ph"><div class="msg">${esc(error.message)}</div></div>`;
    renderMirrorControls();
  }
}

function renderPlayerMeta() {
  const p = state.player;
  if (!p) return;
  const item = currentStoredItem();
  const watched = Number(item?.progress || 0);
  const ep = p.episodes[p.episodeIndex];
  $("#povTitle").textContent = p.title;
  $("#povSub").textContent = `Episode ${ep ? ep.number : "?"} dari ${p.episodes.length} · ditonton ${watched}`;
  $("#povDetail").hidden = false;
  $("#povDetailGrid").innerHTML = `
    <div class="detail-item"><div class="k">Episodes</div><div class="v">${p.episodes.length}</div></div>
    <div class="detail-item"><div class="k">Rating</div><div class="v">${item?.rating ? item.rating.toFixed(1) : "—"}</div></div>
    <div class="detail-item"><div class="k">Status</div><div class="v">${esc(item?.status || "watching")}</div></div>`;
  $("#povSynopsis").textContent = "";
  $("#povGenres").innerHTML = (item?.genres || []).slice(0, 8).map((g) => `<span class="chip">${esc(g)}</span>`).join("");
  $("#povActions").innerHTML = `
    <button type="button" class="btn btn-primary" data-pov-prev ${p.episodeIndex <= 0 ? "disabled" : ""}>← Previous</button>
    <button type="button" class="btn btn-primary" data-pov-next ${p.episodeIndex >= p.episodes.length - 1 ? "disabled" : ""}>Next →</button>`;
}

function renderEpisodeList() {
  const p = state.player;
  if (!p) return;
  const list = $("#povEpisodeList");
  if (!p.episodes.length) {
    /* Placeholder sebelum detail datang: angka dari metadata storage */
    list.innerHTML = p.total ? Array.from({ length: p.total }, (_, i) => i + 1).map((n) => `
      <div class="ep-item"><span class="st"></span><span>EP ${String(n).padStart(2, "0")} · Episode ${n}</span></div>`).join("") : "";
    return;
  }
  const watchedSet = watchedNumbers(currentStoredItem());
  list.innerHTML = p.episodes.map((ep, i) => `
    <button type="button" class="ep-item${i === p.episodeIndex ? " current" : ""}${watchedSet.has(Number(ep.number)) ? " watched" : ""}" data-pov-episode-index="${i}">
      <span class="st">${watchedSet.has(Number(ep.number)) ? "✓" : ""}</span>
      <span>EP ${String(ep.number).padStart(2, "0")} · ${esc(ep.title || "Episode")}</span>
    </button>`).join("");
}

function renderMirrorControls() {
  const p = state.player;
  if (!p) return;
  /* vo-bar hidup di #povStage (di atas kotak player), bukan di dalamnya */
  $("#povStage").querySelectorAll(".vo-bar").forEach((el) => el.remove());
  if (!p.mirrors.length) return;
  const m = p.mirrors[p.mirrorIndex];
  const bar = document.createElement("div");
  bar.className = "vo-bar";
  bar.innerHTML = `
    <div class="vo-mirror">
      <button type="button" class="mirror-trigger" aria-haspopup="true" aria-expanded="false">
        <svg class="ico"><use href="#i-database"/></svg>
        <span class="mirror-label">${esc(m.name || `Mirror ${p.mirrorIndex + 1}`)}</span>
        <svg class="ico gf-chev"><use href="#i-chev-down"/></svg>
      </button>
      <div class="mirror-options" hidden>
        ${p.mirrors.map((mi, i) => `<button type="button" class="${i === p.mirrorIndex ? "active" : ""}" data-mirror-index="${i}">${esc(mi.name || `Mirror ${i + 1}`)}</button>`).join("")}
      </div>
    </div>
    <div class="vo-actions">
      <button type="button" class="vo-btn" data-vo-prev title="Episode sebelumnya" aria-label="Episode sebelumnya" ${p.episodeIndex <= 0 ? "disabled" : ""}><svg class="ico"><use href="#i-chev-left"/></svg></button>
      <button type="button" class="vo-btn" data-vo-next title="Episode berikutnya" aria-label="Episode berikutnya" ${p.episodeIndex >= p.episodes.length - 1 ? "disabled" : ""}><svg class="ico"><use href="#i-chev-right"/></svg></button>
    </div>`;
  $("#povStage").appendChild(bar);
  bar.querySelector(".mirror-trigger").addEventListener("click", (event) => {
    event.stopPropagation();
    const options = bar.querySelector(".mirror-options");
    options.hidden = !options.hidden;
    bar.querySelector(".mirror-trigger").setAttribute("aria-expanded", String(!options.hidden));
  });
  bar.querySelectorAll("[data-mirror-index]").forEach((btn) => btn.addEventListener("click", (event) => {
    event.stopPropagation();
    loadMirror(Number(btn.dataset.mirrorIndex), Number(btn.dataset.mirrorIndex) >= p.mirrorIndex ? "right" : "left");
    /* Tutup dropdown setelah memilih (sama seperti closeActive app utama) */
    bar.querySelector(".mirror-options").hidden = true;
    bar.querySelector(".mirror-trigger").setAttribute("aria-expanded", "false");
  }));
  bar.querySelector("[data-vo-prev]").addEventListener("click", () => navigatePlayerEpisode(-1));
  bar.querySelector("[data-vo-next]").addEventListener("click", () => navigatePlayerEpisode(1));
}

/* Putar episode: ambil mirror (cache 5 mnt) → iframe + dropdown mirror.
   Progres ditandai SEKALI saat episode mulai diputar (markWatched). */
async function playPlayerEpisode(index, direction = "right") {
  const p = state.player;
  if (!p || index < 0 || index >= p.episodes.length) return;
  if (state.streaming) return; /* guard double-click / double-episode */
  state.streaming = true;
  p.episodeIndex = index;
  const ep = p.episodes[index];
  /* Tandai sudah ditonton SEBELUM render (sama seperti aplikasi utama):
     centang emas episode ini langsung tampil di episode list. */
  markWatched(Number(ep.number));
  renderPlayerMeta();
  renderEpisodeList();
  povPlayer().innerHTML = `<div class="player-loading"><div class="spinner"></div></div>`;

  try {
    const streams = await fetchJSON(`/api/streams/${encodeURIComponent(ep.slug)}`, { ttlMs: MIRROR_TTL_MS, cache: mirrorCache, abortKey: `mirror:${p.slug}` });
    if (state.player !== p) return; /* player sudah ditutup/diganti */
    const mirrors = streams.data || [];
    if (!mirrors.length) throw new Error("Mirror tidak tersedia dari server.");
    p.mirrors = mirrors;
    p.mirrorIndex = 0;
    mountMirror("right");
  } catch (error) {
    if (state.player !== p) return;
    p.mirrors = [];
    p.mirrorIndex = 0;
    renderMirrorControls();
    $("#povNote").textContent = error?.name === "AbortError"
      ? "Pengambilan mirror dibatalkan (timeout atau diganti request baru)."
      : `Streaming butuh server anime (YAOI/ANIMASU). Saat hosting/upgrade berjalan, upstream bisa belum tersedia. (${error.message})`;
    povPlayer().innerHTML = `<div class="player-ph"><div class="msg">${esc(error?.name === "AbortError" ? "Pengambilan mirror dibatalkan." : error.message)}</div></div>`;
  } finally {
    state.streaming = false;
  }
}

/* Pasang iframe mirror aktif + bar kontrol, dengan transisi fade/slide */
function mountMirror(direction = "right") {
  const p = state.player;
  const box = povPlayer();
  if (!p || !box) return;
  const mirror = p.mirrors[p.mirrorIndex];
  if (!mirror) return;
  renderMirrorControls();
  const frame = document.createElement("iframe");
  frame.src = mirror.url;
  frame.allow = "fullscreen";
  frame.setAttribute("allowfullscreen", "");
  frame.title = `Player ${p.title}`;
  box.classList.add("mirror-fading");
  setTimeout(() => {
    if (state.player !== p) return;
    box.innerHTML = "";
    box.appendChild(frame);
    box.classList.remove("mirror-fading");
    box.classList.add(`mirror-in-${direction === "left" ? "left" : "right"}`);
    box.addEventListener("animationend", () => box.classList.remove("mirror-in-right", "mirror-in-left"), { once: true });
  }, 170);
  $("#povNote").textContent = "Mirror aktif dari source streaming. Jika gagal, pilih mirror lain.";
}

function loadMirror(index, direction = "right") {
  const p = state.player;
  const mirror = p?.mirrors[index];
  if (!mirror) return;
  p.mirrorIndex = index;
  mountMirror(direction);
}

function navigatePlayerEpisode(delta) {
  const p = state.player;
  if (!p) return;
  const target = p.episodes[p.episodeIndex + delta];
  if (target) playPlayerEpisode(p.episodeIndex + delta, delta > 0 ? "right" : "left");
}

/* Progres episode → iln_tracking (format & key sama dengan aplikasi utama).
   Tab lain yang terbuka menerima pembaruan via event window "storage". */
function markWatched(number) {
  const p = state.player;
  if (!p || !Number.isFinite(number)) return;
  const idx = state.items.findIndex((i) => i.slug === p.slug);
  if (idx < 0) return;
  const item = normalizeStored(state.items[idx]);
  item.watchedEpisodes = [...new Set([...(item.watchedEpisodes || []), Number(number)])].sort((a, b) => a - b);
  item.progress = Math.max(Number(item.progress || 0), Number(number));
  item.status = isComplete(item) ? "completed" : "watching";
  state.items[idx] = item;
  saveState();
  render();
}

function closePlayer() {
  const p = state.player;
  if (p) {
    streamAbort.get(`mirror:${p.slug}`)?.abort();
    streamAbort.get(`detail:${p.slug}`)?.abort();
  }
  $("#playerOverlay").hidden = true;
  povPlayer().innerHTML = ""; /* iframe dibongkar → audio/video berhenti */
  $("#itemModal").hidden = false; /* kembali ke modal detail */
  document.body.style.overflow = "hidden";
  state.player = null;
  /* Bangun ulang modal agar progres & centang episode terbaru tampil */
  const item = p ? state.items.find((i) => i.slug === p.slug) : null;
  if (item) openModal(item.slug);
}

/* ---------- Binding player overlay & modal (dipanggil dari bind()) ---------- */
function bindPlayer() {
  $("#mStream").addEventListener("click", () => {
    const item = state.current;
    if (item) openPlayer(item.slug);
  });

  /* Klik episode di daftar mini modal → player di episode itu */
  $("#mEpisodeList").addEventListener("click", (event) => {
    const btn = event.target.closest("[data-modal-episode]");
    if (btn) openModalEpisode(Number(btn.dataset.modalEpisode));
  });

  /* Delegasi klik di dalam overlay player */
  $("#playerOverlay").addEventListener("click", (event) => {
    if (event.target.closest("[data-pov-close]")) { closePlayer(); return; }
    if (event.target.closest("[data-pov-prev]")) { navigatePlayerEpisode(-1); return; }
    if (event.target.closest("[data-pov-next]")) { navigatePlayerEpisode(1); return; }
    const epBtn = event.target.closest("[data-pov-episode-index]");
    if (epBtn) {
      const idx = Number(epBtn.dataset.povEpisodeIndex);
      const p = state.player;
      if (p && idx !== p.episodeIndex) playPlayerEpisode(idx, idx > p.episodeIndex ? "right" : "left");
      return;
    }
    /* Klik di luar modal (area gelap) menutup player */
    if (event.target.id === "playerOverlay") closePlayer();
  });

  /* Klik di luar dropdown mirror menutup daftar opsi */
  document.addEventListener("click", (event) => {
    if (!event.target.closest(".vo-mirror")) {
      $("#playerOverlay")?.querySelectorAll(".mirror-options:not([hidden])").forEach((options) => {
        options.hidden = true;
        options.closest(".vo-mirror")?.querySelector(".mirror-trigger")?.setAttribute("aria-expanded", "false");
      });
    }
  });
}

/* Klik episode di modal detail: buka player overlay langsung di episode itu */
function openModalEpisode(number) {
  const item = state.current;
  if (!item) return;
  openPlayer(item.slug, { episodeNumber: number });
}

/* ---------- Import / Export ---------- */
function doExport() {
  let prefs = {};
  try { prefs = JSON.parse(localStorage.getItem(PREFS_KEY) || "{}"); } catch { prefs = {}; }
  const payload = buildExportPayload(state.items.map(normalizeStored), prefs);
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }));
  link.download = `ilovenime-tracking-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 0);
  toast("Backup diunduh", `${payload.items.length} anime + profil.`);
}

function doImport(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      const items = Array.isArray(data) ? data : data.items || data.storageItems;
      if (!Array.isArray(items)) throw new Error("Format backup tidak dikenali.");
      state.items = items.map(normalizeStored).filter((x) => x.slug);
      if (data.profile && typeof data.profile === "object") {
        try {
          const current = JSON.parse(localStorage.getItem(PREFS_KEY) || "{}");
          localStorage.setItem(PREFS_KEY, JSON.stringify({ ...current, ...data.profile }));
        } catch { /* prefs lama tetap */ }
      }
      saveState();
      state.selected.clear();
      state.page = 0;
      render();
      toast("Import selesai", `${state.items.length} anime dipulihkan.`);
    } catch (error) {
      toast("Import gagal", error.message);
    }
  };
  reader.onerror = () => toast("Import gagal", "File tidak dapat dibaca.");
  reader.readAsText(file);
}

/* ---------- Jam header (Asia/Bangkok, sama dengan server) ---------- */
function startClock() {
  const el = $("#hdrClock");
  let lastMinutes = "";
  const tick = () => {
    if (document.hidden) return; /* tab background: nol kerja */
    try {
      const text = new Intl.DateTimeFormat("id-ID", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Bangkok" }).format(new Date());
      if (text !== lastMinutes) { lastMinutes = text; el.textContent = text; }
    } catch { el.textContent = ""; }
  };
  tick();
  setInterval(tick, 30_000);
}

/* ---------- Binding ---------- */
function bind() {
  $("#localSearch").addEventListener("input", (event) => { state.query = event.target.value; state.page = 0; render(); });

  $$("#storageTabs .tab").forEach((tab) => tab.addEventListener("click", () => { state.tab = tab.dataset.tab; state.page = 0; render(); }));

  $("#dataMenuBtn").addEventListener("click", (event) => {
    event.stopPropagation();
    const menu = $("#dataMenu");
    menu.hidden = !menu.hidden;
    $("#dataMenuBtn").setAttribute("aria-expanded", String(!menu.hidden));
  });
  document.addEventListener("click", (event) => {
    if (!event.target.closest(".datamenu-wrap")) { $("#dataMenu").hidden = true; $("#dataMenuBtn").setAttribute("aria-expanded", "false"); }
  });
  $("#exportBtn").addEventListener("click", () => { $("#dataMenu").hidden = true; doExport(); });
  $("#importBtn").addEventListener("click", () => { $("#dataMenu").hidden = true; $("#importFile").click(); });
  $("#importFile").addEventListener("change", (event) => { doImport(event.target.files?.[0]); event.target.value = ""; });

  $("#editModeBtn").addEventListener("click", () => {
    state.editMode = !state.editMode;
    state.selected.clear();
    $("#editModeBtn").setAttribute("aria-pressed", String(state.editMode));
    $("#editModeBtn").innerHTML = state.editMode ? `Done` : `<svg class="ico"><use href="#i-edit"/></svg> Edit Mode`;
    render();
  });
  $("#selectAllBtn").addEventListener("click", () => {
    filteredItems().forEach((item) => state.selected.add(item.slug));
    render();
  });
  $("#cancelEditBtn").addEventListener("click", () => { state.editMode = false; state.selected.clear(); $("#editModeBtn").innerHTML = `<svg class="ico"><use href="#i-edit"/></svg> Edit Mode`; render(); });

  /* Delegasi klik grid: open / check / remove(hold) */
  $("#storageGrid").addEventListener("click", (event) => {
    const check = event.target.closest('[data-act="check"]');
    if (check) {
      event.stopPropagation();
      const id = check.dataset.id;
      state.selected.has(id) ? state.selected.delete(id) : state.selected.add(id);
      render();
      return;
    }
    const remove = event.target.closest('[data-act="remove"]');
    if (remove) {
      event.stopPropagation();
      return; /* diaktifkan lewat holdable() di bawah */
    }
    const open = event.target.closest('[data-act="open"]');
    if (open && !state.editMode) openModal(open.dataset.id);
  });
  $("#storageGrid").addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const open = event.target.closest('[data-act="open"]');
    if (open && !state.editMode) { event.preventDefault(); openModal(open.dataset.id); }
  });
  /* hold-to-confirm di-setiap render (delegasi tidak cocok untuk hold) */
  new MutationObserver(() => $$('[data-act="remove"]').forEach((btn) => holdable(btn, 1500, (b) => {
    const id = b.dataset.id;
    const item = state.items.find((i) => i.slug === id);
    state.items = state.items.filter((i) => i.slug !== id);
    state.selected.delete(id);
    saveState();
    render();
    toast("Terhapus", `${item?.title || "Anime"} dihapus dari storage.`);
  }))).observe($("#storageGrid"), { childList: true });

  $("#bulkDeleteBtn") && holdable($("#bulkDeleteBtn"), 1500, () => {
    const before = state.items.length;
    state.items = state.items.filter((i) => !state.selected.has(i.slug));
    state.selected.clear();
    saveState();
    render();
    toast("Anime terpilih dihapus", `${before - state.items.length} judul dihapus.`);
  });

  $("#storagePager").addEventListener("click", (event) => {
    const btn = event.target.closest("button[data-page]");
    if (!btn || btn.disabled) return;
    state.page = Number(btn.dataset.page);
    render();
    $("#storage").scrollIntoView({ behavior: "smooth", block: "start" });
  });

  $("#itemModal").addEventListener("click", (event) => { if (event.target.closest("[data-close]")) closeModal(); });

  /* Esc: player lebih dulu (tutup → kembali ke modal), lalu modal */
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (!$("#playerOverlay").hidden) { closePlayer(); return; }
    if (!$("#itemModal").hidden) closeModal();
  });

  bindPlayer();

  /* Placeholder link web baru: cegah lompat kalau belum diisi */
  $$("[data-newsite]").forEach((a) => a.addEventListener("click", (event) => {
    if (a.getAttribute("href") === "#") { event.preventDefault(); toast("Web baru belum ditautkan", "Isi URL web baru pada elemen [data-newsite] di index.html."); }
  }));

  /* Perubahan dari tab lain (aplikasi utama terbuka paralel) tetap tersinkron */
  window.addEventListener("storage", (event) => {
    if (event.key === TRACKING_KEY) { state.items = readTracking(); render(); }
  });

  window.addEventListener("resize", (() => {
    let lastSize = pageSizeFor(window.innerWidth < 768);
    return () => {
      const size = pageSizeFor(window.innerWidth < 768);
      if (size !== lastSize) { lastSize = size; state.page = 0; render(); }
    };
  })());
}

/* ---------- Pause animasi hero saat off-screen (hemat GPU) ---------- */
function watchHeroVisibility() {
  const frame = $(".frame");
  if (!("IntersectionObserver" in window) || !frame) return;
  new IntersectionObserver((entries) => {
    entries.forEach((entry) => document.body.classList.toggle("hero-offscreen", !entry.isIntersecting));
  }, { threshold: 0.02 }).observe(frame);
}

/* ---------- Fetch helper: cache + dedupe + timeout + abort ---------- */
async function fetchJSON(url, { ttlMs, cache, abortKey, timeoutMs = 12_000 } = {}) {
  const now = Date.now();
  const hit = cache.get(url);
  if (hit && now - hit.at < ttlMs) return hit.data;
  if (inFlight.has(url)) return inFlight.get(url);
  if (abortKey) streamAbort.get(abortKey)?.abort();
  const controller = new AbortController();
  if (abortKey) streamAbort.set(abortKey, controller);
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const promise = (async () => {
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
      return await res.json();
    } finally {
      clearTimeout(timer);
      inFlight.delete(url);
      if (abortKey && streamAbort.get(abortKey) === controller) streamAbort.delete(abortKey);
    }
  })();
  inFlight.set(url, promise);
  const data = await promise;
  cache.set(url, { at: now, data });
  return data;
}

/* ---------- Init (tanpa panggilan upstream) ---------- */
state.items = readTracking();
bind();
startClock();
watchHeroVisibility();
render();
