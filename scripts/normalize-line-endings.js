/* scripts/normalize-line-endings.js
   Ubah semua file teks repo ini ke LF.

   Kenapa alat ini perlu ada, dan kenapa bukan sekali saja:
   PowerShell di Windows menulis CRLF. [IO.File]::WriteAllLines SELALU
   menulis CRLF, dan Add-Content memakai newline platform. Repo ini
   memakai LF - terbukti dari file yang tidak pernah disentuh
   (api.js, net-status.js, tokens.css, server.js semuanya 0 byte CR).

   Kerugiannya bukan cosmetics. Regex test seperti
   /pasangLayarTanpaJaringan\(\);\n/ berhenti cocok begitu `;` diikuti
   `\r`, dan seluruh file test itu gagal memuat - 25 test hilang tanpa
   ada yang memberi tahu keuang. Dan test baru auto-update.test.js
   sekarang menjaga hal ini supaya tidak terjadi diam-diam lagi.

   Diproses per BYTE, bukan lewat string: hanya 0x0D sebelum 0x0A yang
   dibuang, sehingga encoding dan isi file lain tidak tersentuh. */
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const SKIP_DIR = new Set(["node_modules", ".git", "release", "dist", ".gradle", "build"]);
const EKSTENSI = new Set([".js", ".json", ".css", ".html", ".md", ".MD", ".yml", ".yaml", ".txt", ".mjs", ".cjs"]);

function walnutkan(file) {
  const sebelum = fs.readFileSync(file);
  let cr = 0;
  for (let i = 0; i < sebelum.length - 1; i += 1) {
    if (sebelum[i] === 0x0d && sebelum[i + 1] === 0x0a) cr += 1;
  }
  if (cr === 0) return 0;
  const sesudah = Buffer.alloc(sebelum.length - cr);
  let j = 0;
  for (let i = 0; i < sebelum.length; i += 1) {
    if (sebelum[i] === 0x0d && sebelum[i + 1] === 0x0a) continue;
    sesudah[j] = sebelum[i];
    j += 1;
  }
  fs.writeFileSync(file, sesudah);
  return cr;
}

const ikut = process.argv.includes("--check");
let diubah = 0, crDibuang = 0, diperiksa = 0;
const suspect = [];

(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") && entry.name !== ".") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIR.has(entry.name)) continue;
      walk(full);
      continue;
    }
    const ext = path.extname(entry.name);
    if (!EKSTENSI.has(ext)) continue;
    diperiksa += 1;
    const rel = path.relative(ROOT, full);
    if (ikut) {
      const buf = fs.readFileSync(full);
      for (let i = 0; i < buf.length; i += 1) {
        if (buf[i] === 0x0d) { suspect.push(rel); break; }
      }
      continue;
    }
    const n = walnutkan(full);
    if (n) { diubah += 1; crDibuang += n; console.log("  " + rel + "  (-" + n + " CR)"); }
  }
})(ROOT);

if (ikut) {
  if (suspect.length) {
    console.log("File yang masih punya CR:");
    for (const s of suspect) console.log("  " + s);
    process.exit(1);
  }
  console.log("Semua file sumber pakai LF (" + diperiksa + " file diperiksa)");
  process.exit(0);
}

console.log(diubah === 0
  ? "Semua file sudah LF (" + diperiksa + " file diperiksa)"
  : diubah + " file dinormalkan, " + crDibuang + " byte CR dibuang (" + diperiksa + " file diperiksa)");