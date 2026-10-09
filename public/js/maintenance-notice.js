if (typeof globalThis.registerSeal === "function") globalThis.registerSeal("notice", "copyright LoveNime");
/* ============================================================================
   ILoveNime — Pemberitahuan pemeliharaan 14 hari, bentuk BANNER
   ----------------------------------------------------------------------------
   Dulu ini modal layar penuh (overlay aria-modal) yang mengunci seluruh
   halaman sampai pengunjung klik "Mengerti". Audit UX DesignMeter (5 Okt
   2026) menandainya CRITICAL: pengunjung baru — yang localStorage-nya masih
   kosong — selalu terkunci di depan gembok sebelum sempat melihat apa pun,
   dan crawler memberi nilai UX rendah karena situs memang tidak bisa
   dijelajahi.

   Sekarang bentuknya pita ramping non-blocking di atas halaman: pesan tetap
   tersampaikan, tapi pengunjung bisa langsung menjelajah dan menonton.
   Halaman didorong turun lewat class "notice-open" di <body>, bukan
   ditimpa overlay.

   Waktu tampil terakhir tetap disimpan di localStorage per perangkat, jadi
   tidak ada server yang perlu ikut menyimpan apa pun.

  (localStorage dipakai penuh: kalau browser dalam mode privat atau storage
   diblokir, notis akan muncul lagi di kunjungan berikutnya. Itu perilaku yang
   wajar untuk pengingat, bukan bug.)
   ========================================================================== */

const STORAGE_KEY = "iln.notice.lastShownAt";
export const NOTICE_INTERVAL_DAYS = 14;
const INTERVAL_MS = NOTICE_INTERVAL_DAYS * 24 * 60 * 60 * 1000;

export function shouldShowNotice(storage, now = Date.now()) {
  let last = 0;
  try { last = Number(storage.getItem(STORAGE_KEY)) || 0; } catch (_) { return true; }
  return now - last >= INTERVAL_MS;
}

export function markNoticeShown(storage, now = Date.now()) {
  try { storage.setItem(STORAGE_KEY, String(now)); } catch (_) { /* storage diblokir, abaikan */ }
}

/* Tanggal pemberitahuan BERIKUTNYA, dalam bahasa Indonesia.

   Anchor-nya adalah `now` - waktu banner ini sedang ditampilkan.
   Versi lama memakai `lastShownAt` (kapan banner terakhir ditutup), dan
   itu salah karena keduanya bisa berbeda jauh:

     ditutup 8 Oktober, dibuka lagi 23 Oktober
       lama  : 8 + 14 hari  = 22 Oktober   <-- MASA LALU, sudah lewat 1 hari
       benar : 23 + 14 hari = 6 November

   Banner_write "Pemberitahuan berikutnya: 22 Oktober" tepat di hari ke-15,
   padahal tanggal itu sudah lewat. Itu bukan soal zona waktu atau hosting;
   underlying-nya sejak awal salah anchor.

  Kalau storage diblokir, lastShownAt = 0. `now` tetap jadi anchor
   yang benar, jadi tidak perlu cabang khusus. */
export function nextNoticeDate(now = Date.now()) {
  const next = new Date(now + INTERVAL_MS);
  try {
    return next.toLocaleDateString("id-ID", { day: "numeric", month: "long", year: "numeric" });
  } catch (_) {
    return next.toISOString().slice(0, 10);
  }
}

export function buildNoticeHtml(esc = (value) => String(value)) {
  const nextDate = nextNoticeDate();
  return `
    <div class="maintenance-badge"><svg class="ico"><use href="#i-info"/></svg></div>
    <h3 id="maintenanceNoticeTitle" class="nb-title">Pemberitahuan Pemeliharaan</h3>
    <p class="nb-text">Pemeliharaan server rutin setiap <b>14 hari</b> agar katalog, mirror, dan kecepatan pencarian tetap stabil. <b>Mohon maaf</b> atas ketidaknyamanannya — data anime kamu di perangkat ini <b>tidak akan hilang</b>.</p>
    <span class="nb-next">Pemberitahuan berikutnya: <b>${esc(nextDate)}</b></span>
    <button class="btn btn-ghost nb-close" data-notice-ok>Mengerti</button>`;
}

export function mountMaintenanceNotice(root = document.body, options = {}) {
  if (!root) return null;
  const storage = options.storage || (() => { try { return window.localStorage; } catch (_) { return null; } })();
  const now = options.now || Date.now;
  if (!shouldShowNotice(storage, now())) return null;

  const esc = options.esc || ((value) => String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])));
  /* role="status", BUKAN dialog: pita ini tidak boleh mengambil alih
     interaksi halaman. Ditambahkan ke <body> supaya position:fixed-nya
     benar-benar menempel ke viewport, bukan ke kontainer yang di-transform. */
  const banner = document.createElement("aside");
  banner.className = "notice-banner";
  banner.setAttribute("role", "status");
  banner.setAttribute("aria-live", "polite");
  banner.setAttribute("aria-labelledby", "maintenanceNoticeTitle");
  banner.innerHTML = buildNoticeHtml(esc);
  root.appendChild(banner);
  document.body.classList.add("notice-open");

  /* Tinggi banner DINAMIS: di layar sempit teks membungkus dan pita bisa
     lebih tinggi dari 64px. Padding body mengikuti tinggi nyata, dan
     diukur ulang tiap resize, jadi konten tidak pernah tertutup pita. */
  const pasangTinggi = () => document.body.style.setProperty("--notice-h", `${banner.offsetHeight}px`);
  pasangTinggi();
  window.addEventListener("resize", pasangTinggi);

  const close = () => {
    markNoticeShown(storage, now());
    banner.classList.add("is-closing");
    document.body.classList.remove("notice-open");
    document.body.style.removeProperty("--notice-h");
    window.removeEventListener("resize", pasangTinggi);
    setTimeout(() => banner.remove(), 220);
  };
  banner.querySelector("[data-notice-ok]").onclick = close;
  return banner;
}
