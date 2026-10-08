const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const referenceApp = fs.readFileSync(path.join(ROOT, "public/js/reference-app.js"), "utf8");
const orbSource = fs.readFileSync(path.join(ROOT, "public/js/search-orb.js"), "utf8");
const morphCss = fs.readFileSync(path.join(ROOT, "public/css/morph.css"), "utf8");
const indexHtml = fs.readFileSync(path.join(ROOT, "public/index.html"), "utf8");

/* Komentar sering menyebut "tanpa WebGL" atau "tanpa ctx.filter" sebagai
   penjelasan. Assertion di bawah harus memeriksa kode yang benar-benar
   jalan, bukan teks komentar, jadi komentar dibuang lebih dulu. */
const kodeOrb = orbSource.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

/* .search-skeleton-grid masih dipakai sah oleh filter Local Storage,
   jadi assertion harus dibaca hanya dari tubuh renderSearch. */
const renderSearchBody = ((referenceApp.split("function renderSearch(")[1] || "").split("\nfunction ")[0])
  .replace(/\/\*[\s\S]*?\*\//g, "");

test("skeleton search disuntik langsung ke card-grid, bukan dibungkus grid sendiri", () => {
  /* Pembungkus .search-skeleton-grid membuat seluruh skeleton jadi satu
     cell .card-grid, sehingga kartunya turun ke bawah satu per satu.
     renderUpdates() sudah benar sejak awal; search harus ikut pola sama. */
  assert.doesNotMatch(renderSearchBody, /search-skeleton-grid/);
  /* Kerangka fluid harus masuk sebagai anak langsung .card-grid supaya ikut
     grid responsif yang sama dengan kartu hasil. */
  assert.match(renderSearchBody, /gridEl\.innerHTML = waveLoaderHTML\("Mencari…"\)/);
  assert.match(renderSearchBody, /startWavePhysics\(\$\("#waveLoader", gridEl\)\)/);
});

test("loader pencarian memakai komponen yang sama dengan New Update", () => {
  assert.match(referenceApp, /function waveLoaderHTML\(caption = "Memuat update terbaru…"\)/);
  assert.match(referenceApp, /update-skel-card/);
  /* Fisika wave harus dijalankan untuk pencarian, bukan hanya untuk update. */
  const panggilan = referenceApp.match(/startWavePhysics\(\$\("#waveLoader"/g) || [];
  assert.ok(panggilan.length >= 2, "startWavePhysics harus dipakai di update dan search");
});

test("orb mencari memakai canvas 2D polos tanpa filter", () => {
  assert.match(orbSource, /registerSeal\("searchorb", "copyright LoveNime"\)/);
  /* Batasan performa yang tidak boleh dilanggar: tidak ada filter, tidak
     ada WebGL, dan devicePixelRatio dibatasi. */
  assert.doesNotMatch(kodeOrb, /ctx\.filter|\.filter\s*=|WebGL|webgl/);
  assert.match(kodeOrb, /Math\.min\(2, window\.devicePixelRatio/);
  /* Loop harus bisa dihentikan: rAF, IntersectionObserver, visibilitychange. */
  assert.match(orbSource, /cancelAnimationFrame/);
  assert.match(orbSource, /IntersectionObserver/);
  assert.match(orbSource, /visibilitychange/);
  assert.match(orbSource, /prefers-reduced-motion: reduce/);
  assert.match(orbSource, /performanceTier === "low"/);
});

test("orb hanya memakai arc, tanpa fillText atau gambar", () => {
  assert.match(kodeOrb, /ctx\.arc\(/);
  assert.doesNotMatch(kodeOrb, /fillText|drawImage|new Image/);
});

test("orb disembunyikan saat tidak mencari dan tidak menutupi ikon", () => {
  assert.match(morphCss, /\.search-orb\{[^}]*opacity:0/);
  assert.match(morphCss, /\.search-wrap\.is-searching \.search-orb\{opacity:1\}/);
  /* Input harus menyingkir saat orb muncul supaya teks tidak ketimpa. */
  assert.match(morphCss, /\.search-wrap\.is-searching input\{padding-left:30px\}/);
  assert.match(morphCss, /\.search-orb\{[^}]*pointer-events:none/);
});

test("orb dipasang ke search-wrap dan ikut kancing integritas", () => {
  assert.match(referenceApp, /import \{ mountSearchOrb \} from "\.\/search-orb\.js"/);
  assert.match(referenceApp, /orb = mountSearchOrb\(\$\("\.search-wrap"\)\)/);
  const seal = fs.readFileSync(path.join(ROOT, "scripts/seal.js"), "utf8");
  assert.match(seal, /searchorb: "search-orb"/);
  const integrity = fs.readFileSync(path.join(ROOT, "public/js/integrity.js"), "utf8");
  assert.match(integrity, /searchorb: "copyright LoveNime"/);
});

test("asset yang berubah naikkan cache-buster", () => {
  assert.ok(indexHtml.includes("/js/reference-app.js?v="), "reference-app.js wajib punya cache-buster");
  assert.ok(indexHtml.includes("/css/morph.css?v="), "morph.css wajib punya cache-buster");
});
