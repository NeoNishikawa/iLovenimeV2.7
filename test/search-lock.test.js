const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const referenceApp = fs.readFileSync(path.join(ROOT, "public/js/reference-app.js"), "utf8");
const morphCss = fs.readFileSync(path.join(ROOT, "public/css/morph.css"), "utf8");
const componentsCss = fs.readFileSync(path.join(ROOT, "public/css/components.css"), "utf8");
const indexHtml = fs.readFileSync(path.join(ROOT, "public/index.html"), "utf8");
const kode = referenceApp.replace(/\/\*[\s\S]*?\*\//g, "");

test("kolom search terkunci selama permintaan berjalan", () => {
  assert.match(kode, /function lockSearch\(locked\)/);
  /* readOnly, bukan disabled: disabled memindahkan fokus dan membuat kolom
     terasa mati, sedangkan yang diminta hanya "tidak bisa di otak atik". */
  assert.match(kode, /if \(input\) input\.readOnly = locked/);
  assert.doesNotMatch(kode, /input\.disabled/);
  /* Dipanggil di kedua cabang renderSearch: true saat mulai, false saat selesai. */
  const calls = (referenceApp.match(/lockSearch\((true|false)\)/g) || []).length;
  assert.equal(calls, 2, "lockSearch harus dipanggil tepat dua kali: mulai dan selesai");
  assert.match(morphCss, /\.search-wrap\.is-locked input\{cursor:progress\}/);
});

test("kolom search kembali bisa diketik setelah hasil keluar", () => {
  /* lockSearch(false) harus berada di cabang else, bukan hanya di awal. */
  const renderSearch = (referenceApp.split("function renderSearch(")[1] || "").split("\nfunction ")[0];
  const posisiIf = renderSearch.indexOf("if (state.searchLoading)");
  const posisiElse = renderSearch.indexOf("} else {", posisiIf);
  assert.ok(posisiIf > -1 && posisiElse > posisiIf, "cabang loading dan selesai harus terpisah");
  const cabangElse = renderSearch.slice(posisiElse, posisiElse + 120);
  assert.match(cabangElse, /lockSearch\(false\)/);
});

test("placeholder memakai mesin ketik, bukan teks mati", () => {
  assert.match(referenceApp, /Cari anime…/);
  assert.match(kode, /PHRASES\s*=/);
  assert.match(kode, /input\.placeholder = current\.slice\(0, chars\)/);
  /* Berhenti saat pengguna mulai mengetik, dan tidak jalan saat
     reduced-motion — kalau tidak, placeholder akan bertabrakan dengan
     ketikan asli. */
  assert.match(kode, /addEventListener\("focus", stop, \{ once: true \}\)/);
  assert.match(kode, /prefers-reduced-motion: reduce/);
  assert.match(kode, /if \(reduced\.matches\) return/);
});

test("shiny text hanya aktif saat sedang mencari", () => {
  assert.match(kode, /sub\?\.classList\.toggle\("shiny", locked\)/);
  assert.match(morphCss, /\.shiny\{[^}]*background-clip:text/);
  assert.match(morphCss, /@keyframes shinySweep/);
  /* Tidak boleh jalan di tier rendah maupun reduced-motion. */
  assert.match(morphCss, /\[data-performance-tier="low"\] \.shiny\{animation:none/);
  assert.match(morphCss, /@media \(prefers-reduced-motion: reduce\)\{\.shiny\{animation:none/);
});

test("menu gooey 4 aksi: Favorite, Dislike, Reset, Hapus", () => {
  assert.match(indexHtml, /data-goo="favorite"/);
  assert.match(indexHtml, /data-goo="dislike"/);
  assert.match(indexHtml, /#i-thumb-down/);
  assert.match(indexHtml, /data-goo="reset"/);
  assert.match(indexHtml, /data-goo="remove"/);
  /* Harus memakai aturan yang sama dengan setAnimeReaction: kedua status
     saling meniadakan. */
  assert.match(kode, /isFavorite \? \{ favorite: true, dislike: false \} : \{ dislike: true, favorite: false \}/);
  /* SET, bukan toggle: satu klik tidak boleh membalik statusnya sendiri. */
  assert.doesNotMatch(kode, /favorite: !entry\.favorite/);
  /* Reset lewat konfirmasi (silent, bukan erase) — masih wajar karena
     progress bisaPulihkan dengan menonton ulang. */
  assert.match(kode, /if \(action === "reset"\) \{[\s\S]*?openConfirm\(/);
  assert.match(kode, /openConfirm\("Reset progress\?"[\s\S]{0,200}resetProgress\(slug\)/);
  /* Hapus dari menu morph: TIDAK boleh popup, harus hold. */
  assert.doesNotMatch(kode, /if \(action === "remove"\) \{[\s\S]{0,400}openConfirm\(/);
  assert.match(kode, /if \(action === "remove"\) \{[\s\S]{0,400}Tahan tombol Hapus/);
});

test("tombol morph ada di DALAM kartu anime, bukan di toolbar", () => {
  /* Ini yang diminta Neo: tombol morph menempel pada box anime Local Storage,
     dengan dua tombol per kartu seperti tampilan awal (+ morph dan mata). */
  assert.match(kode, /btn-icon-only btn-morph" data-act="goo"/);
  /* Tombol kedua (mata / Lihat detail) tetap ada di sebelahnya. */
  assert.match(kode, /data-act="goo"[^\n]*<\/button><button class="btn btn-sm btn-icon-only" data-act="detail"/);
  /* Kartu yang sudah di storage tidak lagi menampilkan tombol "See Detail"
     satu tombol penuh — sekarang dua tombol ikon. */
  assert.doesNotMatch(kode, /btn-icon-only btn-morph[^\n]*<\/button><button[^>]*><span class="btn-label">See Detail/);
  /* Menu TUNGGAL di root, bukan satu panel per kartu: 18 kartu tidak boleh
     berarti 18 panel. */
  assert.match(indexHtml, /<div class="goo-menu" id="gooMenu" role="menu" hidden>/);
  assert.doesNotMatch(indexHtml, /id="storageGoo"/);
  assert.doesNotMatch(indexHtml, /id="searchGoo"/);
  /* Delegasi, bukan bind per tombol: kartu dirender ulang tiap render. */
  assert.match(kode, /closest\?\.\('\[data-act="goo"\]'\)/);
});

test("kartu anime bisa diklik langsung, tidak wajib pakai tombol mata", () => {
  /* Permintaan Neo: pengguna tidak harus menekan ikon mata untuk buka detail.
     Tombol mata TETAP ADA (dia jalur keyboard dan masih dikunci test lain),
     jadi ini menambah cara, bukan Removes. */
  assert.ok(
    kode.includes('${options.removeMode || options.checkbox ? "" : " data-card-open"}'),
    "kartu harus dapat data-card-open, dan hanya di luar Edit Mode"
  );
  /* Guard WAJIB: listener goo ada di document.addEventListener terpisah.
     Tanpa guard [data-act], satu klik tombol morph akan membuka menu goo
     DAN modal detail sekaligus. */
  assert.ok(
    kode.includes("const aksi = event.target.closest?.('[data-act]')"),
    "semua elemen data-act harus dikeluarkan sebelum cek kartu"
  );
  assert.ok(
    kode.includes("event.target.closest?.('a,input,select,textarea,label')"),
    "tautan dan field form di dalam kartu tidak boleh memicu buka detail"
  );
  assert.ok(
    kode.includes("event.target.closest?.('.anime-card[data-card-open]')"),
    "selector kartu harus memakai data-card-open supaya Edit Mode aman"
  );
  assert.ok(
    kode.includes("} else if (card) { event.preventDefault(); openDetail(card.dataset.id); }"),
    "cabang else harus membuka detail lewat kartu"
  );
  /* Urutan penting: cabang kartu harus TERAKHIR, setelah play/detail/add/
     check/remove, supaya klik tombol tidak sekaligus membuka kartu. */
  const urut = kode.indexOf("} else if (card) {");
  assert.ok(urut > -1, "cabang kartu harus ada");
  assert.ok(
    kode.indexOf('closest?.(\'[data-act="detail"]\')') < urut,
    "cabang detail harus lebih dulu dari cabang kartu"
  );
  /* Affordance: kursor tangan, dan hanya untuk kartu yang bisa diklik. */
  assert.match(componentsCss, /\.anime-card\[data-card-open\]\{cursor:pointer\}/);
  assert.doesNotMatch(componentsCss, /\.anime-card\{cursor:pointer\}/);
  /* Cache-buster wajib ada. NOMORNYA tidak dikunci: memaksa test gagal
     setiap kali versi naik akan melatih orang mengabaikan kegagalan. */
  assert.match(indexHtml, /reference-app\.js\?v=[0-9.]+/);
  assert.match(indexHtml, /components\.css\?v=[0-9.]+/);
  /* Tombol mata tidak boleh ikut hilang. */
  assert.match(kode, /data-act="detail"/);
});

test("gumpalan gooey DIHAPUS dari kartu: filter dan blob tidak boleh kembali", () => {
  /* Alasan penghapusan: blur + contrast alpha butuh ruang gerak minimal ~2x
     ukuran blob. Tombol di kartu cuma 52x34px, jadi hasilnya blob solid
     yang menutupi ikon + dan tetangganya — bukan tetesan cair. Efeknya
     berulang menimpa ikon di dua percobaan perbaikan layout. */
  assert.doesNotMatch(indexHtml, /<filter id="gooFilter/);
  assert.doesNotMatch(kode, /goo-blobs/);
  assert.doesNotMatch(kode, /goo-blob/);
  assert.doesNotMatch(componentsCss, /\.goo-blobs\{/);
  assert.doesNotMatch(componentsCss, /\.goo-blob\{/);
  /* Tombol morph tetap ada sebagai tombol ikon biasa (dua tombol/kartu). */
  assert.match(kode, /btn-icon-only btn-morph" data-act="goo"/);
  assert.match(componentsCss, /\.card-actions \.btn-morph\{flex:0 0 44px\}/);
});

test("fungsi morph tetap utuh walau tampilan gumpalan dihapus", () => {
  /* Yang hilang hanya visual. Menu 4 aksi, konfirmasi, dan ikon berputar
     saat menu terbuka harus tetap berfungsi. */
  assert.match(indexHtml, /<div class="goo-menu" id="gooMenu" role="menu" hidden>/);
  /* Empat item menu ada di MARKUP (index.html), bukan di reference-app.js
     yang hanya membacanya lewat item.dataset.goo. */
  assert.match(indexHtml, /data-goo="favorite"/);
  assert.match(indexHtml, /data-goo="dislike"/);
  assert.match(indexHtml, /data-goo="reset"/);
  assert.match(indexHtml, /data-goo="remove"/);
  assert.match(kode, /item\.dataset\.goo/);
  assert.match(kode, /openConfirm\("Reset progress\?"[\s\S]{0,200}resetProgress\(slug\)/);
  assert.match(componentsCss, /\.btn-morph\[aria-expanded="true"\] \.ico-plus\{[^}]*rotate\(90deg\)/);
  assert.match(componentsCss, /\.goo-menu\{[^}]*position:fixed/);
});

test("hapus satu anime = hold + toast, TANPA popup; popup khusus Delete All Data", () => {
  /* Aturan yang diminta Neo: tidak boleh ada dua bahasa interaksi untuk
     aksi yang sama. Hapus satu anime SELALU hold lalu toast. Popup
     konfirmasi + animasi erase hanya untuk Delete All Data di sidebar,
     karena itu satu-satunya hapus yang sekaligus menghapus semuanya. */
  assert.match(kode, /holdable\(removeBtn, MORPH_HOLD_MS/);
  assert.match(kode, /const MORPH_HOLD_MS = 1200/);
  /* Fill progress untuk tombol Hapus di menu — bukti interaksinya hold. */
  assert.match(componentsCss, /\.goo-menu button\[data-goo="remove"\]::before\{[^}]*scaleX\(var\(--hold,0\)\)/);
  /* Hold di menu morph memanggil removeStorage() (yang sudah toast). */
  assert.match(kode, /holdable\(removeBtn, MORPH_HOLD_MS[\s\S]{0,400}removeStorage\(slug\)/);
  /* Klik singkat di kedua jalur hanya memberi petunjuk, bukan popup. */
  assert.match(kode, /Tahan tombol Hapus/);
  assert.match(kode, /Tahan tombol Remove/);
  /* Tidak boleh ada openConfirm untuk hapus satu anime di mana pun. */
  assert.doesNotMatch(kode, /openConfirm\("Hapus dari Local Storage\?"/);
  /* Delete All Data tetap pegang popup + erase. */
  assert.match(kode, /holdable\(\$\("#deleteDataBtn"\), 1500, \(\) => openConfirm\("Hapus seluruh data lokal\?"/);
  /* Bulk delete Edit Mode juga hold + toast, tanpa popup. */
  assert.match(kode, /holdable\(\$\("#bulkDeleteBtn"\), 1500[\s\S]{0,200}toast\("Anime terpilih dihapus"\)/);
});

test("menu gooey diposisikan di viewport, tidak keluar layar", () => {
  assert.match(componentsCss, /\.goo-menu\{[^}]*position:fixed/);
  assert.match(kode, /window\.innerHeight - h - 8/);
  assert.match(kode, /window\.innerWidth - w - 8/);
  /* Caption judul anime: user harus tahu kartu mana yang dituju. */
  assert.match(kode, /scopeLine\.textContent = item\.title/);
  assert.match(componentsCss, /\.goo-scope\{[^}]*text-overflow:ellipsis/);
  /* Escape menutup dan mengembalikan fokus ke tombol asalnya. */
  assert.match(kode, /e\.key !== "Escape" \|\| !gooAnchor/);
});

test("filter gooey sudah tidak ada (dead markup jangan dihidupkan lagi)", () => {
  /* Efek gumpalan dihapus dari kartu. Test lama di sini menuntut
     <filter id="gooFilter"> hidup; sekarang tujuannya justru menjaga
     supaya tidak ada filter SVG yatim yang cuma menambah bobot render. */
  assert.doesNotMatch(indexHtml, /<filter id="gooFilter/);
  assert.doesNotMatch(indexHtml, /feGaussianBlur/);
  assert.doesNotMatch(indexHtml, /feColorMatrix/);
  /* Wadah svg goo-defs boleh tinggal, tapi harus benar-benar kosong. */
  assert.match(indexHtml, /<svg class="goo-defs"[^>]*><defs><\/defs><\/svg>/);
  assert.doesNotMatch(componentsCss, /\.goo-blob/);
  assert.doesNotMatch(componentsCss, /filter:url\(#goo/);
});