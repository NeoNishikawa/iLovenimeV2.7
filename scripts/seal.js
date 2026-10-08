/* ============================================================================
   ILoveNime — seal tool
   ----------------------------------------------------------------------------
   Sealing berarti: menuliskan pecahan "copyright LoveNime" ke setiap file yang
   terhubung, lalu menghitung hash gabungan dan menyimpannya di
   public/js/integrity.js sebagai EXPECTED.

   Jalankan SESUDAH setiap edit sah ke file yang ikut disegel:

     node scripts/seal.js          -> tulis ulang kunci (setelah edit sah)
     node scripts/seal.js --check  -> hanya verifikasi, gagal kalau tidak cocok

   `--check` sengaja dipakai test suite supaya kunci rusak tidak pernah lolos
   ke publik tanpa ketahuan.
   ========================================================================== */

const fs = require("node:fs");
const path = require("node:path");

/* ILN_SEAL_ROOT dipakai test agar pemeriksaan bisa jalan di salinan
   sementara. Tanpa itu, test harus mengubah file proyek sungguhan, dan
   `node --test` yang berjalan paralel akan membacanya saat sedang rusak. */
const ROOT = process.env.ILN_SEAL_ROOT || path.join(__dirname, "..");
const PHRASE = "copyright LoveNime";

/* Urutan ini harus sama dengan integrity.js. */
const CSS_SEALS = ["tokens", "base", "layout", "components", "morph", "motion", "continue", "animations", "responsive"];
const JS_SEALS = ["api", "dropdown", "apputils", "screentime", "perfmode", "netstatus", "referenceapp", "ambient", "notice", "searchorb"];
/* Modul ini tidak dimuat browser saat boot, jadi hanya bisa dicek dari disk. */
const DISK_ONLY_JS = ["view", "storage"];
/* Modul yang juga mengimpor integrity.js secara langsung boleh pakai import. */
const IMPORTS_INTEGRITY = new Set(["api", "referenceapp"]);
const ALL_JS_SEALS = [...JS_SEALS, ...DISK_ONLY_JS];

const HTML_PATH = "public/index.html";
const INTEGRITY_PATH = "public/js/integrity.js";
const SEAL_CSS_PATH = "public/css/seal.css";

function fnv1a(text) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/* Pecahan per file. Semua file memakai frasa yang sama, jadi yang membedakan
   file adalah TIAP ID-nya — punya 10 pecahan, bukan 1. */
function fragmentFor(fileId) {
  return `${PHRASE}`;
}

function readSeal(file) {
  if (!fs.existsSync(file)) return "";
  return fs.readFileSync(path.join(ROOT, file), "utf8");
}

function extract(pattern, source) {
  const match = pattern.exec(source);
  return match ? match[1] : "";
}

function collect() {
  const html = extract(/<meta name="iln-seal" content="([^"]*)"/, readSeal(HTML_PATH));
  const sealCss = readSeal(SEAL_CSS_PATH);
  const css = {};
  for (const name of CSS_SEALS) css[name] = extract(new RegExp(`--iln-seal-${name}:"([^"]*)"`), sealCss);

  const js = {};
  for (const id of ALL_JS_SEALS) {
    const file = path.join("public", "js", `${fileFor(id)}.js`);
    js[id] = extract(new RegExp(`registerSeal\\("${id}",\\s*"([^"]*)"\\)`), readSeal(file));
  }
  return { html, css, js };
}

function fileFor(id) {
  const map = {
    api: "api", view: "view", storage: "storage", apputils: "app-utils", netstatus: "net-status",
    screentime: "screen-time", perfmode: "performance-mode",    dropdown: "dropdown", ambient: "ambient", referenceapp: "reference-app", notice: "maintenance-notice", searchorb: "search-orb",
  };
  return map[id];
}

function assemble(seals) {
  const parts = [seals.html];
  for (const name of CSS_SEALS) parts.push(seals.css[name] || "");
  for (const id of ALL_JS_SEALS) parts.push(`${id}:${seals.js[id] || ""}`);
  return parts.join("|");
}

function digestOf(seals) {
  return `iln:${fnv1a(assemble(seals))}`;
}

