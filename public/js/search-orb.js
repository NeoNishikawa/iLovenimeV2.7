if (typeof globalThis.registerSeal === "function") globalThis.registerSeal("searchorb", "copyright LoveNime");

/* Search orb — state "searching": meridian pemindaian menyapu globe bertitik.
   Di dalam input pencarian, hanya saat pencarian berjalan.

   Batasan yang sengaja dipatuhi, sama seperti bagian motion lain:
   - Canvas 2D polos. Hanya ctx.arc, tanpa ctx.filter, tanpa SVG filter, tanpa WebGL.
   - devicePixelRatio dibatasi 2 supaya layar retina tidak jadi 4x pixel kerja.
   - Berhenti total saat tab disembunyikan atau orb keluar viewport.
   - prefers-reduced-motion dan performance tier "low" hanya menggambar satu
     bingkai statis, tidak menjalankan loop.
   - Tanpa timer: satu requestAnimationFrame yang dibatalkan sendiri. */

const DOTS = 46;
const RADIUS = 11;
const SPIN = 0.00042;      /* rad per ms, putaran globe */
const SWEEP = 0.0016;       /* rad per ms, kecepatan meridian */
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

/* Fibonacci sphere: titik tersebar merata, bukan mengelompok di kutub. */
const SPHERE = Array.from({ length: DOTS }, (_, i) => {
  const y = 1 - (i / (DOTS - 1)) * 2;
  const radius = Math.sqrt(Math.max(0, 1 - y * y));
  const theta = GOLDEN_ANGLE * i;
  return { x: Math.cos(theta) * radius, y, z: Math.sin(theta) * radius };
});

function shortestAngle(from, to) {
  let delta = (to - from) % (Math.PI * 2);
  if (delta > Math.PI) delta -= Math.PI * 2;
  if (delta < -Math.PI) delta += Math.PI * 2;
  return Math.abs(delta);
}

let handle = null;
let frame = 0;

function paint(canvas, rotation, sweep, color) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const size = RADIUS * 2;
  if (canvas.width !== size * dpr) {
    canvas.width = size * dpr;
    canvas.height = size * dpr;
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, size, size);
  const cx = size / 2;
  const cy = size / 2;

  for (const dot of SPHERE) {
    /* Putar globe terhadap sumbu Y. */
    const rx = dot.x * Math.cos(rotation) + dot.z * Math.sin(rotation);
    const rz = -dot.x * Math.sin(rotation) + dot.z * Math.cos(rotation);
    const px = cx + rx * RADIUS;
    const py = cy - dot.y * RADIUS;
    /* Titik di belahan belakang lebih redup, tapi tetap digambar supaya
       globe terasa bulat dan bukan setengah lingkaran. */
    const depth = (rz + 1) / 2;
    /* Meridian yang sedang menyapu: banding di sekitar bujur saat ini. */
    const longitude = Math.atan2(-rz, rx);
    const onScan = Math.max(0, 1 - shortestAngle(longitude, sweep) / 0.8);
    const alpha = 0.16 + depth * 0.3 + onScan * 0.62;
    const dotRadius = 0.85 + onScan * 0.75;
    ctx.beginPath();
    ctx.arc(px, py, dotRadius, 0, Math.PI * 2);
    ctx.globalAlpha = Math.min(1, alpha);
    ctx.fillStyle = color;
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function inkColor() {
  const styles = getComputedStyle(document.documentElement);
  const raw = (styles.getPropertyValue("--gold-ink") || styles.getPropertyValue("--gold") || "#FFD700").trim();
  return raw || "#FFD700";
}

function prefersStill() {
  if (document.documentElement.dataset.performanceTier === "low") return true;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function isHidden() {
  return document.visibilityState === "hidden";
}

/* Dipanggil sekali saat boot: menyisipkan canvas ke dalam kolom pencarian
   lalu mengembalikan kendali loop-nya. setBusy() kemudian dipanggil setiap
   kali state pencarian berubah. */
export function mountSearchOrb(wrap) {
  if (!wrap || wrap.querySelector(".search-orb")) return null;
  const canvas = document.createElement("canvas");
  canvas.className = "search-orb";
  canvas.setAttribute("aria-hidden", "true");
  wrap.appendChild(canvas);
  handle = canvas;

  let visible = false;
  let offscreen = false;

  const stop = () => {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
  };

  const loop = (now) => {
    if (!visible || offscreen || isHidden()) { stop(); return; }
    if (prefersStill()) {
      paint(canvas, 0.6, 0, inkColor());
      stop();
      return;
    }
    paint(canvas, now * SPIN, now * SWEEP, inkColor());
    frame = requestAnimationFrame(loop);
  };

  const start = () => { if (!frame) frame = requestAnimationFrame(loop); };

  /* IntersectionObserver: orb berada di header, jadi sering keluar viewport
     saat user menggulir. Loop dihentikan, bukan tetap jalan diam-diam. */
  if (typeof IntersectionObserver === "function") {
    new IntersectionObserver((entries) => {
      offscreen = !entries[0].isIntersecting;
      if (!offscreen && visible) start();
      else if (offscreen) stop();
    }).observe(canvas);
  }

  document.addEventListener("visibilitychange", () => {
    if (isHidden()) stop();
    else if (visible && !offscreen) start();
  });

  return {
    setBusy(busy) {
      visible = Boolean(busy);
      wrap.classList.toggle("is-searching", visible);
      if (visible && !offscreen && !isHidden()) start();
      else stop();
    },
    destroy() {
      visible = false;
      stop();
      canvas.remove();
      handle = null;
    },
  };
}

export function activeSearchOrb() {
  return handle;
}
