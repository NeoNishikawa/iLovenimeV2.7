const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const sealSource = fs.readFileSync(path.join(ROOT, "scripts/seal.js"), "utf8");
const integritySource = fs.readFileSync(path.join(ROOT, "public/js/integrity.js"), "utf8");
const sealCss = fs.readFileSync(path.join(ROOT, "public/css/seal.css"), "utf8");
const indexHtml = fs.readFileSync(path.join(ROOT, "public/index.html"), "utf8");
const { CSS_SEALS, ALL_JS_SEALS } = require(path.join(ROOT, "scripts/seal.js"));

const FILE_FOR = {
  api: "api", view: "view", storage: "storage", apputils: "app-utils", netstatus: "net-status",
  screentime: "screen-time", perfmode: "performance-mode",  dropdown: "dropdown", ambient: "ambient", referenceapp: "reference-app", notice: "maintenance-notice", searchorb: "search-orb",
};

/*(node --test menjalankan berkas test BERPARALEL. Test yang mengubah file
  proyek sungguhan akan membuat berkas lain membaca file yang sedang rusak.
  Karena itu semua pemeriksaan merusak dilakukan di salinan sementara.) */
function buatSalinan() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "iln-seal-"));
  fs.mkdirSync(path.join(root, "public/css"), { recursive: true });
  fs.mkdirSync(path.join(root, "public/js"), { recursive: true });
  fs.copyFileSync(path.join(ROOT, "public/index.html"), path.join(root, "public/index.html"));
  fs.copyFileSync(path.join(ROOT, "public/css/seal.css"), path.join(root, "public/css/seal.css"));
  fs.copyFileSync(path.join(ROOT, "public/js/integrity.js"), path.join(root, "public/js/integrity.js"));
  for (const id of ALL_JS_SEALS) {
    fs.copyFileSync(path.join(ROOT, "public/js", `${FILE_FOR[id]}.js`), path.join(root, "public/js", `${FILE_FOR[id]}.js`));
  }
  return root;
}

function cekDi(root) {
  return execFileSync(process.execPath, [path.join(ROOT, "scripts/seal.js"), "--check"], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, ILN_SEAL_ROOT: root },
    stdio: "pipe",
  });
}

test("seal utuh: satu huruf pun berubah di file mana pun akan terdeteksi", () => {
  assert.match(cekDi(ROOT), /seal utuh/);
});

test("frasa kunci ada di HTML, semua CSS, dan setiap modul JS", () => {
  assert.match(indexHtml, /<meta name="iln-seal" content="copyright LoveNime" \/>/);
  for (const name of CSS_SEALS) {
    assert.match(sealCss, new RegExp(`--iln-seal-${name}:"copyright LoveNime"`), `css ${name} wajib punya pecahan`);
  }
  for (const id of ALL_JS_SEALS) {
    const source = fs.readFileSync(path.join(ROOT, "public/js", `${FILE_FOR[id]}.js`), "utf8");
    assert.match(source, new RegExp(`registerSeal\\("${id}", "copyright LoveNime"\\)`), `js ${id} wajib punya pecahan`);
  }
});

