const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

/* Perintah /genre untuk mobile, 15 Oktober 2026.

   Genre disembunyikan di mobile dengan sengaja (responsive.css, blok 767px:
   .header .genre-filter{display:none}) supaya header tidak penuh. Efek
   sampingnya ada dua:
     1. placeholder mobile ikut bikin bohong - dia masih berbunyi "Ketik judul
        atau genre" padahal genre tidak bisa dipilih di layar itu;
     2. di layar 768-1023px picker-nya masih terlihat, jadi ambang perintah
        HARUS 767px, bukan 1023px. Pakai angka 1023px (isMobileViewport)
        akan membuat dua jalan ke genre di satu layar.

   Yang diuji di sini bukan perilakunya di browser, tapi hal-hal
   yang mudah rusak diam-diam: ambangnya meleset, desktop ikut berubah,
   atau perintah ini mulai menduplicate listener yang sudah ada. */

const ROOT = path.join(__dirname, "..");
const kode = fs.readFileSync(path.join(ROOT, "public/js/reference-app.js"), "utf8");
const responsive = fs.readFileSync(path.join(ROOT, "public/css/responsive.css"), "utf8");
const morph = fs.readFileSync(path.join(ROOT, "public/css/morph.css"), "utf8");
const dropdown = fs.readFileSync(path.join(ROOT, "public/js/dropdown.js"), "utf8");
const indexHtml = fs.readFileSync(path.join(ROOT, "public/index.html"), "utf8");

/* Iris blok perintahnya saja. Tanpa ini, satu assertion yang gagal
   menumpahkan seluruh reference-app.js (134 KB) ke output - dan yang
   tampil bukan baris yang salah, tapi ratusan baris yang tidak berhubungan. */
const blokPerintah = kode.slice(
  kode.indexOf("Perintah /genre"),
  kode.indexOf("bindGenreCommand();")
);

function blokMobile() {
  const mulai = responsive.indexOf("@media (max-width:767px)");
  assert.ok(mulai > -1, "blok mobile 767px harus ada");
  const selesai = responsive.indexOf("@media", mulai + 10);
  return responsive.slice(mulai, selesai > -1 ? selesai : undefined);
}

