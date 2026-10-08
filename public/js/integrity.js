/* ============================================================================
   ILoveNime — Seal (kunci integritas)
   ----------------------------------------------------------------------------
   "copyright LoveNime" ditulis sebagai pecahan di setiap file yang terhubung.
   Saat boot, tiap pecahan dibandingkan dengan MANIFEST di bawah. Kalau satu
   huruf saja berubah, atau sebuah pecahan dihapus, aplikasi mengunci diri:
   yang tampil hanya design — tanpa anime, tanpa hasil pencarian, tanpa episode.

   Cara membaca pecahan (tanpa fetch, jadi tidak menambah request saat boot):
   - HTML : <meta name="iln-seal" content="..."> dibaca dari DOM
   - CSS  : --iln-seal-<file> dibaca dari getComputedStyle(documentElement)
   - JS   : tiap modul memanggil registerSeal("<id>", "...") saat dimuat

   PENTING: modul yang tidak pernah dimuat (view.js, storage.js) tidak bisa
   dideteksi runtime, jadi keduanya dicek oleh `npm run seal:check` yang
   membaca file langsung dari disk.
   ========================================================================== */

export const SEAL_PHRASE = "copyright LoveNime";

/* Manifest: apa yang HARUS muncul di setiap file. */
const MANIFEST = {
  html: "copyright LoveNime",
  css: {
    tokens: "copyright LoveNime",
    base: "copyright LoveNime",
    layout: "copyright LoveNime",
    components: "copyright LoveNime",
    morph: "copyright LoveNime",
    motion: "copyright LoveNime",
    continue: "copyright LoveNime",
    animations: "copyright LoveNime",
    responsive: "copyright LoveNime",
  },
  /* id ini wajib terdaftar saat boot karena modulnya memang dimuat. */
  js: {
    api: "copyright LoveNime",
    dropdown: "copyright LoveNime",
    apputils: "copyright LoveNime",
    screentime: "copyright LoveNime",
    perfmode: "copyright LoveNime",
    netstatus: "copyright LoveNime",
    referenceapp: "copyright LoveNime",
    ambient: "copyright LoveNime",
    notice: "copyright LoveNime",
    searchorb: "copyright LoveNime",
  },
};

/* id modul yang hanya dicek dari disk oleh scripts/seal.js --check.
   Tidak dimuat browser saat boot, jadi runtime tidak bisa memverifikasinya. */
export const DISK_ONLY_JS = ["view", "storage"];
const MANIFEST_DISK_ONLY = {
  view: "copyright LoveNime",
  storage: "copyright LoveNime",
};

export const CSS_SEALS = Object.keys(MANIFEST.css);
export const JS_SEALS = Object.keys(MANIFEST.js);

const registry = new Map();

export function registerSeal(id, fragment) {
  registry.set(id, fragment);
  return fragment;
}

/*Modul pure (app-utils, net-status, performance-mode, screen-time) sengaja
  TIDAK memakai `import` untuk mendaftarkan pecahan. Alasannya: unit test
  mengimpor modul itu lewat data:text/javascript, dan relative import dari
  data: URL selalu gagal. Global ini membuat modul tetap bebas import. */
if (typeof globalThis !== "undefined") globalThis.registerSeal = registerSeal;

function fnv1a(text) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/* Bypass hanya untuk pemilik, supaya satu edit tidak mengunci aplikasi
   permanen. Pakai env var server-side atau set window.__ILN_SEAL_BYPASS__.
   Jangan pernah ikut ke build yang dibagikan. */
function bypassed() {
  try {
    if (typeof window !== "undefined" && window.__ILN_SEAL_BYPASS__ === true) return true;
  } catch (_) { /* akses window bisa ditolak */ }
  try {
    if (typeof process !== "undefined" && process.env && process.env.ILN_SEAL_BYPASS === "1") return true;
  } catch (_) { /* bukan lingkungan node */ }
  return false;
}

function readStyleSeal(name) {
  const value = getComputedStyle(document.documentElement).getPropertyValue(`--iln-seal-${name}`);
  return String(value || "").trim().replace(/^["']|["']$/g, "");
}

export function collectSeals() {
  const meta = document.querySelector('meta[name="iln-seal"]');
  const css = {};
  for (const name of CSS_SEALS) css[name] = readStyleSeal(name);
  return { html: meta ? meta.getAttribute("content") || "" : "", css, js: Object.fromEntries(registry) };
}

export function verify(seals = collectSeals()) {
  const wrong = [];
  if (seals.html !== MANIFEST.html) wrong.push("html");
  for (const name of CSS_SEALS) {
    if ((seals.css[name] || "") !== MANIFEST.css[name]) wrong.push(`css:${name}`);
  }
  for (const id of JS_SEALS) {
    if ((seals.js[id] || "") !== MANIFEST.js[id]) wrong.push(`js:${id}`);
  }
  return { ok: wrong.length === 0, wrong, digest: `iln:${fnv1a(seals.html + JSON.stringify(seals.css) + JSON.stringify(seals.js))}` };
}

/* Mengunci tampilan: yang tersisa hanya design. Data anime, hasil pencarian,
   episode, dan player dikosongkan supaya tidak ada isi yang bocor. */
export function applyLock(reason = "") {
  document.documentElement.setAttribute("data-iln-seal-locked", "1");
  try { window.dispatchEvent(new CustomEvent("iln:seal-locked", { detail: { reason } })); } catch (_) { /* CustomEvent mungkin tidak tersedia */ }
  for (const id of ["searchGrid", "updateGrid", "storageGrid", "continueRail", "episodeList", "watchDetailGrid", "searchPager", "storagePager"]) {
    const node = document.getElementById(id);
    if (node) node.innerHTML = "";
  }
  for (const id of ["profileSection", "playerStage", "searchSection", "continueSection", "updateSection", "storageSection"]) {
    const node = document.getElementById(id);
    if (node) node.setAttribute("hidden", "");
  }
  return true;
}

export function releaseLock() {
  document.documentElement.removeAttribute("data-iln-seal-locked");
}

export function runSealCheck() {
  if (bypassed()) return { ok: true, bypassed: true, wrong: [] };
  const result = verify();
  if (!result.ok) applyLock(result.wrong.length ? `kunci berubah: ${result.wrong.join(", ")}` : "kunci tidak cocok");
  return result;
}