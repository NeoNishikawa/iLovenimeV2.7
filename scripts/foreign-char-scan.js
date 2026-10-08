/* Scan karakter asing di file sumber.
   Rentang sengaja dibuat lebar: selain CJK/Kana/Hangul/Cyrillic/Greek, skrip ini
   juga menutup Arabic, Hebrew, Thai, Devanagari, dan huruf/angka fullwidth.

   Fullwidth TIDAK diperiksa untuk tanda baca. `server.js:126` sengaja memuat
   `[:：-]` di dalam kelas karakter untuk membersihkan Judul upstream yang
   memakai titik dua fullwidth — itu parsing defensif yang benar, bukan
   korupsi. Memasukkannya sebagai temuan hanya menghasilkan false positive
   yang mengajari kita mengabaikan output scanner.
   Pelajaran: scan sebelumnya hanya punya 8 rentang, sehingga teks Arab di
   design.MD lolos sebagai "bersih". Scanner ini sendiri adalah bug yang lolos.

   Pakai codePointAt + array rentang, BUKAN grep -P: build grep di host ini
   diam-diam gagal untuk \x{...} besar dan tetap mencetak "bersih".

   Baris yang memuat marker `foreign-char-ok` dilewati: itu tempat karakter
   asing DISENGAJA (mis. fixture uji CJK/Arab di test/robustness.test.js).
   False positive melatih kita mengabaikan scanner — jangan tumbuhkan. */
const fs = require("node:fs");
const path = require("node:path");

const RANGES = [
  [0x0370, 0x03ff, "Greek"],
  [0x0400, 0x04ff, "Cyrillic"],
  [0x0590, 0x05ff, "Hebrew"],
  [0x0600, 0x06ff, "Arabic"],
  [0x0750, 0x077f, "Arabic"],
  [0x0900, 0x097f, "Devanagari"],
  [0x0e00, 0x0e7f, "Thai"],
  [0x0e80, 0x0eff, "Lao"],
  [0x1000, 0x109f, "Myanmar"],
  [0x1780, 0x17ff, "Khmer"],
  [0x1e00, 0x1eff, "Latin Extended Additional"],
  [0x3040, 0x30ff, "Kana"],
  [0x3100, 0x312f, "Bopomofo"],
  [0x3400, 0x4dbf, "CJK"],
  [0x4e00, 0x9fff, "CJK"],
  [0xa000, 0xa4cf, "Yi"],
  [0xac00, 0xd7af, "Hangul"],
  [0xf900, 0xfaff, "CJK"],
  [0xfb50, 0xfdff, "Arabic Presentation"],
  [0xfe70, 0xfeff, "Arabic Presentation"],
  [0xff10, 0xff19, "Fullwidth angka (encoding rusak)"],
  [0xff21, 0xff3a, "Fullwidth huruf (encoding rusak)"],
  [0xff41, 0xff5a, "Fullwidth huruf (encoding rusak)"],
  [0x20000, 0x2ffff, "CJK"],
];

const roots = process.argv.slice(2);
const skip = new Set(["node_modules", ".git", "vendor", "release", "dist", ".ciel", ".agents"]);
const findings = [];

function scanFile(file) {
  const text = fs.readFileSync(file, "utf8");
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    if (line.includes("foreign-char-ok")) return;
    for (const char of line) {
      const code = char.codePointAt(0);
      for (const [start, end, label] of RANGES) {
        if (code >= start && code <= end) {
          findings.push({ file, line: index + 1, label, char, code: `U+${code.toString(16).toUpperCase()}`, text: line.trim().slice(0, 90) });
          break;
        }
      }
    }
  });
}

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (/\.(js|css|html|json|md|MD)$/.test(entry.name)) scanFile(full);
  }
}

for (const root of roots) {
  if (!fs.existsSync(root)) continue;
  if (fs.statSync(root).isDirectory()) walk(root);
  else scanFile(root);
}

if (!findings.length) {
  console.log("bersih: tidak ada karakter asing yang tersesat");
} else {
  for (const item of findings) console.log(`${item.file}:${item.line} ${item.char} ${item.label} ${item.code} | ${item.text}`);
  console.log(`\n${findings.length} temuan`);
  process.exitCode = 1;
}