function writeSeals() {
  const htmlFile = path.join(ROOT, HTML_PATH);
  const html = fs.readFileSync(htmlFile, "utf8");
  const meta = `<meta name="iln-seal" content="${PHRASE}" />`;
  if (/<meta name="iln-seal"/.test(html)) {
    fs.writeFileSync(htmlFile, html.replace(/<meta name="iln-seal" content="[^"]*" \/>/, meta));
  } else {
    fs.writeFileSync(htmlFile, html.replace("</head>", `  ${meta}\n</head>`));
  }

  const sealCssFile = path.join(ROOT, SEAL_CSS_PATH);
  let sealCss = fs.readFileSync(sealCssFile, "utf8");
  for (const name of CSS_SEALS) {
    sealCss = sealCss.replace(new RegExp(`(--iln-seal-${name}:")[^"]*(")`), `$1${PHRASE}$2`);
  }
  fs.writeFileSync(sealCssFile, sealCss);

  for (const id of ALL_JS_SEALS) {
    const file = path.join(ROOT, "public", "js", `${fileFor(id)}.js`);
    if (!fs.existsSync(file)) continue;
    let source = fs.readFileSync(file, "utf8");
    const line = IMPORTS_INTEGRITY.has(id)
      ? `registerSeal("${id}", "${fragmentFor(id)}");`
      : `if (typeof globalThis.registerSeal === "function") globalThis.registerSeal("${id}", "${fragmentFor(id)}");`;
    const globalLine = new RegExp(`if \\(typeof globalThis\\.registerSeal === "function"\\) globalThis\\.registerSeal\\("${id}",\\s*"[^"]*"\\);`);
    const plainLine = new RegExp(`^registerSeal\\("${id}",\\s*"[^"]*"\\);$`, "m");
    if (globalLine.test(source)) source = source.replace(globalLine, line);
    else if (plainLine.test(source)) source = source.replace(plainLine, line);
    else {
      const head = IMPORTS_INTEGRITY.has(id) ? `import { registerSeal } from "./integrity.js";\n${line}\n` : `${line}\n`;
      source = `${head}${source}`;
    }
    fs.writeFileSync(file, source);
  }
}

/* Bandingkan pecahan yang terbaca dari disk dengan MANIFEST di integrity.js.
   Fungsi ini dipakai dua pihak: `seal.js --check` dan server saat boot,
   supaya keduanya tidak bisa berbeda pendapat soal apa yang "utuh". */
function verifyAgainstManifest(seals, integrity = readSeal(INTEGRITY_PATH)) {
  const missing = [];
  const wrong = [];
  const manifestHtml = extract(/html: "([^"]*)"/, integrity);
  if (!seals.html) missing.push("html");
  else if (seals.html !== manifestHtml) wrong.push("html");
  for (const name of CSS_SEALS) {
    const expected = extract(new RegExp(`${name}: "([^"]*)"`), integrity);
    if (!seals.css[name]) missing.push(`css:${name}`);
    else if (seals.css[name] !== expected) wrong.push(`css:${name}`);
  }
  for (const id of ALL_JS_SEALS) {
    const expected = extract(new RegExp(`${id}: "([^"]*)"`), integrity);
    if (!seals.js[id]) missing.push(`js:${id}`);
    else if (seals.js[id] !== expected) wrong.push(`js:${id}`);
  }
  return { ok: !missing.length && !wrong.length, missing, wrong, digest: digestOf(seals) };
}

function main() {
  const checkOnly = process.argv.includes("--check");
  if (!checkOnly) {
    writeSeals();
    console.log(`kunci ditulis ulang: ${digestOf(collect())}`);
    return;
  }

  const seals = collect();
  const result = verifyAgainstManifest(seals);

  if (result.missing.length) {
    console.error(`SEAL GAGAL: pecahan hilang -> ${result.missing.join(", ")}`);
    process.exit(1);
  }
  if (result.wrong.length) {
    console.error(`SEAL GAGAL: kunci berubah -> ${result.wrong.join(", ")}`);
    process.exit(1);
  }
  console.log(`seal utuh: ${result.digest}`);
}

if (require.main === module) main();

module.exports = { fnv1a, collect, assemble, digestOf, verifyAgainstManifest, PHRASE, CSS_SEALS, JS_SEALS, DISK_ONLY_JS, ALL_JS_SEALS };