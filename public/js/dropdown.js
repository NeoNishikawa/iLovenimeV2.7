if (typeof globalThis.registerSeal === "function") globalThis.registerSeal("dropdown", "copyright LoveNime");
/* ==========================================================================
   ILoveNime — Dropdown mekanik terpusat
   Semua dropdown (genre, karakter, tipe, status, data menu, mirror)
   memakai modul ini. Logika filter tetap milik reference-app.js.
   ========================================================================== */

const mobileQuery = window.matchMedia("(max-width: 767px)");
let activeDropdown = null;

function isMobile() { return mobileQuery.matches; }

function setOpen(root, trigger, panel, open) {
  if (open) {
    if (activeDropdown && activeDropdown.root !== root) closeActive();
    activeDropdown = { root, trigger, panel };
    panel.hidden = false;
    panel.style.animation = "none";
    void panel.offsetHeight; /* paksa reflow agar animation restart */
    if (isMobile()) document.body.style.overflow = "hidden";
    else clampPanel(panel); /* ukur saat animasi mati agar geometry stabil */
    panel.style.animation = "";
    root.classList.add("open");
    trigger.setAttribute("aria-expanded", "true");
  } else {
    const finish = () => {
      panel.hidden = true;
      root.classList.remove("open", "is-closing");
      panel.style.animation = "";
    };
    root.classList.remove("open");
    trigger.setAttribute("aria-expanded", "false");
    if (isMobile()) document.body.style.overflow = "";
    if (isMobile()) {
      root.classList.add("is-closing");
      panel.addEventListener("animationend", finish, { once: true });
      /* Cadangan bila reduced-motion memotong animationend */
      window.setTimeout(finish, 300);
    } else {
      finish();
    }
  }
}

/* Geser panel agar tidak keluar viewport (desktop saja).
   Dipanggil saat animation:none agar rect tidak terdistorsi transform.
   left/right panel bersifat relatif ke containing block, jadi koreksi
   dihitung sebagai delta terhadap rect yang terukur. */
export function clampPanel(panel) {
  panel.style.left = "";
  panel.style.right = "";
  const rect = panel.getBoundingClientRect();
  const anchor = panel.offsetParent?.getBoundingClientRect();
  if (!anchor) return;
  const margin = 8;
  if (rect.left < margin) {
    const shift = margin - rect.left;
    panel.style.left = `${Math.round(rect.left - anchor.left + shift)}px`;
    panel.style.right = "auto";
  } else if (rect.right > window.innerWidth - margin) {
    const shift = rect.right - (window.innerWidth - margin);
    panel.style.right = `${Math.round(anchor.right - rect.right + shift)}px`;
    panel.style.left = "auto";
  }
}

export function closeActive() {
  if (!activeDropdown) return;
  const { root, trigger, panel } = activeDropdown;
  setOpen(root, trigger, panel, false);
  activeDropdown = null;
}

export function bindDropdown({ root, trigger, panel }) {
  if (!root || !trigger || !panel) return;

  trigger.addEventListener("click", (event) => {
    event.stopPropagation();
    const willOpen = panel.hidden;
    if (!willOpen) closeActive();
    setOpen(root, trigger, panel, willOpen);
  });

  trigger.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !panel.hidden) { closeActive(); event.stopPropagation(); }
  });
}

/* Klik luar & Esc global */
document.addEventListener("click", (event) => {
  if (!activeDropdown) return;
  const { root } = activeDropdown;
  if (event.target.closest && root.contains(event.target)) return;
  closeActive();
}, true);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && activeDropdown) { closeActive(); event.stopPropagation(); }
});
mobileQuery.addEventListener("change", () => { if (activeDropdown) closeActive(); });

/* Helper: bungkus elemen dropdown lama ke modul ini (idempoten) */
export function attach(rootSelector) {
  const root = typeof rootSelector === "string" ? document.querySelector(rootSelector) : rootSelector;
  if (!root || root.dataset.dropdownBound === "1") return null;
  const trigger = root.querySelector(".gf-trigger, .mirror-trigger, .btn");
  const panel = root.querySelector(".gf-panel, .mirror-options, .data-menu");
  if (!trigger || !panel) return null;
  root.dataset.dropdownBound = "1";
  bindDropdown({ root, trigger, panel });
  return { root, trigger, panel };
}