test("satu huruf diganti di file mana pun langsung menggagalkan --check", () => {
  for (const file of ["public/css/seal.css", "public/js/api.js", "public/index.html"]) {
    const root = buatSalinan();
    try {
      const target = path.join(root, file);
      fs.writeFileSync(target, fs.readFileSync(target, "utf8").replace(/copyright LoveNime/g, "copyright LoveN1me"));
      assert.throws(() => cekDi(root), `${file} harus terdeteksi kalau seal berubah`);
      /* Dikembalikan ke bentuk semula, seal harus utuh lagi. */
      fs.copyFileSync(path.join(ROOT, file), target);
      assert.match(cekDi(root), /seal utuh/, `${file} harus kembali utuh setelah dipulihkan`);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test("pecahan yang dihapus total juga menggagalkan --check", () => {
  const root = buatSalinan();
  try {
    /* Dua pola dipakai: modul murni memakai globalThis, api/reference-app
       memakai import langsung. Keduanya harus terdeteksi kalau dihapus. */
    const target = path.join(root, "public/js/api.js");
    fs.writeFileSync(target, fs.readFileSync(target, "utf8").replace(/^registerSeal\("api".*$/m, ""));
    assert.throws(() => cekDi(root), "pecahan yang dihapus harus terdeteksi");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("mode terkunci menyembunyikan isi tapi mempertahankan design", () => {
  for (const selector of ["#searchGrid", "#updateGrid", "#storageGrid", "#continueRail", "#episodeList", "#playerStage", "#searchSection", "#updateSection", "#storageSection", "#profileSection"]) {
    assert.ok(sealCss.includes(selector), `${selector} harus ikut tersembunyi saat terkunci`);
  }
  assert.doesNotMatch(sealCss, /\[data-iln-seal-locked="1"\]\s*\.sidebar\s*\{[^}]*display:none/);
  assert.match(sealCss, /\[data-iln-seal-locked="1"\]\s*\.sidebar/);
});

test("boot tidak memanggil server sama sekali saat kunci tidak cocok", () => {
  const referenceApp = fs.readFileSync(path.join(ROOT, "public/js/reference-app.js"), "utf8");
  assert.match(referenceApp, /sealReady\.then\(\(ok\) => \{\s*if \(!ok\) return;\s*loadLive\(\)/);
  assert.doesNotMatch(referenceApp, /^loadLive\(\);$/m);
});

test("password bypass tidak ikut ke kode yang dibagikan", () => {
  assert.match(integritySource, /ILN_SEAL_BYPASS/);
  assert.doesNotMatch(integritySource, /__ILN_SEAL_BYPASS__\s*=\s*true/);
  assert.doesNotMatch(integritySource, /ILN_SEAL_BYPASS\s*=\s*"1"/);
  assert.doesNotMatch(indexHtml, /__ILN_SEAL_BYPASS__\s*:\s*true/);
});

test("seal tool bisa ditulis ulang tanpa merusak struktur", () => {
  assert.match(sealSource, /function writeSeals/);
  assert.match(sealSource, /--check/);
  assert.match(sealSource, /ILN_SEAL_ROOT/, "seal.js harus bisa diarahkan ke salinan sementara");
  const cssIds = [...sealCss.matchAll(/--iln-seal-([a-z]+):/g)].map((m) => m[1]);
  assert.ok(cssIds.length >= 9, "semua file CSS harus punya pecahan");
});

test("server menolak data dari API saat kunci rusak, tapi tetap menyajikan design", async () => {
  const http = require("node:http");
  const serverSource = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
  /* Guard harus memakai alat seal sungguhan. Membandingkan literal dengan
     dirinya sendiri terlihat aman tapi tidak pernah gagal — itu cacat.
     Dua baris di bawah ini hanya tripwire: mereka menangkap kembalinya
     pola tautologis, tapi TIDAK membuktikan guard bekerja. Yang membuktikan
     adalah assertion 503 di ujung test ini. */
  assert.match(serverSource, /verifyAgainstManifest/);
  assert.doesNotMatch(serverSource, /SEAL_PHRASE\) === "copyright LoveNime"/);

  /* Server diuji dengan seal rusak pada salinan sementara supaya berkas
     proyek tidak pernah berubah saat test lain berjalan paralel. */
  const root = buatSalinan();
  const target = path.join(root, "public/js/api.js");
  fs.writeFileSync(target, fs.readFileSync(target, "utf8").replace(/copyright LoveNime/g, "copyright LoveN1me"));
  assert.throws(() => cekDi(root), "sanity: seal harus terbaca rusak");

  /* ILN_SEAL_ROOT WAJIB di-set sebelum server.js di-require, dan cache modul
     scripts/seal.js harus dibuang lebih dulu. seal.js mengunci ROOT ke nilai
     env saat pertama kali di-load lalu menyimpannya di cache modul — file test
     ini sudah me-require-nya di baris atas tanpa env, jadi tanpa pembersihan
     cache ini server akan membaca proyek asli yang utuh, kunci terbaca benar,
     dan test hijau tanpa pernah menguji 503. Persis kelas test yang kita tolak
     di atas. */
  const sealModulePath = require.resolve(path.join(ROOT, "scripts/seal.js"));
  delete require.cache[sealModulePath];
  process.env.ILN_SEAL_ROOT = root;
  const { app } = require(path.join(ROOT, "server.js"));
  const listener = http.createServer(app);
  await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
  try {
    const base = `http://127.0.0.1:${listener.address().port}`;
    const design = await fetch(`${base}/`);
    assert.equal(design.status, 200, "design tetap bisa disajikan");
    assert.match(design.headers.get("content-type") || "", /text\/html/);

    /* Ini yang membuktikan guard benar-benar bisa gagal. Tanpa assertion ini,
       test hanya memeriksa bahwa HTML masih tersaji — dan itu tetap true
       baik saat terkunci maupun tidak. */
    const api = await fetch(`${base}/api/genres`);
    assert.equal(api.status, 503, "route data harus menolak saat kunci tidak valid");
    const body = await api.json();
    assert.match(body.error || "", /Kunci integritas/, "pesan harus menyebut kunci, bukan upstream");
  } finally {
    await new Promise((resolve) => listener.close(resolve));
    delete process.env.ILN_SEAL_ROOT;
    delete require.cache[sealModulePath];
    fs.rmSync(root, { recursive: true, force: true });
  }
});