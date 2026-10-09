/* scripts/verify-smartscreen-dialog.js
   Bukti bahwa dialog SmartScreen bekerja dan isinya sesuai permintaan.

   Yang diperiksa dari file yang benar-benar tersaji di server (bukan dari
   file lokal): kalau server menyajikan versi lama, pemeriksaan ini harus
   gagal - bukan diam-diam membaca file lokal dan melaporkan lulus. */
const http = require("node:http");

const PORT = Number(process.argv[2] || 5199);

function ambil(pathname) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port: PORT, path: pathname, timeout: 8000 }, (res) => {
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => resolve(body));
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
  });
}

(async () => {
  /* Server harus hidup. Percaya hasil hanya setelah HTTP 200 - fuzz ke port
     kosong memberi status=0 yang bisa disalahartikan sebagai bukti. */
  let html = "";
  try {
    html = await ambil("/");
  } catch (e) {
    console.log("  GAGAL  server tidak hidup di 127.0.0.1:" + PORT + " (" + e.message + ")");
    console.log("  VERIFIKASI TIDAK DIJALANKAN - jangan dibaca sebagai lulus.");
    process.exit(1);
  }
  if (!html.includes("iLoveNime")) {
    console.log("  GAGAL  HTTP 200 tapi halaman tidak tampak seperti iLoveNime");
    process.exit(1);
  }
  console.log("  server hidup, HTTP OK\n");

  const js = await ambil("/js/reference-app.js");
  const norm = js.replace(/\r\n/g, "\n");

  /* Assertion memakai substring, bukan regex. Versi pertama memakai
     /\[data-ss-go"\], overlay\)/ yang menolak kode yang benar: selector di
     sumber ditulis "[data-ss-go]" - kutip ada SEBELUM kurung siku. Pola
     rapuh seperti itu lebih berbahaya daripada tidak ada test, karena
     orang akan memperbaiki kode yang sudah benar sampai cocok tebakan. */
  const harusAda = [
    ["klik .exe membuka dialog, bukan langsung mengunduh",
      'if (item.dataset.dl === "exe") { showSmartScreenNotice(url); return; }'],
    [".apk tetap langsung membuka link",
      'if (item.dataset.dl === "exe") { showSmartScreenNotice(url); return; }' + "\n" + '      window.open(url, "_blank", "noopener");'],
    ["link GitHub dibuka hanya setelah tombol ditekan",
      '$("[data-ss-go]", overlay).onclick = () => { close(); setTimeout(() => window.open(url, "_blank", "noopener"), 230); };'],
    ["Batal menutup tanpa membuka link",
      '$("[data-ss-cancel]", overlay).onclick = close;'],
    ["Escape menutup dialog",
      'overlay.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });'],
    ["overlay ganda dibuang",
      'root.querySelectorAll(".overlay").forEach((lama) => lama.remove());'],
    ["fokus ke tombol utama saat dibuka",
      '$("[data-ss-go]", overlay).focus();'],
    ["dialog memakai kelas .ss-modal", 'confirm-modal ss-modal'],
    ["judul dialog ada", 'id="ssTtl"'],
    ["menyebut Windows protected your PC", "Windows protected your PC"],
    ["menyebut Unknown Publisher", "Unknown Publisher"],
    ["menyatakan itu wajar", "wajar"],
    ["ada langkah 1 More info", 'Klik <strong>"More info"</strong>'],
    ["ada langkah 2 Run anyway", 'Klik <strong>"Run anyway"</strong>'],
    ["ada tombol Lanjut unduh", "data-ss-go>Lanjut unduh"],
    ["ada tombol Batal", "data-ss-cancel>Batal"],
  ];

  /* Yang harus TIDAK ada. Permintaan Neo 9 Oktober: blok tegasan "hanya
     untuk file iLoveNime-...-Setup-x64.exe" dihapus karena tidak penting,
     dan kalimat "(atau "Show more")" juga dibuang. */
  const harusTidakAda = [
    ["blok tegasan nama file", "ss-warn"],
    ["kalimat '(atau \"Show more\")'", 'Show more'],
    ["teks 'dari halaman ini'", "dari halaman ini"],
  ];

  let gagal = 0;
  console.log("  -- harus ada --");
  for (const [label, potongan] of harusAda) {
    const ok = norm.includes(potongan);
    if (!ok) gagal += 1;
    console.log("  " + (ok ? "ok   " : "GAGAL") + "  " + label);
  }
  console.log("\n  -- harus tidak ada --");
  for (const [label, potongan] of harusTidakAda) {
    const ok = !norm.includes(potongan);
    if (!ok) gagal += 1;
    console.log("  " + (ok ? "ok   " : "GAGAL") + "  " + label);
  }

  /* CSS: .ss-warn sudah dihapus. Kalau masih ada, selector itu tidak)
n     berdampak apa pun, tapi sisa CSS adalah jejak yang tidak perlu. */
  const css = await ambil("/css/layout.css");
  if (css.includes(".ss-warn")) {
    gagal += 1;
    console.log("\n  GAGAL  .ss-warn masih ada di layout.css");
  } else {
    console.log("  ok     .ss-warn sudah hilang dari layout.css");
  }
  if (!css.includes(".ss-steps")) {
    gagal += 1;
    console.log("  GAGAL  .ss-steps hilang dari layout.css - daftar langkah jadi tanpa gaya");
  } else {
    console.log("  ok     .ss-steps masih ada di layout.css");
  }

  console.log("\n  " + (gagal === 0
    ? "SMARTSCREEN DIALOG: sesuai (" + (harusAda.length + harusTidakAda.length + 2) + " pemeriksaan)"
    : "SMARTSCREEN DIALOG: " + gagal + " pemeriksaan gagal"));
  process.exit(gagal === 0 ? 0 : 1);
})();