test("ambang perintah /genre 767px, sama dengan yang menyembunyikan filter", () => {
  assert.match(kode, /genreCmdQuery\s*=\s*window\.matchMedia\("\(max-width:\s*767px\)"\)/,
    "perintah genre harus memakai 767px");
  assert.match(responsive, /@media \(max-width:767px\)\{[\s\S]{0,900}?\.header \.genre-filter/,
    ".genre-filter harus disembunyikan di blok 767px");
  assert.doesNotMatch(kode, /genreCmdQuery[^;]*1023px/,
    "1023px itu untuk drawer dan ukuran halaman, bukan untuk filter genre");
});

test("ambang perintah sama dengan ambang dropdown, supaya tidak ada dua definisi", () => {
  assert.match(dropdown, /window\.matchMedia\("\(max-width:\s*767px\)"\)/,
    "dropdown.js sudah memakai 767px untuk isMobile()");
});

test("placeholder mobile hanya /genre, desktop tidak boleh tersentuh", () => {
  assert.match(kode, /PHRASES\s*=\s*\["Cari anime/,
    "larik desktop harus tetap ada dan tidak boleh diganti nama");
  assert.match(kode, /PHRASES_MOBILE\s*=\s*\["\/"\]/,
    "placeholder mobile harus persis /genre");
  assert.match(kode, /phrases\s*=\s*\(\)\s*=>\s*\(mobileCmd\.matches\s*\?\s*PHRASES_MOBILE\s*:\s*PHRASES\)/,
    "pilihan frasa harus menyesuaikan layar, bukan satu larik untuk semua");
});

test("mesin ketik yang mengunci search-lock.test.js tetap utuh", () => {
  /* Dua ekspresi ini dikunci test lain. Kalau dirapikan tanpa sengaja,
     placeholder berhenti sama sekali dan tidak ada yang memberi tahu. */
  assert.match(kode, /PHRASES\s*=/, "PHRASES harus ada");
  assert.match(kode, /input\.placeholder = current\.slice\(0, chars\)/,
    "placeholder harus tetap diketik huruf demi huruf di desktop");
});

test("mesin ketik mati di mobile, jadi placeholder tidak berkedip", () => {
  assert.match(kode, /list === PHRASES_MOBILE[\s\S]{0,120}?input\.placeholder = current; return;/,
    "satu frasa /genre tidak boleh diketik-hapus berulang");
});

test("placeholder ditukar saat layar berubah lebar, tidak tertinggal", () => {
  assert.match(kode, /mobileCmd\.addEventListener\("change"/,
    "memutar HP harus menukar placeholder, bukan menyisakan milik layar lain");
});

test("Enter membuka panel dan tidak pernah jadi pencarian", () => {
  assert.match(blokPerintah, /e\.key === "Enter" && isGenreCommand\(\)\) \{[\s\S]{0,60}?e\.preventDefault\(\);[\s\S]{0,40}?openGenreCommand\(\)/,
    "Enter saat /genre aktif harus membuka panel, bukan mengirim pencarian");
  assert.match(kode, /onkeydown = \(e\) => \{ if \(e\.key === "Enter"\) \{ if \(isGenreCommand\(\)\) return;/,
    "pencarian harus dilewati kalau isinya perintah, bukan dikirim sebagai judul");
});

test("Escape membatalkan perintah tanpa menutup panel yang sudah terbuka", () => {
  assert.match(kode, /e\.key === "Escape" && isGenreCommand\(\)\) \{ input\.value = "";/,
    "Escape harus mengosongkan teks perintah");
});

test("panel dibuka lewat trigger yang ada, bukan listener baru", () => {
  /* dropdown.js sudah memasang Escape global dan klik luar. Kalau perintah
     ini memasang listener sendiri, ketiganya akan berebut dan panel bisa
     tertutup dua kali. setOpen tidak diekspor, jadi trigger.click() adalah
     jalan yang benar: ia lewat handler yang sama dengan pengguna desktop. */
  assert.match(kode, /trigger\.click\(\)/, "panel harus dibuka lewat trigger");
  assert.doesNotMatch(kode, /addEventListener\("keydown"[\s\S]{0,80}?Escape[\s\S]{0,80}?closeActive/,
    " jangan menambah Escape sendiri; dropdown.js sudah menangani");
  assert.match(dropdown, /document\.addEventListener\("keydown"[\s\S]{0,160}?closeActive\(\)/,
    "penjaga: Escape global harus masih ada di dropdown.js");
});

/* Aturan html.genre-cmd sengaja di luar media query: class itu hanya pernah
   ada di <=767px karena dicek JS, jadi media query hanya mengulang keputusan
   yang sama. Di luar query, aturannya bisa diperiksa di jendela lebar tanpa
   harus berpindah perangkat - itu gunanya. */
function blokGenreCmd() {
  const mulai = responsive.indexOf("html.genre-cmd");
  assert.ok(mulai > -1, "aturan html.genre-cmd harus ada");
  return responsive.slice(mulai);
}

test("CSS memunculkan panel dan menyembunyikan tombolnya", () => {
  const blok = blokGenreCmd();
  assert.match(blok, /html\.genre-cmd \.header \.genre-filter\{display:block/,
    "panel genre harus muncul saat perintah aktif");
  assert.match(blok, /html\.genre-cmd \.header \.genre-filter \.gf-trigger\{display:none/,
    "tombolnya harus tetap disembunyi supaya header tidak berubah");
});

test("aturan genre-cmd tidak boleh berada di dalam media query", () => {
  /* Komentar dibuang dulu: ada catatan di blok 767px yang menyebut nama
     class-nya, dan itu bukan aturan. Tanpa membuang komentar, assertion
     ini akan salah membaca komentar sebagai pelanggaran. */
  const tanpaKomentar = blokMobile().replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(tanpaKomentar, /html\.genre-cmd/,
    "di dalam blok 767px aturannya tidak akan bisa diperiksa tanpa perangkat");
  /* Sekalian: blok genre-cmd harus benar-benar berada setelah media
     query terakhir, bukan di selah yang tidak terduga. */
  const terakhir = responsive.lastIndexOf("@media");
  const aturan = responsive.indexOf("html.genre-cmd .header .genre-filter{");
  assert.ok(aturan > terakhir,
    "aturan genre-cmd harus setelah media query terakhir");
});

test("perintah /genre jadi dropdown melayang, bukan bottom sheet", () => {
  /* Di HP bottom sheet hasilnya salah: panelnya pendek dan melekat di
     dasar layar, sementara kartu anime di belakangnya tetap terang dan
     terlihat bisa diklik. Tidak terbaca sebagai lapisan di atas halaman.
     Yang benar: melayang tepat di bawah kotak pencarian. */
  const blok = blokGenreCmd();
  assert.match(blok, /html\.genre-cmd \.gf-panel\{[\s\S]{0,200}?top:var\(--genre-cmd-top/,
    "posisi atas harus datang dari pengukuran JS");
  assert.match(blok, /html\.genre-cmd \.gf-panel\{[\s\S]{0,420}?right:auto !important;bottom:auto !important;/,
    "harus melepas bottom:0 dari aturan bottom sheet, kalau tidak panelnya nempel di bawah");
  assert.match(blok, /left:var\(--genre-cmd-left/,
    "panel harus dikaitkan ke kotak pencarian, bukan kelebar layar");
});

test("latar redup wajib, tanpa itu panelnya tidak terbaca sebagai modal", () => {
  assert.match(responsive, /\.genre-cmd-backdrop\{[\s\S]{0,200}?position:fixed;inset:0/,
    "backdrop harus menutup layar");
  assert.match(responsive, /\.genre-cmd-backdrop\{[\s\S]{0,200}?background:rgba/,
    "backdrop harus meredupkan isi di belakangnya");
  assert.match(responsive, /\.genre-cmd-backdrop\[hidden\]\{display:none\}/,
    "backdrop harus bisa disembunyikan, kalau tidak tidak akan pernah hilang");
  /* Panel harus di atas backdrop, kalau tidak panelnya tertutup sendiri. */
  const zBack = responsive.match(/\.genre-cmd-backdrop\{[\s\S]{0,200}?z-index:(\d+)/);
  const zPanel = responsive.match(/html\.genre-cmd \.gf-panel\{[\s\S]{0,900}?z-index:(\d+)/);
  assert.ok(zBack && zPanel, "kedua z-index harus ada");
  assert.ok(Number(zPanel[1]) > Number(zBack[1]),
    "panel harus di atas backdrop");
});

test("grid 2 kolom di dalam perintah, seperti yang diminta", () => {
  const blok = blokGenreCmd();
  assert.match(blok, /html\.genre-cmd \.gf-grid\{[\s\S]{0,160}?grid-template-columns:repeat\(2,minmax\(0,1fr\)\) !important/,
    "chip harus 2 kolom di dalam perintah /genre");
  assert.match(blok, /max-height:none !important/,
    "tinggi panel yang dibatasi, bukan grid-nya yang menggulir sendiri");
});

test("koordinat panel diukur dari kotak pencarian, bukan ditebak", () => {
  assert.match(blokPerintah, /function positionGenreCommand\(\)/);
  assert.match(blokPerintah, /getBoundingClientRect\(\)/,
    "harus mengukur, bukan memakai angka tetap");
  assert.match(blokPerintah, /--genre-cmd-left/);
  assert.match(blokPerintah, /--genre-cmd-w/);
  assert.match(blokPerintah, /--genre-cmd-top/);
  assert.match(blokPerintah, /Math\.max\(r\.width, 260\)/,
    "lebar minimal 260px, supaya grid 2 kolom tidak tergencet");
  /* YangComputed harus benar-benar dipakai. Hanya Kemunculannya
     getBoundingClientRect() tidak cukup: mutasi yang menggantikiri
     dengan angka tetap lolos semua test kalau ini tidak ada. */
  assert.match(blokPerintah, /const w = Math\.min\(Math\.max\(r\.width, 260\), vw - 20\)/,
    "lebar harus dihitung dari kotak pencarian");
  assert.match(blokPerintah, /const left = Math\.min\(Math\.max\(10, r\.left\), vw - w - 10\)/,
    "kiri harus diukur dari kotak pencarian, bukan angka tetap");
  assert.match(blokPerintah, /panel\.style\.setProperty\("--genre-cmd-left", Math\.round\(left\) \+ "px"\)/,
    "nilai terukur itu yang harus dikirim ke CSS");
});

test("panel yang ditutup dari luar juga membersihkan diri", () => {
  /* Escape global dan klik luar milik dropdown.js menutup panel tanpa lewat
     kode ini. Kalau html.genre-cmd tidak dibuang, body overflow="hidden"
     tertinggal dan halaman terkunci padahal tidak ada yang terbuka. */
  assert.match(blokPerintah, /new MutationObserver\(\(\) => \{ if \(panelEl\.hidden\) genreCmdChromeOff\(\); \}\)/,
    "penutupan dari luar harus diamati lewat atribut hidden");
  assert.match(blokPerintah, /attributeFilter: \["hidden"\]/);
  assert.match(blokPerintah, /function genreCmdChromeOff\(\)[\s\S]{0,300}?classList\.remove\("genre-cmd"\)/,
    "class harus dibuang saat menutup");
  assert.match(blokPerintah, /function genreCmdChromeOn\(\)[\s\S]{0,300}?genreCmdBackdropEl\(\)\.hidden = false/,
    "backdrop harus muncul saat membuka");
});

test("tag pilihan bisa dihapus, karena di mobile itu satu-satunya tempatnya", () => {
  /* sh-tag tadinya <span> murni label. Di mobile picker genre disembunyikan,
     jadi baris tag ini satu-satunya tempat pilihan terlihat; kalau tidak bisa
     dihapus, orang tidak bisa membatalkan pilihannya dari layar yang sama. */
  assert.match(kode, /<button type="button" class="sh-tag" data-chip-kind=/,
    "tag harus jadi tombol, bukan span");
  assert.match(kode, /\$\$\("\[data-chip-key\]", tags\)\.forEach\(\(btn\) => btn\.onclick = \(event\) => \{ event\.stopPropagation\(\); removeSearchPick/,
    "tag harus memanggil removeSearchPick saat diklik");
  assert.match(morph, /\.sh-tag\{[\s\S]{0,400}?cursor:pointer/,
    "kursor harus menandakan bisa diklik");
});

test("aset yang diubah ikut naikkan cache-buster", () => {
  /* Tanpa ini browser memakai CSS/JS lama dan perubahannya terlihat acak. */
  assert.match(indexHtml, /\/css\/morph\.css\?v=2\.4\.2/);
  assert.match(indexHtml, /\/css\/responsive\.css\?v=2\.4\.0/);
  assert.match(indexHtml, /\/js\/reference-app\.js\?v=2\.38\.0/);
});
test("/genre: menyaring chip langsung saat mengetik, bukan setelah Enter", () => {
  /* Inilah yang membedakan perintah ini dari sekadar membuka panel. Tanpa
     penyaringan langsung, /genre cuma dua ketukan ekstra tanpa untung:
     buka panel, baca semua chip, cari yang benar di mata. */
  assert.match(blokPerintah, /input\.addEventListener\("input"[\s\S]{0,320}?filterGenreCommand\(q\)/,
    "penyaringan harus jalan di event input, bukan hanya di Enter");
});

test("penyaringan memakai awalan dan menerima titik dua", () => {
  assert.match(blokPerintah, /GENRE_CMD_RE = \/\^\\\/\(\?:genre\)\?/,
    "pola harus menerima /genre, /genre: dan /genre ' + teks penyaring");
  assert.match(blokPerintah, /name\.startsWith\(needle\)/,
    "harus cocok awalan, bukan 'mengandung' - orang mengetik dari awal kata");
  assert.match(blokPerintah, /\(b\.dataset\.name \|\| ""\)\.toLowerCase\(\)/,
    "pencocokan harus memakai nama yang tampil, bukan slug");
});

test("bindGenre memberi chip data-name, tanpa itu penyaringan tidak bisa jalan", () => {
  assert.match(kode, /data-genre="\$\{esc\(g\.slug\)\}" data-name="\$\{esc\(g\.name\)\}"/,
    "setiap chip harus menyimpan nama tampilan untuk pencocokan awalan");
});

test("chip disembunyikan, bukan dirender ulang", () => {
  /* bindGenre() memasang onclick per chip. Kalau grid dibangun ulang saat
     menyaring, handler-nya ikut mati - itu bug "tidak bisa ganti pilihan"
     yang sudah dicatat di file ini. */
  assert.match(blokPerintah, /b\.hidden = !cocok/,
    "penyaringan harus menyembunyikan chip, bukan membangun ulang grid");
  assert.doesNotMatch(blokPerintah, /function filterGenreCommand[\s\S]{0,700}?innerHTML\s*=/,
    " jangan menulis ulang .gf-grid di dalam filterGenreCommand");
});

test("panel yang kosong diberi tahu, bukan dibiarkan hening", () => {
  assert.match(blokPerintah, /genreCmdNote\.hidden = shown > 0/,
    "pesan 'tidak ada yang cocok' harus muncul kalau tidak ada hasil");
  assert.match(blokPerintah, /className = "gf-empty"/,
    "pesan perlu kelas sendiri");
});

test("keluar dari mobile mengembalikan semua chip, jangan ada sisa saringan", () => {
  /* Kalau tidak, layar desktop mewarisi penyaringan yang ditinggalkan
     perintah mobile: sebagian genre hilang tanpa sebab. */
  assert.match(blokPerintah, /if \(!genreCmdQuery\.matches\)[\s\S]{0,320}?filterGenreCommand\(""\)/,
    "keluar dari mobile wajib mengembalikan seluruh chip");
});

test("tombol yang diklik mengosongkan perintah supaya kotak cari kembali normal", () => {
  assert.match(blokPerintah, /\$\("\.gf-grid", genreCmdRoot\)\?\.addEventListener\("click"/,
    "listener harus di grid (delegasi), bukan per chip");
  assert.match(blokPerintah, /addEventListener\("click"[\s\S]{0,200}?input\.value = "";/,
    "setelah memilih genre, teks perintah harus dibersihkan");
});

test("openGenreCommand tidak menutup panelnya sendiri", () => {
  /* trigger.click() pada panel yang sudah terbuka akan MENUTUPNYA. Kalau
     openGenreCommand() tidak dicek, mengetik huruf kedua akan menutup
     panel tepat saat pengguna menyaring. */
  assert.match(blokPerintah, /if \(!genreCmdRoot\.classList\.contains\("open"\)\) trigger\.click\(\);/,
    "hanya klik trigger saat panel masih tertutup");
});

test("components.css naik karena dapat aturan .gf-empty", () => {
  assert.match(indexHtml, /\/css\/components\.css\?v=2\.23\.0/);
  const comp = fs.readFileSync(path.join(ROOT, "public/css/components.css"), "utf8");
  assert.match(comp, /\.gf-empty\{[\s\S]{0,200}?grid-column:1\/-1/,
    "pesan harus membentang penuh, bukan menempati satu kolom chip");
});



test("backdrop-filter header dimatikan selama perintah aktif", () => {
  /* Ini bukan kosmetik. backdrop-filter pada .header menjadikannya
     containing block bagi position:fixed di dalamnya, jadi panel terukur
     relatif ke header dan koordinat dari JS meleset sebesar tinggi header.
     Di HP aturan itu sudah mati - tapi begitu hidup lagi, panelnya bergeser
     tanpa error. Diuji karena menggeser posisi diam-diam adalah kegagalan
     yang paling sulit noticed. */
  const blok = blokGenreCmd();
  assert.match(blok, /html\.genre-cmd \.header\{backdrop-filter:none\}/,
    "backdrop-filter header harus dimatikan saat perintah aktif");
});
test("backdrop HARUS di bawah header, atau panel tidak bisa diklik", () => {
  /* Bug yang nyata, ditemukan dari laporan Neo di perangkat: panel terlihat
     tapi tidak bisa diklik. Sebabnya .header punya position:relative +
     z-index:40, jadi ia stacking context dan z-index pada .gf-panel
     (420) terperangkap di dalamnya - efektinya cuma 40 di root. Backdrop
     di 410 menutupinya. Terlihat tetap karena backdrop cuma 55% hitam,
     tapi setiap klik jatuh ke backdrop yang lalu menutup panel. */
  const layout = fs.readFileSync(path.join(ROOT, "public/css/layout.css"), "utf8");
  const header = layout.match(/\.header\{[\s\S]{0,400}?z-index:(\d+)/);
  assert.ok(header, "z-index .header harus bisa dibaca dari layout.css");
  const zBack = Number(responsive.match(/\.genre-cmd-backdrop\{[\s\S]{0,200}?z-index:(\d+)/)[1]);
  assert.ok(zBack < Number(header[1]),
    "backdrop (z-index " + zBack + ") harus di bawah .header (" + header[1] + "), " +
    "atau panel tidak akan bisa diklik: panel terkurung di stacking context header");
  assert.doesNotMatch(responsive, /\.genre-cmd-backdrop\{[\s\S]{0,200}?z-index:(?!3[0-9]\b)\d{3}/,
    "backdrop tidak boleh pakai z-index tiga digit - itu pasti di atas header");
});

test("Enter memilih chip pertama yang cocok", () => {
  /* Palette di Slack dan VS Code begitu juga: Enter ambil yang pertama.
     Tanpa ini, orang yang tidak memakai tetikus harus memindai daftar. */
  assert.match(blokPerintah, /const pertama = \$\$\("\[data-genre\]", \$\("\.gf-grid", genreCmdRoot\)\)\.find\(\(b\) => !b\.hidden\)/,
    "harus mencari chip pertama yang terlihat, bukan chip pertama di DOM");
  assert.match(blokPerintah, /if \(pertama\) pertama\.click\(\);/,
    "Enter harus memanggil click chip itu");
  assert.doesNotMatch(blokPerintah, /if \(pertama\) pertama\.click\(\);\s*else[^}]*\.click/,
    "kalau tidak ada yang cocok, jangan klik apa pun");
});
test("satu karakter / sudah cukup, tidak perlu mengetik 'genre'", () => {
  /* Neo: "kenapa pengguna harus mengetik ulang kata genre". Tujuh karakter
     di keyboard HP untuk membuka panel itu friksi murni - maknanya cuma
     "aku mau genre". Kata 'genre' tetap diterima untuk yang sudah
     terbiasa, jadi tidak ada buntu kalau ada yang mengetik "/genre". */
  assert.match(blokPerintah, /GENRE_CMD_RE = \/\^\\\/\(\?:genre\)\?/,
    "pola harus menerima / tanpa kata 'genre'");
  assert.match(kode, /PHRASES_MOBILE = \["\/"\]/,
    "placeholder mobile harus '/', jujur soal batas minimum");
});

test("batas pemilihan genre: maksimal 2", () => {
  assert.match(kode, /const GENRE_PICK_LIMIT = 2;/,
    "batasnya dua, bukan satu");
  assert.match(kode, /if \(set\.size >= GENRE_PICK_LIMIT\) \{ genreLimitWarn\(root\)\.hidden = false; return; \}/,
    "pemilihan ketiga harus ditolak, bukan diam");
  assert.match(kode, /genreLimitWarn\(root\)\.hidden = set\.size < GENRE_PICK_LIMIT/,
    "pesan ikut hilang begitu jumlah turun di bawah batas");
  assert.match(kode, /remove\("on"\)\); genreLimitWarn\(root\)\.hidden = true; storage/,
    "Clear All juga harus menyembunyikan pesan");
  assert.match(kode, /el\.textContent = "Maksimal " \+ GENRE_PICK_LIMIT \+ " genre\. Hapus satu dulu\."/,
    "pesan harus menyebut batasnya, supaya bisa dibatalkan");
});

test("penesan batas punya gaya sendiri", () => {
  const comp = fs.readFileSync(path.join(ROOT, "public/css/components.css"), "utf8");
  assert.match(comp, /\.gf-warn\{[\s\S]{0,260}?color:var\(--gold\)/,
    "pesan batas harus kelihatan peringatan, bukan teks biasa");
});
